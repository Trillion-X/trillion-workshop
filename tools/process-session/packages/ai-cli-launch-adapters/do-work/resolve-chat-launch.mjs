#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/resolve-chat-launch.mjs
//
// =============================================================================
// PURPOSE — the ONE canonical "resolve the selected provider's launch argv" seam
// =============================================================================
//
// Every caller that wants to "run a prompt against the user-selected provider"
// needs the same join: provider rows + CLI-registry rows -> pick the provider ->
// pick the CLI bound to it -> render its `chat_launch` argv/cwd/env from the
// registry descriptor DATA. Until now that join was COPIED into every package's
// own script (prompt-to-variations/make-prompt-to-variations-command-request.py;
// the convicted customer-article-engine did the worse `[cli,"-p",prompt]` default
// "claude" version). `ai-cli-launch-adapters` OWNS the `prop:cli_registry:*`
// descriptor schema, so this resolver is its bedrock (L088) — every caller
// dispatches here via Envelope and passes the returned argv as opaque DATA to its
// own executor (e.g. content-production `generate-derived --cli`). Convergence:
// Claude + Codex (gpt-5.5) independently landed on this exact placement.
//
// =============================================================================
// INVARIANTS
// =============================================================================
//   - Pure resolution. NEVER executes a CLI or any OS process.
//   - NO prompt persona, NO output shaping — that is the caller's domain.
//   - NO hardcoded provider/CLI/model names. "claude", "codex", "-m", "-p" never
//     appear — every name and flag is read from provider/CLI registry DATA rows.
//   - Returns the argv WITHOUT a prompt (the `{value:"prompt"}` launch slot drops
//     when no prompt is in context), so the caller appends its own prompt.
//   - Returns provenance {provider_id, cli_id, model_id} on every result.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { resolveTransport } from "./transport-capabilities.mjs";
import { remoteHttpStreamTransport } from "./remote-http-stream-transport.mjs";

/** Non-empty string or null. */
export function asString(value) {
  return typeof value === "string" && value ? value : null;
}

/** Parse a value_json cell: registry rows store JSON as a string; accept already-
 *  parsed values too. Returns the raw value on parse failure (never throws). */
function parseCell(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Parse a JSON array of attribute_fact rows (or [] on any failure). */
export function parseRows(value) {
  let parsed;
  try {
    parsed = value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** Group flat attribute_fact rows {subject_id, property_id, value_json} into one
 *  object per subject, parsing each value_json cell. */
export function groupRows(rows, idKey) {
  const grouped = new Map();
  for (const row of rows) {
    const subjectId = asString(row?.subject_id);
    const propertyId = asString(row?.property_id);
    if (subjectId === null || propertyId === null) continue;
    let current = grouped.get(subjectId);
    if (!current) {
      current = { [idKey]: subjectId, subject_id: subjectId };
      grouped.set(subjectId, current);
    }
    current[propertyId] = parseCell(row.value_json);
  }
  return [...grouped.values()];
}

/** Render an open-parameter value as launch-context text: strings pass through;
 *  bools/numbers use canonical text; structures serialize to compact JSON. */
export function scalarText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Default model id from a registry models list: first isDefault, else first. */
export function firstDefaultModel(models) {
  if (!Array.isArray(models)) return null;
  for (const m of models) if (m && (m.isDefault === true || m.is_default === true) && asString(m.id)) return m.id;
  for (const m of models) if (m && asString(m.id)) return m.id;
  return null;
}

/** The identity keys a provider exposes for CLI<->provider matching. */
export function providerKeys(provider) {
  const keys = new Set([provider.provider_id]);
  const vendor = asString(provider["prop:provider:vendor"]);
  if (vendor) {
    keys.add(vendor);
    keys.add(`provider:${vendor}`);
  }
  return keys;
}

/** The primary provider (or the first). */
export function resolveProvider(providers) {
  for (const p of providers) if (p["prop:provider:is_primary"] === true) return p;
  return providers.length ? providers[0] : null;
}

/** The requested CLI by id, else the CLI bound to the provider via provider_ids,
 *  else the first CLI. No hardcoded provider->CLI map (data join only). */
export function resolveCli(provider, clis, requestedCliId) {
  if (requestedCliId) {
    for (const cli of clis) {
      if (cli.subject_id === requestedCliId || cli["prop:cli_registry:cli"] === requestedCliId) return cli;
    }
  }
  if (provider === null) return clis.length ? clis[0] : null;
  const keys = providerKeys(provider);
  for (const cli of clis) {
    const providerIds = cli["prop:cli_registry:provider_ids"];
    if (Array.isArray(providerIds) && providerIds.some((i) => typeof i === "string" && keys.has(i))) return cli;
  }
  return clis.length ? clis[0] : null;
}

function readPath(source, path) {
  let current = source;
  for (const part of path) {
    if (current === null || typeof current !== "object") return null;
    current = current[part];
  }
  return current;
}

/** Whether a conditional launch argument applies in this context. `when` is an
 *  OPEN context-key condition (L090): `new`/`resume` are the two structural
 *  resume-ness states; ANY other value gates on the truthiness of that context
 *  key — a descriptor can declare `when:"temperature"` (or any parameter the
 *  caller sends) with zero code here. */
export function shouldUseArgument(argument, context) {
  const condition = argument.when;
  if (condition === undefined || condition === null) return true;
  if (condition === "new") return !context.resume;
  if (condition === "resume") return Boolean(context.resume);
  return Boolean(context[condition]);
}

/** Render one launch argv item: a literal string, a `{literal}`, or a
 *  `{value:<contextKey>}` (e.g. "model", "prompt"). Returns null to omit. A
 *  `{value:"prompt"}` slot with no prompt in context drops out — so the resolved
 *  argv has NO prompt and the caller appends its own. */
export function renderArgument(argument, context) {
  if (typeof argument === "string") return argument;
  if (!argument || typeof argument !== "object" || !shouldUseArgument(argument, context)) return null;
  const literal = asString(argument.literal);
  if (literal !== null) return literal;
  const valueKey = asString(argument.value);
  const value = valueKey ? context[valueKey] : null;
  if (typeof value === "string" && value) return value;
  return null;
}

/** Render account-sourced env bindings declared by the launch descriptor. */
export function renderEnv(launch, account) {
  const env = {};
  for (const binding of launch.env || []) {
    if (!binding || typeof binding !== "object") continue;
    const name = asString(binding.name);
    const source = binding.source;
    if (name === null || !source || typeof source !== "object" || source.from !== "account") continue;
    const path = source.path;
    if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) continue;
    const value = readPath(account || {}, path);
    if (typeof value === "string" && value) env[name] = value;
  }
  return env;
}

/** Resolve the launch cwd: the literal path, the projectPath token, else ".". */
function resolveCwd(launch, context) {
  const cwd = launch.cwd;
  if (cwd === "projectPath") return asString(context.projectPath) || ".";
  if (typeof cwd === "string" && cwd) return cwd;
  return ".";
}

/** A launch descriptor declares the content kinds it can materialize. Legacy
 * process descriptors are text-only; every non-legacy descriptor carries its
 * declaration in Society data. */
export function declaredContentKinds(launch) {
  const declared = launch?.content_kinds;
  if (!Array.isArray(declared)) return ["text"];
  const kinds = [...new Set(declared.filter((kind) => typeof kind === "string" && kind))];
  if (kinds.length === 0) throw new Error("cli_launch_has_no_content_kinds");
  return kinds;
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return the declared HTTP invocation template without interpreting it. The
 * model-response owner renders template bindings and executes the request. */
function resolveHttpTransport(launch) {
  const targetSlot = asString(launch.target_slot);
  const method = asString(launch.method);
  const url = asString(launch.url);
  if (targetSlot === null || method === null || url === null) {
    throw new Error("http_launch_missing_required_descriptor");
  }
  if (!plainRecord(launch.headers) || !plainRecord(launch.body_template) || !plainRecord(launch.response_extract)) {
    throw new Error("http_launch_malformed_template");
  }
  let credentialInjections;
  if (launch.credential !== undefined) {
    if (!plainRecord(launch.credential) || asString(launch.credential.secret_name) === null || !plainRecord(launch.credential.placement)) {
      throw new Error("http_launch_malformed_credential");
    }
    credentialInjections = [{ credential_key: launch.credential.secret_name, placement: launch.credential.placement }];
  }
  return {
    transport: "http",
    target_slot: targetSlot,
    method,
    url,
    headers: launch.headers,
    body_template: launch.body_template,
    timeout_ms: Number.isSafeInteger(launch.timeout_ms) && launch.timeout_ms > 0 ? launch.timeout_ms : 120000,
    content_kinds: declaredContentKinds(launch),
    response_extract: launch.response_extract,
    ...(plainRecord(launch.response_structure) ? { response_structure: launch.response_structure } : {}),
    // Dropping this silently turned a streamed answer back into one unreadable
    // document: the provider streamed, and the reader still expected one.
    ...(plainRecord(launch.answer_arrives_as_a_run_of_documents) ? { answer_arrives_as_a_run_of_documents: launch.answer_arrives_as_a_run_of_documents } : {}),
    ...(credentialInjections ? { credential_injections: credentialInjections } : {}),
    ...(plainRecord(launch.materialization_policy) ? { materialization_policy: launch.materialization_policy } : {}),
    ...(typeof launch.system_prompt_transport === "string" ? { system_prompt_transport: launch.system_prompt_transport } : {}),
    ...(plainRecord(launch.limits) ? { limits: launch.limits } : {}),
  };
}

/* =============================================================================
 * Transport capabilities. The launch descriptor's `transport` DATA value selects
 * one of these through the capability MAP below (resolveTransport), so this file
 * has NO if/switch on the transport value. Each capability takes the same bundle
 * ({ base, launch, context, account }) and returns the finished launch. Adding a
 * transport is one map entry bound to a leaf capability; the generic dispatcher
 * never changes (enum-dissolution).
 * ========================================================================== */

/** A local or remote process session. Renders argv/cwd/env from launch DATA. */
function processTransport({ base, launch, context, account }) {
  const argvSource = context.resume && Array.isArray(launch.resumeArgv) ? launch.resumeArgv : launch.argv;
  if (!Array.isArray(argvSource)) throw new Error("cli_launch_has_no_argv");
  const argv = argvSource.map((item) => renderArgument(item, context)).filter((a) => a !== null);
  if (argv.length === 0) throw new Error("cli_launch_rendered_empty_argv");
  return {
    ...base,
    argv,
    cwd: resolveCwd(launch, context),
    env: renderEnv(launch, account),
    timeout_ms: Number.isSafeInteger(launch.session_timeout_ms) && launch.session_timeout_ms > 0
      ? launch.session_timeout_ms
      : Number.isSafeInteger(launch.timeout_ms) && launch.timeout_ms > 0
        ? launch.timeout_ms
        : 300000,
    ...(Array.isArray(launch.inputs) ? { inputs: launch.inputs } : {}),
  };
}

/** A declared HTTP request/response template (the model-response owner executes it). */
function httpTransport({ base, launch }) {
  return { ...base, http: resolveHttpTransport(launch) };
}

/** A remote streaming agent endpoint (leaf module resolves the descriptor). */
function remoteHttpStreamCapability({ base, launch }) {
  return { ...base, remote: remoteHttpStreamTransport(launch) };
}

/* The capability MAP (owner wiring). Adding a transport is one entry here bound to
 * a leaf capability; the generic resolveTransport dispatcher never changes. */
const LAUNCH_TRANSPORT_CAPABILITIES = {
  process: processTransport,
  process_session: processTransport,
  http: httpTransport,
  "remote-http-stream": remoteHttpStreamCapability,
};

/**
 * THE canonical resolution. Given provider rows + CLI registry rows (+ optional
 * requested cli/model/account/context), return the rendered launch:
 *   process: { provider_id, cli_id, model_id, transport, argv, cwd, env, ... }
 *   http:    { provider_id, cli_id, model_id, transport, http, ... }
 * Process argv carries NO prompt (the caller appends). HTTP templates remain
 * declared data for the HTTP/model-response owner. Invalid descriptors fail
 * before a caller can dispatch a transport.
 */
export function resolveChatLaunch(input) {
  const providers = Array.isArray(input.providers) ? input.providers : [];
  const clis = Array.isArray(input.clis) ? input.clis : [];
  const provider = resolveProvider(providers);
  const cli = resolveCli(provider, clis, asString(input.requestedCliId));
  if (cli === null) throw new Error("no_cli_in_registry");

  const launch = cli["prop:cli_registry:chat_launch"];
  if (!launch || typeof launch !== "object") throw new Error("cli_has_no_chat_launch_descriptor");

  const modelId = asString(input.model) || firstDefaultModel(cli["prop:cli_registry:models"]);
  const context = {
    resume: Boolean(input.resume),
    model: modelId || undefined,
    prompt: asString(input.prompt) || undefined,
    projectPath: asString(input.projectPath) || undefined,
    sourceSessionId: asString(input.sourceSessionId) || undefined,
  };
  // Open per-invocation parameter bag: each key becomes launch-rendering
  // context a descriptor references via `when:"<key>"`/`{value:"<key>"}`.
  // Structural keys are set FIRST and already-set keys win — that ordering
  // (not an enumerated reserved list) is the shadowing protection.
  if (input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)) {
    for (const [key, value] of Object.entries(input.parameters)) {
      if (!key || key in context) continue;
      context[key] = scalarText(value);
    }
  }

  const providerId = provider ? asString(provider.provider_id) : null;
  const cliId = asString(cli["prop:cli_registry:cli"]) || asString(cli.subject_id) || null;
  const transport = asString(launch.transport) || "process";
  const base = {
    provider_id: providerId,
    cli_id: cliId,
    model_id: modelId || null,
    transport,
    system_prompt_transport: asString(launch.system_prompt_transport),
    content_kinds: declaredContentKinds(launch),
    provenance: { provider_id: providerId, cli_id: cliId, model_id: modelId || null },
  };

  // Dispatch on the self-describing `transport` DATA value through the capability
  // MAP, so there is no if/switch on the transport here. An unknown transport has
  // no registered capability and fails closed inside resolveTransport.
  return resolveTransport(transport, { base, launch, context, account: account(input) }, LAUNCH_TRANSPORT_CAPABILITIES);
}

/** Decode a published-record row without exposing its storage shape to callers. */
function publishedPayload(row) {
  return row && typeof row === "object" && row.payload && typeof row.payload === "object" ? row.payload : row;
}

/**
 * The owner boundary for a runnable HTTP model invocation. It joins live model
 * descriptors with this package's derived available options before returning
 * the finished transport admission. Consumers receive no catalog rows.
 */
export function resolveModelInvocation(input) {
  const modelId = asString(input.model);
  const requestedCliId = asString(input.requestedCliId);
  if (!modelId || !requestedCliId) throw new Error("model_and_adapter_identity_required");
  const descriptors = (Array.isArray(input.modelDescriptorRows) ? input.modelDescriptorRows : []).map(publishedPayload);
  const options = (Array.isArray(input.adapterOptionRows) ? input.adapterOptionRows : []).map(publishedPayload);
  const model = descriptors.find((item) => item?.kind === "ai-model-descriptor" && item.model_id === modelId && item.status === "available");
  if (!model) throw new Error("model_descriptor_unavailable");
  const providerId = asString(model.provider_ref);
  if (!providerId) throw new Error("model_descriptor_missing_provider");
  const bareProviderId = providerId.replace(/^(?:ai_)?provider:/, "");
  const declaredProviders = Array.isArray(input.providers) ? input.providers : [];
  const identifiedProviders = declaredProviders.filter((provider) => {
    const id = asString(provider.provider_id);
    return id !== null && (id === providerId || id.replace(/^(?:ai_)?provider:/, "") === bareProviderId);
  });
  // A vendor is who MAKES the model, not which provider serves it, and several
  // providers can name the same vendor. So a vendor match is a fallback for a
  // reference that names no provider we hold, never a peer of an exact id match:
  // leaving both in the same list lets a sibling provider that merely shares the
  // vendor win on ordering, and the launch then carries a provider the model
  // descriptor never named.
  const matchingProviders = identifiedProviders.length > 0
    ? identifiedProviders
    : declaredProviders.filter((provider) => {
      const keys = providerKeys(provider);
      return keys.has(providerId) || keys.has(bareProviderId) || keys.has(`provider:${bareProviderId}`);
    });
  const resolved = resolveChatLaunch({ ...input, providers: matchingProviders, requestedCliId, model: modelId });
  const cliId = asString(resolved.cli_id);
  const bareCliId = cliId?.replace(/^cli:/, "");
  const bareRequestedCliId = requestedCliId.replace(/^cli:/, "");
  const option = options.find((item) => item?.kind === "ai-model-invocation-option" && item.status === "available" && item.model === modelId && (String(item.agent_ref || "").replace(/^cli:/, "") === bareCliId || item.id === requestedCliId || item.id === bareRequestedCliId));
  if (!option) throw new Error("adapter_invocation_unavailable");
  if (resolved.transport !== "http" || !resolved.http) throw new Error("adapter_transport_unsupported");
  // Compare the SAME normal form this function already uses to find the provider
  // above. One provider is written both `provider:x` and `ai_provider:x` in live
  // DATA, so a raw string comparison here rejects the very provider the lookup
  // three lines earlier accepted, and reports it as a mismatch between two names
  // for one thing.
  const resolvedBareProviderId = asString(resolved.provider_id)?.replace(/^(?:ai_)?provider:/, "");
  if (resolved.provider_id && resolvedBareProviderId !== bareProviderId) {
    // Name both sides. A bare "mismatch" sends the reader looking for a missing
    // row when the real answer is almost always two spellings of one provider.
    throw new Error(
      `adapter_provider_mismatch: launch resolved ${JSON.stringify(resolved.provider_id)} and the model descriptor names ${JSON.stringify(providerId)}`,
    );
  }
  return {
    model_descriptor: model,
    launch: { ...resolved, provider_id: providerId },
    provenance: { model_id: modelId, provider_id: providerId, cli_id: cliId },
  };
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !asString(item))) throw new Error(`${label}_must_be_string_array`);
  return value.map((item) => asString(item));
}

function candidateMatchesCondition(candidate, condition) {
  if (!plainRecord(condition) || !asString(condition.property)) throw new Error("model_routing_policy_condition_invalid");
  const value = candidate[condition.property];
  if (Object.hasOwn(condition, "equals")) return JSON.stringify(value) === JSON.stringify(condition.equals);
  if (Array.isArray(condition.contains_all)) return Array.isArray(value) && condition.contains_all.every((item) => value.includes(item));
  if (Array.isArray(condition.in)) return condition.in.some((item) => JSON.stringify(item) === JSON.stringify(value));
  throw new Error("model_routing_policy_condition_comparison_missing");
}

function compareCandidateValues(left, right, missing) {
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    const missingOrder = missing === "first" ? -1 : 1;
    return leftMissing ? missingOrder : -missingOrder;
  }
  if (typeof left === "number" && typeof right === "number") return left - right;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

/**
 * Resolve every runnable model/adapter candidate for a capability request.
 * Provider names, endpoints, credentials, locality and model ids remain DATA.
 * The returned order is defined by one open routing-policy row, so adding a
 * provider or changing preference requires no executable-code branch.
 */
export function resolveModelInvocations(input) {
  const requestedModel = asString(input.model);
  const requestedAdapter = asString(input.requestedCliId);
  if (requestedModel || requestedAdapter) {
    if (!requestedModel || !requestedAdapter) throw new Error("model_and_adapter_identity_must_be_supplied_together");
    // Preserve the established explicit-selection contract. Only automatic
    // capability selection returns a ranked candidate set.
    return resolveModelInvocation(input);
  }

  const requiredCapabilities = stringArray(input.requiredCapabilities || [], "required_capabilities");
  if (requiredCapabilities.length === 0) throw new Error("required_capabilities_missing");
  const descriptors = (Array.isArray(input.modelDescriptorRows) ? input.modelDescriptorRows : []).map(publishedPayload);
  const options = (Array.isArray(input.adapterOptionRows) ? input.adapterOptionRows : []).map(publishedPayload);
  const policies = (Array.isArray(input.modelRoutingPolicyRows) ? input.modelRoutingPolicyRows : [])
    .map(publishedPayload)
    .filter((item) => item?.kind === "ai-model-routing-policy" && item.status === "active");
  if (policies.length !== 1) throw new Error("model_routing_policy_must_resolve_once");
  const policy = policies[0];
  if (!Array.isArray(policy.order_by) || policy.order_by.length === 0) throw new Error("model_routing_policy_order_missing");

  const candidates = [];
  for (const model of descriptors) {
    if (model?.kind !== "ai-model-descriptor" || model.status !== "available") continue;
    if (!Array.isArray(model.capabilities) || !requiredCapabilities.every((capability) => model.capabilities.includes(capability))) continue;
    for (const option of options) {
      if (option?.kind !== "ai-model-invocation-option" || option.status !== "available" || option.model !== model.model_id) continue;
      const requestedCliId = asString(option.agent_ref) || asString(option.adapter_ref) || asString(option.id);
      if (!requestedCliId) continue;
      const candidate = { ...model, invocation_option: option };
      if (Array.isArray(policy.eligibility) && !policy.eligibility.every((condition) => candidateMatchesCondition(candidate, condition))) continue;
      try {
        candidates.push(resolveModelInvocation({ ...input, model: model.model_id, requestedCliId }));
      } catch {
        // A catalog row without a runnable transport is not an invocation.
      }
    }
  }
  candidates.sort((left, right) => {
    const leftFields = { ...left.model_descriptor, ...left.launch, ...left.provenance };
    const rightFields = { ...right.model_descriptor, ...right.launch, ...right.provenance };
    for (const rule of policy.order_by) {
      if (!plainRecord(rule) || !asString(rule.property) || !["asc", "desc"].includes(rule.direction)
        || ![undefined, "first", "last"].includes(rule.missing)) throw new Error("model_routing_policy_order_invalid");
      const compared = compareCandidateValues(leftFields[rule.property], rightFields[rule.property], rule.missing);
      if (compared !== 0) return rule.direction === "desc" ? -compared : compared;
    }
    return String(left.provenance.model_id).localeCompare(String(right.provenance.model_id));
  });
  if (candidates.length === 0) throw new Error("no_runnable_model_for_capability");
  return { candidates };
}

function account(input) {
  return input && typeof input.account === "object" ? input.account : null;
}

// --- CLI entry: read DATA from files/inline, write the resolved launch -------
// A workflow-action dispatches here via compute.process, passing the provider +
// CLI registry rows it read from the live log; the result's `argv` is then fed
// as `--cli` to the caller's executor.
function readArg(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
// A row flag may be named more than once and the rows accumulate. The caller
// reads each `prop:<subject>:<property>` path separately, because live facts are
// indexed BY path and one query reaches one path. Grouping has to happen after
// every part has arrived, or each part pivots into its own half-built subject and
// a CLI ends up with its identity in one row and its launch in another.
function readArgs(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
}
function rowsFromSpec(spec) {
  if (!spec) return [];
  // accept a file path or inline JSON
  const raw = spec.trim().startsWith("[") ? spec : readFileSync(spec, "utf8");
  return parseRows(raw);
}
function loadRows(specs, kind) {
  const list = Array.isArray(specs) ? specs : [specs];
  const rows = list.flatMap((spec) => rowsFromSpec(spec));
  return groupRows(rows, kind === "provider" ? "provider_id" : "subject_id");
}

function main(argv) {
  const args = argv.slice(2);
  const out = readArg(args, "out");
  const result = resolveModelInvocations({
    providers: loadRows(readArg(args, "providers"), "provider"),
    clis: loadRows(readArgs(args, "clis"), "cli"),
    requestedCliId: readArg(args, "cli"),
    model: readArg(args, "model"),
    modelDescriptorRows: parseRows(readArg(args, "model-descriptor-rows")),
    adapterOptionRows: parseRows(readArg(args, "adapter-option-rows")),
    modelRoutingPolicyRows: parseRows(readArg(args, "model-routing-policy-rows")),
    requiredCapabilities: readArg(args, "required-capabilities") ? JSON.parse(readArg(args, "required-capabilities")) : [],
    resume: readArg(args, "resume") === "true",
    projectPath: readArg(args, "project-path"),
    sourceSessionId: readArg(args, "source-session-id"),
    account: readArg(args, "account") ? JSON.parse(readFileSync(readArg(args, "account"), "utf8")) : null,
  });
  const text = JSON.stringify(result);
  if (out) writeFileSync(out, text, "utf8");
  else process.stdout.write(text + "\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
