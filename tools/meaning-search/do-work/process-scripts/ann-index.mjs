#!/usr/bin/env node
// Node port of ann-index.py (L108 preserve-behavior).
//
// Pure-stdlib approximate-nearest-neighbor (LSH random-hyperplane) index over
// embedding vectors, keyed per semantic-index-descriptor (index_id). Narrows the
// candidate set before the exact cosine ranker (nearest-embedding-facts) reranks.
//
// BYTE-IDENTITY NOTES:
//  - Every output uses json.dumps(..., ensure_ascii=False, separators) -> pyDumps
//    with ensureAscii:false.
//  - The ONLY floats in the persisted state are the LSH hyperplane elements. The
//    hyperplanes come from a 64-bit LCG; JS needs BigInt to reproduce the exact
//    integer state, and Number(state)/2**64 reproduces Python's int/int true
//    division bit-for-bit (2**64 is a power of two, so scaling is exact). Internally
//    the hyperplanes stay plain numbers (for _dot); at serialization every element
//    is wrapped in pyFloat so an integer-valued element renders "-1.0"/"0.0" like
//    CPython. Every other state field is an integer, string, or bool.
//  - Python container truthiness ([] and {} are falsy) drives several `or`/`if`
//    branches; truthy() replicates it so regenerate-vs-reuse decisions match.
import fs from "node:fs";
import { pyDumps, pyFloat } from "./pyjson.mjs";
import { requireCanonicalMultihash, ValueError } from "./canonical_multihash.mjs";

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Python truthiness: None/False/0/""/[]/{}/NaN are falsy.
function truthy(x) {
  if (x === null || x === undefined || x === false || x === "") return false;
  if (typeof x === "number") return x !== 0 && !Number.isNaN(x);
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x).length > 0;
  return Boolean(x);
}

function pyGet(obj, key, dflt) {
  return isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

// Python int(x): truncate toward zero for numbers, parse base-10 integer strings,
// bool -> 0/1, else raise. Used where the .py wraps int() in a (TypeError,ValueError).
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

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function loadJson(path, dflt) {
  let text;
  try {
    text = fs.readFileSync(path, "utf-8").trim();
  } catch (e) {
    if (e && e.code === "ENOENT") return dflt;
    throw e;
  }
  if (!text) return dflt;
  return JSON.parse(text);
}

// Order-preserving JSON parser: objects become Map so key order survives (a plain
// JS object reorders integer-like keys, corrupting bucket-table byte-identity).
// Values equal JSON.parse output; only the container type differs (Map vs object).
function parseOrdered(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  function str() {
    i++; // opening quote
    let s = "";
    while (text[i] !== '"') {
      if (text[i] === "\\") {
        i++;
        const e = text[i];
        if (e === "u") { s += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 5; continue; }
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        s += map[e]; i++;
      } else { s += text[i]; i++; }
    }
    i++; // closing quote
    return s;
  }
  function num() {
    let j = i;
    while (j < text.length && /[-+0-9.eE]/.test(text[j])) j++;
    const n = Number(text.slice(i, j));
    i = j;
    return n;
  }
  function arr() {
    i++; ws();
    const a = [];
    if (text[i] === "]") { i++; return a; }
    while (true) { a.push(val()); ws(); if (text[i] === ",") { i++; ws(); continue; } i++; break; }
    return a;
  }
  function obj() {
    i++; ws();
    const m = new Map();
    if (text[i] === "}") { i++; return m; }
    while (true) { ws(); const k = str(); ws(); i++; const v = val(); m.set(k, v); ws(); if (text[i] === ",") { i++; continue; } i++; break; }
    return m;
  }
  function val() {
    ws();
    const c = text[i];
    if (c === "{") return obj();
    if (c === "[") return arr();
    if (c === '"') return str();
    if (c === "t") { i += 4; return true; }
    if (c === "f") { i += 5; return false; }
    if (c === "n") { i += 4; return null; }
    return num();
  }
  return val();
}

function deepDemap(v) {
  if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[k] = deepDemap(x); return o; }
  if (Array.isArray(v)) return v.map(deepDemap);
  return v;
}

// Load a state file with bucket tables kept as Maps (insertion order preserved)
// and every other object demapped to a plain object for normal dot access.
function loadState(path, dflt) {
  let text;
  try {
    text = fs.readFileSync(path, "utf-8").trim();
  } catch (e) {
    if (e && e.code === "ENOENT") return dflt;
    throw e;
  }
  if (!text) return dflt;
  const tree = parseOrdered(text);
  if (!(tree instanceof Map)) return deepDemap(tree);
  const state = {};
  for (const [k, v] of tree) {
    if (k === "buckets" && Array.isArray(v)) {
      state[k] = v.map((table) => (table instanceof Map ? table : new Map(Object.entries(table))));
    } else {
      state[k] = deepDemap(v);
    }
  }
  return state;
}

// Only a persisted ANN state carries hyperplane floats; wrap them so an
// integer-valued LSH element renders as a Python float. Everything else passes
// through unchanged (facts/events/candidates have no floats).
function floatifyForOutput(value) {
  if (isDict(value) && Array.isArray(value.hyperplanes)) {
    return {
      ...value,
      hyperplanes: value.hyperplanes.map((table) => table.map((plane) => plane.map((x) => pyFloat(x)))),
    };
  }
  return value;
}

function writeJson(path, value) {
  fs.writeFileSync(path, pyDumps(floatifyForOutput(value), { ensureAscii: false }), "utf-8");
}

// Deterministic 64-bit LCG, bit-identical to the Python _lcg_stream. Yields
// floats in [-1.0, 1.0). Uses BigInt for the exact 64-bit integer recurrence.
function* lcgStream(seed) {
  const M = 1n << 64n;
  let state = ((BigInt(seed) % M) + M) % M;
  const a = 6364136223846793005n;
  const c = 1442695040888963407n;
  const twoPow64 = 2 ** 64;
  while (true) {
    state = (a * state + c) % M;
    yield (Number(state) / twoPow64) * 2.0 - 1.0;
  }
}

function makeHyperplanes(seed, tableCount, hyperplaneCount, dims) {
  const stream = lcgStream(seed);
  const tables = [];
  for (let t = 0; t < tableCount; t++) {
    const table = [];
    for (let hp = 0; hp < hyperplaneCount; hp++) {
      const plane = [];
      for (let d = 0; d < dims; d++) plane.push(stream.next().value);
      table.push(plane);
    }
    tables.push(table);
  }
  return tables;
}

function dot(a, b) {
  let total = 0.0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) total += a[i] * b[i];
  return total;
}

function bucketKey(vector, hyperplanes) {
  let bits = "";
  for (const plane of hyperplanes) {
    bits += dot(vector, plane) >= 0.0 ? "1" : "0";
  }
  return bits;
}

class SystemExitError extends Error {}

function resolveParams(paramsIn, dims) {
  const required = ["hyperplane_count", "table_count", "seed", "candidate_limit"];
  if (!isDict(paramsIn) || required.some((key) => !Object.prototype.hasOwnProperty.call(paramsIn, key))) {
    throw new SystemExitError("ann-index: descriptor ann_params must contain hyperplane_count, table_count, seed, candidate_limit");
  }
  if (required.some((key) => typeof paramsIn[key] === "boolean")) {
    throw new SystemExitError("ann-index: descriptor ann_params values must be integers");
  }
  const resolved = {};
  try {
    for (const key of required) resolved[key] = pyInt(paramsIn[key]);
  } catch (exc) {
    if (exc instanceof TypeError || exc instanceof ValueError) {
      throw new SystemExitError("ann-index: descriptor ann_params values must be integers");
    }
    throw exc;
  }
  if (resolved.hyperplane_count < 1 || resolved.table_count < 1 || resolved.candidate_limit < 1) {
    throw new SystemExitError("ann-index: descriptor ann_params counts must be positive");
  }
  return { ...resolved, dims };
}

function requiredRevision(value, name) {
  if (typeof value !== "string" || !value) {
    throw new SystemExitError(`ann-index: ${name} must be a non-empty string`);
  }
  return value;
}

function subjectMetadata(args) {
  try {
    return {
      canonical_address: requiredRevision(args.canonical_address || args.subject_id, "canonical_address"),
      revision: requireCanonicalMultihash(args.revision, "revision"),
      payload_hash: requireCanonicalMultihash(args.payload_hash, "payload_hash"),
      source_snapshot_ref: requireCanonicalMultihash(args.source_snapshot_ref, "source_snapshot_ref"),
    };
  } catch (exc) {
    if (exc instanceof ValueError) throw new SystemExitError(`ann-index: ${exc.message}`);
    throw exc;
  }
}

function isRejected(existing, incoming, removed) {
  if (!truthy(existing)) return false;
  if (existing.source_snapshot_ref !== incoming.source_snapshot_ref) return false;
  const sameRepresentation =
    existing.canonical_address === incoming.canonical_address &&
    existing.revision === incoming.revision &&
    existing.payload_hash === incoming.payload_hash;
  if (removed) return !sameRepresentation;
  return !sameRepresentation || Boolean(existing.removed);
}

// Bucket tables are Maps (Python dict insertion order; JS objects would reorder
// integer-like bit-string keys).
function removeSubjectFromBuckets(buckets, subjectId) {
  for (const table of buckets) {
    for (const key of [...table.keys()]) {
      const members = table.get(key).filter((member) => member !== subjectId);
      if (members.length) table.set(key, members);
      else table.delete(key);
    }
  }
}

function factsForState(indexId, state) {
  const publishedPath = ["current-item", "published-record"];
  const typeId = "type:semantic-ann-index";
  const propertyId = `prop:semantic-ann-index:${indexId}`;
  const valueJson = pyDumps(floatifyForOutput(state), { ensureAscii: false });
  return [
    { address: `entity|${indexId}`, path: publishedPath, payload: { table: "entity", id: indexId } },
    { address: `entity_types|${indexId}|${typeId}`, path: publishedPath, payload: { table: "entity_types", entity_id: indexId, type_id: typeId } },
    { address: `type_properties|${typeId}|${propertyId}`, path: publishedPath, payload: { table: "type_properties", type_id: typeId, property_id: propertyId } },
    { address: `attribute_fact|${indexId}|${propertyId}|${typeId}`, path: publishedPath, payload: { table: "attribute_fact", subject_id: indexId, property_id: propertyId, type_id: typeId, value_json: valueJson } },
  ];
}

function factsForRetraction(indexId, subjectId, state) {
  const publishedPath = ["current-item", "published-record"];
  const typeId = "type:semantic-indexed";
  return [
    ...factsForState(indexId, state),
    { address: `attribute_fact|${subjectId}|prop:semantic-embedding:${indexId}|${typeId}`, path: publishedPath, remove: true },
    { address: `attribute_fact|${subjectId}|prop:semantic-provenance:${indexId}|${typeId}`, path: publishedPath, remove: true },
  ];
}

function cmdUpsert(args) {
  const state = truthy(loadState(args.state_json, {})) ? loadState(args.state_json, {}) : {};
  let vector = loadJson(args.vector_json, null);
  const paramsIn = truthy(loadJson(args.params_json, {})) ? loadJson(args.params_json, {}) : {};

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new SystemExitError("ann-index upsert: vector.json must be a non-empty numeric array");
  }
  vector = vector.map((x) => floatOf(x));
  const dims = vector.length;

  const metadata = subjectMetadata(args);
  const subjects = truthy(pyGet(state, "subjects", null)) ? state.subjects : {};
  const existing = subjects[args.subject_id];
  if (isRejected(existing, metadata, false)) {
    writeJson(args.output_state_json, state);
    writeJson(args.output_facts_json, factsForState(args.index_id, state));
    if (args.output_event_json) {
      writeJson(args.output_event_json, {
        event: "semantic_index.stale_rejected", subject_ref: args.subject_id,
        indexed_snapshot_ref: pyGet(existing, "source_snapshot_ref", undefined) ?? null,
        source_snapshot_ref: metadata.source_snapshot_ref,
      });
    }
    return;
  }

  const params = resolveParams(paramsIn, dims);
  if (truthy(pyGet(state, "params", null)) && !deepEqual(state.params, params)) {
    throw new SystemExitError("ann-index: descriptor ann_params differ from persisted index parameters");
  }
  const seed = pyInt(params.seed);
  const tableCount = pyInt(params.table_count);
  const hyperplaneCount = pyInt(params.hyperplane_count);

  let hyperplanes = pyGet(state, "hyperplanes", null);
  if (!truthy(hyperplanes) || pyGet(state, "dims", undefined) !== dims || pyGet(state, "seed", undefined) !== seed ||
      pyGet(state, "table_count", undefined) !== tableCount || pyGet(state, "hyperplane_count", undefined) !== hyperplaneCount) {
    hyperplanes = makeHyperplanes(seed, tableCount, hyperplaneCount, dims);
  }

  const wasAlreadyPresent = Boolean(truthy(existing) && !existing.removed);

  const buckets = truthy(pyGet(state, "buckets", null)) ? state.buckets : Array.from({ length: tableCount }, () => new Map());
  while (buckets.length < tableCount) buckets.push(new Map());

  removeSubjectFromBuckets(buckets, args.subject_id);
  for (let t = 0; t < tableCount; t++) {
    const key = bucketKey(vector, hyperplanes[t]);
    if (!buckets[t].has(key)) buckets[t].set(key, []);
    if (!buckets[t].get(key).includes(args.subject_id)) buckets[t].get(key).push(args.subject_id);
  }

  const newState = {
    index_id: args.index_id,
    dims,
    seed,
    table_count: tableCount,
    hyperplane_count: hyperplaneCount,
    params,
    hyperplanes,
    buckets,
    subjects: { ...subjects, [args.subject_id]: { ...metadata, removed: false } },
    vector_count: pyInt(pyGet(state, "vector_count", 0)) + (wasAlreadyPresent ? 0 : 1),
  };

  writeJson(args.output_state_json, newState);
  writeJson(args.output_facts_json, factsForState(args.index_id, newState));
  if (args.output_event_json) {
    writeJson(args.output_event_json, {
      event: "semantic_index.mutated", operation: wasAlreadyPresent ? "update" : "add",
      subject_ref: args.subject_id, revision: metadata.revision,
      source_snapshot_ref: metadata.source_snapshot_ref,
    });
  }
}

function cmdDelete(args) {
  const state = truthy(loadState(args.state_json, {})) ? loadState(args.state_json, {}) : {};
  const metadata = subjectMetadata(args);
  const subjects = { ...(truthy(pyGet(state, "subjects", null)) ? state.subjects : {}) };
  const existing = subjects[args.subject_id];
  if (truthy(existing) && isRejected(existing, metadata, true)) {
    writeJson(args.output_state_json, state);
    writeJson(args.output_facts_json, factsForState(args.index_id, state));
    if (args.output_event_json) {
      writeJson(args.output_event_json, {
        event: "semantic_index.stale_rejected", subject_ref: args.subject_id,
        indexed_snapshot_ref: truthy(existing) ? (pyGet(existing, "source_snapshot_ref", undefined) ?? null) : null,
        source_snapshot_ref: metadata.source_snapshot_ref,
      });
    }
    return;
  }
  const buckets = truthy(pyGet(state, "buckets", null)) ? state.buckets : [];
  removeSubjectFromBuckets(buckets, args.subject_id);
  subjects[args.subject_id] = { ...metadata, removed: true };
  const newState = { ...state, buckets, subjects, vector_count: Math.max(0, pyInt(pyGet(state, "vector_count", 0)) - 1) };
  writeJson(args.output_state_json, newState);
  writeJson(args.output_facts_json, factsForRetraction(args.index_id, args.subject_id, newState));
  if (args.output_event_json) {
    writeJson(args.output_event_json, {
      event: "semantic_index.mutated", operation: "delete",
      subject_ref: args.subject_id, revision: metadata.revision,
      source_snapshot_ref: metadata.source_snapshot_ref,
    });
  }
}

function applyUpsertToState(state, { indexId, subjectId, metadata, vector, paramsIn }) {
  const subjects = truthy(pyGet(state, "subjects", null)) ? state.subjects : {};
  const existing = subjects[subjectId];
  if (isRejected(existing, metadata, false)) return state;
  const dims = vector.length;
  const params = resolveParams(paramsIn, dims);
  if (truthy(pyGet(state, "params", null)) && !deepEqual(state.params, params)) {
    throw new SystemExitError("ann-index: descriptor ann_params differ from persisted index parameters");
  }
  const seed = pyInt(params.seed);
  const tableCount = pyInt(params.table_count);
  const hyperplaneCount = pyInt(params.hyperplane_count);
  let hyperplanes = pyGet(state, "hyperplanes", null);
  if (!truthy(hyperplanes) || pyGet(state, "dims", undefined) !== dims || pyGet(state, "seed", undefined) !== seed ||
      pyGet(state, "table_count", undefined) !== tableCount || pyGet(state, "hyperplane_count", undefined) !== hyperplaneCount) {
    hyperplanes = makeHyperplanes(seed, tableCount, hyperplaneCount, dims);
  }
  const wasAlreadyPresent = Boolean(truthy(existing) && !existing.removed);
  const buckets = truthy(pyGet(state, "buckets", null)) ? state.buckets : Array.from({ length: tableCount }, () => new Map());
  while (buckets.length < tableCount) buckets.push(new Map());
  if (truthy(existing)) removeSubjectFromBuckets(buckets, subjectId);
  for (let t = 0; t < tableCount; t++) {
    const key = bucketKey(vector, hyperplanes[t]);
    if (!buckets[t].has(key)) buckets[t].set(key, []);
    if (!buckets[t].get(key).includes(subjectId)) buckets[t].get(key).push(subjectId);
  }
  // state.update(...) mutates the same object, preserving existing key order and
  // appending new keys, exactly like Python dict.update.
  const patch = {
    index_id: indexId, dims, seed, table_count: tableCount, hyperplane_count: hyperplaneCount,
    params, hyperplanes, buckets, subjects,
    vector_count: pyInt(pyGet(state, "vector_count", 0)) + (wasAlreadyPresent ? 0 : 1),
  };
  for (const [k, v] of Object.entries(patch)) state[k] = v;
  subjects[subjectId] = { ...metadata, removed: false };
  return state;
}

function applyDeleteToState(state, { subjectId, metadata }) {
  const subjects = { ...(truthy(pyGet(state, "subjects", null)) ? state.subjects : {}) };
  const existing = subjects[subjectId];
  if (truthy(existing) && isRejected(existing, metadata, true)) return state;
  const buckets = truthy(pyGet(state, "buckets", null)) ? state.buckets : [];
  removeSubjectFromBuckets(buckets, subjectId);
  subjects[subjectId] = { ...metadata, removed: true };
  const patch = { buckets, subjects, vector_count: Math.max(0, pyInt(pyGet(state, "vector_count", 0)) - 1) };
  for (const [k, v] of Object.entries(patch)) state[k] = v;
  return state;
}

function applyPlanWithOutcomes(state, plan, vectors, params, indexId) {
  if (!isDict(plan) || !isDict(vectors)) throw new SystemExitError("ann-index apply-plan requires object plan and vectors");
  if (!isDict(state)) throw new SystemExitError("ann-index apply-plan requires object state");
  if (!isDict(params)) throw new SystemExitError("ann-index apply-plan requires object params");
  state = structuredClone(state);
  const mutations = [...(truthy(pyGet(plan, "upserts", null)) ? plan.upserts : []), ...(truthy(pyGet(plan, "retracts", null)) ? plan.retracts : [])];
  if (!mutations.every((item) => isDict(item))) throw new SystemExitError("ann-index apply-plan mutations must be objects");
  let applied = 0;
  const acceptedRetractions = [];
  for (const mutation of mutations) {
    const mutationIndexId = requiredRevision(pyGet(mutation, "index_id", undefined), "index_id");
    if (mutationIndexId !== indexId) throw new SystemExitError("ann-index apply-plan mutation index_id does not match target");
    const subjectId = requiredRevision(pyGet(mutation, "content_address", undefined), "content_address");
    let metadata;
    try {
      metadata = {
        canonical_address: requiredRevision(pyGet(mutation, "canonical_address", undefined), "canonical_address"),
        revision: requireCanonicalMultihash(pyGet(mutation, "canonical_revision", undefined), "canonical_revision"),
        payload_hash: requireCanonicalMultihash(pyGet(mutation, "canonical_payload_hash", undefined), "canonical_payload_hash"),
        source_snapshot_ref: requireCanonicalMultihash(pyGet(mutation, "source_snapshot_ref", undefined), "source_snapshot_ref"),
      };
    } catch (exc) {
      if (exc instanceof ValueError) throw new SystemExitError(`ann-index: ${exc.message}`);
      throw exc;
    }
    if (Object.prototype.hasOwnProperty.call(mutation, "content_text")) {
      const vector = pyGet(vectors, subjectId, undefined);
      if (!Array.isArray(vector) || vector.length === 0) throw new SystemExitError("ann-index apply-plan needs a non-empty numeric vector for every upsert");
      state = applyUpsertToState(state, { indexId, subjectId, metadata, vector: vector.map((value) => floatOf(value)), paramsIn: params });
    } else {
      const existing = pyGet(truthy(pyGet(state, "subjects", null)) ? state.subjects : {}, subjectId, undefined);
      const accepted = !(truthy(existing) && isRejected(existing, metadata, true));
      state = applyDeleteToState(state, { subjectId, metadata });
      if (accepted) acceptedRetractions.push(subjectId);
    }
    applied += 1;
  }
  return { state, applied, acceptedRetractions };
}

function applyPlan(state, plan, vectors, params, indexId) {
  const { state: nextState, applied } = applyPlanWithOutcomes(state, plan, vectors, params, indexId);
  return { nextState, mutationCount: applied };
}

function cmdApplyPlan(args) {
  let state = truthy(loadState(args.state_json, {})) ? loadState(args.state_json, {}) : {};
  const plan = loadJson(args.plan_json, {});
  const vectors = loadJson(args.vectors_json, {});
  const params = truthy(loadJson(args.params_json, {})) ? loadJson(args.params_json, {}) : {};
  const result = applyPlan(state, plan, vectors, params, args.index_id);
  state = result.nextState;
  writeJson(args.output_state_json, state);
  writeJson(args.output_facts_json, factsForState(args.index_id, state));
  if (args.output_event_json) {
    writeJson(args.output_event_json, { event: "semantic_index.plan_applied", index_id: args.index_id, mutation_count: result.mutationCount, vector_count: pyInt(pyGet(state, "vector_count", 0)) });
  }
}

function cmdQuery(args) {
  const state = truthy(loadState(args.state_json, {})) ? loadState(args.state_json, {}) : {};
  let vector = loadJson(args.vector_json, null);
  const paramsIn = truthy(loadJson(args.params_json, {})) ? loadJson(args.params_json, {}) : {};
  const queryDims = Array.isArray(vector) && vector.length ? vector.length : pyInt(truthy(pyGet(state, "dims", null)) ? state.dims : 1);
  resolveParams(paramsIn, queryDims);

  const hyperplanes = pyGet(state, "hyperplanes", null);
  const buckets = pyGet(state, "buckets", null);
  if (!truthy(hyperplanes) || !truthy(buckets) || !Array.isArray(vector) || vector.length === 0) {
    writeJson(args.output_candidates_json, []);
    return;
  }

  vector = vector.map((x) => floatOf(x));
  if (vector.length !== pyGet(state, "dims", undefined)) {
    writeJson(args.output_candidates_json, []);
    return;
  }

  const params = resolveParams(paramsIn, vector.length);
  if (!deepEqual(pyGet(state, "params", null), params)) {
    throw new SystemExitError("ann-index: descriptor ann_params differ from persisted index parameters");
  }
  const candidateLimit = pyInt(params.candidate_limit);

  const seen = [];
  const seenSet = new Set();
  for (let t = 0; t < buckets.length; t++) {
    const key = bucketKey(vector, hyperplanes[t]);
    const members = buckets[t].has(key) ? buckets[t].get(key) : [];
    for (const subjectId of members) {
      if (!seenSet.has(subjectId)) {
        seenSet.add(subjectId);
        seen.push(subjectId);
      }
      if (seen.length >= candidateLimit) break;
    }
    if (seen.length >= candidateLimit) break;
  }

  const candidates = [];
  for (const subjectId of seen.slice(0, candidateLimit)) {
    const metadata = pyGet(truthy(pyGet(state, "subjects", null)) ? state.subjects : {}, subjectId, undefined);
    if (!isDict(metadata) || metadata.removed) continue;
    try {
      requireCanonicalMultihash(metadata.revision, "indexed revision");
      requireCanonicalMultihash(metadata.payload_hash, "indexed payload hash");
      requireCanonicalMultihash(metadata.source_snapshot_ref, "indexed source snapshot");
    } catch (e) {
      if (e instanceof ValueError) continue;
      throw e;
    }
    candidates.push({ subject_ref: subjectId, ...metadata });
  }
  writeJson(args.output_candidates_json, candidates);
  if (args.output_event_json) {
    writeJson(args.output_event_json, {
      event: "semantic_index.queried", descriptor_ref: args.index_id,
      candidate_count: seen.length, qualified_count: candidates.length,
      model_provenance_ref: args.model_provenance_ref || null,
    });
  }
}

function parseArgs(argv, spec, defaults) {
  const values = { ...defaults };
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

function main() {
  const spec = {
    mode: "--mode", state_json: "--state-json", vector_json: "--vector-json", params_json: "--params-json",
    index_id: "--index-id", subject_id: "--subject-id", canonical_address: "--canonical-address",
    revision: "--revision", payload_hash: "--payload-hash", source_snapshot_ref: "--source-snapshot-ref",
    model_provenance_ref: "--model-provenance-ref", at: "--at", output_state_json: "--output-state-json",
    output_facts_json: "--output-facts-json", output_candidates_json: "--output-candidates-json",
    output_event_json: "--output-event-json", plan_json: "--plan-json", vectors_json: "--vectors-json",
  };
  const defaults = {
    vector_json: "", params_json: "", index_id: "", subject_id: "", canonical_address: "", revision: "",
    payload_hash: "", source_snapshot_ref: "", model_provenance_ref: "", at: "", output_state_json: "",
    output_facts_json: "", output_candidates_json: "", output_event_json: "", plan_json: "", vectors_json: "",
  };
  const args = parseArgs(process.argv.slice(2), spec, defaults);
  const allowed = ["upsert", "delete", "query", "apply-plan"];
  if (!allowed.includes(args.mode)) throw new SystemExitError(`ann-index: invalid --mode ${args.mode}`);

  if (args.mode === "apply-plan") {
    if (!args.index_id || !args.plan_json || !args.vectors_json || !args.params_json || !args.output_state_json || !args.output_facts_json) {
      throw new SystemExitError("ann-index apply-plan requires --index-id --plan-json --vectors-json --params-json --output-state-json --output-facts-json");
    }
    cmdApplyPlan(args);
  } else if (args.mode === "upsert" || args.mode === "delete") {
    if (!args.index_id || !args.subject_id || !args.output_state_json || !args.output_facts_json) {
      throw new SystemExitError(`ann-index ${args.mode} requires --index-id --subject-id --output-state-json --output-facts-json`);
    }
    if (args.mode === "upsert") {
      if (!args.vector_json || !args.params_json) throw new SystemExitError("ann-index upsert requires --vector-json --params-json");
      cmdUpsert(args);
    } else {
      cmdDelete(args);
    }
  } else {
    if (!args.output_candidates_json || !args.vector_json || !args.params_json) {
      throw new SystemExitError("ann-index query requires --vector-json --params-json --output-candidates-json");
    }
    cmdQuery(args);
  }
  return 0;
}

try {
  process.exit(main());
} catch (exc) {
  process.stderr.write(`[meaning-search] error: ${exc && exc.message ? exc.message : exc}\n`);
  process.exit(1);
}
