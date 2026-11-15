#!/usr/bin/env node
// Nearest-neighbor ranking over EEAF embedding fact rows (cosine similarity).
//
// Node port of nearest-embedding-facts.py (L108 preserve-behavior). Named by the
// semantic-index-descriptor's nearest_executor.argv:
//   --embedding-json  embedding.json  ({"vector":[...]} from the embed executor)
//   --input-json      input.json      (the action input; optional limit)
//   --descriptor-json descriptor.json (the semantic-index-descriptor; min_score)
//   --facts-json      facts.json      (find-current-items attribute_fact rows)
//   --output-json     nearest.json    ({"items":[canonical ranked representations], ...})
// Fail-closed: results below min_score are dropped (never padded); malformed fact
// rows are skipped and counted, never guessed at.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pyDumps, pyFloat } from "./pyjson.mjs";
import { requireCanonicalMultihash, ValueError } from "./canonical_multihash.mjs";

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Faithful two-arg dict.get: returns the default only when the key is ABSENT
// (a present-but-null value returns null, exactly like Python dict.get).
function pyGet(obj, key, dflt) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

function load(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

// Python float(v): number is identity; a numeric string is parsed; anything else
// raises (so the caller skips the row). Mirrors the realistic vector inputs.
function floatOf(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === "-" ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
    if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  }
  throw new ValueError("could not convert to float");
}

// Python round(x, 6): round-half-to-even on the true binary double. Real cosine
// scores never land on an exact 6th-decimal tie, so toFixed(6) reproduces it;
// the golden parity fuzz proves this against CPython on real vectors. Preserves
// -0.0 (round(-1e-9,6) == -0.0).
function pyRound6(x) {
  return Number(x.toFixed(6));
}

function cosine(a, b) {
  if (a.length !== b.length) return -1.0;
  let dot = 0.0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  let sa = 0.0;
  for (let i = 0; i < a.length; i++) sa += a[i] * a[i];
  let sb = 0.0;
  for (let i = 0; i < b.length; i++) sb += b[i] * b[i];
  const na = Math.sqrt(sa);
  const nb = Math.sqrt(sb);
  if (na === 0.0 || nb === 0.0) return -1.0;
  return dot / (na * nb);
}

// Unicode code-point comparison (Python str ordering), matching JS `<` for the
// ASCII identifiers used here but faithful for any input.
function cmpStr(a, b) {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i].codePointAt(0);
    const cb = bi[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  return 0;
}

function canonicalItem(row, score, descriptor) {
  const subject = pyGet(row, "canonical_address", row.subject_id);
  if (typeof subject !== "string" || !subject) {
    throw new ValueError("missing canonical address");
  }
  let revision = pyGet(row, "canonical_revision", row.revision);
  let payloadHash = pyGet(row, "canonical_payload_hash", row.payload_hash);
  let sourceSnapshotRef = row.source_snapshot_ref;
  let descriptorRevision;
  try {
    revision = requireCanonicalMultihash(revision, "candidate revision");
    payloadHash = requireCanonicalMultihash(payloadHash, "candidate payload hash");
    sourceSnapshotRef = requireCanonicalMultihash(sourceSnapshotRef, "candidate source snapshot");
    descriptorRevision = requireCanonicalMultihash(
      descriptor.descriptor_revision,
      "semantic index descriptor revision",
    );
  } catch (exc) {
    if (exc instanceof ValueError) {
      throw new ValueError("candidate lacks canonical revision, payload hash, or source snapshot reference");
    }
    throw exc;
  }
  const modelProvenanceRef = descriptor.model_provenance_ref;
  if (typeof modelProvenanceRef !== "string" || !modelProvenanceRef) {
    throw new ValueError("semantic index descriptor lacks model provenance");
  }
  const item = {
    address: subject,
    score: pyFloat(descriptor.similarity === 'float32-dot' ? score : pyRound6(score)),
    index_id: descriptor.index_id,
    model_id: descriptor.model_id,
    model_version: descriptor.model_version,
    descriptor_revision: descriptorRevision,
    model_provenance_ref: modelProvenanceRef,
    revision,
    source_snapshot_ref: sourceSnapshotRef,
    payload_hash: payloadHash,
  };
  for (const key of [
    "owner_target",
    "schema_ref",
    "schema_digest",
    "authority_provenance_ref",
    "surface_ref",
    "title",
    "description",
  ]) {
    const value = pyGet(row, key, undefined);
    if (value !== null && value !== undefined) {
      item[key] = value;
    }
  }
  return item;
}

function parseArgs(argv, spec) {
  const values = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    let matched = false;
    for (const [dest, flag] of Object.entries(spec)) {
      if (token === flag) {
        values[dest] = argv[i + 1];
        i += 2;
        matched = true;
        break;
      }
      if (token.startsWith(flag + "=")) {
        values[dest] = token.slice(flag.length + 1);
        i += 1;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return values;
}

// Python int(x): number truncates toward zero; a base-10 integer string parses;
// bool is 0/1; anything else raises (TypeError/ValueError -> caller error).
function pyInt(x) {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new Error("cannot int a non-finite");
    return Math.trunc(x);
  }
  if (typeof x === "string") {
    const s = x.trim();
    if (/^[+-]?\d+$/.test(s)) return Number(s);
    throw new ValueError("invalid literal for int");
  }
  throw new TypeError("int() argument must be a number or string");
}

// One scorer for stored EEAF facts and directly read vector-set rows. Iterables
// are consumed once; only qualified canonical results remain for the existing
// total-order sort. The default adapter keeps the command's fact-row semantics.
export function rankRows({ embedding, input: actionInput, descriptor, rows, representationOf = row => JSON.parse(row.value_json || "null") }) {
  let query = embedding.vector;
  if (!Array.isArray(query) || query.length === 0) {
    throw new ValueError("embedding output has no numeric vector");
  }
  query = query.map((v) => floatOf(v));
  if (!Number.isInteger(descriptor.result_limit) || descriptor.result_limit < 1) {
    throw new ValueError("descriptor result_limit must be a positive integer");
  }
  if (typeof descriptor.min_score !== "number") {
    throw new ValueError("descriptor min_score must be numeric");
  }
  const descriptorLimit = descriptor.result_limit;
  const requestedLimit = pyGet(actionInput, "limit", descriptorLimit);
  let limit;
  try {
    limit = Math.min(pyInt(requestedLimit), descriptorLimit);
  } catch (e) {
    if (e instanceof TypeError || e instanceof ValueError) {
      throw new ValueError("limit must be an integer");
    }
    throw e;
  }
  if (limit < 1) {
    throw new ValueError("limit must be positive");
  }
  const minScore = descriptor.min_score;

  const similarity = descriptor.similarity ?? 'cosine';
  if (!['cosine', 'float32-dot'].includes(similarity)) throw new ValueError('descriptor similarity must be cosine or float32-dot');
  const sourceOrder = descriptor.tie_order === 'source';
  if (descriptor.tie_order !== undefined && !['source', 'canonical'].includes(descriptor.tie_order)) throw new ValueError('descriptor tie_order must be canonical or source');
  let iterable = rows?.[Symbol.iterator] ? rows : [];
  const dotScores = new Map();
  const representations = new Map();
  if (similarity === 'float32-dot') {
    // NumPy keeps the source's float32 multiply/accumulate semantics. This
    // primitive receives vectors only: it owns no store reader or ranking.
    iterable = Array.from(iterable);
    const valid = [];
    for (const row of iterable) {
      try {
        const representation = representationOf(row);
        const vector = representation.vector.map(floatOf);
        if (vector.length !== query.length || !vector.every(Number.isFinite)) throw new ValueError('source vector dimensions must agree');
        representations.set(row, representation);
        valid.push({ row, vector });
      } catch { /* The shared qualification loop counts malformed rows below. */ }
    }
    if (valid.length) {
      const body = Buffer.alloc((valid.length + 1) * query.length * 4);
      let at = 0;
      for (const vector of [query, ...valid.map(item => item.vector)]) for (const value of vector) { body.writeFloatLE(value, at); at += 4; }
      const header = Buffer.from(`${JSON.stringify({ dimensions: query.length, rows: valid.length })}\n`);
      const scores = execFileSync(process.env.VECTOR_PYTHON || 'python3', [fileURLToPath(new URL('./float32-dot-products.py', import.meta.url))],
        { input: Buffer.concat([header, body]), maxBuffer: Math.max(1024, valid.length * 4 + 1024) });
      if (scores.length !== valid.length * 4) throw new ValueError('source dot arithmetic returned an incomplete result');
      valid.forEach(({ row }, index) => dotScores.set(row, scores.readFloatLE(index * 4)));
    }
  }

  const scored = [];
  let skipped = 0;
  let considered = 0;
  for (let row of iterable) {
    considered += 1;
    if (!isDict(row)) {
      skipped += 1;
      continue;
    }
    const subject = row.subject_id;
    let score;
    try {
      const representation = similarity === 'float32-dot' ? representations.get(row) : representationOf(row);
      if (!isDict(representation)) throw new ValueError("assert");
      const vector = representation.vector;
      if (!Array.isArray(vector) || vector.length === 0) throw new ValueError("assert");
      score = similarity === 'float32-dot' ? dotScores.get(row) : cosine(query, vector.map((v) => floatOf(v)));
      row = { ...row, ...representation };
    } catch (e) {
      skipped += 1;
      continue;
    }
    if (typeof subject === "string" && subject && score >= minScore) {
      try {
        scored.push(canonicalItem(row, score, descriptor));
      } catch (e) {
        if (e instanceof ValueError) {
          skipped += 1;
        } else {
          throw e;
        }
      }
    }
  }
  // Stable total order before truncation (mirror Python tuple key
  // (-score, address, revision, payload_hash) ascending).
  scored.sort((p, q) => {
    const ps = p.score.value;
    const qs = q.score.value;
    if (-ps < -qs) return -1;
    if (-ps > -qs) return 1;
    if (sourceOrder) return 0;
    const byAddr = cmpStr(p.address, q.address);
    if (byAddr) return byAddr;
    const byRev = cmpStr(p.revision, q.revision);
    if (byRev) return byRev;
    return cmpStr(p.payload_hash, q.payload_hash);
  });
  const output = {
    items: scored.slice(0, limit),
    considered,
    skipped,
    min_score: pyFloat(minScore),
  };
  // Canonical candidates contain scores/provenance only, never input vectors.
  // A global collector may spread these before applying its own output limit.
  return { result: output, ranked_count: scored.length, candidates: scored };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    embedding_json: "--embedding-json",
    input_json: "--input-json",
    descriptor_json: "--descriptor-json",
    facts_json: "--facts-json",
    output_json: "--output-json",
  });

  const embedding = load(args.embedding_json);
  const actionInput = load(args.input_json);
  const descriptor = load(args.descriptor_json);
  const facts = load(args.facts_json);
  const rows = isDict(facts) ? pyGet(facts, "items", facts) : facts;
  let ranked;
  try {
    ranked = rankRows({ embedding, input: actionInput, descriptor, rows: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    process.stderr.write(`[nearest-embedding-facts] ${error.message}\n`);
    return 1;
  }
  fs.writeFileSync(args.output_json, pyDumps(ranked.result, { ensureAscii: true }), "utf-8");
  process.stdout.write(
    `[nearest-embedding-facts] ranked ${ranked.ranked_count} of ${ranked.result.considered} rows, returned ${ranked.result.items.length}\n`,
  );
  return 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exit(main());
