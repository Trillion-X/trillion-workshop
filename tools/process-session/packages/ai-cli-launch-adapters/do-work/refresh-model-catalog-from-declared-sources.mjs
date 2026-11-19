#!/usr/bin/env node
// bitfield-packages/packages/ai-cli-launch-adapters/do-work/refresh-model-catalog-from-declared-sources.mjs
//
// Purpose: keep every model catalog a consumer reads equal to what the vendors
// serve RIGHT NOW. Nothing in this file names a vendor, a model, a URL, a
// field, or a port; all of that is DATA in the sources file (L216: an
// externally-owned fact is read from its source, never transcribed).
//
// Three facts are kept apart, because conflating them is how a catalog lies:
//   1. AVAILABILITY: which models does this provider serve now. Read from the
//      provider's list endpoint on every refresh.
//   2. CONTRACT: which per-model fields does the consumer require. Not written
//      down anywhere we own; the consumer's own vendor publishes them on every
//      model it lists, so the contract is the intersection of field names
//      across that vendor's listed models, read fresh each refresh
//      (`contract_from` names that source).
//   3. FACTS: the truthful value of each contract field for THIS model. From
//      the provider's response when it serves them; otherwise from the source
//      row's `provider_descriptor`, an explicit statement about that provider
//      (and optionally per model under `models.<slug>`); otherwise UNKNOWN,
//      filled with the consumer's null-shape for that field (`unknown_shape`),
//      and the model is reported `partially_described` with the fields it
//      lacks. A fact is never copied from a different model or provider.
//
// Non-negotiable invariants:
// - A source that cannot be read, serves zero models, or cannot satisfy the
//   contract even with unknowns, leaves its previous catalog file untouched and
//   is reported `stale` with `last_read_on`. A guess is never written.
// - A read that drops the model the consumer config selects, when the previous
//   catalog held it, is also `stale`. On 2026-10-29 a short vendor answer (10
//   of 16 models, none of the selected family) was written as a success; the
//   Desktop loaded it, could not find the selected model, and fell back to its
//   own built-in default for the rest of the day. A partial answer is not a
//   retirement: the selected model leaves the catalog only after the config
//   moves off it.
// - Catalog files are written atomically (temp file + rename) so a consumer
//   loading mid-write never reads a torn file.
// - Derived catalogs are recomputed from the freshly written vendor catalogs
//   through deriveModelCatalogWithToolExposure; they are never edited by hand.
//
// Sources file shape (DATA):
// {
//   "schema": "ai-cli-launch-adapters.model-catalog-sources",
//   "codex_config_file": "/abs/config.toml",   // for codex_model_provider reads
//   "min_interval_seconds": 900,
//   "sources": [
//     { "id": "...",
//       "read": { "url": "..." } | { "codex_model_provider": "id", "path": "/models" },
//       "decode": { "models_path": ["models"], "slug_field": "slug",
//                   "filter": {"field": "...", "equals": ...}, "field_map": {to: from},
//                   "carry_raw_fields": true },
//       "contract_from": "<source id read earlier>",      // optional
//       "provider_descriptor": { <field>: <value>, "models": { "<slug>": {...} } },
//       "unknown_shape": { <field>: <value the consumer treats as absent> },
//       "write": { "catalog_file": "/abs/path.json", "models_fact_subjects": ["..."] } }
//   ],
//   "derived": [ { "id": "...", "policy_file": "...", "from_sources": [...], "catalog_file": "..." } ]
// }
//
// CLI: node refresh-model-catalog-from-declared-sources.mjs --sources <file>
// Prints a JSON report to stdout; exit 0 when every source was read, 2 when
// any source is stale (previous file kept), 1 on a malformed sources file.

import { readFile, writeFile, mkdir, rename, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModelCatalogWithToolExposure } from "./derive-model-catalog-with-tool-exposure.mjs";
import { readModelListFromCodexAppServer } from "./read-model-list-from-codex-app-server.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

// The provider blocks of a Codex config, verbatim, without the rest (hooks,
// MCP servers, notify, projects), so a scratch consumer home resolves the same
// providers the live one does and nothing else runs.
export function providerBlocksOf(toml) {
  const blocks = [];
  const lines = toml.split("\n");
  let keep = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) keep = /^\s*\[model_providers\./.test(line);
    if (keep) blocks.push(line);
  }
  return blocks.join("\n") + "\n";
}

// The default consumer check: load the candidate through a scratch consumer
// home and ask the consumer's app-server what it lists. `check` is DATA:
// { "codex_binary": "/abs/codex", "codex_config_file": "/abs/config.toml" }.
// The scratch home holds a config naming the candidate catalog plus the
// provider blocks read from that config.
async function askConsumerWhatItLists({ check, catalog }) {
  const home = await mkdtemp(join(tmpdir(), "consumer-check-"));
  try {
    const candidate = join(home, "candidate-catalog.json");
    await writeFile(candidate, JSON.stringify(catalog));
    const providers = check.codex_config_file ? providerBlocksOf(await readFile(check.codex_config_file, "utf8")) : "";
    await writeFile(join(home, "config.toml"), `model_catalog_json = ${JSON.stringify(candidate)}\n${providers}`);
    const { listed } = await readModelListFromCodexAppServer({ codexBinary: check.codex_binary, codexHome: home });
    return listed;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

let consumerCheckImpl = askConsumerWhatItLists;
export function setConsumerCheckForTests(fn) { consumerCheckImpl = fn ?? askConsumerWhatItLists; }

function lookup(value, path) {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomically(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
}

// A source may name a Codex model provider instead of a URL. The provider's
// base_url and bearer token then come from the Codex config where they already
// live once (SSOT), and `path` is appended to that base.
export function resolveProviderFromCodexConfig(toml, providerId) {
  const header = `[model_providers.${providerId}]`;
  const start = toml.indexOf(header);
  if (start === -1) throw new Error(`provider ${providerId} not declared in codex config`);
  const rest = toml.slice(start + header.length);
  const end = rest.search(/\n\[/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const field = (name) => block.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  const baseUrl = field("base_url");
  if (!baseUrl) throw new Error(`provider ${providerId} has no base_url`);
  return { baseUrl, bearerToken: field("experimental_bearer_token") };
}

// The model a Codex config selects: the top-level `model` key, read before the
// first [table] header (a key after a header belongs to that table).
export function selectedModelOf(toml) {
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) return null;
    const match = line.match(/^\s*model\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

async function resolveRead(read, codexConfigFile) {
  if (read.url) return { url: read.url, headers: read.headers ?? {} };
  const toml = await readFile(read.codex_config_file ?? codexConfigFile, "utf8");
  const provider = resolveProviderFromCodexConfig(toml, read.codex_model_provider);
  const headers = { ...(read.headers ?? {}) };
  if (provider.bearerToken) headers.Authorization = `Bearer ${provider.bearerToken}`;
  return { url: provider.baseUrl.replace(/\/$/, "") + (read.path ?? ""), headers };
}

async function fetchSource(read, fetchImpl, codexConfigFile) {
  const resolved = await resolveRead(read, codexConfigFile);
  const response = await fetchImpl(resolved.url, {
    method: read.method ?? "GET",
    headers: resolved.headers,
    signal: AbortSignal.timeout(read.timeout_ms ?? 15000),
  });
  if (!response.ok) throw new Error(`http ${response.status} from ${resolved.url}`);
  return response.json();
}

// AVAILABILITY: the models a provider serves, each carrying only what the
// provider actually said about it (plus field_map renames).
export function decodeServedModels(body, decode) {
  const list = lookup(body, decode.models_path ?? ["models"]);
  if (!Array.isArray(list)) throw new Error(`models_path did not resolve to an array`);
  const slugField = decode.slug_field ?? "slug";
  const models = [];
  for (const raw of list) {
    if (decode.filter && lookup(raw, [decode.filter.field]) !== decode.filter.equals) continue;
    const slug = raw[slugField];
    if (typeof slug !== "string" || slug.length === 0) continue;
    const mapped = {};
    for (const [target, sourceField] of Object.entries(decode.field_map ?? {})) {
      if (raw[sourceField] !== undefined) mapped[target] = raw[sourceField];
    }
    const carried = decode.carry_raw_fields === false ? {} : raw;
    models.push({ ...carried, ...mapped, slug });
  }
  return models;
}

// CONTRACT: the field names every listed model of the consumer's own vendor
// carries. Read from that vendor's catalog, never typed.
export function contractFieldsOf(models) {
  const listed = models.filter((m) => m.visibility === undefined || m.visibility === "list");
  if (listed.length === 0) return [];
  return listed.slice(1).reduce((acc, m) => acc.filter((k) => k in m), Object.keys(listed[0]));
}

// FACTS: fill each contract field for a served model from, in order, what the
// provider served, the provider descriptor for that slug, the provider
// descriptor for the provider, the unknown shape. Reports what stayed unknown.
export function describeModel(served, contract, providerDescriptor = {}, unknownShape = {}) {
  const { models: perModel = {}, not_applicable: notApplicable = [], ...forProvider } = providerDescriptor;
  const forThisModel = perModel[served.slug] ?? {};
  const model = { ...served };
  const unknown = [];
  const undescribable = [];
  for (const field of contract) {
    if (field in model) continue;
    // A provider may state that a contract field does not apply to it (a
    // plan gate on a provider that has no plans). The field is then ABSENT,
    // which is what the consumer reads as "no gate"; an empty or null value
    // would instead read as "gated by nothing" and hide every model.
    if (notApplicable.includes(field)) continue;
    if (field in forThisModel) model[field] = forThisModel[field];
    else if (field in forProvider) model[field] = forProvider[field];
    else if (field in unknownShape) { model[field] = unknownShape[field]; unknown.push(field); }
    else undescribable.push(field);
  }
  return { model, unknown, undescribable };
}

export async function refreshModelCatalogsFromDeclaredSources({ sources, fetchImpl = fetch, now = new Date(), codexConfigFile }) {
  if (sources?.schema !== "ai-cli-launch-adapters.model-catalog-sources") {
    throw new Error("sources file must declare schema ai-cli-launch-adapters.model-catalog-sources");
  }
  const readOn = now.toISOString();
  const report = { read_on: readOn, sources: [], derived: [] };
  const catalogsById = new Map();
  // Cadence is DATA on the sources file. A catalog read more recently than
  // `min_interval_seconds` ago is reported `fresh` and not re-fetched.
  const minIntervalMs = (sources.min_interval_seconds ?? 0) * 1000;
  const configFile = codexConfigFile ?? sources.codex_config_file;
  const configToml = configFile ? await readFile(configFile, "utf8").catch(() => null) : null;
  const selectedModel = configToml ? selectedModelOf(configToml) : null;

  for (const source of sources.sources ?? []) {
    const previous = await readJsonOrNull(source.write.catalog_file);
    const previousReadAt = previous?.read_on ? Date.parse(previous.read_on) : NaN;
    if (minIntervalMs > 0 && Number.isFinite(previousReadAt) && now.getTime() - previousReadAt < minIntervalMs) {
      catalogsById.set(source.id, previous);
      report.sources.push({ id: source.id, status: "fresh", last_read_on: previous.read_on, model_count: previous.models?.length ?? 0 });
      continue;
    }
    try {
      const body = await fetchSource(source.read, fetchImpl, configFile);
      const served = decodeServedModels(body, source.decode ?? {});
      if (served.length === 0) throw new Error("source served zero models");
      const previousHeldSelected = previous?.models?.some((m) => m.slug === selectedModel) === true;
      if (previousHeldSelected && !served.some((m) => m.slug === selectedModel)) {
        throw new Error(`read of ${served.length} models drops ${selectedModel}, the model the consumer config selects`);
      }

      let contract = [];
      if (source.contract_from) {
        const contractCatalog = catalogsById.get(source.contract_from);
        if (!contractCatalog) throw new Error(`contract_from ${source.contract_from} is not an already-read catalog`);
        contract = contractFieldsOf(contractCatalog.models ?? []);
      }
      const models = [];
      const partiallyDescribed = [];
      for (const s of served) {
        const { model, unknown, undescribable } = describeModel(s, contract, source.provider_descriptor, source.unknown_shape);
        if (undescribable.length > 0) {
          throw new Error(`${s.slug} cannot be described: no provider fact and no unknown shape for ${JSON.stringify(undescribable)}`);
        }
        if (unknown.length > 0) partiallyDescribed.push({ slug: s.slug, unknown });
        models.push(model);
      }

      const catalog = { source_id: source.id, read_on: readOn, models };
      // CONSUMER CHECK: before the real file is replaced, the consumer itself is
      // asked what it would list from the candidate. Only the consumer knows
      // which fields it reads as gates; a CLI run cannot prove the picker. The
      // candidate is loaded through a scratch consumer home whose config names
      // it, so nothing live changes until the consumer has listed every model
      // the source marked listable.
      const entryExtras = {};
      if (source.write.consumer_check) {
        const listable = models.filter((m) => m.visibility === undefined || m.visibility === "list").map((m) => m.slug);
        const listed = await consumerCheckImpl({ check: source.write.consumer_check, catalog, listable });
        const hidden = listable.filter((slug) => !listed.includes(slug));
        // `expect` is DATA: "all_listable" for a provider whose models carry no
        // consumer gate; "some_listable" (default) for the consumer's own vendor,
        // whose gates (plan, client version, account) legitimately hide some.
        const expect = source.write.consumer_check.expect ?? "some_listable";
        if (expect === "all_listable" && hidden.length > 0) {
          throw new Error(`consumer would hide ${hidden.length} of ${listable.length} listable models: ${JSON.stringify(hidden.slice(0, 5))}`);
        }
        if (listed.length === 0) throw new Error(`consumer would list none of ${listable.length} listable models`);
        if (hidden.length > 0) entryExtras.hidden_by_consumer = hidden;
      }
      await writeJsonAtomically(source.write.catalog_file, catalog);
      catalogsById.set(source.id, catalog);
      const entry = { id: source.id, status: "read", model_count: models.length, slugs: models.map((m) => m.slug), ...entryExtras };
      if (partiallyDescribed.length > 0) entry.partially_described = partiallyDescribed;
      report.sources.push(entry);
      // Optional: the same read also feeds a cli-registry `models` fact for any
      // subjects the source row names, in the shape those facts already hold.
      for (const subject of source.write.models_fact_subjects ?? []) {
        report.models_facts ??= {};
        report.models_facts[subject] = models
          .filter((m) => m.visibility === undefined || m.visibility === "list")
          .map((m, i) => ({ id: m.slug, label: m.display_name ?? m.slug, is_default: i === 0 }));
      }
    } catch (error) {
      if (previous) catalogsById.set(source.id, previous);
      report.sources.push({
        id: source.id,
        status: "stale",
        error: String(error?.message ?? error),
        last_read_on: previous?.read_on ?? null,
        model_count: previous?.models?.length ?? 0,
      });
    }
  }

  for (const derived of sources.derived ?? []) {
    // A malformed row is REPORTED, never thrown: this file is hand-edited DATA,
    // and one bad row killing the whole refresh would leave every catalog stale
    // with a stack trace as the only explanation. Found the hard way when a
    // comment-only row (no from_sources) crashed the run.
    if (!Array.isArray(derived.from_sources) || derived.from_sources.length === 0) {
      report.derived.push({ id: derived.id ?? null, status: "skipped", reason: "row declares no from_sources" });
      continue;
    }
    const policy = await readJsonOrNull(derived.policy_file);
    const catalogs = derived.from_sources.map((id) => catalogsById.get(id)).filter(Boolean);
    if (!policy || catalogs.length === 0) {
      report.derived.push({ id: derived.id, status: "skipped", reason: policy ? "no readable inputs" : "policy unreadable" });
      continue;
    }
    const out = deriveModelCatalogWithToolExposure({ catalogs, policy });
    await writeJsonAtomically(derived.catalog_file, { ...out, derived_on: readOn });
    report.derived.push({ id: derived.id, status: "written", model_count: out.models.length });
  }
  return report;
}

function readArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const sourcesFile = readArg(process.argv, "--sources");
  if (!sourcesFile) {
    process.stderr.write("usage: --sources <sources.json>\n");
    process.exit(1);
  }
  const sources = await readJsonOrNull(sourcesFile);
  if (!sources) {
    process.stderr.write(`cannot parse ${sourcesFile}\n`);
    process.exit(1);
  }
  const report = await refreshModelCatalogsFromDeclaredSources({ sources });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.sources.some((s) => s.status === "stale") ? 2 : 0);
}
