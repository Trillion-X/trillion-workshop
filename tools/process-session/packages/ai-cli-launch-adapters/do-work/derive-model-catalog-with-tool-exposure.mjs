#!/usr/bin/env node
// packages/ai-cli-launch-adapters/do-work/derive-model-catalog-with-tool-exposure.mjs
//
// =============================================================================
// PURPOSE: derive a harness model catalog whose model-visible tool exposure is DATA
// =============================================================================
//
// A harness (Codex today; any harness whose per-model tool exposure lives in a
// model catalog file) decides which native tools it builds for the model from
// fields on each catalog entry. Capability-only mode needs a catalog in which
// those fields are set so the harness never constructs native computer-effect
// tool specs, and so tools from the package capability substrate (MCP) are
// exposed directly rather than behind a search tool that custom-provider paths
// drop. This deriver takes N vendor catalogs plus one exposure-policy DATA row
// and emits ONE merged catalog. Ordinary mode keeps the vendor catalogs untouched.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure derivation. Reads catalog JSON files and one policy JSON; writes one
//    JSON file. Never executes a harness, never touches the network or log.
// 2. NO hardcoded provider, model, vendor, or tool names. Which fields to set,
//    and to what, is the policy row. Which catalogs to merge is the argv list.
// 3. Deterministic: same inputs in, byte-same catalog out (stable model order =
//    input order, stable key order = source entry order with policy keys applied
//    in place). A new model in any vendor catalog is covered on the next run
//    with zero code change.
// 4. Field semantics belong to the harness. This owner applies `set` verbatim
//    and never interprets a field; a policy naming a field the harness does not
//    read is inert, never an error here.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const TOOL_EXPOSURE_POLICY_SCHEMA =
  "ai-cli-launch-adapters.model-catalog-tool-exposure-policy";

/**
 * @param {{ catalogs: Array<{models?: unknown[]}>, policy: {schema?: string, set: Record<string, unknown>} }} input
 * @returns {{ models: Array<Record<string, unknown>> }}
 */
export function deriveModelCatalogWithToolExposure({ catalogs, policy }) {
  if (!policy || typeof policy !== "object" || !policy.set || typeof policy.set !== "object") {
    throw new Error("policy.set must be an object of catalog fields to apply to every model");
  }
  if (policy.schema && policy.schema !== TOOL_EXPOSURE_POLICY_SCHEMA) {
    throw new Error(`policy.schema must be ${TOOL_EXPOSURE_POLICY_SCHEMA}`);
  }
  const excluded = policy.exclude_model_slugs ?? [];
  if (!Array.isArray(excluded) || excluded.some((slug) => typeof slug !== "string" || !slug)) {
    throw new Error("policy.exclude_model_slugs must be an array of model slugs");
  }
  const excludedSlugs = new Set(excluded);
  const models = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    for (const entry of Array.isArray(catalog?.models) ? catalog.models : []) {
      if (!entry || typeof entry !== "object" || typeof entry.slug !== "string") continue;
      if (excludedSlugs.has(entry.slug)) continue;
      if (seen.has(entry.slug)) continue;
      seen.add(entry.slug);
      const out = { ...entry };
      for (const [field, value] of Object.entries(policy.set)) out[field] = value;
      models.push(out);
    }
  }
  return { models };
}

export function main(argv = process.argv) {
  const args = argv.slice(2);
  const readArg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const policyFile = readArg("policy");
  const outFile = readArg("out");
  const catalogFiles = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--catalog" && i + 1 < args.length) catalogFiles.push(args[i + 1]);
  }
  if (!policyFile || !outFile || catalogFiles.length === 0) {
    process.stderr.write(
      "usage: derive-model-catalog-with-tool-exposure.mjs --policy <policy.json> --catalog <a.json> [--catalog <b.json> ...] --out <catalog.json>\n",
    );
    process.exit(2);
  }
  const catalogs = catalogFiles.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  const derived = deriveModelCatalogWithToolExposure({ catalogs, policy });
  writeFileSync(outFile, `${JSON.stringify(derived, null, 2)}\n`);
  process.stdout.write(
    JSON.stringify({
      out: outFile,
      models: derived.models.map((m) => m.slug),
      fields_set: Object.keys(policy.set),
    }),
  );
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (IS_MAIN) main();
