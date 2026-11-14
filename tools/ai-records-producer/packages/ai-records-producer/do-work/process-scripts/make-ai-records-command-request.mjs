#!/usr/bin/env node
// Pure, DATA-driven request builder for ai-records-producer. It never executes
// a provider and carries no model, provider, customer, founder, or source names.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const ADDRESSED_INPUT_SNAPSHOT_KIND = [
  "ai-records-producer.addressed-input-snapshot/",
  "v",
  "1",
].join("");
const PROFILE_INSTRUCTION_SNAPSHOT_KIND = [
  "ai-records-producer.profile-instruction-snapshot/",
  "v",
  "1",
].join("");
const PROFILE_INSTRUCTION_SELECTION_KIND = [
  "ai-agent-profile.instruction-selection/",
  "v",
  "1",
].join("");
const MAX_INPUT_ITEMS = 16;
const MAX_INPUT_ITEM_BYTES = 32 * 1024;
const MAX_INPUT_TOTAL_BYTES = 128 * 1024;
const MAX_INSTRUCTION_ITEMS = 64;
const MAX_INSTRUCTION_ITEM_BYTES = 64 * 1024;
const MAX_INSTRUCTION_TOTAL_BYTES = 256 * 1024;
const MAX_MATERIALIZED_INSTRUCTION_BYTES = 16 * 1024 * 1024;

function asString(value) {
  return typeof value === "string" && value ? value : null;
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const body = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",");
  return `{${body}}`;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonemptyText(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  if ([...value].some((character) => character.codePointAt(0) < 32)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function parseRows(value) {
  let parsed;
  try {
    parsed = value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const flattened = [];
  const pending = [...parsed].reverse();
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) pending.push(...[...item].reverse());
    else if (plainRecord(item) && Object.keys(item).join() === "items") pending.push(item.items);
    else flattened.push(item);
  }
  return flattened;
}

function parseOptionalObject(value, label) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (parsed === null) return null;
  if (!plainRecord(parsed)) throw new Error(`${label} must be an object or null`);
  return parsed;
}

function payloadOfKind(row, kind) {
  if (!plainRecord(row)) return null;
  const payload = plainRecord(row.payload) ? row.payload : row;
  return plainRecord(payload) && payload.kind === kind ? payload : null;
}

function factPayload(row) {
  if (plainRecord(row) && plainRecord(row.payload)) return row.payload;
  return plainRecord(row) ? row : {};
}

function groupRows(rows, idKey) {
  const grouped = new Map();
  for (const raw of rows) {
    const row = factPayload(raw);
    const subjectId = asString(row.subject_id);
    const propertyId = asString(row.property_id);
    if (!subjectId || !propertyId) continue;
    if (!grouped.has(subjectId)) {
      grouped.set(subjectId, { [idKey]: subjectId, subject_id: subjectId });
    }
    let value = row.value_json;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        // Non-JSON cells remain text.
      }
    }
    grouped.get(subjectId)[propertyId] = value;
  }
  return [...grouped.values()];
}

function extractInputRefs(input) {
  const direct = Object.hasOwn(input, "input_refs") ? input.input_refs : undefined;
  const nestedInput = plainRecord(input.input) ? input.input : null;
  const nested = nestedInput && Object.hasOwn(nestedInput, "input_refs")
    ? nestedInput.input_refs
    : undefined;
  if (direct !== undefined && nested !== undefined && canonicalJson(direct) !== canonicalJson(nested)) {
    throw new Error("input_refs are ambiguous between direct and nested action input");
  }
  const selected = direct !== undefined ? direct : nested;
  if (selected === undefined || selected === null) return [];
  if (!Array.isArray(selected)) throw new Error("input_refs must be an ordered list");
  return selected;
}

function inputLimits(input) {
  let raw = Object.hasOwn(input, "input_snapshot_limits")
    ? input.input_snapshot_limits
    : undefined;
  if ((raw === undefined || raw === null) && plainRecord(input.input)) {
    raw = Object.hasOwn(input.input, "input_snapshot_limits")
      ? input.input.input_snapshot_limits
      : undefined;
  }
  if (raw === undefined || raw === null) raw = {};
  if (!plainRecord(raw)) throw new Error("input_snapshot_limits must be an object when supplied");
  const ceilings = {
    max_items: MAX_INPUT_ITEMS,
    max_item_bytes: MAX_INPUT_ITEM_BYTES,
    max_total_bytes: MAX_INPUT_TOTAL_BYTES,
  };
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const value = Object.hasOwn(raw, key) ? raw[key] : ceiling;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`input_snapshot_limits.${key} must be an integer from 1 to ${ceiling}`);
    }
    return [key, value];
  }));
}

function normalizedInputRef(raw) {
  if (typeof raw === "string") {
    return {
      canonical_address: nonemptyText(raw, "input reference address"),
      expected_revision: null,
      expected_content_hash: null,
    };
  }
  if (!plainRecord(raw)) {
    throw new Error("every input_ref must be an address string or an addressed reference object");
  }
  const address = Object.hasOwn(raw, "canonical_address") ? raw.canonical_address : raw.address;
  const revision = Object.hasOwn(raw, "expected_revision")
    ? raw.expected_revision
    : raw.revision;
  const hash = Object.hasOwn(raw, "expected_content_hash")
    ? raw.expected_content_hash
    : (Object.hasOwn(raw, "content_hash") ? raw.content_hash : raw.payload_hash);
  return {
    canonical_address: nonemptyText(address, "input reference canonical_address"),
    expected_revision: revision === undefined || revision === null
      ? null
      : nonemptyText(revision, "input reference expected_revision"),
    expected_content_hash: hash === undefined || hash === null
      ? null
      : nonemptyText(hash, "input reference expected_content_hash"),
  };
}

function hydrateAddressedInputs(input, ownerRows) {
  const refs = extractInputRefs(input).map(normalizedInputRef);
  const limits = inputLimits(input);
  if (refs.length > limits.max_items) {
    throw new Error("addressed input item count exceeds input snapshot limit");
  }
  if (refs.length === 0) {
    if (ownerRows.length > 0) {
      throw new Error("addressed input owner rows supplied without input_refs");
    }
    return {
      kind: ADDRESSED_INPUT_SNAPSHOT_KIND,
      items: [],
      item_count: 0,
      content_bytes: 0,
      limits,
      snapshot_hash: sha256Text("[]"),
    };
  }

  const byAddress = new Map();
  for (const raw of ownerRows) {
    if (!plainRecord(raw)) throw new Error("addressed input owner reply contains a malformed row");
    const row = plainRecord(raw.payload) ? { ...raw.payload, ...raw, payload: raw.payload } : raw;
    const address = Object.hasOwn(row, "canonical_address") ? row.canonical_address : row.address;
    if (typeof address !== "string") continue;
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push(row);
  }

  const items = [];
  const seen = new Set();
  let totalBytes = 0;
  refs.forEach((ref, position) => {
    const address = ref.canonical_address;
    if (seen.has(address)) {
      throw new Error("addressed input references must not contain duplicate canonical addresses");
    }
    seen.add(address);
    const matches = byAddress.get(address) ?? [];
    if (matches.length !== 1) {
      throw new Error(`addressed input must resolve exactly one current authorized row: ${address}`);
    }
    const row = matches[0];
    if (row.found === false) throw new Error(`addressed input is missing: ${address}`);
    if (row.authorized === false || row.authorization === false) {
      throw new Error(`addressed input is unauthorized: ${address}`);
    }
    if (row.retracted === true || row.remove === true || row.payload === null || row.payload === undefined) {
      throw new Error(`addressed input is retracted: ${address}`);
    }
    const ownerHash = nonemptyText(
      row.content_hash ?? row.payload_hash,
      `addressed input content hash for ${address}`,
    );
    const revision = nonemptyText(
      row.current_revision ?? row.revision ?? ownerHash,
      `addressed input revision for ${address}`,
    );
    if (ref.expected_revision !== null && ref.expected_revision !== revision) {
      throw new Error(`addressed input is stale at ${address}: expected revision does not match current`);
    }
    if (ref.expected_content_hash !== null && ref.expected_content_hash !== ownerHash) {
      throw new Error(`addressed input is stale at ${address}: expected content hash does not match current`);
    }
    const ignored = new Set([
      "address", "canonical_address", "revision", "current_revision", "content_hash",
      "payload_hash", "found", "authorized", "retracted", "remove", "provenance",
      "authorization_provenance_ref",
    ]);
    const content = Object.hasOwn(row, "payload")
      ? row.payload
      : Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.has(key)));
    const normalized = canonicalJson(content);
    const contentBytes = Buffer.byteLength(normalized, "utf8");
    if (contentBytes > limits.max_item_bytes) {
      throw new Error(`addressed input exceeds per-item byte limit: ${address}`);
    }
    if (totalBytes + contentBytes > limits.max_total_bytes) {
      throw new Error("addressed inputs exceed total byte limit");
    }
    totalBytes += contentBytes;
    const provenance = row.provenance;
    if (provenance !== undefined && provenance !== null &&
      !plainRecord(provenance) && !Array.isArray(provenance) && typeof provenance !== "string") {
      throw new Error(`addressed input provenance is malformed: ${address}`);
    }
    items.push({
      position,
      canonical_address: address,
      expected_revision: revision,
      expected_content_hash: ownerHash,
      normalized_content_hash: sha256Text(normalized),
      content,
      content_bytes: contentBytes,
      provenance: provenance ?? { source: "current-owner-read" },
      authorization_provenance_ref: row.authorization_provenance_ref ?? null,
    });
  });
  return {
    kind: ADDRESSED_INPUT_SNAPSHOT_KIND,
    items,
    item_count: items.length,
    content_bytes: totalBytes,
    limits,
    snapshot_hash: sha256Text(canonicalJson(items)),
  };
}

function normalizedInstructionRef(raw) {
  if (typeof raw === "string") {
    return {
      id: nonemptyText(raw, "profile instruction reference"),
      expected_revision: null,
      expected_content_hash: null,
    };
  }
  if (!plainRecord(raw)) {
    throw new Error("every profile instruction_ref must be an id string or pinned reference object");
  }
  const id = Object.hasOwn(raw, "id") ? raw.id : (raw.ref ?? raw.instruction_ref);
  const revision = Object.hasOwn(raw, "expected_revision")
    ? raw.expected_revision
    : (raw.revision_ref ?? raw.revision);
  const hash = Object.hasOwn(raw, "expected_content_hash")
    ? raw.expected_content_hash
    : (raw.content_hash ?? raw.body_hash);
  return {
    id: nonemptyText(id, "profile instruction reference id"),
    expected_revision: revision === undefined || revision === null
      ? null
      : nonemptyText(revision, "profile instruction expected_revision"),
    expected_content_hash: hash === undefined || hash === null
      ? null
      : nonemptyText(hash, "profile instruction expected_content_hash"),
  };
}

function validateSelection(profile, refs) {
  const raw = profile.instruction_selection;
  if (raw === undefined || raw === null) return null;
  if (!plainRecord(raw) || raw.kind !== PROFILE_INSTRUCTION_SELECTION_KIND) {
    throw new Error("profile instruction_selection kind is missing or unsupported");
  }
  const revision = nonemptyText(raw.revision, "profile instruction_selection revision");
  const sourceSetRef = nonemptyText(raw.source_set_ref, "profile instruction_selection source_set_ref");
  let resolveMode = raw.resolve_mode;
  if (resolveMode !== undefined && resolveMode !== null) {
    resolveMode = nonemptyText(resolveMode, "profile instruction_selection resolve_mode");
    if (resolveMode !== "by-set-live") {
      throw new Error("profile instruction_selection resolve_mode is unsupported");
    }
  }
  const maxBytes = raw.max_total_bytes;
  const ceiling = resolveMode === "by-set-live"
    ? MAX_MATERIALIZED_INSTRUCTION_BYTES
    : MAX_INSTRUCTION_TOTAL_BYTES;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ceiling) {
    throw new Error("profile instruction_selection max_total_bytes must be a positive integer within the producer ceiling");
  }
  const rawCandidates = raw.candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0 || rawCandidates.length > 256) {
    throw new Error("profile instruction_selection candidates must be a non-empty ordered list within the hard limit");
  }
  const candidates = [];
  const seen = new Set();
  const included = [];
  for (const candidate of rawCandidates) {
    if (!plainRecord(candidate)) {
      throw new Error("profile instruction_selection candidate must be an object");
    }
    const instructionRef = nonemptyText(
      candidate.instruction_ref,
      "profile instruction_selection candidate instruction_ref",
    );
    if (seen.has(instructionRef)) {
      throw new Error("profile instruction_selection candidates must not contain duplicates");
    }
    seen.add(instructionRef);
    if (candidate.disposition !== "include" && candidate.disposition !== "exclude") {
      throw new Error("profile instruction_selection candidate disposition must be include or exclude");
    }
    const reasonRef = nonemptyText(
      candidate.reason_ref,
      "profile instruction_selection candidate reason_ref",
    );
    candidates.push({
      instruction_ref: instructionRef,
      disposition: candidate.disposition,
      reason_ref: reasonRef,
    });
    if (candidate.disposition === "include") included.push(instructionRef);
  }
  if (included.join("\0") !== refs.map((ref) => ref.id).join("\0")) {
    throw new Error("profile instruction_selection included candidates must exactly match ordered instruction_refs");
  }
  const basis = {
    kind: PROFILE_INSTRUCTION_SELECTION_KIND,
    revision,
    source_set_ref: sourceSetRef,
    max_total_bytes: maxBytes,
    candidates,
  };
  const selectionHash = nonemptyText(raw.selection_hash, "profile instruction_selection selection_hash");
  if (selectionHash !== sha256Text(canonicalJson(basis))) {
    throw new Error("profile instruction_selection selection_hash mismatch");
  }
  const result = { ...basis, selection_hash: selectionHash };
  if (resolveMode !== undefined && resolveMode !== null) result.resolve_mode = resolveMode;
  for (const field of ["mount_scope", "on_demand_corpus_set_ref"]) {
    if (raw[field] !== undefined && raw[field] !== null) {
      result[field] = nonemptyText(raw[field], `profile instruction_selection ${field}`);
    }
  }
  return result;
}

function selectedProfile(agentId, rows) {
  const matches = rows
    .map((row) => payloadOfKind(row, "ai-agent-profile"))
    .filter((payload) => payload && payload.id === agentId);
  if (matches.length > 1) {
    throw new Error(`selected profile must resolve exactly one current row: ${agentId}`);
  }
  return matches[0] ?? null;
}

function hydrateProfileInstructions(agentId, profileRows, instructionRows, materialization, requestId) {
  const limits = {
    max_items: MAX_INSTRUCTION_ITEMS,
    max_item_bytes: MAX_INSTRUCTION_ITEM_BYTES,
    max_total_bytes: MAX_INSTRUCTION_TOTAL_BYTES,
  };
  const snapshot = {
    kind: PROFILE_INSTRUCTION_SNAPSHOT_KIND,
    profile_id: agentId,
    profile_revision: null,
    profile_content_hash: null,
    items: [],
    item_count: 0,
    content_bytes: 0,
    limits,
    snapshot_hash: sha256Text("[]"),
  };
  if (!agentId) return snapshot;
  const profile = selectedProfile(agentId, profileRows);
  if (!profile) return snapshot;
  const rawRefs = profile.instruction_refs ?? [];
  if (!Array.isArray(rawRefs)) {
    throw new Error(`selected profile instruction_refs must be an ordered list: ${agentId}`);
  }
  if (rawRefs.length > MAX_INSTRUCTION_ITEMS) {
    throw new Error("selected profile instruction count exceeds hard limit");
  }
  const refs = rawRefs.map(normalizedInstructionRef);
  const selection = validateSelection(profile, refs);
  const profileHash = sha256Text(canonicalJson(profile));
  const profileRevision = asString(profile.revision_ref) ?? asString(profile.revision) ?? profileHash;
  snapshot.profile_revision = profileRevision;
  snapshot.profile_content_hash = profileHash;
  if (selection) snapshot.instruction_selection = selection;

  if (selection?.resolve_mode === "by-set-live") {
    if (instructionRows.length > 0) {
      throw new Error("by-set-live profile instructions must arrive only through CAS materialization");
    }
    if (!plainRecord(materialization)) {
      throw new Error("by-set-live profile instruction materialization is required");
    }
    if (!selection.source_set_ref.startsWith("harness-set:") || selection.source_set_ref === "harness-set:") {
      throw new Error("by-set-live profile source_set_ref must name a harness-set");
    }
    const contentHash = nonemptyText(
      materialization.content_hash,
      "profile instruction materialization content_hash",
    );
    if (!contentHash.includes(":")) {
      throw new Error("profile instruction materialization content_hash is malformed");
    }
    const address = nonemptyText(materialization.address, "profile instruction materialization address");
    const expectedAddress = `package::ai-instruction-blocks::harness-prompt::${requestId}`;
    if (requestId && address !== expectedAddress) {
      throw new Error("profile instruction materialization address does not match request_id");
    }
    const bytes = materialization.content_bytes ?? materialization.bytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > selection.max_total_bytes) {
      throw new Error("profile instruction materialization bytes exceed selection limit");
    }
    const blockCount = materialization.block_count;
    if (typeof blockCount !== "number" || !Number.isSafeInteger(blockCount) || blockCount <= 0) {
      throw new Error("profile instruction materialization block_count must be positive");
    }
    if (!Array.isArray(materialization.missing) || materialization.missing.length !== 0) {
      throw new Error("profile instruction materialization must have no missing blocks");
    }
    const receipt = {
      address,
      content_hash: contentHash,
      bytes,
      block_count: blockCount,
      missing: [],
    };
    const { candidates, ...compactSelection } = selection;
    snapshot.instruction_selection = {
      ...compactSelection,
      candidate_count: candidates.length,
      included_count: candidates.filter((item) => item.disposition === "include").length,
      excluded_count: candidates.filter((item) => item.disposition === "exclude").length,
    };
    snapshot.delivery_mode = "cas-system-prompt";
    snapshot.materialization = receipt;
    snapshot.content_bytes = bytes;
    snapshot.limits.max_total_bytes = selection.max_total_bytes;
    snapshot.snapshot_hash = sha256Text(canonicalJson({
      profile_id: agentId,
      profile_revision: profileRevision,
      profile_content_hash: profileHash,
      instruction_selection: selection,
      delivery_mode: "cas-system-prompt",
      materialization: receipt,
    }));
    return snapshot;
  }
  if (materialization !== null && materialization !== undefined) {
    throw new Error("profile instruction materialization was supplied for a direct profile");
  }

  const byId = new Map();
  for (const row of instructionRows) {
    const payload = payloadOfKind(row, "ai-instruction-block");
    const id = payload ? asString(payload.id) : null;
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ row, payload });
  }
  const items = [];
  const seen = new Set();
  let totalBytes = 0;
  refs.forEach((ref, position) => {
    if (seen.has(ref.id)) {
      throw new Error("selected profile instruction_refs must not contain duplicates");
    }
    seen.add(ref.id);
    const matches = byId.get(ref.id) ?? [];
    if (matches.length !== 1) {
      throw new Error(`profile instruction must resolve exactly one current owner row: ${ref.id}`);
    }
    const { row, payload } = matches[0];
    if (payload.status && !["active", "available", "enabled"].includes(payload.status)) {
      throw new Error(`profile instruction is not active: ${ref.id}`);
    }
    const body = payload.body;
    if (typeof body !== "string" || !body.trim() || body.includes("\0")) {
      throw new Error(`profile instruction body is missing or malformed: ${ref.id}`);
    }
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > MAX_INSTRUCTION_ITEM_BYTES) {
      throw new Error(`profile instruction exceeds per-item byte limit: ${ref.id}`);
    }
    const totalLimit = selection ? selection.max_total_bytes : MAX_INSTRUCTION_TOTAL_BYTES;
    if (totalBytes + bodyBytes > totalLimit) {
      throw new Error("selected profile instructions exceed total byte limit");
    }
    totalBytes += bodyBytes;
    const bodyHash = sha256Text(body);
    const ownerHash = asString(row.content_hash) ??
      asString(row.payload_hash) ??
      asString(payload.content_hash) ??
      asString(payload.source_hash) ??
      bodyHash;
    const revision = asString(row.current_revision) ??
      asString(row.revision) ??
      asString(payload.revision_ref) ??
      asString(payload.revision) ??
      ownerHash;
    if (ref.expected_revision !== null && ref.expected_revision !== revision) {
      throw new Error(`profile instruction is stale at ${ref.id}: revision mismatch`);
    }
    if (ref.expected_content_hash !== null &&
      ref.expected_content_hash !== ownerHash && ref.expected_content_hash !== bodyHash) {
      throw new Error(`profile instruction is stale at ${ref.id}: content hash mismatch`);
    }
    items.push({
      position,
      id: ref.id,
      revision,
      owner_content_hash: ownerHash,
      body_hash: bodyHash,
      body_bytes: bodyBytes,
      body,
    });
  });
  snapshot.items = items;
  snapshot.item_count = items.length;
  snapshot.content_bytes = totalBytes;
  snapshot.snapshot_hash = sha256Text(canonicalJson({
    profile_id: agentId,
    profile_revision: profileRevision,
    profile_content_hash: profileHash,
    items: items.map(({ body, ...item }) => item),
  }));
  return snapshot;
}

function profilePrompt(snapshot) {
  if (snapshot.items.length === 0) return "";
  return `${[
    "Selected agent instructions (ordered current-owner snapshot):",
    ...snapshot.items.map((item) => `\n[Instruction ${item.position + 1}: ${item.id}]\n${item.body}`),
  ].join("\n")}\n\nUser request:\n`;
}

function profileReceipt(snapshot) {
  const { items, ...rest } = snapshot;
  return { ...rest, items: items.map(({ body, ...item }) => item) };
}

function firstDefaultModel(models) {
  if (!Array.isArray(models)) return null;
  for (const model of models) {
    if (plainRecord(model) && (model.isDefault === true || model.is_default === true) && asString(model.id)) {
      return model.id;
    }
  }
  for (const model of models) {
    if (plainRecord(model) && asString(model.id)) return model.id;
  }
  return null;
}

function cliIdentityMatches(cli, requested) {
  if (!requested) return false;
  if (cli.subject_id === requested || cli["prop:cli_registry:cli"] === requested) return true;
  const subject = asString(cli.subject_id);
  return Boolean(subject && (subject === `cli:${requested}` ||
    (subject.includes(":") && subject.slice(subject.lastIndexOf(":") + 1) === requested)));
}

function cliSupportsModel(cli, model) {
  if (!model || !Array.isArray(cli["prop:cli_registry:models"])) return false;
  return cli["prop:cli_registry:models"].some((entry) => {
    if (!plainRecord(entry)) return false;
    return (asString(entry.id) ?? asString(entry.model)) === model;
  });
}

function resolveCliByModel(clis, model) {
  return model ? clis.find((cli) => cliSupportsModel(cli, model)) ?? null : null;
}

function comparePolicyValues(left, right, missing) {
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    const missingOrder = missing === "first" ? -1 : 1;
    return leftMissing ? missingOrder : -missingOrder;
  }
  if (typeof left === "number" && typeof right === "number") return left - right;
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function providerMatchesCondition(provider, condition) {
  if (!plainRecord(condition) || !asString(condition.property_id)) {
    throw new Error("automatic provider routing policy contains an invalid eligibility condition");
  }
  const value = provider[condition.property_id];
  if (Object.hasOwn(condition, "equals")) return canonicalJson(value) === canonicalJson(condition.equals);
  if (Array.isArray(condition.in)) return condition.in.some((candidate) => canonicalJson(candidate) === canonicalJson(value));
  if (Array.isArray(condition.contains_all)) {
    return Array.isArray(value) && condition.contains_all.every((candidate) => value.includes(candidate));
  }
  throw new Error("automatic provider routing policy condition has no supported comparison");
}

/**
 * Empty selection is resolved only by open provider DATA. The policy row names
 * the eligibility fields and sort fields; this function knows no provider,
 * transport, locality, pricing plan, or machine path. A missing policy or an
 * ineligible provider is customer setup state, never permission to pick the
 * first transport installed on the machine.
 */
function resolveProvider(providers) {
  const policyRows = providers.filter((provider) => plainRecord(provider["prop:provider_routing:policy"]));
  if (policyRows.length === 0) {
    throw new Error("No available AI is connected. Connect an AI provider to continue.");
  }
  if (policyRows.length !== 1) throw new Error("automatic provider routing policy must resolve exactly one row");
  const policy = policyRows[0]["prop:provider_routing:policy"];
  if (policy.kind !== "ai-provider-routing-policy" || !Array.isArray(policy.eligibility)
    || !Array.isArray(policy.order_by) || policy.order_by.length === 0) {
    throw new Error("automatic provider routing policy is malformed");
  }
  const eligible = providers
    .filter((provider) => asString(provider["prop:provider:vendor"]))
    .filter((provider) => policy.eligibility.every((condition) => providerMatchesCondition(provider, condition)));
  eligible.sort((left, right) => {
    for (const order of policy.order_by) {
      if (!plainRecord(order) || !asString(order.property_id)
        || !["asc", "desc"].includes(order.direction)
        || ![undefined, "first", "last"].includes(order.missing)) {
        throw new Error("automatic provider routing policy contains an invalid ordering rule");
      }
      const compared = comparePolicyValues(left[order.property_id], right[order.property_id], order.missing);
      if (compared !== 0) return order.direction === "desc" ? -compared : compared;
    }
    return String(left.subject_id).localeCompare(String(right.subject_id));
  });
  if (eligible.length === 0) {
    throw new Error("No available AI is connected. Connect an AI provider to continue.");
  }
  return eligible[0];
}

function resolveRequestedModel(modelRef, rows) {
  if (!modelRef) return { modelId: "", providerRef: null };
  if (!modelRef.startsWith("ai-model-descriptor:")) {
    return { modelId: modelRef, providerRef: null };
  }
  const matches = rows
    .map((row) => plainRecord(row?.payload) ? row.payload : row)
    .filter((row) => plainRecord(row) && row.kind === "ai-model-descriptor" && row.id === modelRef);
  if (matches.length !== 1 || matches[0].status !== "available") {
    throw new Error("requested model descriptor must resolve exactly one available row");
  }
  const modelId = asString(matches[0].model_id);
  const providerRef = asString(matches[0].provider_ref);
  if (!modelId || !providerRef) throw new Error("requested model descriptor is incomplete");
  return { modelId, providerRef };
}

function resolveProviderByRef(providers, providerRef) {
  if (!providerRef) return null;
  const bare = providerRef.replace(/^(?:ai_)?provider:/, "");
  const matches = providers.filter((provider) => {
    const keys = providerKeys(provider);
    return keys.has(providerRef) || keys.has(bare) || keys.has(`provider:${bare}`);
  });
  if (matches.length !== 1) throw new Error("requested model provider must resolve exactly one row");
  return matches[0];
}

function providerKeys(provider) {
  const keys = new Set([provider.provider_id]);
  const vendor = asString(provider["prop:provider:vendor"]);
  if (vendor) keys.add(vendor).add(`provider:${vendor}`);
  return keys;
}

function resolveCli(provider, clis, requested) {
  if (requested) {
    const found = clis.find((cli) => cliIdentityMatches(cli, requested));
    if (found) return found;
  }
  if (!provider) return null;
  const keys = providerKeys(provider);
  const forProvider = clis.filter((cli) => {
    const ids = cli["prop:cli_registry:provider_ids"];
    return Array.isArray(ids) && ids.some((id) => typeof id === "string" && keys.has(id));
  });
  // More than one CLI can claim the same provider, and only some of them carry a
  // chat_launch descriptor. Taking the first match made the choice depend on row
  // order: a launch-less registry entry for the same vendor won, and the run died
  // at "CLI registry entry has no chat_launch descriptor" while a fully runnable
  // entry for that exact provider sat further down the list. A CLI with no launch
  // descriptor is not a way to run, so it is not preferred over one that is.
  return forProvider.find((cli) => plainRecord(cli["prop:cli_registry:chat_launch"]))
    ?? forProvider[0]
    ?? null;
}

function resolveCliForProvider(provider, clis, model) {
  if (!provider) return null;
  const keys = providerKeys(provider);
  const matches = clis.filter((cli) => {
    const ids = cli["prop:cli_registry:provider_ids"];
    const launch = cli["prop:cli_registry:chat_launch"];
    const transport = plainRecord(launch) ? asString(launch.transport) ?? "process" : null;
    return (transport === "http" || transport === "process") &&
      Array.isArray(ids) && ids.some((id) => typeof id === "string" && keys.has(id));
  });
  const modelMatches = model ? matches.filter((cli) => cliSupportsModel(cli, model)) : [];
  const eligible = model ? modelMatches : matches;
  if (eligible.length > 1) throw new Error("requested model provider has ambiguous CLI transports");
  return eligible[0] ?? null;
}

function shouldUseArgument(argument, context) {
  const condition = argument.when;
  if (condition === undefined || condition === null) return true;
  if (condition === "new") return context.resume !== true;
  if (condition === "resume") return context.resume === true;
  return Boolean(context[condition]);
}

function renderArgument(argument, context) {
  if (typeof argument === "string") return argument;
  if (!plainRecord(argument) || !shouldUseArgument(argument, context)) return null;
  const literal = asString(argument.literal);
  if (literal) return literal;
  const key = asString(argument.value);
  const value = key ? context[key] : null;
  if (typeof value === "string" && value) return value;
  return argument.optional === true ? null : "";
}

function renderEnv(launch) {
  const env = {};
  for (const binding of launch.env ?? []) {
    if (!plainRecord(binding) || !plainRecord(binding.source) || binding.source.from !== "account") continue;
    const path = binding.source.path;
    const name = asString(binding.name);
    if (!name || !Array.isArray(path) || !path.every((part) => typeof part === "string")) continue;
    let value = binding.source;
    for (const part of [null, ...path]) value = part === null ? binding : value?.[part];
    if (typeof value === "string" && value) env[name] = value;
  }
  return env;
}

function renderArgvAndCwd(launch, context) {
  if (!Array.isArray(launch.argv)) throw new Error("Selected CLI has no chat launch argv descriptor");
  const argv = launch.argv.map((item) => renderArgument(item, context)).filter((item) => item !== null);
  if (argv.length === 0) throw new Error("Selected CLI launch descriptor rendered an empty argv");
  const cwd = launch.cwd === "projectPath"
    ? asString(context.projectPath) ?? "."
    : asString(launch.cwd) ?? ".";
  return { argv, cwd };
}

function portablePath(value) {
  return value.startsWith("/") || value.includes("\\") || value.split("/").includes("..");
}

function buildProcessDescriptor(launch, context) {
  for (const field of ["sandbox_profile", "capture_stdout", "capture_stderr"]) {
    if (Object.hasOwn(launch, field)) throw new Error(`Selected CLI uses retired process field: ${field}`);
  }
  const { argv, cwd } = renderArgvAndCwd(launch, context);
  if (portablePath(argv[0])) throw new Error("Selected CLI argv[0] must be a portable runtime alias or executable input mount");
  if (portablePath(cwd)) {
    throw new Error("Selected CLI launch cwd must be portable process-root data; materialize project bytes through input_trees");
  }
  const inputs = Array.isArray(launch.inputs) ? [...launch.inputs] : [];
  const promptHash = asString(context.system_prompt_content_hash);
  const promptPath = asString(context.system_prompt_path);
  if (promptHash || promptPath) {
    if (!promptHash || !promptPath || portablePath(promptPath)) {
      throw new Error("materialized system prompt requires a portable relative path and content hash");
    }
    if (inputs.some((entry) => plainRecord(entry) && entry.mount_path === promptPath)) {
      throw new Error("materialized system prompt mount path collides with launch inputs");
    }
    inputs.push({
      mount_path: promptPath,
      content_type: "text/markdown",
      source: { kind: "blob_ref", hash: promptHash },
    });
  }
  const inputTrees = Array.isArray(launch.input_trees) ? launch.input_trees : [];
  if (argv[0].includes("/") && inputTrees.length === 0) {
    const mounts = new Set(inputs
      .filter((entry) => plainRecord(entry) && entry.executable === true)
      .map((entry) => entry.mount_path));
    if (!mounts.has(argv[0])) throw new Error("Relative CLI argv[0] must name an executable input mount");
  }
  return {
    argv,
    cwd: cwd === "." ? null : cwd,
    timeout_ms: Number.isSafeInteger(launch.timeout_ms) && launch.timeout_ms > 0 ? launch.timeout_ms : 300000,
    termination_grace_ms: 1000,
    expected_termination: null,
    env: renderEnv(launch),
    inputs,
    input_trees: inputTrees,
    outputs: Array.isArray(launch.outputs) ? launch.outputs : [],
    containment: {
      kind: "descendant_effect_contained",
      pipe_eof_timeout_ms: 1000,
      publications: [],
    },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

export function substitute(node, subs) {
  if (typeof node === "string") {
    let result = node;
    for (const [key, value] of Object.entries(subs)) {
      result = result.replaceAll(`{{${key}}}`, scalarText(value)).replaceAll(`{${key}}`, scalarText(value));
    }
    return result;
  }
  // A sequence node standing inside a list means "the items of this binding go
  // here", not "one element that is a list". Mapping element-wise produced a
  // nested array, and the model answered HTTP 400 "Expected an object, got
  // array" against a body that looked right in every local test, because no
  // local test rendered a sequence inside a list. An element that renders to
  // nothing is dropped rather than left as a null the wire format has to carry.
  if (Array.isArray(node)) {
    const rendered = [];
    for (const value of node) {
      if (plainRecord(value) && value.$kind === "template.sequence") {
        rendered.push(...substitute(value, subs));
        continue;
      }
      const item = substitute(value, subs);
      if (item === undefined) continue;
      rendered.push(item);
    }
    return rendered;
  }
  if (!plainRecord(node)) return node;
  if (node.$kind === "template.value") return Object.hasOwn(subs, node.binding) ? subs[node.binding] : undefined;
  if (node.$kind === "template.sequence") {
    const value = Object.hasOwn(subs, node.binding) ? subs[node.binding] : [];
    return Array.isArray(value) ? value : [];
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substitute(value, subs)]));
}

export function referencesBinding(node, binding) {
  if (typeof node === "string") return node.includes(`{{${binding}}}`) || node.includes(`{${binding}}`);
  if (Array.isArray(node)) return node.some((value) => referencesBinding(value, binding));
  if (!plainRecord(node)) return false;
  if (node.$kind === "template.value" && node.binding === binding) return true;
  return Object.values(node).some((value) => referencesBinding(value, binding));
}

function buildHttpDescriptor(launch, context) {
  const url = asString(launch.url);
  if (!url) throw new Error("cloud (http) launch descriptor has no url");
  const apiModel = asString(launch.api_model) ?? asString(context.model) ?? "";
  const subs = {
    ...context,
    prompt: context.prompt ?? "",
    api_model: apiModel,
    model_id: apiModel,
  };
  const bodyTemplate = launch.body_template;
  if (bodyTemplate === undefined || bodyTemplate === null) {
    throw new Error("cloud (http) launch descriptor has no body_template");
  }
  if (Object.hasOwn(context, "system_prompt") && !referencesBinding(bodyTemplate, "system_prompt")) {
    throw new Error("http-body-template transport must consume the system_prompt binding");
  }
  const injections = [];
  if (plainRecord(launch.credential) && plainRecord(launch.credential.placement) &&
    asString(launch.credential.secret_name)) {
    injections.push({
      secret_name: launch.credential.secret_name,
      placement: launch.credential.placement,
    });
  }
  return {
    url: substitute(url, subs),
    method: asString(launch.method) ?? "POST",
    headers: plainRecord(launch.headers) ? launch.headers : { "Content-Type": "application/json" },
    body: Array.from(new TextEncoder().encode(JSON.stringify(substitute(bodyTemplate, subs)))),
    credential_injections: injections,
    timeout_ms: Number.isSafeInteger(launch.timeout_ms) ? launch.timeout_ms : 120000,
  };
}

function buildTransport(launch, context) {
  const kind = asString(launch.transport) ?? "process";
  const callerContext = plainRecord(launch.context) ? launch.context : null;
  if (kind === "http") {
    const transport = {
      slot: asString(launch.target_slot) ?? "slot::http-client",
      payload: buildHttpDescriptor(launch, context),
      response_path: asString(launch.response_path) ?? "",
      response_extract: plainRecord(launch.response_extract) ? launch.response_extract : null,
    };
    if (callerContext) transport.context = callerContext;
    return transport;
  }
  if (kind === "process_session") {
    const process = buildProcessDescriptor(launch, context);
    process.timeout_ms = Number.isSafeInteger(launch.session_timeout_ms) && launch.session_timeout_ms > 0
      ? launch.session_timeout_ms
      : process.timeout_ms;
    process.outputs = [];
    const grid = plainRecord(launch.session_text_grid) ? launch.session_text_grid : null;
    const transport = {
      slot: "compute.process_session",
      payload: {
        operation: "start_session",
        descriptor: {
          process,
          session_settings: {
            text_grid: grid && Number.isSafeInteger(grid.columns) && Number.isSafeInteger(grid.rows)
              ? { columns: grid.columns, rows: grid.rows }
              : null,
          },
        },
      },
      response_path: "",
    };
    if (callerContext) transport.context = callerContext;
    return transport;
  }
  const transport = {
    slot: "compute.process",
    payload: buildProcessDescriptor(launch, context),
    response_path: "",
  };
  if (callerContext) transport.context = callerContext;
  return transport;
}

function readArg(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function requiredArg(args, name) {
  const value = readArg(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function buildRequest(args) {
  let parsedInput = {};
  try {
    parsedInput = JSON.parse(readArg(args, "input-json") || "{}");
  } catch {
    parsedInput = {};
  }
  const input = plainRecord(parsedInput) ? parsedInput : {};
  const instructionRows = parseRows(readArg(args, "instruction-rows-json"));
  let materialization = parseOptionalObject(
    readArg(args, "harness-materialization-json", "null"),
    "harness materialization",
  );
  const scalar = {
    address: readArg(args, "harness-materialization-address"),
    content_hash: readArg(args, "harness-materialization-content-hash"),
    bytes: readArg(args, "harness-materialization-bytes"),
    block_count: readArg(args, "harness-materialization-block-count"),
    missing: readArg(args, "harness-materialization-missing-json"),
  };
  if (Object.values(scalar).some(Boolean)) {
    if (materialization) throw new Error("harness materialization must use either JSON or scalar fields, not both");
    if (Object.values(scalar).some((value) => !value)) {
      throw new Error("harness materialization scalar fields must be supplied together");
    }
    let missing;
    let bytes;
    let blockCount;
    try {
      missing = JSON.parse(scalar.missing);
      bytes = Number(scalar.bytes);
      blockCount = Number(scalar.block_count);
    } catch {
      throw new Error("harness materialization scalar fields are malformed");
    }
    materialization = {
      address: scalar.address,
      content_hash: scalar.content_hash,
      bytes,
      block_count: blockCount,
      missing,
    };
    if (bytes >= 0 && blockCount === 0 && Array.isArray(missing) && missing.length === 0) {
      materialization = null;
    }
  }

  const producerInstructionRows = parseRows(readArg(args, "producer-instruction-rows-json"));
  const instructionText = asString(input.instruction_text) ?? "";
  let outputKind = asString(input.output_kind);
  const modelRef = asString(input.model) ?? "";
  const requestedAgent = asString(input.agent_ref) ?? "";
  const wrapRef = asString(input.wrap_instruction_ref) ?? "";
  let wrapPrefix = "";
  if (wrapRef) {
    const targetId = wrapRef.split("::").at(-1);
    const candidates = producerInstructionRows.length > 0 ? producerInstructionRows : instructionRows;
    for (const row of candidates) {
      const payload = plainRecord(row.payload) ? row.payload : row;
      if (plainRecord(payload) && payload.id === targetId) {
        wrapPrefix = asString(payload.wrap_prefix) ?? "";
        break;
      }
    }
  }
  const requestId = asString(input.request_id) ?? "";
  const addressedSnapshot = hydrateAddressedInputs(
    input,
    parseRows(readArg(args, "addressed-input-rows-json")),
  );

  const selectedAgentRows = parseRows(readArg(args, "selected-agent-rows-json"))
    .concat(parseRows(readArg(args, "selected-agent-pub-rows-json")));
  const profileRows = parseRows(readArg(args, "profile-rows-json"));
  const requestedModel = resolveRequestedModel(
    modelRef,
    parseRows(readArg(args, "model-descriptor-rows-json")),
  );
  const modelOverride = requestedModel.modelId;
  const providerRows = parseRows(readArg(args, "provider-rows-json"))
    .concat(parseRows(readArg(args, "provider-pub-rows-json")));
  const cliRows = parseRows(readArg(args, "cli-rows-json"))
    .concat(parseRows(readArg(args, "cli-pub-rows-json")));
  const providers = groupRows(providerRows, "provider_id");
  const clis = groupRows(cliRows, "cli_id");
  const descriptorProvider = requestedModel.providerRef
    ? resolveProviderByRef(providers, requestedModel.providerRef)
    : null;
  const descriptorCli = descriptorProvider ? resolveCliForProvider(descriptorProvider, clis, modelOverride) : null;
  if (descriptorProvider && !descriptorCli) {
    throw new Error("requested model provider has no matching CLI transport");
  }

  let agentId = requestedAgent;
  if (!agentId) {
    for (const raw of selectedAgentRows) {
      const row = factPayload(raw);
      if (row.subject_id === "selected-agent:current" && row.property_id === "prop:selected_agent:id") {
        try {
          const decoded = JSON.parse(row.value_json);
          if (typeof decoded === "string" && decoded.trim()) agentId = decoded.trim();
        } catch {
          if (typeof row.value_json === "string" && row.value_json.trim()) agentId = row.value_json.trim();
        }
        break;
      }
    }
  }

  const instructionSnapshot = hydrateProfileInstructions(
    agentId,
    profileRows,
    instructionRows,
    materialization,
    requestId,
  );
  const profile = agentId ? selectedProfile(agentId, profileRows) : null;
  let launch = profile ? (profile.process_launch ?? profile.processLaunch ?? profile.launch ?? null) : null;
  if (plainRecord(launch) && Object.keys(launch).length === 0) launch = null;
  const modelCli = resolveCliByModel(clis, modelOverride);
  if (plainRecord(launch)) {
    if (descriptorCli) {
      launch = null;
    } else if (!descriptorCli && modelCli &&
      asString(launch.model) !== modelOverride && asString(launch.model_id) !== modelOverride) {
      launch = null;
    }
  }
  if (!outputKind) outputKind = profile?.produce_output_kind ?? "note";

  let model = null;
  let cliId = "provider-fallback";
  let resolvedAgent;
  if (plainRecord(launch)) {
    model = asString(launch.model) ?? asString(launch.model_id);
    resolvedAgent = agentId ?? "selected-agent";
  } else {
    const explicitlySelectedCli = agentId ? clis.find((candidate) => cliIdentityMatches(candidate, agentId)) ?? null : null;
    const provider = descriptorProvider ?? (explicitlySelectedCli || modelCli ? null : resolveProvider(providers));
    let cli = descriptorCli ?? explicitlySelectedCli ?? resolveCli(provider, clis, agentId);
    if (!descriptorCli && modelCli && (!cli || !cliSupportsModel(cli, modelOverride))) cli = modelCli;
    const providerModel = provider ? asString(provider["prop:provider:model"]) : null;
    if (!plainRecord(cli)) {
      throw new Error("The connected AI has no usable way to run. Reconnect it or choose another provider.");
    }
    launch = cli["prop:cli_registry:chat_launch"];
    if (!plainRecord(launch)) throw new Error("CLI registry entry has no chat_launch descriptor");
    cliId = asString(cli["prop:cli_registry:cli"]) ?? asString(cli.subject_id) ?? "unknown";
    resolvedAgent = agentId && cliIdentityMatches(cli, agentId)
      ? `selected-cli/${cliId}`
      : modelOverride && modelCli === cli
        ? `model-routed/${cliId}`
        : `provider-fallback/${cliId}`;
    model = providerModel ?? firstDefaultModel(cli["prop:cli_registry:models"]);
  }
  if (modelOverride) model = modelOverride;

  const prompt = profilePrompt(instructionSnapshot) +
    (wrapPrefix ? wrapPrefix + instructionText : instructionText) +
    (addressedSnapshot.items.length > 0
      ? `\n\nAddressed input snapshot (immutable, ordered, and source-bound):\n${canonicalJson(addressedSnapshot)}`
      : "");
  const context = { prompt, model, resume: false, projectPath: "." };
  const materialized = instructionSnapshot.materialization;
  if (plainRecord(materialized)) {
    const transport = asString(launch.system_prompt_transport);
    if (transport === "system-prompt-file-flag") {
      context.system_prompt_path = asString(launch.system_prompt_path) ?? ".bitfield-harness/system-prompt.md";
      context.system_prompt_content_hash = materialized.content_hash;
    } else if (transport === "http-body-template") {
      if (asString(launch.transport) !== "http") {
        throw new Error("http-body-template system prompt requires an http launch");
      }
      const path = readArg(args, "harness-system-prompt-file");
      if (!path) throw new Error("http-body-template system prompt requires a mounted prompt file");
      let bytes = readFileSync(path);
      try {
        const decoded = JSON.parse(bytes.toString("utf8"));
        if (typeof decoded === "string") bytes = Buffer.from(decoded, "utf8");
      } catch {
        // Raw markdown remains itself.
      }
      if (bytes.length !== materialized.bytes) {
        throw new Error("mounted system prompt byte count does not match materialization receipt");
      }
      context.system_prompt = bytes.toString("utf8");
      context.system_prompt_content_hash = materialized.content_hash;
    } else {
      throw new Error("selected transport does not support hash-only system-prompt delivery");
    }
  }
  if (plainRecord(input.parameters)) {
    for (const [key, value] of Object.entries(input.parameters)) {
      if (key && !Object.hasOwn(context, key)) context[key] = scalarText(value);
    }
  }

  console.log(`[ai-records-producer] resolved agent=${resolvedAgent} cli=${cliId} model=${model ?? "(cli-default)"} wrap_ref=${wrapRef || "(none)"}`);
  return {
    request_id: requestId || null,
    partition_key: readArg(args, "partition-key"),
    instruction_text: instructionText,
    instruction_observability: profileReceipt(instructionSnapshot),
    addressed_input_snapshot: addressedSnapshot,
    prompt_hash: sha256Text(prompt),
    system_prompt_content_hash: materialized?.content_hash ?? null,
    target_group_ref: asString(input.target_group_ref),
    output_kind: outputKind,
    wrap_instruction_ref: wrapRef,
    resolved_agent: resolvedAgent,
    cli_id: cliId,
    model_id: model,
    stream_parse_spec: launch.stream_parse_spec,
    transport: buildTransport(launch, context),
  };
}

function main() {
  const args = process.argv.slice(2);
  requiredArg(args, "input-json");
  requiredArg(args, "partition-key");
  const output = requiredArg(args, "output-json");
  writeFileSync(output, `${JSON.stringify(buildRequest(args), null, 2)}\n`, "utf8");
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
