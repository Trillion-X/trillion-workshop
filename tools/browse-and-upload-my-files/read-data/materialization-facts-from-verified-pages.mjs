// packages/live-namespace/read-data/materialization-facts-from-verified-pages.mjs
//
// PURPOSE
// Turn explicitly verified receiver pages into the smallest exact fact set that can say:
// “this receiver verifiably possesses this checked byte interval of this immutable subject.”
// The module owns admission, paging coherence, interval normalization, and conflict refusal.
// It does not read storage, open the network, schedule work, or infer authority.
//
// NON-NEGOTIABLE INVARIANTS
//  1. A page is evidence only when it names the same receiver, immutable subject, receiver
//     state, observation authorization, and schema as the demand.
//  2. Observation authority and transfer authority are separate. A possession fact never
//     carries, implies, or widens the authorization used to read or move bytes.
//  3. Every checked interval carries a digest for exactly that interval. Partial clamping
//    would fabricate a digest for bytes never checked, so an interval must lie wholly inside
//    the exact demand. Distinct checked windows may overlap; one exact interval with two
//    digests conflicts and the whole batch is refused.
//  4. Paging is a chain from cursor null to next-cursor null. A missing continuation is
//     incomplete evidence, never a complete smaller answer.
//  5. Exact-result and immutable-byte subjects never become interchangeable because their
//     identities happen to be equal. Subject kind is part of exact identity.

const IDENTITY_TEXT = /^[0-9a-f]+:[0-9a-f]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Named for what the shape IS, never an ordinal (L206).
export const RECEIVER_MATERIALIZATION_SHAPE = "live-namespace.receiver-materialization-from-verified-pages";
const SCHEMA_VERSION = RECEIVER_MATERIALIZATION_SHAPE;
const SUBJECT_KINDS = new Set(["immutable-bytes", "exact-result"]);

export class MaterializationFactsError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "MaterializationFactsError";
    this.details = details ?? {};
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new MaterializationFactsError(`${label} must be an object`, { field: label });
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length !== 0) {
    throw new MaterializationFactsError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.sort(),
    });
  }
}

function exactString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new MaterializationFactsError(`${label} must be a non-empty string`, { field: label });
  }
  return value;
}

function exactSubject(value, label) {
  const subject = plainObject(value, label);
  rejectUnknownFields(subject, new Set(["kind", "identity"]), label);
  if (!SUBJECT_KINDS.has(subject.kind)) {
    throw new MaterializationFactsError(`${label}.kind must be immutable-bytes or exact-result`, {
      field: `${label}.kind`,
    });
  }
  const identity = exactString(subject.identity, `${label}.identity`);
  if (!IDENTITY_TEXT.test(identity)) {
    throw new MaterializationFactsError(`${label}.identity must be exact lowercase multihash text`, {
      field: `${label}.identity`,
    });
  }
  return { kind: subject.kind, identity };
}

function authorizationValue(value, label) {
  if (Array.isArray(value)) {
    return value.map((item, index) => authorizationValue(item, `${label}[${index}]`));
  }
  if (value == null || typeof value !== "object") {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      throw new MaterializationFactsError(`${label} is not valid JSON data`, { field: label });
    }
    return value;
  }
  const source = plainObject(value, label);
  const output = {};
  for (const key of Object.keys(source).sort()) output[key] = authorizationValue(source[key], `${label}.${key}`);
  return output;
}

function authorizationDescriptor(value, label) {
  const descriptor = authorizationValue(value, label);
  plainObject(descriptor, label);
  if (Object.keys(descriptor).length === 0) {
    throw new MaterializationFactsError(`${label} must not be empty`, { field: label });
  }
  return descriptor;
}

function sameAuthorization(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneAuthorization(value) {
  return structuredClone(value);
}

function validRange(value, label) {
  const range = plainObject(value, label);
  const fields = Object.keys(range);
  if (fields.length !== 2 || !fields.includes("offset") || !fields.includes("length")) {
    throw new MaterializationFactsError(`${label} must contain exactly offset and length`, { field: label });
  }
  const { offset, length } = range;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new MaterializationFactsError(`${label}.offset must be a non-negative safe integer`, { field: label });
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new MaterializationFactsError(`${label}.length must be a positive safe integer`, { field: label });
  }
  if (offset + length > Number.MAX_SAFE_INTEGER) {
    throw new MaterializationFactsError(`${label} exceeds the safe integer byte address space`, { field: label });
  }
  return { offset, length };
}

function admittedDemand(rawDemand) {
  const demand = plainObject(rawDemand, "demand");
  rejectUnknownFields(
    demand,
    new Set([
      "schemaVersion",
      "receiverId",
      "subject",
      "receiverStateVersion",
      "observationAuthorization",
      "transferAuthorization",
      "range",
    ]),
    "demand",
  );
  if (demand.schemaVersion !== SCHEMA_VERSION) {
    throw new MaterializationFactsError("demand schema version mismatch", {
      expected: SCHEMA_VERSION,
      received: demand.schemaVersion,
    });
  }
  return {
    receiverId: exactString(demand.receiverId, "demand.receiverId"),
    subject: exactSubject(demand.subject, "demand.subject"),
    receiverStateVersion: exactString(demand.receiverStateVersion, "demand.receiverStateVersion"),
    observationAuthorization: authorizationDescriptor(
      demand.observationAuthorization,
      "demand.observationAuthorization",
    ),
    transferAuthorization: authorizationDescriptor(demand.transferAuthorization, "demand.transferAuthorization"),
    range: validRange(demand.range, "demand.range"),
  };
}

function cursorValue(value, label, allowNull) {
  if (value === null && allowNull) return null;
  return exactString(value, label);
}

function admittedInterval(rawInterval, index) {
  const label = `intervals[${index}]`;
  const interval = plainObject(rawInterval, label);
  rejectUnknownFields(interval, new Set(["offset", "length", "sha256"]), label);
  const range = validRange({ offset: interval.offset, length: interval.length }, label);
  const sha256 = exactString(interval.sha256, `${label}.sha256`);
  if (!SHA256_HEX.test(sha256)) {
    throw new MaterializationFactsError(`${label}.sha256 must be 64 lowercase hex characters`, {
      field: `${label}.sha256`,
    });
  }
  return { offset: range.offset, length: range.length, end: range.offset + range.length, sha256 };
}

function admittedPage(rawPage, index, demand) {
  const label = `pages[${index}]`;
  const page = plainObject(rawPage, label);
  rejectUnknownFields(
    page,
    new Set([
      "schemaVersion",
      "cursor",
      "nextCursor",
      "receiverId",
      "subject",
      "receiverStateVersion",
      "observationAuthorization",
      "intervals",
      "verified",
    ]),
    label,
  );
  if (page.schemaVersion !== SCHEMA_VERSION) {
    throw new MaterializationFactsError(`${label} schema version mismatch`, {
      expected: SCHEMA_VERSION,
      received: page.schemaVersion,
    });
  }
  if (page.receiverId !== demand.receiverId) {
    throw new MaterializationFactsError(`${label} receiver mismatch`, { index });
  }
  const subject = exactSubject(page.subject, `${label}.subject`);
  if (subject.kind !== demand.subject.kind || subject.identity !== demand.subject.identity) {
    throw new MaterializationFactsError(`${label} subject/root mismatch`, { index });
  }
  if (page.receiverStateVersion !== demand.receiverStateVersion) {
    throw new MaterializationFactsError(`${label} receiver state version mismatch`, { index });
  }
  const observationAuthorization = authorizationDescriptor(
    page.observationAuthorization,
    `${label}.observationAuthorization`,
  );
  if (!sameAuthorization(observationAuthorization, demand.observationAuthorization)) {
    throw new MaterializationFactsError(`${label} observation authorization mismatch`, { index });
  }
  if (page.verified !== true) {
    throw new MaterializationFactsError(`${label} is not explicitly verified`, { index });
  }
  if (!Array.isArray(page.intervals)) {
    throw new MaterializationFactsError(`${label}.intervals must be an array`, { field: `${label}.intervals` });
  }

  return {
    cursor: cursorValue(page.cursor, `${label}.cursor`, true),
    nextCursor: cursorValue(page.nextCursor, `${label}.nextCursor`, true),
    intervals: page.intervals.map((interval, intervalIndex) => admittedInterval(interval, intervalIndex)),
  };
}

function validatePageChain(pages) {
  if (pages.length === 0) {
    throw new MaterializationFactsError("at least one receiver page is required", { field: "pages" });
  }
  const seen = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const isLast = index === pages.length - 1;
    if (index === 0 && page.cursor !== null) {
      throw new MaterializationFactsError("the first page cursor must be null", { index });
    }
    if (index > 0 && page.cursor !== pages[index - 1].nextCursor) {
      throw new MaterializationFactsError("page cursor does not continue the previous page", { index });
    }
    if (page.cursor !== null) {
      if (seen.has(page.cursor)) {
        throw new MaterializationFactsError("duplicate page cursor", { index, cursor: page.cursor });
      }
      seen.add(page.cursor);
    }
    if (isLast && page.nextCursor !== null) {
      throw new MaterializationFactsError("page sequence is truncated: final nextCursor is not null", {
        index,
        nextCursor: page.nextCursor,
      });
    }
    if (!isLast && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0)) {
      throw new MaterializationFactsError("a non-final page must name its next cursor", { index });
    }
  }
}

function normalizeVerifiedIntervals(allIntervals) {
  const byExactInterval = new Map();
  for (const interval of allIntervals) {
    const key = `${interval.offset}:${interval.end}`;
    const existing = byExactInterval.get(key);
    if (existing == null) {
      byExactInterval.set(key, { ...interval });
    } else if (existing.sha256 !== interval.sha256) {
      throw new MaterializationFactsError("verified intervals conflict: one exact interval has two digests", {
        first: { offset: existing.offset, length: existing.end - existing.offset, sha256: existing.sha256 },
        second: { offset: interval.offset, length: interval.end - interval.offset, sha256: interval.sha256 },
      });
    }
  }
  return [...byExactInterval.values()]
    .sort((left, right) => left.offset - right.offset || left.end - right.end)
    .map(({ offset, end, sha256 }) => ({ offset, length: end - offset, sha256 }));
}

function clampToIntervals(intervals, range) {
  const start = range.offset;
  const end = range.offset + range.length;
  return intervals.map(({ offset, length, sha256 }) => {
    const intervalEnd = offset + length;
    if (offset < start || intervalEnd > end) {
      throw new MaterializationFactsError(
        "verified interval is not wholly inside the exact demand; it cannot be clamped without fabricating a digest",
        { interval: { offset, length, sha256 }, demand: { offset: start, length: range.length } },
      );
    }
    return { offset, length, sha256 };
  });
}

/**
 * Admit a complete page sequence and emit exact receiver possession facts.
 * Neither demand nor pages is mutated.
 *
 * @param {object} input An exact demand plus a finite array of explicitly verified pages.
 * @returns {object} A generic fact set with observation and transfer authority kept separate.
 */
export function materializationFactsFromVerifiedPages({ demand, pages }) {
  if (!Array.isArray(pages)) {
    throw new MaterializationFactsError("pages must be an array", { field: "pages" });
  }
  const admitted = admittedDemand(demand);
  const admittedPages = pages.map((page, index) => admittedPage(page, index, admitted));
  validatePageChain(admittedPages);

  const merged = normalizeVerifiedIntervals(admittedPages.flatMap((page) => page.intervals));
  const withinDemand = clampToIntervals(merged, admitted.range);
  const fact = ({ offset, length, sha256 }) => ({
    kind: "live-namespace.receiver-materialization-fact",
    schemaVersion: SCHEMA_VERSION,
    receiverId: admitted.receiverId,
    subject: { ...admitted.subject },
    receiverStateVersion: admitted.receiverStateVersion,
    observationAuthorization: cloneAuthorization(admitted.observationAuthorization),
    interval: { offset, length },
    intervalSha256: sha256,
    verified: true,
  });

  return {
    kind: "live-namespace.receiver-materialization-fact-set",
    schemaVersion: SCHEMA_VERSION,
    receiverId: admitted.receiverId,
    subject: { ...admitted.subject },
    receiverStateVersion: admitted.receiverStateVersion,
    observationAuthorization: cloneAuthorization(admitted.observationAuthorization),
    transferAuthorization: cloneAuthorization(admitted.transferAuthorization),
    range: { ...admitted.range },
    facts: withinDemand.map(fact),
    paging: {
      pagesSupplied: admittedPages.length,
      intervalsSupplied: admittedPages.reduce((sum, page) => sum + page.intervals.length, 0),
      complete: true,
    },
  };
}
