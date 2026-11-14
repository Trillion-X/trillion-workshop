import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildCandidates } from "../../../../../match-community-members/src/community-logic/match/bounded-candidates.mjs";
import { pairKey, priorPairKeys, selectPairs } from "../../../../../community-logic-match/src/community-logic/match/select-pairs.mjs";

function payload(item) {
  return item && typeof item === "object" && item.payload ? item.payload : item;
}

function loadJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function firstProgram(raw) {
  const candidates = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : [raw]);
  for (const candidate of candidates) {
    const value = payload(candidate);
    if (value && typeof value === "object") return value;
  }
  return {};
}

function normalizeConsents(raw) {
  if (!raw) return {};
  if (Array.isArray(raw?.items)) return normalizeConsents(raw.items);
  if (Array.isArray(raw)) {
    const consents = {};
    for (const item of raw) {
      const value = payload(item);
      const party = value?.party ?? value?.participant ?? value?.subject;
      const status = value?.status ?? value?.consent ?? value?.value;
      if (typeof party === "string" && party.length > 0 && typeof status === "string") {
        consents[party] = status;
      }
    }
    return consents;
  }
  if (typeof raw === "object") return raw;
  return {};
}

function loadRequestSiblings(req) {
  if (!Array.isArray(req.retrieval_results)) {
    const retrievals = loadJson("retrievals.json");
    req.retrieval_results = Array.isArray(retrievals?.items) ? retrievals.items : retrievals;
  }
  if (!Array.isArray(req.prior_items)) req.prior_items = loadJson("prior.json");
  if (!req.consents || typeof req.consents !== "object") {
    req.consents = normalizeConsents(loadJson("consents.json"));
  }

  const program = firstProgram(loadJson("program.json"));
  for (const key of [
    "pairing",
    "retrieval",
    "expected_value",
    "eligibility",
    "initiative",
    "consent_policy",
    "introduction",
    "subject_context",
  ]) {
    if (req[key] == null && program[key] != null) req[key] = program[key];
  }
  if (req.relationship_kind_ref == null && typeof program.relationship_kind_ref === "string") {
    req.relationship_kind_ref = program.relationship_kind_ref;
  }
}

function normalizeRequest(req) {
  if (!Array.isArray(req.already_matched) && Array.isArray(req.prior_items)) {
    req.already_matched = priorPairKeys(req.prior_items);
  }
  if (typeof req.relationship_kind !== "string" && typeof req.relationship_kind_ref === "string") {
    const separator = req.relationship_kind_ref.lastIndexOf(":");
    req.relationship_kind = separator >= 0
      ? req.relationship_kind_ref.slice(separator + 1)
      : req.relationship_kind_ref;
  }
}

function candidateConfig(req) {
  return {
    shortlist_size: req?.retrieval?.shortlist_size,
    eligibility: req?.eligibility,
    expected_value: req?.expected_value,
  };
}

function main(argv) {
  const inputPath = argv[2];
  const outputPath = argv[3];
  if (!inputPath || !outputPath) {
    process.stderr.write("usage: select-pairs-cli.mjs <request.json> <groups.json>\n");
    process.exit(2);
  }

  const req = JSON.parse(readFileSync(inputPath, "utf8"));
  loadRequestSiblings(req);
  normalizeRequest(req);
  const built = Array.isArray(req.candidates)
    ? { candidates: req.candidates, instrumentation: req.candidate_instrumentation ?? {} }
    : buildCandidates(req.retrieval_results, candidateConfig(req));
  const selected = selectPairs({ ...req, candidates: built.candidates });
  const programId = typeof req.program_id === "string" ? req.program_id : "program";
  const cycle = typeof req.cycle === "string" ? req.cycle : String(req.cycle ?? "0");
  const relationshipKind = typeof req.relationship_kind === "string" ? req.relationship_kind : "interaction";

  const connections = selected.groups
    .filter((group) => group.introduction.send_authorized)
    .map((group) => ({
    id: `${programId}:${cycle}:${group.members.join("-")}`,
    source: group.members[0],
    target: group.members[1] ?? group.members[0],
    members: group.members,
    relation: relationshipKind,
    attributes: {
      program_id: programId,
      cycle,
      grouping: group.grouping,
      expected_value: group.expected_value,
      expected_value_factors: group.expected_value_factors,
      needle_mover_scope: group.scope,
      needle_mover_scope_key: group.scope_key,
      match_provenance: group.provenance,
      prepared_introduction_id: group.introduction.id,
      introduction_send_status: group.introduction.send_gate.status,
    },
    }));

  writeFileSync(outputPath, JSON.stringify({
    program_id: programId,
    cycle,
    connections,
    groups: selected.groups,
    introductions: selected.introductions,
    ready_introductions: selected.ready_introductions,
    blocked_introductions: selected.blocked_introductions,
    reasoning_requests: selected.groups.map((group) => group.reasoning_request),
    configuration_requests: selected.groups.flatMap((group) => group.configuration_requests),
    pair_keys: selected.groups
      .filter((group) => group.introduction.send_authorized)
      .filter((group) => group.members.length === 2)
      .map((group) => pairKey(group.members[0], group.members[1])),
    unmatched: selected.unmatched,
    unmatched_details: [...(built.rejections ?? []), ...selected.unmatched_details],
    instrumentation: {
      retrieval: built.instrumentation,
      selection: selected.instrumentation,
    },
  }, null, 2));
}

try {
  main(process.argv);
} catch (error) {
  try {
    const outputPath = process.argv[3];
    if (outputPath) {
      writeFileSync(outputPath, JSON.stringify({
        error: String(error?.message ?? error),
        stack: String(error?.stack ?? ""),
      }));
    }
  } catch {}
  process.stderr.write(`select-pairs-cli: ${error?.stack ?? error}\n`);
  process.exit(1);
}
