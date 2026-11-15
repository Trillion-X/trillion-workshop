#!/usr/bin/env node
// Project exact current descriptor and optional singleton ANN state for a job.
//
// Node port of prepare-semantic-index-process-input.py (L108 preserve-behavior).
// Workflow replies are collections. Process jobs must never choose a row by
// position: this pure preparation leaf accepts the full replies, enforces their
// cardinality, and emits only the validated values a process may consume.
import fs from "node:fs";
import { pyDumps } from "./pyjson.mjs";
import { ValueError } from "./canonical_multihash.mjs";

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function load(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function rows(reply) {
  let rawItems;
  if (Array.isArray(reply)) {
    rawItems = reply;
  } else if (isDict(reply) && Array.isArray(reply.items)) {
    rawItems = reply.items;
  } else {
    throw new ValueError("reply must be a full items collection");
  }
  const result = [];
  for (const raw of rawItems) {
    if (isDict(raw)) {
      const payload = raw.payload;
      result.push({ ...raw, ...(isDict(payload) ? payload : {}) });
    }
  }
  return result;
}

function exactDescriptor(reply, indexId) {
  const matches = rows(reply).filter(
    (row) => row.kind === "semantic-index-descriptor" && row.index_id === indexId,
  );
  if (matches.length !== 1) {
    throw new ValueError("semantic index descriptor requires exactly one current row");
  }
  return matches[0];
}

function optionalAnnState(reply, indexId) {
  const propertyId = `prop:semantic-ann-index:${indexId}`;
  const matches = rows(reply).filter(
    (row) => row.table === "attribute_fact" && row.property_id === propertyId,
  );
  if (matches.length > 1) {
    throw new ValueError("semantic ANN state requires zero or one current row");
  }
  if (matches.length === 0) {
    return "{}";
  }
  const value = matches[0].value_json;
  if (typeof value !== "string") {
    throw new ValueError("semantic ANN state value_json must be text");
  }
  const parsed = JSON.parse(value);
  if (!isDict(parsed)) {
    throw new ValueError("semantic ANN state must be an object");
  }
  return value;
}

function embeddingRequest(plan) {
  if (!isDict(plan)) {
    throw new ValueError("semantic index plan must be an object");
  }
  const upserts = plan.upserts;
  if (!Array.isArray(upserts)) {
    throw new ValueError("semantic index plan upserts must be an array");
  }
  const items = [];
  const seen = new Set();
  for (const mutation of upserts) {
    if (!isDict(mutation)) {
      throw new ValueError("semantic index plan upserts must contain objects");
    }
    if (Object.prototype.hasOwnProperty.call(mutation, "content_vector_base64")) {
      continue;
    }
    const itemId = mutation.content_address;
    const text = mutation.content_text;
    if (typeof itemId !== "string" || !itemId) {
      throw new ValueError("semantic index upsert requires content_address");
    }
    if (seen.has(itemId)) {
      throw new ValueError(`duplicate semantic index upsert: ${itemId}`);
    }
    if (typeof text !== "string" || !text) {
      // Python renders item_id with !r (repr). For the ASCII content-address ids
      // used here that is the value wrapped in single quotes.
      throw new ValueError(`semantic index upsert '${itemId}' requires content_text`);
    }
    seen.add(itemId);
    items.push({ id: itemId, text });
  }
  return { items };
}

// Minimal argparse-faithful reader for the fixed flag set. Supports both
// `--flag value` and `--flag=value`, exactly as the descriptor dispatches.
function parseArgs(argv, spec) {
  const values = {};
  for (const key of Object.keys(spec)) values[key] = undefined;
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
    index_id: "--index-id",
    descriptor_reply_json: "--descriptor-reply-json",
    ann_state_reply_json: "--ann-state-reply-json",
    plan_json: "--plan-json",
    embedding_request_json: "--embedding-request-json",
    output_state_json: "--output-state-json",
    output_json: "--output-json",
  });
  if (!args.index_id) {
    throw new ValueError("index_id is required");
  }
  if (Boolean(args.plan_json) !== Boolean(args.embedding_request_json)) {
    throw new ValueError("plan-json and embedding-request-json must be supplied together");
  }
  const descriptor = exactDescriptor(load(args.descriptor_reply_json), args.index_id);
  const stateValueJson = optionalAnnState(load(args.ann_state_reply_json), args.index_id);
  const output = { descriptor };
  fs.writeFileSync(args.output_state_json, stateValueJson, "utf-8");
  fs.writeFileSync(args.output_json, pyDumps(output, { ensureAscii: true }), "utf-8");
  if (args.plan_json) {
    const request = embeddingRequest(load(args.plan_json));
    fs.writeFileSync(args.embedding_request_json, pyDumps(request, { ensureAscii: true }), "utf-8");
  }
  return 0;
}

process.exit(main());
