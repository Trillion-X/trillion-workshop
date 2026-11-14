// packages/live-namespace/read-data/residual-read-demand-from-receiver-facts.mjs
//
// PURPOSE
// Turn an exact demand for immutable bytes plus EXPLICIT verified receiver facts into the
// exact byte windows the receiver still lacks. Nothing here reads storage, names a network,
// trusts a similar representation, or assumes an omitted fact. It owns arithmetic and
// fail-closed admission only.
//
// NON-NEGOTIABLE INVARIANTS
//  1. Identity is EXACT wire identity text. A name, embedding, semantic key, equivalent hash,
//     or "same media" proxy is not this identity and is refused.
//  2. A fact counts only when it states the same receiver, state version, authorization, and
//     identity. Missing or different versions are errors, never implicit acceptance.
//  3. Cold accounting counts facts that the caller supplied. There is no cache inference and
//     no network-throughput estimate; a coverage ratio describes explicit facts, not speed.
//  4. The direct exact demand is always preserved. A receiver or owner may use it when facts
//     are stale or absent without this module inventing a source or protocol.
//  5. The full demand contract (plan section 14.4) is carried EXACTLY or refused. Fidelity is
//     exact or the demand is not a byte demand. A budget names every resource counter the
//     capability-edge owner names, with finite nonnegative bounds, or dispatch is not admitted.
//     A logical object is carried opaque and never becomes a byte fact. Freshness is the
//     receiver state version and deadline is the wall_time bound; neither gets a second field.
//  6. No budget means no admission. The plan stays arithmetic; nothing here executes.

import { DIRECT_EDGE_ID, DISPATCH_BUDGET_POLICY, RESOURCE_COUNTERS } from "./capability-edges.mjs";

const IDENTITY_TEXT = /^[0-9a-f]+:[0-9a-f]+$/;
// Named for what the shape IS, never an ordinal (L206).
export const RESIDUAL_READ_SHAPE = "live-namespace.residual-read-from-receiver-facts";
const SCHEMA_VERSION = RESIDUAL_READ_SHAPE;
// Closed by physics: bytes are either the original bytes or they are not.
const EXACT_FIDELITY = "exact";
// This owner computes byte windows. An exact-result demand belongs to the capability-edge
// owner whose edges declare their observable; it is refused here by name, never coerced.
const BYTE_SUBJECT_KIND = "immutable-bytes";
// Closed by physics: with zero verified facts a receiver either takes the direct exact read
// or takes nothing.
const NO_FACTS_POLICIES = new Set([DIRECT_EDGE_ID, "refuse"]);
const CURRENCY_TEXT = /^[A-Z]{3}$/;

export class ResidualDemandError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ResidualDemandError";
    this.details = details ?? {};
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidualDemandError(`${label} must be an object`, { field: label });
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length !== 0) {
    throw new ResidualDemandError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.sort(),
    });
  }
}

function sameAuthorization(left, right) {
  // Authorization is an exact opaque descriptor. Key order is irrelevant; an added, missing,
  // renamed, or retyped member is a mismatch.
  try {
    if (left == null || right == null || typeof left !== typeof right) return false;
    if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    for (const key of leftKeys) {
      const a = left[key];
      const b = right[key];
      if (a != null && b != null && typeof a === "object") {
        if (!sameAuthorization(a, b)) return false;
      } else if (a !== b) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function exactString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResidualDemandError(`${label} must be a non-empty string`, { field: label });
  }
  return value;
}

function demandRange(value) {
  const range = plainObject(value, "range");
  const fields = Object.keys(range);
  if (fields.length !== 2 || !fields.includes("offset") || !fields.includes("length")) {
    throw new ResidualDemandError("range must contain exactly offset and length", { field: "range" });
  }
  return validInterval(range, "range");
}

function validInterval(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidualDemandError(`${label} must be an object`, { field: label });
  }
  const { offset, length } = value;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ResidualDemandError(`${label}.offset must be a non-negative safe integer`, { field: label });
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new ResidualDemandError(`${label}.length must be a positive safe integer`, { field: label });
  }
  if (offset + length > Number.MAX_SAFE_INTEGER) {
    throw new ResidualDemandError(`${label} exceeds the safe integer byte address space`, { field: label });
  }
  return { offset, length };
}

function admittedFidelity(value) {
  if (value === undefined) return EXACT_FIDELITY;
  if (value !== EXACT_FIDELITY) {
    throw new ResidualDemandError("a byte demand is exact; a semantic or approximate result satisfies only its declared observable", {
      field: "demand.fidelity",
      received: value,
      expected: EXACT_FIDELITY,
    });
  }
  return value;
}

function admittedSubjectKind(value) {
  if (value === undefined) return BYTE_SUBJECT_KIND;
  if (value !== BYTE_SUBJECT_KIND) {
    throw new ResidualDemandError("this owner plans byte windows only; an exact-result demand belongs to the capability-edge owner", {
      field: "demand.subjectKind",
      received: value,
      expected: BYTE_SUBJECT_KIND,
      owner: "live-namespace capability-edges",
    });
  }
  return value;
}

function admittedLogicalObject(value) {
  if (value === undefined) return null;
  return exactString(value, "demand.logicalObject");
}

function admittedMonetaryBudget(value) {
  if (value === null) return null;
  const monetary = plainObject(value, "demand.budget.monetary");
  rejectUnknownFields(monetary, new Set(["amount_inclusive", "currency"]), "demand.budget.monetary");
  if (typeof monetary.amount_inclusive !== "number" || !Number.isFinite(monetary.amount_inclusive) || monetary.amount_inclusive < 0) {
    throw new ResidualDemandError("demand.budget.monetary.amount_inclusive must be a finite nonnegative number", {
      field: "demand.budget.monetary.amount_inclusive",
    });
  }
  if (typeof monetary.currency !== "string" || !CURRENCY_TEXT.test(monetary.currency)) {
    throw new ResidualDemandError("demand.budget.monetary.currency must be one declared currency code", {
      field: "demand.budget.monetary.currency",
    });
  }
  return { amount_inclusive: monetary.amount_inclusive, currency: monetary.currency };
}

function admittedBudget(value) {
  if (value === undefined) return null;
  const budget = plainObject(value, "demand.budget");
  rejectUnknownFields(budget, new Set(["resource", "monetary"]), "demand.budget");
  const resource = plainObject(budget.resource, "demand.budget.resource");
  const supplied = Object.keys(resource);
  const missing = RESOURCE_COUNTERS.filter((counter) => !supplied.includes(counter));
  const unknown = supplied.filter((counter) => !RESOURCE_COUNTERS.includes(counter));
  if (missing.length !== 0 || unknown.length !== 0) {
    throw new ResidualDemandError("demand.budget.resource must bound exactly the declared resource counters", {
      field: "demand.budget.resource",
      missing: missing.sort(),
      unknown: unknown.sort(),
      rule: DISPATCH_BUDGET_POLICY,
    });
  }
  for (const counter of RESOURCE_COUNTERS) {
    const bound = resource[counter];
    if (typeof bound !== "number" || !Number.isFinite(bound) || bound < 0) {
      throw new ResidualDemandError(`demand.budget.resource.${counter} must be a finite nonnegative upper bound`, {
        field: `demand.budget.resource.${counter}`,
        rule: DISPATCH_BUDGET_POLICY,
      });
    }
  }
  if (!("monetary" in budget)) {
    throw new ResidualDemandError("demand.budget.monetary must be stated, as an amount or as null", {
      field: "demand.budget.monetary",
    });
  }
  return {
    resource: Object.fromEntries(RESOURCE_COUNTERS.map((counter) => [counter, resource[counter]])),
    monetary: admittedMonetaryBudget(budget.monetary),
  };
}

function admittedFallbackPolicy(value) {
  if (value === undefined) return { whenNoVerifiedFacts: DIRECT_EDGE_ID };
  const policy = plainObject(value, "demand.fallbackPolicy");
  rejectUnknownFields(policy, new Set(["whenNoVerifiedFacts"]), "demand.fallbackPolicy");
  if (!NO_FACTS_POLICIES.has(policy.whenNoVerifiedFacts)) {
    throw new ResidualDemandError("demand.fallbackPolicy.whenNoVerifiedFacts must name the direct exact read or refuse", {
      field: "demand.fallbackPolicy.whenNoVerifiedFacts",
      expected: [...NO_FACTS_POLICIES],
      received: policy.whenNoVerifiedFacts,
    });
  }
  return { whenNoVerifiedFacts: policy.whenNoVerifiedFacts };
}

function admittedDemand(input) {
  const demand = plainObject(input, "demand");
  rejectUnknownFields(
    demand,
    new Set([
      "schemaVersion",
      "receiverId",
      "identity",
      "receiverStateVersion",
      "authorization",
      "range",
      "logicalObject",
      "subjectKind",
      "fidelity",
      "budget",
      "fallbackPolicy",
    ]),
    "demand",
  );
  if (demand.schemaVersion !== SCHEMA_VERSION) {
    throw new ResidualDemandError("demand schema version mismatch", {
      expected: SCHEMA_VERSION,
      received: demand.schemaVersion,
    });
  }
  const receiverId = exactString(demand.receiverId, "demand.receiverId");
  const identity = exactString(demand.identity, "demand.identity");
  if (!IDENTITY_TEXT.test(identity)) {
    throw new ResidualDemandError("identity must be exact lowercase multihash text", { field: "demand.identity" });
  }
  const receiverStateVersion = exactString(demand.receiverStateVersion, "demand.receiverStateVersion");
  const authorization = plainObject(demand.authorization, "demand.authorization");
  if (Object.keys(authorization).length === 0) {
    throw new ResidualDemandError("authorization must not be empty", { field: "demand.authorization" });
  }
  return {
    receiverId,
    identity,
    receiverStateVersion,
    authorization,
    range: demandRange(demand.range),
    logicalObject: admittedLogicalObject(demand.logicalObject),
    subjectKind: admittedSubjectKind(demand.subjectKind),
    fidelity: admittedFidelity(demand.fidelity),
    budget: admittedBudget(demand.budget),
    fallbackPolicy: admittedFallbackPolicy(demand.fallbackPolicy),
  };
}

function feasibilityAgainstBudget(budget, missingBytes) {
  if (budget === null) {
    return {
      budgetSupplied: false,
      admitted: false,
      rule: "no budget means no admission; the plan is arithmetic only",
      exceeded: [],
    };
  }
  // payload_bytes is the one counter this owner can compare before work: the exact holes
  // are the only bytes the plan moves. Every other bound is carried to whoever dispatches.
  const exceeded = missingBytes > budget.resource.payload_bytes
    ? [{ counter: "payload_bytes", required: missingBytes, bound: budget.resource.payload_bytes }]
    : [];
  return {
    budgetSupplied: true,
    admitted: exceeded.length === 0,
    rule: DISPATCH_BUDGET_POLICY,
    exceeded,
  };
}

function admittedFact(rawFact, index, demand) {
  const fact = plainObject(rawFact, `receiverFact[${index}]`);
  rejectUnknownFields(
    fact,
    new Set([
      "schemaVersion",
      "receiverId",
      "identity",
      "receiverStateVersion",
      "authorization",
      "interval",
      "verified",
    ]),
    `receiverFact[${index}]`,
  );
  if (fact.schemaVersion !== SCHEMA_VERSION) {
    throw new ResidualDemandError(`receiverFact[${index}] schema version mismatch`, {
      expected: SCHEMA_VERSION,
      received: fact.schemaVersion,
    });
  }
  if (fact.verified !== true) {
    throw new ResidualDemandError(`receiverFact[${index}] is not explicitly verified`, { index });
  }
  if (fact.receiverId !== demand.receiverId) {
    throw new ResidualDemandError(`receiverFact[${index}] receiver mismatch`, { index });
  }
  if (fact.identity !== demand.identity) {
    // This is also the semantic-proxy gate. Every spelling other than exact identity text,
    // including a name or alternate representation, fails here instead of contributing bytes.
    throw new ResidualDemandError(`receiverFact[${index}] identity mismatch`, { index });
  }
  if (fact.receiverStateVersion !== demand.receiverStateVersion) {
    throw new ResidualDemandError(`receiverFact[${index}] receiver state version mismatch`, { index });
  }
  if (!sameAuthorization(fact.authorization, demand.authorization)) {
    throw new ResidualDemandError(`receiverFact[${index}] authorization mismatch`, { index });
  }
  return validInterval(fact.interval, `receiverFact[${index}].interval`);
}

function mergeWithinDemand(intervals, demandRangeValue) {
  const start = demandRangeValue.offset;
  const end = demandRangeValue.offset + demandRangeValue.length;
  const bounded = intervals
    .map(({ offset, length }) => ({ from: Math.max(offset, start), to: Math.min(offset + length, end) }))
    .filter(({ from, to }) => from < to)
    .sort((left, right) => left.from - right.from || left.to - right.to);

  const merged = [];
  for (const interval of bounded) {
    const last = merged[merged.length - 1];
    // Adjacent intervals merge too: they describe one known byte run.
    if (last != null && interval.from <= last.to) {
      last.to = Math.max(last.to, interval.to);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.map(({ from, to }) => ({ offset: from, length: to - from }));
}

/**
 * Build a pure residual read plan. Neither input is mutated.
 *
 * @param {object} input An exact demand plus a finite array of explicitly verified facts.
 * @returns {object} Missing exact windows and the preserved direct exact fallback.
 */
export function residualReadDemandFromReceiverFacts({ demand, receiverFacts }) {
  if (!Array.isArray(receiverFacts)) {
    throw new ResidualDemandError("receiverFacts must be an array", { field: "receiverFacts" });
  }
  const admitted = admittedDemand(demand);
  // Validate every fact before emitting any plan, so a hostile mix cannot produce a partially
  // trusted answer.
  const intervals = receiverFacts.map((fact, index) => admittedFact(fact, index, admitted));
  const known = mergeWithinDemand(intervals, admitted.range);

  const missing = [];
  let cursor = admitted.range.offset;
  for (const { offset, length } of known) {
    if (offset > cursor) missing.push({ offset: cursor, length: offset - cursor });
    cursor = offset + length;
  }
  const end = admitted.range.offset + admitted.range.length;
  if (cursor < end) missing.push({ offset: cursor, length: end - cursor });

  const knownBytes = known.reduce((sum, { length }) => sum + length, 0);
  const missingBytes = missing.reduce((sum, { length }) => sum + length, 0);
  if (knownBytes === 0 && admitted.fallbackPolicy.whenNoVerifiedFacts === "refuse") {
    throw new ResidualDemandError("no verified fact covers this demand and the receiver refused the direct exact read", {
      field: "demand.fallbackPolicy.whenNoVerifiedFacts",
      factsSupplied: receiverFacts.length,
    });
  }
  const feasibility = feasibilityAgainstBudget(admitted.budget, missingBytes);
  if (feasibility.budgetSupplied && !feasibility.admitted) {
    // The direct read moves at least as many bytes as the holes, so no fallback fits either.
    throw new ResidualDemandError("the exact holes exceed the demand's resource budget", {
      field: "demand.budget.resource",
      exceeded: feasibility.exceeded,
    });
  }
  const exactRead = (interval) => ({
    kind: "live-namespace.exact-read",
    identity: admitted.identity,
    ...interval,
  });

  return {
    kind: "live-namespace.residual-read-plan",
    schemaVersion: SCHEMA_VERSION,
    identity: admitted.identity,
    receiverId: admitted.receiverId,
    receiverStateVersion: admitted.receiverStateVersion,
    missing: missing.map(exactRead),
    fallback: {
      ...exactRead(admitted.range),
      useWhen: "facts are absent, stale, or do not converge",
    },
    demandContract: {
      logicalObject: admitted.logicalObject,
      immutableVersion: admitted.identity,
      observable: { kind: "byte-range", ...admitted.range },
      subjectKind: admitted.subjectKind,
      fidelity: admitted.fidelity,
      freshness: {
        owner: "receiverStateVersion",
        value: admitted.receiverStateVersion,
        rule: "facts from any other receiver state version are refused",
      },
      deadline: {
        owner: "budget.resource.wall_time",
        value: admitted.budget === null ? null : admitted.budget.resource.wall_time,
      },
      budget: admitted.budget,
      fallbackPolicy: admitted.fallbackPolicy,
    },
    feasibility,
    monetaryAccounting: {
      budget: admitted.budget === null ? null : admitted.budget.monetary,
      priced: false,
      rule: "this owner carries a monetary ceiling and prices nothing; a price owner must be supplied to admit spend",
    },
    coldAccounting: {
      basis: "only receiverFacts explicitly supplied to this call",
      factsSupplied: receiverFacts.length,
      hiddenFactPolicy: "none",
      demandBytes: admitted.range.length,
      explicitVerifiedBytesWithinDemand: knownBytes,
      missingBytes,
      explicitFactCoverageRatio: knownBytes / admitted.range.length,
      inferredNetworkByteCount: 0,
      inferredNetworkSpeed: null,
    },
  };
}
