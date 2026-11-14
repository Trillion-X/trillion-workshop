#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/derive-model-invocation-options.mjs
//
// =============================================================================
// PURPOSE — derive the runnable-model option catalog from live cli-registry DATA
// =============================================================================
//
// This package owns the `prop:cli_registry:*` schema — the only truth for which
// models are runnable and over which transport. Surfaces, however, list choices
// by folding published-records BY KIND (`options_address` / config `options.kind`
// folds in the composer, boards, forms). This deriver is the owner-published
// bridge: it projects the registry facts (enriched with `ai-model-descriptor`
// display metadata read as DATA by kind) into `kind:"ai-model-invocation-option"`
// records, one per (cli x declared model). Every by-kind option fold then lists
// ALL cloud/local/CLI models with zero surface code, and a new transport row in
// the registry appears in every picker on the next refresh.
//
// Lifecycle: recompute-from-truth + tombstones. An option whose backing model or
// cli vanished from the registry is re-emitted with `status:"retired"` (its last
// payload preserved) — consumers already exclude by DATA; records are NEVER
// null-retracted (a null payload poisons boot hydration).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure derivation. Never executes a CLI, never touches the network or log —
//    reads argv row JSON, writes one output JSON file.
// 2. NO hardcoded provider/model/CLI names — every name comes from the rows.
// 3. Deterministic: same rows in, byte-same records out (stable ids + ordering),
//    so the engine's same-content dedup makes refreshes idempotent.
// 4. No fabricated metadata: absent label/description/capabilities stay absent
//    or fall back to values genuinely present in the rows.

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { asString, declaredContentKinds, parseRows, groupRows } from "./resolve-chat-launch.mjs";

/** Present a bare cli/model id as a human label when the rows carry no
 *  display name. Strips a `cli:` namespace and treats -_: as word boundaries
 *  so internal vocabulary never surfaces as product copy. */
export function humanizeId(id) {
  return (
    String(id)
      .replace(/^cli:/i, "")
      .split(/[-_\s:]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || String(id)
  );
}

/** The cli's bare routing name: prop:cli_registry:cli, else the subject id tail. */
function cliTail(cli) {
  const declared = asString(cli["prop:cli_registry:cli"]);
  if (declared) return declared;
  const subject = asString(cli.subject_id) || "";
  return subject.includes(":") ? subject.slice(subject.indexOf(":") + 1) : subject;
}

/** Decode published-record rows (flat row IS the record; legacy nested payload
 *  tolerated) into payload objects of one kind. */
export function recordPayloadsOfKind(rows, kind) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const payload = row.payload && typeof row.payload === "object" ? row.payload : row;
    if (!payload || typeof payload !== "object") continue;
    if (payload.kind !== kind) continue;
    out.push(payload);
  }
  return out;
}

/** Preserve only declared content kinds that both the live model descriptor and
 * the selected adapter can carry. A missing descriptor has no model-side
 * capability proof and is therefore never runnable. */
export function intersectContentKinds(modelDescriptor, launch) {
  const adapterKinds = declaredContentKinds(launch);
  if (!modelDescriptor || !Array.isArray(modelDescriptor.capabilities)) return [];
  const modelKinds = new Set(modelDescriptor.capabilities.filter((kind) => typeof kind === "string" && kind));
  return adapterKinds.filter((kind) => modelKinds.has(kind));
}

/** Derive the full option record set.
 *  Input: raw find-current-items rows —
 *    cliRows: attribute_fact rows for prop:cli_registry:* (flat, value_json cells)
 *    descriptorRows: published-record rows, kind ai-model-descriptor
 *    existingOptionRows: published-record rows, kind ai-model-invocation-option
 *  Output: { records: [{ address, payload }] } — active options first (stable
 *  cli/model order), then tombstones for existing ids no longer derivable. */
export function deriveModelInvocationOptions({ cliRows, descriptorRows, existingOptionRows }) {
  const clis = groupRows(Array.isArray(cliRows) ? cliRows : [], "cli_id");
  const descriptors = recordPayloadsOfKind(descriptorRows, "ai-model-descriptor");
  const existing = recordPayloadsOfKind(existingOptionRows, "ai-model-invocation-option");

  const descriptorByModelId = new Map();
  for (const d of descriptors) {
    const modelId = asString(d.model_id);
    if (modelId && !descriptorByModelId.has(modelId)) descriptorByModelId.set(modelId, d);
  }

  const records = [];
  const activeIds = new Set();

  const sortedClis = [...clis].sort((a, b) => String(a.subject_id).localeCompare(String(b.subject_id)));
  for (const cli of sortedClis) {
    const tail = cliTail(cli);
    if (!tail) continue;
    const models = cli["prop:cli_registry:models"];
    if (!Array.isArray(models) || models.length === 0) continue;
    const launch = cli["prop:cli_registry:chat_launch"];
    const transport =
      launch && typeof launch === "object" && asString(launch.transport) ? launch.transport : "process";
    const providerRefs = Array.isArray(cli["prop:cli_registry:provider_ids"])
      ? cli["prop:cli_registry:provider_ids"].filter((x) => typeof x === "string" && x)
      : [];
    const brandLabel =
      asString(cli["prop:cli_registry:brand_label"]) ||
      (providerRefs[0] ? humanizeId(providerRefs[0]) : null);
    const rawPriority = cli["prop:cli_registry:transport_priority"];
    const transportPriority =
      typeof rawPriority === "number" && Number.isFinite(rawPriority) ? rawPriority : null;

    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const modelId = asString(model.id) || asString(model.model);
      if (!modelId) continue;
      const descriptor = descriptorByModelId.get(modelId) || null;
      const label =
        asString(model.label) ||
        asString(model.display_name) ||
        (descriptor ? asString(descriptor.display_name) : null) ||
        humanizeId(modelId);
      const description = asString(model.description) || asString(model.blurb);
      let capabilities;
      try {
        capabilities = intersectContentKinds(descriptor, launch);
      } catch {
        continue; // malformed adapter declarations are never published runnable
      }
      if (capabilities.length === 0) continue;
      const id = `ai-model-invocation-option:${tail}:${modelId}`;
      activeIds.add(id);
      records.push({
        address: `package::ai-cli-launch-adapters::model-invocation-option::${tail}::${modelId}`,
        payload: {
          kind: "ai-model-invocation-option",
          id,
          model: modelId,
          agent_ref: tail,
          label,
          ...(description ? { description } : {}),
          provider_label: brandLabel,
          transport,
          transport_priority: transportPriority,
          capabilities,
          content_kinds: capabilities,
          ...(descriptor && asString(descriptor.id) ? { descriptor_ref: descriptor.id } : {}),
          is_default: model.isDefault === true || model.is_default === true,
          status: "available",
        },
      });
    }
  }

  // Tombstones: an existing option whose backing (cli x model) is no longer
  // derivable keeps its last payload with status flipped — never null-retracted.
  const sortedExisting = [...existing].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const prior of sortedExisting) {
    const id = asString(prior.id);
    if (!id || activeIds.has(id)) continue;
    if (prior.status === "retired") continue; // already tombstoned — same-content no-op anyway
    const tail = asString(prior.agent_ref) || "unknown";
    const modelId = asString(prior.model) || "unknown";
    records.push({
      address: `package::ai-cli-launch-adapters::model-invocation-option::${tail}::${modelId}`,
      payload: { ...prior, status: "retired" },
    });
  }

  return { records };
}

function main() {
  const args = process.argv.slice(2);
  const readArg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
  };
  const readOneRowsArg = (raw) => {
    // Row JSON may arrive inline or as a file path (mounted input), so accept both.
    if (raw && (raw.startsWith("[") || raw.startsWith("{"))) return parseRows(raw);
    if (raw) {
      try {
        return parseRows(readFileSync(raw, "utf8"));
      } catch {
        return [];
      }
    }
    return [];
  };
  // A row flag may be named more than once and the rows accumulate. Live facts
  // are indexed BY property path, and one query reaches one path, so a caller
  // reading several properties has several results to hand over. Grouping runs
  // after every part has arrived; grouping each part alone would give one CLI
  // its name in one half-built row and its launch in another.
  const readRowsArg = (name) =>
    args
      .flatMap((value, index) => (value === name && index + 1 < args.length ? [args[index + 1]] : []))
      .flatMap((raw) => readOneRowsArg(raw));

  const result = deriveModelInvocationOptions({
    cliRows: readRowsArg("--cli-rows-json"),
    descriptorRows: readRowsArg("--descriptor-rows-json"),
    existingOptionRows: readRowsArg("--existing-option-rows-json"),
  });

  const active = result.records.filter((r) => r.payload.status === "available").length;
  const retired = result.records.length - active;
  console.log(
    `[ai-cli-launch-adapters] derived ${result.records.length} model options (${active} active, ${retired} retired)`,
  );

  const outPath = readArg("--output-json");
  if (!outPath) {
    console.error("missing required --output-json");
    return 1;
  }
  writeFileSync(outPath, JSON.stringify(result), "utf8");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
