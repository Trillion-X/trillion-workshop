#!/usr/bin/env node
// Fail closed unless a semantic index is current for its canonical owner set.
//
// Node port of assert-semantic-index-readiness.py (L108 preserve-behavior). Pure
// validation: owns no package inventory, model selection, I/O routing, or source
// vocabulary. Output is json.dumps(result, ensure_ascii=False, separators).
import fs from "node:fs";
import { pyDumps } from "./pyjson.mjs";
import { requireCanonicalMultihash, ValueError } from "./canonical_multihash.mjs";

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function load(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value) {
    throw new ValueError(`${label} must be a non-empty string`);
  }
  return value;
}

function rows(reply) {
  let rawItems;
  if (Array.isArray(reply)) {
    rawItems = reply;
  } else if (isDict(reply) && Array.isArray(reply.items)) {
    rawItems = reply.items;
  } else {
    throw new ValueError("owner reply must be a full items collection");
  }
  const result = [];
  for (const raw of rawItems) {
    if (!isDict(raw)) continue;
    const payload = raw.payload;
    result.push({ ...raw, ...(isDict(payload) ? payload : {}) });
  }
  return result;
}

function one(reply, { kind, identityField, identity, label }) {
  const matches = rows(reply).filter(
    (row) => row.kind === kind && row[identityField] === identity,
  );
  if (matches.length !== 1) {
    throw new ValueError(`${label} requires exactly one current record`);
  }
  return matches[0];
}

function indexNotReadyError(indexId) {
  return new ValueError(
    `INDEX_NOT_READY:${indexId}: semantic index source descriptor is absent; build the index first (#119)`,
  );
}

function requireSourceDescriptor(reply, indexId) {
  const matches = rows(reply).filter(
    (row) => row.kind === "capability-index-source-descriptor" && row.index_id === indexId,
  );
  if (matches.length === 0) {
    throw indexNotReadyError(indexId);
  }
  if (matches.length !== 1) {
    throw new ValueError("source descriptor requires exactly one current record");
  }
  return matches[0];
}

function keySet(obj) {
  return new Set(Object.keys(obj));
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function assertReady({
  indexId,
  descriptorReply,
  sourceDescriptorReply,
  policyReply,
  convergenceReply,
  sourceScan,
  indexStateReply,
}) {
  const source = requireSourceDescriptor(sourceDescriptorReply, indexId);
  const descriptor = one(descriptorReply, {
    kind: "semantic-index-descriptor", identityField: "index_id", identity: indexId,
    label: "semantic index descriptor",
  });
  const policy = one(policyReply, {
    kind: "discovery-readiness-policy", identityField: "id", identity: indexId,
    label: "readiness policy",
  });
  const convergence = one(convergenceReply, {
    kind: "semantic-index-convergence", identityField: "id", identity: indexId,
    label: "convergence receipt",
  });

  const snapshot = isDict(sourceScan) ? sourceScan.snapshot : undefined;
  const items = isDict(sourceScan) ? sourceScan.items : undefined;
  if (!isDict(snapshot) || !Array.isArray(items)) {
    throw new ValueError("current source scan requires snapshot and items");
  }
  const snapshotRef = requireCanonicalMultihash(snapshot.digest, "current source snapshot digest");
  if (snapshot.count !== items.length) {
    throw new ValueError("current source snapshot count mismatch");
  }

  const indexRef = `semantic-index-descriptor:${indexId}`;
  if (source.index_ref !== indexRef || policy.index_ref !== indexRef) {
    throw new ValueError("descriptor/readiness index reference mismatch");
  }
  if (convergence.index_ref !== indexRef || convergence.status !== "ready") {
    throw new ValueError("semantic index is not durably ready");
  }
  if (convergence.source_snapshot_ref !== snapshotRef || convergence.indexed_snapshot_ref !== snapshotRef) {
    throw new ValueError("semantic index snapshot is stale");
  }
  if (convergence.descriptor_count !== items.length) {
    throw new ValueError("semantic index descriptor count is stale");
  }

  const propertyId = `prop:semantic-ann-index:${indexId}`;
  const stateRows = rows(indexStateReply).filter(
    (row) => row.table === "attribute_fact" && row.property_id === propertyId,
  );
  if (stateRows.length > 1) {
    throw new ValueError("multiple current semantic index state rows");
  }
  const stateValue = stateRows.length ? stateRows[0].value_json : '{"subjects":{}}';
  if (typeof stateValue !== "string") {
    throw new ValueError("semantic index state value_json must be text");
  }
  const state = JSON.parse(stateValue);
  const subjects = isDict(state) ? state.subjects : undefined;
  if (!isDict(subjects)) {
    throw new ValueError("semantic index state subjects must be an object");
  }
  const expected = {};
  for (const raw of items) {
    if (!isDict(raw)) {
      throw new ValueError("current source item must be an object");
    }
    const address = requiredText(raw.address, "current source address");
    const contentHash = requireCanonicalMultihash(raw.content_hash, "current source content hash");
    expected[address] = contentHash;
  }
  const live = {};
  for (const [address, value] of Object.entries(subjects)) {
    if (isDict(value) && !value.removed) {
      live[address] = value;
    }
  }
  if (!sameSet(keySet(live), keySet(expected))) {
    throw new ValueError("semantic index membership is stale");
  }
  for (const [address, contentHash] of Object.entries(expected)) {
    const entry = live[address];
    if (
      entry.canonical_address !== address ||
      entry.revision !== contentHash ||
      entry.payload_hash !== contentHash ||
      entry.source_snapshot_ref !== snapshotRef
    ) {
      throw new ValueError("semantic index identity is stale");
    }
  }

  const descriptorRevision = requireCanonicalMultihash(
    descriptor.descriptor_revision, "index descriptor revision",
  );
  const modelProvenanceRef = requiredText(
    descriptor.model_provenance_ref, "index model provenance",
  );
  if (convergence.index_descriptor_revision !== descriptorRevision) {
    throw new ValueError("convergence descriptor revision is stale");
  }
  if (convergence.model_provenance_ref !== modelProvenanceRef) {
    throw new ValueError("convergence model provenance is stale");
  }

  requireCanonicalMultihash(convergence.completion_receipt_ref, "completion receipt");
  const evidence = convergence.sampled_hydrations;
  if (!Array.isArray(evidence)) {
    throw new ValueError("sampled hydration evidence is invalid");
  }
  const hydrationSampleCount = source.hydration_sample_count;
  if (
    !Number.isInteger(hydrationSampleCount) ||
    typeof hydrationSampleCount === "boolean" ||
    hydrationSampleCount < 1
  ) {
    throw new ValueError("source hydration sample count is invalid");
  }
  const expectedSamples = Math.min(hydrationSampleCount, items.length);
  if (evidence.length !== expectedSamples) {
    throw new ValueError("sampled owner hydration is incomplete");
  }
  const seen = new Set();
  for (const item of evidence) {
    if (!isDict(item)) {
      throw new ValueError("sampled hydration evidence item is invalid");
    }
    const address = requiredText(item.canonical_address, "hydrated canonical address");
    const revision = requireCanonicalMultihash(item.canonical_revision, "hydrated canonical revision");
    const payloadHash = requireCanonicalMultihash(item.payload_hash, "hydrated payload hash");
    if (seen.has(address) || expected[address] !== revision || revision !== payloadHash) {
      throw new ValueError("sampled hydration identity is stale");
    }
    seen.add(address);
  }

  const required = policy.requires;
  if (!Array.isArray(required) || required.length === 0) {
    throw new ValueError("readiness policy has no requirements");
  }
  return {
    status: "ready",
    index_id: indexId,
    source_snapshot_ref: snapshotRef,
    descriptor_count: items.length,
    completion_receipt_ref: convergence.completion_receipt_ref,
  };
}

function prepareProbe(indexId, recordsReply) {
  const source = requireSourceDescriptor(recordsReply, indexId);
  const ownerQuery = source.owner_query;
  if (!isDict(ownerQuery)) {
    throw new ValueError("source descriptor owner_query must be an object");
  }
  const target = requiredText(ownerQuery.target, "source owner query target");
  const request = ownerQuery.request;
  if (!isDict(request)) {
    throw new ValueError("source owner query request must be an object");
  }
  const include = request.include;
  if (
    request.operation !== "find-current-items" ||
    request.snapshot !== true ||
    !Array.isArray(include) ||
    !include.includes("address") ||
    !include.includes("content_hash")
  ) {
    throw new ValueError("source owner query must request an exact identity snapshot");
  }
  return { target, request };
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

function main() {
  const args = parseArgs(process.argv.slice(2), {
    mode: "--mode",
    index_id: "--index-id",
    records_json: "--records-json",
    source_scan_json: "--source-scan-json",
    index_state_json: "--index-state-json",
    output_json: "--output-json",
  });
  const indexId = requiredText(args.index_id, "index id");
  const records = load(args.records_json);
  let result;
  if (args.mode === "prepare") {
    result = prepareProbe(indexId, records);
  } else {
    if (!args.source_scan_json || !args.index_state_json) {
      throw new ValueError("assert mode requires --source-scan-json and --index-state-json");
    }
    result = assertReady({
      indexId,
      descriptorReply: records,
      sourceDescriptorReply: records,
      policyReply: records,
      convergenceReply: records,
      sourceScan: load(args.source_scan_json),
      indexStateReply: load(args.index_state_json),
    });
  }
  fs.writeFileSync(args.output_json, pyDumps(result, { ensureAscii: false }), "utf-8");
  return 0;
}

process.exit(main());
