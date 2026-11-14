#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/dispatch-harness-session.mjs
//
// =============================================================================
// PURPOSE: close the self-run wire by turning live continuation contracts +
// cli_registry DATA + a materialized harness CAS reference into one guarded assigned-work
// process_session launch. This is the ONE harness-dispatch composition seam:
// reads live owner data, materializes the dynamic source/worker records, and
// delegates the actual process start to process-session.
// =============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⛔ NOT `@bitfield/runtime-kit/protocol`, AND THE REASON IS A REAL WALL RATHER THAN A PREFERENCE.
// That entry point re-exports this exact function, but it ships as raw TypeScript inside
// node_modules, and node refuses to strip types there:
//   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
// So a plain `.mjs` run under `node --test` cannot reach the owner by that path, while a `.ts`
// file under vitest can. Same owner, two reachabilities, and the difference is invisible until a
// suite runs.
//
// This is the shape that makes people write their own hasher. The owner exists, the author
// imports it, the import fails for a reason that has nothing to do with hashing, and reaching for
// `node:crypto` is one line away and works instantly. `@bitfield/slot-protocol` is the built JS
// package that runtime-kit itself delegates to, so this is the same authority with no second
// implementation, reachable from both runtimes.
import { makeHashCodeHexFromBytes } from '@bitfield/slot-protocol';

import { computeAllocation, findModelDescriptor } from './allocate-session.mjs';
import { captureNativeReadback } from './capture-native-readback.mjs';
import { computeContinuation } from './continue-outcome.mjs';
import { groupRows, resolveChatLaunch } from './resolve-chat-launch.mjs';

const AUTHORIZED_DISPATCH_TARGET = 'process-session.start-authorized-assigned-work-session';
const DEFAULT_POLICY_ADDRESS = 'package::ai-cli-launch-adapters::published-record::harness-dispatch-policy::default';
const DEFAULT_TOOL_RECORD_REF = 'package::ai-tool-catalog::tool::start-assigned-work-session';
const DEFAULT_SOURCE_RECORD_PREFIX = 'package::ai-cli-launch-adapters::assigned-work-source::';
const DEFAULT_WORKER_RECORD_PREFIX = 'package::ai-cli-launch-adapters::assigned-worker::';
const DEFAULT_SYSTEM_PROMPT_PATH = '.bitfield-harness/system-prompt.md';
const DEFAULT_PREPEND_LAUNCHER_DIR = '.bitfield-harness';
const DEFAULT_EFFECT_BOUNDARY = 'Advance active outcome-continuation contracts with local reversible tooling only. Do not send external messages, spend money, or publish without separate authority.';

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function payloadOf(value) {
  return value && typeof value === 'object' && value.payload && typeof value.payload === 'object'
    ? value.payload
    : value;
}

function readArg(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export function resolveTarget(env = process.env) {
  const url = nonEmpty(env.BITFIELD_SESSION_EVENT_SHELL_URL) ?? nonEmpty(env.BITFIELD_SHELL_URL) ?? nonEmpty(env.BITFIELD_TARGET_CARRIER_URL)
    ?? (nonEmpty(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS)
      ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS)
        ? env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS
        : `http://${env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS}`)
      : null)
    ?? (nonEmpty(env.PORT) ? `http://127.0.0.1:${nonEmpty(env.PORT)}` : null);
  const partition = nonEmpty(env.BITFIELD_SESSION_EVENT_PARTITION) ?? nonEmpty(env.BITFIELD_PARTITION);
  return url && partition ? { url, partition } : null;
}

// ⛔ `./send-requests-to-running-app.mjs` IS A MOUNT PATH, NOT A FILE IN THIS FOLDER, and reading
// it as a missing file is a trap this exact session fell into and had to back out of.
//
// The bytes come from `send-requests-to-an-engine`, which the retired
// `send-requests-to-running-app` package's own record names as its successor. A process definition
// MOUNTS those bytes beside this source under the old name, so the import resolves inside the
// process and nowhere else. `content-generation` shows the shape: its manifest declares
// `mount_path: ".../send-requests-to-running-app.mjs"` sourced from the successor, and its tests
// build a temp directory and copy the successor's file to that name before running the leaf.
//
// ⚠️ WHAT MADE THIS LOOK LIKE A BUG, AND IT IS A REAL DEFECT, JUST NOT THIS LINE. Repointing this
// at a relative cross-package path made two failing tests go green in one edit, which is exactly
// how a wrong fix advertises itself: the tests resolve from the repository, and the process does
// not. It would have resolved in the suite and broken in the leaf, where nothing would report it.
//
// A DYNAMIC import is what let it stay ambiguous. A static one fails at load, in front of
// everyone; a dynamic one fails only when its branch runs, so an undeclared test never asks and a
// declared one that never takes the branch never answers. The real question is whether THIS
// package declares the mount, and the answer is in the manifest, not here.
function runningAppRequests() {
  return import('./send-requests-to-running-app.mjs');
}

async function findCurrentItems(requests, session, inScope, where, fetchImpl, select) {
  const rows = await requests.findCurrentItems(session, inScope, where, {
    select, fetchImpl, limit: 200,
  });
  return rows.map(payloadOf);
}

async function readCurrentRecord(requests, session, partition, address, fetchImpl) {
  const response = await requests.readCurrentRecord(session, partition, address, { fetchImpl });
  if (response.found !== true) throw new Error(`owner record not found: ${address}`);
  return payloadOf(response.payload);
}

function toolRefFromPolicy(policy) {
  return nonEmpty(policy?.tool_record_ref) ?? DEFAULT_TOOL_RECORD_REF;
}

function sourcePrefixFromPolicy(policy) {
  return nonEmpty(policy?.source_record_prefix) ?? DEFAULT_SOURCE_RECORD_PREFIX;
}

function workerPrefixFromPolicy(policy) {
  return nonEmpty(policy?.worker_record_prefix) ?? DEFAULT_WORKER_RECORD_PREFIX;
}

function sourceSetRefFromPolicy(policy) {
  const ref = nonEmpty(policy?.source_set_ref);
  if (!ref || !ref.startsWith('harness-set:')) {
    throw new Error('harness-dispatch-policy.source_set_ref must be a harness-set:* ref');
  }
  return ref;
}

function maxTotalBytesFromPolicy(policy) {
  const value = policy?.max_total_bytes;
  return Number.isSafeInteger(value) && value > 0 ? value : 1310720;
}

// The harness continuation is intrinsically a long-lived autonomous session, so the
// policy may NAME the process_session CLI to launch (e.g. cli:claude-stream). When it
// does, the dispatch resolves THAT cli directly instead of inheriting whatever provider
// is globally is_primary (a cheap http one-shot primary would make the harness
// undispatchable, which is exactly the UNSUPPORTED_TRANSPORT gate). Null = legacy
// behavior (fall back to the primary provider's cli).
function sessionCliRefFromPolicy(policy) {
  return nonEmpty(policy?.session_cli_ref);
}

// The model ids a cli_registry CLI declares it serves. Used to keep the allocation
// model only when the named session CLI actually serves it: a session CLI uses its own
// aliases (sonnet/opus/haiku), so forcing a cross-provider model id would render an
// invalid argv. Returns null when the CLI or its models list is absent.
function cliModelIds(groupedClis, cliRef) {
  if (!cliRef) return null;
  const cli = groupedClis.find((c) => c?.subject_id === cliRef
    || c?.['prop:cli_registry:cli'] === cliRef
    || c?.subject_id === `cli:${cliRef}`);
  const models = cli?.['prop:cli_registry:models'];
  if (!Array.isArray(models)) return null;
  return models.map((m) => (typeof m?.id === 'string' ? m.id : null)).filter(Boolean);
}

function policyProfile(policy) {
  const snapshot = policy?.instruction_selection_snapshot ?? policy?.instructionSelectionSnapshot;
  if (snapshot) {
    const kind = nonEmpty(snapshot?.kind);
    const sourceClosureSha256 = nonEmpty(snapshot?.source_closure_sha256);
    const selectionHash = nonEmpty(snapshot?.selection_hash);
    if (kind !== 'ai-agent-profile.instruction-role-section-selection/current') {
      throw new Error('instruction_selection_snapshot.kind must name the immutable role-section selection contract');
    }
    if (!sourceClosureSha256?.startsWith('sha256:') || !selectionHash?.startsWith('sha256:')) {
      throw new Error('instruction_selection_snapshot requires source_closure_sha256 and selection_hash');
    }
    return { instruction_selection: snapshot };
  }
  return {
    instruction_selection: {
      kind: 'ai-agent-profile.instruction-selection/v1',
      resolve_mode: 'by-set-live',
      source_set_ref: sourceSetRefFromPolicy(policy),
      max_total_bytes: maxTotalBytesFromPolicy(policy),
    },
  };
}

function processInputIdentity(input) {
  if (!input || typeof input !== 'object') return null;
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  return {
    mount_path: nonEmpty(input.mount_path),
    content_type: nonEmpty(input.content_type) ?? null,
    executable: input.executable === true,
    source_kind: nonEmpty(source.kind),
    source_hash: nonEmpty(source.hash) ?? null,
  };
}

// ⛔ THIS MINTED A RIVAL INTERNAL IDENTITY, and the field name told on it. `objective_sha256`
// named the algorithm in the KEY, which is the second source of truth for a fact the value should
// declare about itself. The moment the algorithm rotates, either the name goes false or every
// reader of the name has to be found and edited, and the name going false is what actually happens.
//
// Both digests here are minted by this system, read by this system, and defined by nobody outside
// it: `capture-native-readback.mjs` and the semantic probe suite are the only
// consumers. That is what makes it convertible. An OCI digest or a PKCE challenge in the same
// shape would not be, because there the algorithm is somebody else's contract.
//
// The value now carries its own multihash code, so nothing downstream has to be told which
// algorithm produced it, and the name no longer claims to know.
const encoder = new TextEncoder();

function contentIdentityOfText(value) {
  return makeHashCodeHexFromBytes(encoder.encode(String(value ?? '')));
}

function finalInputIdentityDigest({ profile, promptContentHash, objective, processLaunch, launchProvenance }) {
  const identity = {
    instruction_selection: profile.instruction_selection,
    prompt_content_hash: promptContentHash ?? null,
    objective_content_hash: contentIdentityOfText(objective),
    mounted_inputs: (processLaunch.inputs ?? []).map(processInputIdentity),
    selected_provider: launchProvenance.selected_provider,
    selected_model: launchProvenance.selected_model,
    selected_vendor: launchProvenance.selected_vendor,
    cli_id: launchProvenance.cli_id,
    system_prompt_transport: launchProvenance.system_prompt_transport,
  };
  return contentIdentityOfText(JSON.stringify(identity));
}

function findChatLaunchRecord(groupedClis, cliId) {
  return groupedClis.find((cli) => {
    const descriptorId = typeof cli?.['prop:cli_registry:cli'] === 'string' ? cli['prop:cli_registry:cli'] : null;
    return descriptorId === cliId || cli?.subject_id === cliId || cli?.subject_id === `cli:${cliId}`;
  })?.['prop:cli_registry:chat_launch'] ?? null;
}

function renderPolicyEnv(env) {
  return Object.entries(env || {}).map(([name, value]) => ({
    kind: 'literal',
    name,
    value: String(value),
    inert: true,
  }));
}

export function buildContinuationObjective({ decision, sessionRef, wakeSource }) {
  const lines = [
    'Advance the active outcome-continuation contracts.',
    '',
    `Wake source: ${nonEmpty(decision?.wake_source) ?? wakeSource ?? 'unknown'}`,
    `Session reference: ${nonEmpty(sessionRef) ?? 'loop'}`,
    '',
    'Open contracts:',
  ];
  for (const [index, contract] of (decision?.open_contracts ?? []).entries()) {
    lines.push(`${index + 1}. id: ${nonEmpty(contract?.id) ?? '(missing id)'}`);
    lines.push(`   outcome: ${nonEmpty(contract?.outcome) ?? '(missing outcome)'}`);
    lines.push(`   status: ${nonEmpty(contract?.status) ?? '(missing status)'}`);
    if (nonEmpty(contract?.next_action)) lines.push(`   next action: ${contract.next_action}`);
  }
  lines.push('');
  lines.push('Requirements:');
  lines.push('- Advance only the contracts listed above.');
  lines.push('- Respect every declared next action and authority boundary.');
  lines.push('- If no safe action remains, write proof and stop.');
  return lines.join('\n');
}

function dispatchKeyFrom({ sessionRef, wakeSource, openContracts, cliId, modelId }) {
  const keySource = JSON.stringify({
    session_ref: sessionRef ?? 'loop',
    wake_source: wakeSource ?? 'unknown',
    cli_id: cliId ?? null,
    model_id: modelId ?? null,
    contracts: (openContracts ?? []).map((contract) => ({
      id: contract?.id ?? null,
      status: contract?.status ?? null,
      next_action: contract?.next_action ?? null,
    })),
  });
  // A SHORT DEDUP KEY, NOT A CONTENT IDENTITY, and the truncation is what says so: 16 hex
  // characters cannot be a multihash and must never be handed to anything that reads one. It is
  // deliberately kept bare rather than given a `1f:` prefix, because a prefix on a truncated
  // digest would be a label promising a digest the value no longer contains, which is the same
  // forgery this migration exists to end, wearing a helpful costume.
  //
  // It still derives from the owner, so the system runs ONE algorithm rather than one for
  // identities and a second for keys. The owner emits `code:hex`; the hex half is taken here.
  return makeHashCodeHexFromBytes(encoder.encode(keySource)).split(':')[1].slice(0, 16);
}

function safeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Full-request fit admission from ai-model-descriptor.full_prompt_fit DATA.
 *
 * This is deliberately NOT a tokenizer. Until a provider-exact counter owner is
 * admitted, every model must publish a conservative bytes-per-token upper bound
 * plus fixed input/output reservations. The materializer supplies exact selected
 * prompt bytes; this function adds the objective, fixed model input (tool schemas,
 * skill metadata, and bootstrap/delegation material), and reserved output/context.
 * Missing DATA is unproven and must reject before authorization.
 */
function measureFullPromptFit({ modelDescriptors, modelId, promptContentBytes, objective }) {
  const descriptor = findModelDescriptor(modelDescriptors, modelId);
  const contextWindowTokens = safeNonNegativeInteger(descriptor?.context_window_tokens);
  const fit = descriptor?.full_prompt_fit;
  const bytesPerTokenUpperBound = positiveNumber(fit?.bytes_per_token_upper_bound);
  const fixedInputTokens = safeNonNegativeInteger(fit?.fixed_input_tokens);
  const reservedOutputTokens = safeNonNegativeInteger(fit?.reserved_output_tokens);
  const selectedPromptBytes = safeNonNegativeInteger(promptContentBytes);
  const objectiveBytes = Buffer.byteLength(String(objective ?? ''), 'utf8');
  const requiredComponents = [
    'system_prompt_and_selected_instructions',
    'bootstrap_or_delegation_objective',
    'tool_schemas_skills_and_fixed_input',
    'reserved_output_and_context',
  ];
  const accountedComponents = Array.isArray(fit?.component_accounting)
    ? fit.component_accounting.filter((component) => typeof component === 'string')
    : [];
  const missing = [];
  if (!descriptor) missing.push('model_descriptor');
  if (!(contextWindowTokens > 0)) missing.push('context_window_tokens');
  if (!bytesPerTokenUpperBound) missing.push('full_prompt_fit.bytes_per_token_upper_bound');
  if (fixedInputTokens == null) missing.push('full_prompt_fit.fixed_input_tokens');
  if (reservedOutputTokens == null) missing.push('full_prompt_fit.reserved_output_tokens');
  if (selectedPromptBytes == null) missing.push('materialized_prompt_content_bytes');
  for (const component of requiredComponents) {
    if (!accountedComponents.includes(component)) missing.push(`full_prompt_fit.component_accounting:${component}`);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'CONTEXT_FIT_UNPROVEN',
      reason: `missing fit DATA: ${missing.join(', ')}`,
      missing,
      model_descriptor_id: descriptor?.id ?? null,
    };
  }

  const dynamicPromptTokens = Math.ceil(selectedPromptBytes / bytesPerTokenUpperBound)
    + Math.ceil(objectiveBytes / bytesPerTokenUpperBound);
  const requiredContextTokens = dynamicPromptTokens + fixedInputTokens + reservedOutputTokens;
  const result = {
    ok: true,
    context_fit: requiredContextTokens <= contextWindowTokens ? 'proven' : 'unfit',
    method: nonEmpty(fit.method) ?? 'conservative-byte-bound',
    model_descriptor_id: descriptor.id,
    prompt_content_bytes: selectedPromptBytes,
    objective_bytes: objectiveBytes,
    dynamic_prompt_tokens: dynamicPromptTokens,
    fixed_input_tokens: fixedInputTokens,
    reserved_output_tokens: reservedOutputTokens,
    required_context_tokens: requiredContextTokens,
    context_window_tokens: contextWindowTokens,
    bytes_per_token_upper_bound: bytesPerTokenUpperBound,
    component_accounting: accountedComponents,
  };
  if (result.context_fit === 'unfit') {
    return {
      ...result,
      ok: false,
      status: 'CONTEXT_OVERFLOW',
      reason: `required=${requiredContextTokens} tokens exceeds context_window=${contextWindowTokens} tokens`,
    };
  }
  return result;
}

export async function buildHarnessDispatchPlan({
  continuationDecision,
  providerFacts,
  cliFacts,
  policy,
  promptContentHash,
  promptContentBytes,
  prependLauncherContentHash,
  sessionRef,
  wakeSource,
  modelDescriptors = [],
}) {
  const decision = continuationDecision ?? { open_contracts: [], open_contract_count: 0, wake_source: wakeSource };
  const openCount = Number.isSafeInteger(decision.open_contract_count)
    ? decision.open_contract_count
    : Array.isArray(decision.open_contracts) ? decision.open_contracts.length : 0;
  const childRecovery = openCount <= 0 && decision.selected_child_recovery_action?.kind === 'resume-parent-assignment'
    ? decision.selected_child_recovery_action : null;
  if (openCount <= 0 && !childRecovery) {
    const paused = decision.decision === 'PAUSED_OPEN_CONTRACTS';
    return {
      kind: 'harness-dispatch-receipt',
      should_dispatch: false,
      status: paused ? 'PAUSED_OPEN_CONTRACTS' : 'NO_OPEN_CONTRACTS',
      reason: paused ? 'all-open-contracts-paused' : 'no-open-contracts',
      session_ref: sessionRef ?? null,
      wake_source: wakeSource ?? null,
      open_contract_count: openCount,
    };
  }

  const allocation = computeAllocation({
    providerFacts,
    runtimeDescriptors: [],
    sessionRef: sessionRef ?? 'loop',
    ts: new Date(0).toISOString(),
    modelDescriptors,
    requiredContextTokens: null,
  });
  const groupedProviders = groupRows(providerFacts, 'provider_id');
  const groupedClis = groupRows(cliFacts, 'subject_id');
  const sessionCliRef = sessionCliRefFromPolicy(policy);
  const allocatedModel = nonEmpty(allocation.selected_model) ?? undefined;
  const sessionCliModelIds = cliModelIds(groupedClis, sessionCliRef);
  // Only carry the allocation model into a NAMED session CLI when that CLI actually
  // serves it; otherwise let resolveChatLaunch pick the CLI's default (avoids a
  // cross-provider model id rendering an invalid argv). Legacy path (no session_cli_ref)
  // keeps the allocation model unchanged.
  const launchModel = sessionCliRef
    ? (allocatedModel && Array.isArray(sessionCliModelIds) && sessionCliModelIds.includes(allocatedModel)
      ? allocatedModel
      : undefined)
    : allocatedModel;
  const initialLaunch = resolveChatLaunch({
    providers: groupedProviders,
    clis: groupedClis,
    requestedCliId: sessionCliRef ?? undefined,
    model: launchModel,
  });
  if (initialLaunch.transport !== 'process_session') {
    return {
      should_dispatch: false,
      status: 'UNSUPPORTED_TRANSPORT',
      reason: `resolved transport is ${initialLaunch.transport}`,
      session_ref: sessionRef ?? null,
      wake_source: wakeSource ?? null,
    };
  }

  if (childRecovery) {
    const threadId = nonEmpty(childRecovery.current_parent_thread_id);
    const assignmentRef = nonEmpty(childRecovery.parent_assignment_ref);
    const eventRef = nonEmpty(childRecovery.source_event_ref);
    const recoveryRef = nonEmpty(childRecovery.recovery_ref);
    const childThreadId = nonEmpty(childRecovery.child_thread_id);
    const rootTurnId = nonEmpty(childRecovery.root_turn_id);
    const modelId = nonEmpty(initialLaunch.model_id);
    if (!threadId || !assignmentRef || !eventRef || !recoveryRef || !childThreadId
      || !rootTurnId || !modelId || path.posix.basename(initialLaunch.argv?.[0] ?? '') !== 'codex') {
      return { should_dispatch: false, status: 'CHILD_RECOVERY_UNPROVEN',
        reason: 'current parent, assignment, child turn, or Codex launch is not proven',
        session_ref: sessionRef ?? null, wake_source: wakeSource ?? null };
    }
    const prompt = `Resume the current parent assignment ${assignmentRef}. Child task ${childThreadId} aborted at ${eventRef} in root turn ${rootTurnId}. First check the current assignment and whether another result superseded this child. If unfinished, complete that exact work here, verify its outcome, and record the result. Do not start a parallel parent task.`;
    const sourceRecordRef = `${sourcePrefixFromPolicy(policy)}child-recovery::${recoveryRef}`;
    const workerRecordRef = `${workerPrefixFromPolicy(policy)}child-recovery::${recoveryRef}`;
    const processLaunch = {
      argv: [initialLaunch.argv[0], 'exec', 'resume', '-m', modelId, threadId, prompt],
      cwd: { kind: 'literal', value: initialLaunch.cwd || '.', inert: true },
      env: renderPolicyEnv(initialLaunch.env),
      inputs: [],
      timeoutMs: initialLaunch.timeout_ms,
      model_binding: { argv_index: 4, executable: 'codex' },
    };
    return {
      kind: 'harness-dispatch-plan',
      schema: 'ai-cli-launch-adapters.harness-dispatch-plan/v1',
      should_dispatch: true,
      status: 'READY_TO_DISPATCH',
      dispatch_key: recoveryRef,
      session_ref: sessionRef ?? null,
      wake_source: wakeSource ?? null,
      open_contract_count: openCount,
      source_record_ref: sourceRecordRef,
      worker_record_ref: workerRecordRef,
      tool_record_ref: toolRefFromPolicy(policy),
      partition_label: nonEmpty(policy?.partition_label) ?? 'runtime-partition',
      source_record: {
        kind: 'assigned-work-source', owner: 'ai-cli-launch-adapters',
        title: `Resume parent assignment ${assignmentRef}`, objective: prompt,
        acceptance_criteria: ['The exact parent assignment is completed or verified superseded.'],
        attachments: [], proof_links: [], context_descriptor_refs: [], proof_sink_refs: [],
        assignedTo: [workerRecordRef], estimated_cost: 0,
        effect_boundary: nonEmpty(policy?.effect_boundary) ?? DEFAULT_EFFECT_BOUNDARY,
        state: 'ready', parent_assignment_ref: assignmentRef, source_event_ref: eventRef,
      },
      worker_record: {
        kind: 'ai-agent-profile', id: workerRecordRef, label: 'Parent assignment recovery',
        status: 'available', model_refs: [`ai-model-descriptor:${modelId}`],
        tool_refs: ['tool:start-assigned-work-session'],
        instruction_selection: policyProfile(policy).instruction_selection,
        process_launch: processLaunch,
      },
      launch_provenance: { cli_id: initialLaunch.cli_id, selected_model: modelId,
        parent_thread_id: threadId, source_event_ref: eventRef },
    };
  }

  const launchDescriptor = findChatLaunchRecord(groupedClis, initialLaunch.cli_id);
  if (!launchDescriptor || typeof launchDescriptor !== 'object') {
    throw new Error(`cli_registry chat_launch not found for ${initialLaunch.cli_id}`);
  }

  const objective = buildContinuationObjective({ decision, sessionRef, wakeSource });
  const transport = initialLaunch.system_prompt_transport;
  let finalObjective = objective;
  let extraInputs = [];
  let launchParameters = undefined;
  let prependPromptPath = null;

  if (!promptContentHash) {
    throw new Error('engine-native harness prompt content hash is required');
  }
  {
    // ENGINE-NATIVE (#111): the ai-instruction-blocks.materialize-harness-prompt op
    // already assembled + guarded the harness prompt and stored the RAW markdown to
    // CAS via payload_text; promptContentHash is that record's BLAKE3 content_hash.
    // Mount it BY HASH so this plan JSON carries only the ~46-char hash, never the
    // assembled bytes, so it never trips the 64KB compute-capture tail. There is NO
    // assembly here (the op owns it, NO-GOD-PACKAGE); the leaf just references CAS.
    if (transport === 'system-prompt-file-flag') {
      const systemPromptPath = nonEmpty(policy?.system_prompt_path) ?? DEFAULT_SYSTEM_PROMPT_PATH;
      launchParameters = { system_prompt_path: systemPromptPath };
      extraInputs = [
        {
          mount_path: systemPromptPath,
          content_type: 'text/markdown',
          source: { kind: 'blob_ref', hash: promptContentHash },
        },
      ];
    } else if (transport === 'prepend-to-prompt') {
      if (!nonEmpty(prependLauncherContentHash)) {
        throw new Error('prepend-to-prompt transport requires the stored prepend launcher content hash');
      }
      prependPromptPath = nonEmpty(policy?.system_prompt_path) ?? DEFAULT_SYSTEM_PROMPT_PATH;
      extraInputs = [
        {
          mount_path: prependPromptPath,
          content_type: 'text/markdown',
          source: { kind: 'blob_ref', hash: promptContentHash },
        },
      ];
    }
  }

  const finalLaunch = resolveChatLaunch({
    providers: groupedProviders,
    clis: groupedClis,
    requestedCliId: sessionCliRef ?? undefined,
    model: launchModel,
    prompt: finalObjective,
    parameters: launchParameters,
  });
  const modelId = nonEmpty(finalLaunch.model_id);
  if (!modelId) throw new Error('resolved process_session launch declares no model');
  const contextFit = measureFullPromptFit({
    modelDescriptors,
    modelId,
    promptContentBytes,
    objective: finalObjective,
  });
  if (!contextFit.ok) {
    return {
      kind: 'harness-dispatch-receipt',
      should_dispatch: false,
      status: contextFit.status,
      reason: contextFit.reason,
      session_ref: sessionRef ?? null,
      wake_source: wakeSource ?? null,
      open_contract_count: openCount,
      context_fit: contextFit.context_fit ?? 'unproven',
      context_fit_measurement: contextFit,
    };
  }

  let processArgv = [...finalLaunch.argv];
  if (prependPromptPath) {
    const promptIndexes = [];
    for (let index = 0; index < finalLaunch.argv.length; index += 1) {
      if (finalLaunch.argv[index] === objective) promptIndexes.push(index);
    }
    if (promptIndexes.length !== 1) {
      throw new Error(`prepend-to-prompt launch must contain the objective exactly once; found ${promptIndexes.length}`);
    }
    const executableName = path.posix.basename(finalLaunch.argv[0]);
    const launcherPath = `${DEFAULT_PREPEND_LAUNCHER_DIR}/${executableName}`;
    extraInputs.push({
      mount_path: launcherPath,
      content_type: 'text/javascript',
      executable: true,
      source: { kind: 'blob_ref', hash: prependLauncherContentHash },
    });
    processArgv = [
      launcherPath,
      '--prompt-file',
      prependPromptPath,
      '--prompt-arg-index',
      String(promptIndexes[0]),
      '--',
      ...finalLaunch.argv,
    ];
  }

  const dispatchKey = dispatchKeyFrom({
    sessionRef,
    wakeSource,
    openContracts: decision.open_contracts,
    cliId: finalLaunch.cli_id,
    modelId,
  });
  const sourceRecordRef = `${sourcePrefixFromPolicy(policy)}${dispatchKey}`;
  const workerRecordRef = `${workerPrefixFromPolicy(policy)}${dispatchKey}`;
  // The session owner proves the launched model against the profile's declared
  // model by reading the argv slot named here. It must be the index in the FINAL
  // argv, after any prepend-launcher wrapping shifted every entry.
  const modelArgvIndexes = [];
  if (modelId) {
    for (let index = 0; index < processArgv.length; index += 1) {
      if (processArgv[index] === modelId) modelArgvIndexes.push(index);
    }
    if (modelArgvIndexes.length !== 1) {
      throw new Error(`launch argv must carry the selected model exactly once so the session owner can prove it; found ${modelArgvIndexes.length} for ${modelId}`);
    }
  }
  const processLaunch = {
    argv: processArgv,
    cwd: { kind: 'literal', value: finalLaunch.cwd || '.', inert: true },
    env: renderPolicyEnv(finalLaunch.env),
    inputs: [...extraInputs, ...(Array.isArray(finalLaunch.inputs) ? finalLaunch.inputs : [])],
    timeoutMs: finalLaunch.timeout_ms,
    ...(modelArgvIndexes.length === 1
      ? {
        model_binding: {
          argv_index: modelArgvIndexes[0],
          executable: path.posix.basename(processArgv[0]),
        },
      }
      : {}),
  };
  const workerProfile = policyProfile(policy);
  const launchProvenance = {
    selected_provider: allocation.selected_provider,
    selected_model: modelId,
    selected_vendor: allocation.selected_vendor,
    cli_id: finalLaunch.cli_id,
    system_prompt_transport: finalLaunch.system_prompt_transport,
    process_launch: processLaunch,
    // #106 observability (L164): make the context-fit decision self-explaining so a
    // live overflow is never a silent "Prompt is too long".
    context_fit: contextFit.context_fit,
    required_context_tokens: contextFit.required_context_tokens,
    selected_model_context_window_tokens: contextFit.context_window_tokens,
    context_fit_measurement: contextFit,
    instruction_selection: workerProfile.instruction_selection,
    mounted_input_identities: processLaunch.inputs.map(processInputIdentity),
    final_input_identity_digest: finalInputIdentityDigest({
      profile: workerProfile,
      promptContentHash,
      objective: finalObjective,
      processLaunch,
      launchProvenance: {
        selected_provider: allocation.selected_provider,
        selected_model: modelId,
        selected_vendor: allocation.selected_vendor,
        cli_id: finalLaunch.cli_id,
        system_prompt_transport: finalLaunch.system_prompt_transport,
      },
    }),
  };

  return {
    kind: 'harness-dispatch-plan',
    schema: 'ai-cli-launch-adapters.harness-dispatch-plan/v1',
    should_dispatch: true,
    status: 'READY_TO_DISPATCH',
    session_ref: sessionRef ?? null,
    wake_source: wakeSource ?? null,
    dispatch_key: dispatchKey,
    open_contract_count: openCount,
    decision,
    source_record_ref: sourceRecordRef,
    worker_record_ref: workerRecordRef,
    tool_record_ref: toolRefFromPolicy(policy),
    partition_label: nonEmpty(policy?.partition_label) ?? 'runtime-partition',
    source_record: {
      kind: 'assigned-work-source',
      owner: 'ai-cli-launch-adapters',
      title: `Harness continuation ${dispatchKey}`,
      objective: finalObjective,
      acceptance_criteria: ['Advance the listed contracts or prove no safe action remains.'],
      attachments: [],
      proof_links: [],
      context_descriptor_refs: [],
      proof_sink_refs: [],
      assignedTo: [workerRecordRef],
      estimated_cost: 0,
      effect_boundary: nonEmpty(policy?.effect_boundary) ?? DEFAULT_EFFECT_BOUNDARY,
      state: 'ready',
      wake_source: wakeSource ?? null,
      session_ref: sessionRef ?? null,
    },
    worker_record: {
      kind: 'ai-agent-profile',
      id: workerRecordRef,
      label: nonEmpty(policy?.worker_label) ?? 'Harness continuation worker',
      description: `Dynamic harness continuation launch via ${finalLaunch.cli_id}.`,
      status: 'available',
      model_refs: [`ai-model-descriptor:${modelId}`],
      tool_refs: ['tool:start-assigned-work-session'],
      instruction_selection: workerProfile.instruction_selection,
      process_launch: processLaunch,
    },
    launch_provenance: launchProvenance,
  };
}

export async function dispatchHarnessSession(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message) => console.error(message));
  const sessionRef = nonEmpty(options.sessionRef) ?? nonEmpty(env.BITFIELD_SESSION_ID) ?? 'loop';
  const wakeSource = nonEmpty(options.wakeSource) ?? nonEmpty(env.BITFIELD_CONTINUE_WAKE_SOURCE) ?? 'clock-tick';
  const target = options.target ?? resolveTarget(env);
  if (!target?.url) {
    return { ok: false, reason: 'no-target', receipt: { kind: 'harness-dispatch-receipt', status: 'NO_TARGET', session_ref: sessionRef, wake_source: wakeSource } };
  }

  try {
    const requests = options.runningAppRequests ?? await runningAppRequests();
    const session = await requests.startRunningAppSession({ url: target.url, fetchImpl });
    const policy = options.policy ?? await readCurrentRecord(
      requests,
      session,
      target.partition,
      nonEmpty(options.policyAddress) ?? DEFAULT_POLICY_ADDRESS,
      fetchImpl,
    );
    if (policy?.status && policy.status !== 'active') {
      throw new Error(`harness dispatch policy is not active: ${policy.status}`);
    }

    const contracts = options.contracts ?? await findCurrentItems(
      requests,
      session,
      'published-record',
      { all: [{ field: 'kind', eq: 'outcome-continuation-contract' }] },
      fetchImpl,
    );
    const events = options.events ?? await findCurrentItems(
      requests,
      session,
      'session-event',
      { all: [{ field: 'kind', eq: 'session-event' }] },
      fetchImpl,
    );
    const pauseReceipts = options.pauseReceipts ?? await findCurrentItems(
      requests,
      session,
      'published-record',
      { all: [{ field: 'kind', eq: 'harness-stop-pause' }] },
      fetchImpl,
    );
    const childTurnStates = options.childTurnStates ?? await findCurrentItems(requests, session,
      'published-record', { all: [{ field: 'kind', eq: 'codex-child-turn-state' }] }, fetchImpl);
    const recoveryClaims = options.recoveryClaims ?? await findCurrentItems(requests, session,
      'published-record', { all: [{
        field: 'kind', in: ['codex-child-recovery-claim', 'harness-dispatch-receipt'],
      }] }, fetchImpl);
    const assignmentOutcomes = options.assignmentOutcomes ?? await findCurrentItems(requests, session,
      'published-record', { all: [{ field: 'kind', eq: 'codex-child-assignment-outcome' }] }, fetchImpl);
    const parentBindings = options.parentBindings ?? await findCurrentItems(requests, session,
      'published-record', { all: [{ field: 'kind', eq: 'codex-current-parent-binding' }] }, fetchImpl);
    const continuationDecision = options.continuationDecision ?? computeContinuation({
      contracts,
      pauseReceipts,
      recentSessionEvents: events,
      childTurnStates, recoveryClaims, assignmentOutcomes, parentBindings,
      wakeSource,
      ts: new Date().toISOString(),
    });

    const providerFacts = options.providerFacts ?? (await findCurrentItems(
      requests,
      session,
      'attribute_fact',
      {
        all: [{
          field: 'property_id',
          in: [
            'prop:provider:vendor',
            'prop:provider:model',
            'prop:provider:is_primary',
          ],
        }],
      },
      fetchImpl,
      ['subject_id', 'property_id', 'value_json'],
    )).filter((row) => typeof row?.subject_id === 'string' && row.subject_id.startsWith('provider:'));

    const cliFacts = options.cliFacts ?? await findCurrentItems(
      requests,
      session,
      'attribute_fact',
      {
        all: [{
          field: 'property_id',
          in: [
            'prop:cli_registry:cli',
            'prop:cli_registry:models',
            'prop:cli_registry:provider_ids',
            'prop:cli_registry:chat_launch',
          ],
        }],
      },
      fetchImpl,
      ['subject_id', 'property_id', 'value_json'],
    );

    // #106: read the ai-model-descriptor rows so the allocation can select a model
    // whose context_window_tokens fits the mounted harness (never overflow at runtime).
    const modelDescriptors = options.modelDescriptors ?? await findCurrentItems(
      requests,
      session,
      'published-record',
      { all: [{ field: 'kind', eq: 'ai-model-descriptor' }] },
      fetchImpl,
    );

    const plan = await buildHarnessDispatchPlan({
      continuationDecision,
      providerFacts,
      cliFacts,
      policy,
      promptContentHash: options.promptContentHash,
      promptContentBytes: options.promptContentBytes,
      prependLauncherContentHash: options.prependLauncherContentHash,
      sessionRef,
      wakeSource,
      modelDescriptors,
    });

    if (plan.should_dispatch !== true) {
      const receipt = {
        kind: 'harness-dispatch-receipt',
        schema: 'ai-cli-launch-adapters.harness-dispatch-receipt/v1',
        status: plan.status,
        reason: plan.reason ?? null,
        session_ref: sessionRef,
        wake_source: wakeSource,
        open_contract_count: plan.open_contract_count ?? 0,
      };
      if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));
      // Async process_session drops stdout, so a no-op (NO_OPEN_CONTRACTS) would be
      // invisible. Persist the no-op receipt to the log so the self-fire loop is
      // observable and every degraded state is legible (L164).
      if (!nonEmpty(env.BITFIELD_HARNESS_CAPTURE_MODE)) {
        await requests.writeRecords(session, [{
          partition_label: target.partition,
          address_label: `package::ai-cli-launch-adapters::harness-dispatch-receipt::${sessionRef}::${wakeSource}`,
          address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          payload: receipt,
        }], { fetchImpl });
      }
      return { ok: true, captured: true, receipt };
    }

    let nativeReadbackReceipt = null;
    if (options.nativeReadbackRequest) {
      nativeReadbackReceipt = await captureNativeReadback({
        request: options.nativeReadbackRequest,
        plan,
        captureRuntime: options.nativeReadbackCaptureRuntime,
        emitEvent: options.nativeReadbackEvent ?? options.emitEvent,
        env,
        fetchImpl,
        eventTarget: options.nativeReadbackEventTarget,
        eventIo: options.nativeReadbackEventIo,
        sessionId: sessionRef,
        contractRef: options.nativeReadbackContractRef,
        log: options.log,
      });
      if (nativeReadbackReceipt.activation_allowed !== true) {
        const receipt = {
          kind: 'harness-dispatch-receipt',
          status: 'READBACK_UNAVAILABLE',
          reason: nativeReadbackReceipt.reason ?? 'native model-visible readback failed closed',
          session_ref: sessionRef,
          wake_source: wakeSource,
          open_contract_count: plan.open_contract_count ?? 0,
          dispatch_key: plan.dispatch_key ?? null,
          native_readback: nativeReadbackReceipt,
          launch_denied: true,
        };
        if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));
        return { ok: false, captured: true, launch_denied: true, receipt };
      }
    }

    // #106 / L164 self-explaining degraded state: when the allocated model may not fit
    // the mounted harness, warn legibly (cause + evidence + fix) so a live overflow is
    // never a silent "Prompt is too long". 'proven' is the normal path (no warning).
    const fit = plan.launch_provenance?.context_fit;
    if (fit === 'unfit' || fit === 'unproven') {
      const win = plan.launch_provenance?.selected_model_context_window_tokens;
      const req = plan.launch_provenance?.required_context_tokens;
      log(fit === 'unfit'
        ? `[harness-dispatch] WARNING context_fit=unfit: model ${plan.launch_provenance?.selected_model} window=${win} < required=${req} tokens; the mounted harness may overflow. Fix: publish a larger context_window_tokens model in the model-descriptor records.`
        : `[harness-dispatch] WARNING context_fit=unproven: no ai-model-descriptor declares context_window_tokens (required=${req}); cannot prove ${plan.launch_provenance?.selected_model} fits the mounted harness. Fix: populate context_window_tokens on the ai-model-descriptor rows.`);
    }

    await requests.writeRecords(session, [
      {
        partition_label: target.partition,
        address_label: plan.source_record_ref,
        address_mode: 'identity_text',
        path_labels: ['current-item', 'published-record'],
        payload: plan.source_record,
      },
      {
        partition_label: target.partition,
        address_label: plan.worker_record_ref,
        address_mode: 'identity_text',
        path_labels: ['current-item', 'published-record'],
        payload: plan.worker_record,
      },
    ], { fetchImpl });

    const launchReply = await requests.sendRequestToRunningApp(session, AUTHORIZED_DISPATCH_TARGET, {
      sourceRecordRef: plan.source_record_ref,
      workerRecordRef: plan.worker_record_ref,
      toolRecordRef: plan.tool_record_ref,
      partitionLabel: target.partition,
    }, { fetchImpl });

    const receipt = {
      kind: 'harness-dispatch-receipt',
      schema: 'ai-cli-launch-adapters.harness-dispatch-receipt/v1',
      status: 'AUTHORIZED_WORK_SESSION_STARTED',
      session_ref: sessionRef,
      wake_source: wakeSource,
      dispatch_key: plan.dispatch_key,
      open_contract_count: plan.open_contract_count,
      source_record_ref: plan.source_record_ref,
      worker_record_ref: plan.worker_record_ref,
      tool_record_ref: plan.tool_record_ref,
      session_id: launchReply.sessionId ?? null,
      authorization_provenance: launchReply.authorizationProvenance ?? null,
      runtime_provenance: launchReply.runtimeProvenance ?? null,
      launch_provenance: plan.launch_provenance,
      native_readback: nativeReadbackReceipt,
    };
    if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));

    if (!nonEmpty(env.BITFIELD_HARNESS_CAPTURE_MODE)) {
      const receiptAddress = `package::ai-cli-launch-adapters::harness-dispatch-receipt::${plan.dispatch_key}`;
      await requests.writeRecords(session, [{
        partition_label: target.partition,
        address_label: receiptAddress,
        address_mode: 'identity_text',
        path_labels: ['current-item', 'published-record'],
        payload: receipt,
      }], { fetchImpl });
      log(`[harness-dispatch] ${wakeSource} launched ${launchReply.sessionId ?? '(missing session id)'} via ${plan.launch_provenance.cli_id}`);
    }
    return { ok: true, captured: true, receipt };
  } catch (error) {
    const receipt = {
      kind: 'harness-dispatch-receipt',
      schema: 'ai-cli-launch-adapters.harness-dispatch-receipt/v1',
      status: 'DISPATCH_ERROR',
      session_ref: sessionRef,
      wake_source: wakeSource,
      error: error?.message ?? String(error),
    };
    if (options.emitStdout !== false) process.stdout.write(JSON.stringify(receipt));
    log(`[harness-dispatch] failed (launch continues): ${receipt.error}`);
    return { ok: false, error: receipt.error, receipt };
  }
}

/**
 * Pure plan builder over MOUNTED input files (no engine I/O, no fetch).
 *
 * This is the sandboxed-`compute.process` side of the engine-native
 * redecomposition. Every live read is done by a preceding
 * engine-native workflow `ask` step and MOUNTED as a file; this function only
 * reads those files and runs the already-pure `buildHarnessDispatchPlan`,
 * emitting the plan for the workflow's `persist` + `dispatch` steps to consume.
 * It NEVER calls back into the shell (see the knowledge leaf
 * `engine-spawned-process-cannot-reach-host-shell.md`).
 *
 * @param {{args: string[], readFile?: (p: string, enc: string) => string, now?: string}} params
 * @returns {Promise<object>} the dispatch plan (should_dispatch / status / records / refs)
 */
export async function buildPlanFromMountedFiles({ args, readFile = readFileSync, now } = {}) {
  const loadJson = (name) => {
    const filePath = readArg(args, name);
    if (!filePath) return undefined;
    return JSON.parse(readFile(filePath, 'utf8'));
  };
  const sessionRef = readArg(args, 'session-ref') ?? undefined;
  const wakeSource = readArg(args, 'wake-source') ?? undefined;
  // Engine-native (#111): the CAS content_hash of the harness prompt the
  // materialize_prompt ask-step wrote (BLAKE3 of the raw markdown). When present,
  // buildHarnessDispatchPlan mounts the prompt by blob_ref instead of assembling +
  // embedding it inline, so the emitted plan stays under the 64KB capture tail.
  const promptContentHash = readArg(args, 'prompt-content-hash') ?? undefined;
  const promptContentBytes = readArg(args, 'prompt-content-bytes');
  const prependLauncherContentHash = readArg(args, 'prepend-launcher-content-hash') ?? undefined;

  let continuationDecision = loadJson('decision-file');
  if (continuationDecision === undefined) {
    const contracts = loadJson('contracts-file') ?? [];
    const pauseReceipts = loadJson('pauses-file') ?? [];
    const recentSessionEvents = loadJson('events-file') ?? [];
    continuationDecision = computeContinuation({
      contracts,
      pauseReceipts,
      recentSessionEvents,
      childTurnStates: loadJson('child-states-file') ?? [],
      recoveryClaims: loadJson('child-claims-file') ?? [],
      assignmentOutcomes: loadJson('child-outcomes-file') ?? [],
      parentBindings: loadJson('parent-bindings-file') ?? [],
      wakeSource,
      ts: now ?? new Date().toISOString(),
    });
  }

  // The engine-native find-current-items ask-step returns an ARRAY at output.items,
  // but buildHarnessDispatchPlan wants ONE policy record. Unwrap the single-record
  // set so policy can reuse the one proven ask mechanism (no read-current ask-step).
  const rawPolicy = loadJson('policy-file');
  const policy = Array.isArray(rawPolicy) ? rawPolicy[0] : rawPolicy;

  return buildHarnessDispatchPlan({
    continuationDecision,
    providerFacts: loadJson('provider-facts-file'),
    cliFacts: loadJson('cli-facts-file'),
    policy,
    promptContentHash,
    promptContentBytes: promptContentBytes == null ? undefined : Number(promptContentBytes),
    prependLauncherContentHash,
    modelDescriptors: loadJson('model-descriptors-file') ?? [],
    sessionRef,
    wakeSource,
  });
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--plan-only')) {
    // Engine-native mode: pure computation over mounted files, emit plan to stdout.
    buildPlanFromMountedFiles({ args }).then((plan) => {
      process.stdout.write(JSON.stringify(plan));
    }).catch((error) => {
      process.stdout.write(JSON.stringify({ should_dispatch: false, status: 'PLAN_ERROR', error: error?.message ?? String(error) }));
    }).finally(() => process.exit(0));
  } else {
    const decisionFile = readArg(args, 'decision-file');
    const decision = decisionFile ? JSON.parse(readFileSync(decisionFile, 'utf8')) : undefined;
    dispatchHarnessSession({
      sessionRef: readArg(args, 'session-ref'),
      wakeSource: readArg(args, 'wake-source'),
      continuationDecision: decision,
    }).catch((error) => {
      process.stderr.write(`[harness-dispatch] unexpected: ${error?.message ?? error}\n`);
    }).finally(() => process.exit(0));
  }
}
