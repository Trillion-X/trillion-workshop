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
    score: pyFloat(pyRound6(score)),
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

function main() {
  const args = parseArgs(process.argv.slice(2), {
    embedding_json: "--embedding-json",
    input_json: "--input-json",
    descriptor_json: "--descriptor-json",
    facts_json: "--facts-json",
    output_json: "--output-json",
  });

  const embedding = load(args.embedding_json);
  let query = embedding.vector;
  if (!Array.isArray(query) || query.length === 0) {
    process.stderr.write("[nearest-embedding-facts] embedding output has no numeric vector\n");
    return 1;
  }
  query = query.map((v) => floatOf(v));
  const actionInput = load(args.input_json);
  const descriptor = load(args.descriptor_json);
  if (!Number.isInteger(descriptor.result_limit) || descriptor.result_limit < 1) {
    process.stderr.write("[nearest-embedding-facts] descriptor result_limit must be a positive integer\n");
    return 1;
  }
  if (typeof descriptor.min_score !== "number") {
    process.stderr.write("[nearest-embedding-facts] descriptor min_score must be numeric\n");
    return 1;
  }
  const descriptorLimit = descriptor.result_limit;
  const requestedLimit = pyGet(actionInput, "limit", descriptorLimit);
  let limit;
  try {
    limit = Math.min(pyInt(requestedLimit), descriptorLimit);
  } catch (e) {
    if (e instanceof TypeError || e instanceof ValueError) {
      process.stderr.write("[nearest-embedding-facts] limit must be an integer\n");
      return 1;
    }
    throw e;
  }
  if (limit < 1) {
    process.stderr.write("[nearest-embedding-facts] limit must be positive\n");
    return 1;
  }
  const minScore = descriptor.min_score;

  const facts = load(args.facts_json);
  const rows = isDict(facts) ? pyGet(facts, "items", facts) : facts;
  const scored = [];
  let skipped = 0;
  const iterable = Array.isArray(rows) ? rows : [];
  for (let row of iterable) {
    if (!isDict(row)) {
      skipped += 1;
      continue;
    }
    const subject = row.subject_id;
    let score;
    try {
      const representation = JSON.parse(row.value_json || "null");
      if (!isDict(representation)) throw new ValueError("assert");
      const vector = representation.vector;
      if (!Array.isArray(vector) || vector.length === 0) throw new ValueError("assert");
      score = cosine(query, vector.map((v) => floatOf(v)));
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
    const byAddr = cmpStr(p.address, q.address);
    if (byAddr) return byAddr;
    const byRev = cmpStr(p.revision, q.revision);
    if (byRev) return byRev;
    return cmpStr(p.payload_hash, q.payload_hash);
  });
  const output = {
    items: scored.slice(0, limit),
    considered: Array.isArray(rows) ? rows.length : 0,
    skipped,
    min_score: pyFloat(minScore),
  };
  fs.writeFileSync(args.output_json, pyDumps(output, { ensureAscii: true }), "utf-8");
  process.stdout.write(
    `[nearest-embedding-facts] ranked ${scored.length} of ${output.considered} rows, returned ${output.items.length}\n`,
  );
  return 0;
}

process.exit(main());
