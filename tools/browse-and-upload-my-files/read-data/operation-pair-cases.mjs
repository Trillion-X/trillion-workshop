// packages/live-namespace/read-data/operation-pair-cases.mjs
//
// PURPOSE
// Admit a prioritized, explicitly bounded operation-pair census as executable
// case DATA and explicit deferrals. This owner normalizes predicates and
// schedules; it never dispatches an operation, owns concurrency, performs I/O,
// invents semantic merge, migrates data, reclaims storage, or grants authority.

// Named for WHAT THE SHAPE IS, never for which generation it is. A counting suffix says only
// that something came earlier; this says a census row carries five schedules, which is the
// invariant a consumer actually depends on.
export const OPERATION_PAIR_CENSUS_SHAPE = "live-namespace.operation-pair-census-with-five-schedules";
const SCHEMA_VERSION = OPERATION_PAIR_CENSUS_SHAPE;
const CASE_SET_KIND = "live-namespace.operation-pair-case-set";
const CASE_KIND = "live-namespace.operation-pair-case";
const DEFERRAL_KIND = "live-namespace.operation-pair-deferral";

const CENSUS_OPERATIONS = new Set([
  "discover", "index", "resolve", "authorize", "read", "prefetch", "write",
  "commit", "rename", "link", "fork", "merge", "replicate", "evict", "delete",
  "restore", "garbage-collect", "revoke", "rotate-key", "detach-source",
  "reconnect", "migrate", "publish", "adopt",
]);

const EXECUTABLE_OPERATIONS = new Set([
  "read-current", "write-batch", "access-decision", "replica-accept",
  "pointer-restore", "identity-check", "not-admitted",
]);

const EXECUTABLE_OWNERS = new Set([
  "engine-operation-target", "access-rule", "mesh-sync", "deferred",
]);

const OUTCOMES = new Set(["pass", "denied", "conflict", "unavailable"]);
const SCHEDULES = Object.freeze([
  "sequential-a-b",
  "sequential-b-a",
  "concurrent-overlap",
  "retry-replay",
  "injected-partition",
]);

const PAIR_ID = /^P([1-9]\d{0,2})$/;
const PRIORITY = /^P[1-5]$/;
const TARGET = /^[a-z0-9][a-z0-9.-]{2,127}[a-z0-9]$/;
const STATE_PREDICATE = /^[a-z0-9][a-z0-9._-]{2,127}[a-z0-9]$/;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}[A-Za-z0-9]$/;
const SOURCE_NEUTRAL_BAN = /:\/\/|@|(?:^|[\s._-])(?:credential|password|secret|api[_-]?key|aws|gcp|azure|s3|openai|anthropic)(?:$|[\s._-])/i;

export class OperationPairCasesError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OperationPairCasesError";
    this.details = details;
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationPairCasesError(`${label} must be an object`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OperationPairCasesError(`${label} must be a plain object`, { field: label });
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Reflect.ownKeys(value).filter((field) => (
    typeof field === "symbol" || !allowed.includes(field)
  ));
  if (unknown.length !== 0) {
    throw new OperationPairCasesError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
}

function rejectUnknownArrayFields(value, label) {
  const unknown = Reflect.ownKeys(value).filter((field) => (
    typeof field === "symbol" ||
    (typeof field === "string" && field !== "length" && !/^\d+$/.test(field))
  ));
  if (unknown.length !== 0) {
    throw new OperationPairCasesError(`${label} has fields outside this exact array contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new OperationPairCasesError(`${label} contains a sparse hole`, {
        field: label,
        index,
      });
    }
  }
}

function exactArray(value, label) {
  if (!Array.isArray(value)) {
    throw new OperationPairCasesError(`${label} must be an array`, { field: label });
  }
  rejectUnknownArrayFields(value, label);
  return value;
}

function exactText(value, label, pattern, message) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    SOURCE_NEUTRAL_BAN.test(value) ||
    !pattern.test(value)
  ) {
    throw new OperationPairCasesError(message, { field: label, value });
  }
  return value;
}

function operationSide(value, label) {
  const side = plainObject(value, label);
  rejectUnknownFields(side, ["censusOperation", "executableOperation"], label);
  if (!CENSUS_OPERATIONS.has(side.censusOperation)) {
    throw new OperationPairCasesError(`${label}.censusOperation is outside the 24-operation census`, {
      field: `${label}.censusOperation`,
      value: side.censusOperation,
    });
  }
  if (!EXECUTABLE_OPERATIONS.has(side.executableOperation)) {
    throw new OperationPairCasesError(`${label}.executableOperation is not an admitted generic descriptor`, {
      field: `${label}.executableOperation`,
      value: side.executableOperation,
    });
  }
  return {
    censusOperation: side.censusOperation,
    executableOperation: side.executableOperation,
  };
}

function initialWrites(value, label) {
  const writes = exactArray(value, label);
  return writes.map((item, index) => {
    const write = plainObject(item, `${label}[${index}]`);
    rejectUnknownFields(
      write,
      ["addressLabel", "payload", "remove", "expectedCurrent"],
      `${label}[${index}]`,
    );
    if (typeof write.addressLabel !== "string" || write.addressLabel.length === 0) {
      throw new OperationPairCasesError(`${label}[${index}].addressLabel must be nonempty text`, {
        field: `${label}[${index}].addressLabel`,
      });
    }
    if (typeof write.remove !== "boolean") {
      throw new OperationPairCasesError(`${label}[${index}].remove must be boolean`, {
        field: `${label}[${index}].remove`,
      });
    }
    if (write.payload === null) {
      throw new OperationPairCasesError(`${label}[${index}].payload null is the tombstone trap; use remove true`, {
        field: `${label}[${index}].payload`,
      });
    }
    if (write.expectedCurrent !== null && typeof write.expectedCurrent !== "string") {
      throw new OperationPairCasesError(`${label}[${index}].expectedCurrent must be text or null`, {
        field: `${label}[${index}].expectedCurrent`,
      });
    }
    try {
      JSON.stringify(write.payload);
    } catch (error) {
      throw new OperationPairCasesError(`${label}[${index}].payload must be JSON`, {
        field: `${label}[${index}].payload`,
        cause: error,
      });
    }
    if (write.payload === undefined) {
      throw new OperationPairCasesError(`${label}[${index}].payload must be JSON`, {
        field: `${label}[${index}].payload`,
      });
    }
    return {
      addressLabel: write.addressLabel,
      payload: write.payload,
      remove: write.remove,
      expectedCurrent: write.expectedCurrent,
    };
  });
}

function fixture(value, label) {
  const output = plainObject(value, label);
  rejectUnknownFields(output, ["partitionLabel", "addressLabel", "initialWrites"], label);
  exactText(
    output.partitionLabel,
    `${label}.partitionLabel`,
    /^[a-z0-9][a-z0-9._-]{2,127}[a-z0-9]$/,
    `${label}.partitionLabel must be safe bounded text`,
  );
  exactText(
    output.addressLabel,
    `${label}.addressLabel`,
    /^[a-z0-9][a-z0-9._-]{2,127}[a-z0-9]$/,
    `${label}.addressLabel must be safe bounded text`,
  );
  return {
    partitionLabel: output.partitionLabel,
    addressLabel: output.addressLabel,
    initialWrites: initialWrites(output.initialWrites, `${label}.initialWrites`),
  };
}

function textArray(value, label, pattern, message) {
  const values = exactArray(value, label);
  if (values.length === 0) {
      throw new OperationPairCasesError(`${label} must contain at least one exact state predicate`, {
      field: label,
    });
  }
  const output = values.map((item, index) => (
    exactText(item, `${label}[${index}]`, pattern, message)
  ));
  if (new Set(output).size !== output.length) {
    throw new OperationPairCasesError(`${label} contains duplicates`, { field: label });
  }
  return output;
}

/** Per-schedule expectations. Absent means none; present, every key must be a real schedule. */
function expectedBySchedule(value, owner, schedules, label) {
  if (value === undefined) return {};
  const source = plainObject(value, label);
  const output = {};
  for (const [schedule, expectation] of Object.entries(source)) {
    if (!schedules.includes(schedule)) {
      throw new OperationPairCasesError(`${label} names a schedule the row does not run`, {
        field: label,
        value: schedule,
      });
    }
    output[schedule] = expected(expectation, owner, `${label}.${schedule}`);
  }
  return output;
}

function expected(value, owner, label) {
  const output = plainObject(value, label);
  rejectUnknownFields(output, ["outcome", "statePredicates", "errorPredicates"], label);
  if (!OUTCOMES.has(output.outcome)) {
    throw new OperationPairCasesError(`${label}.outcome must be pass, denied, conflict, or unavailable`, {
      field: `${label}.outcome`,
      value: output.outcome,
    });
  }
  const statePredicates = textArray(
    output.statePredicates,
    `${label}.statePredicates`,
    STATE_PREDICATE,
    `${label}.statePredicates contains an unsafe predicate`,
  );
  const rawErrors = exactArray(output.errorPredicates, `${label}.errorPredicates`);
  const errorPredicates = rawErrors.map((item, index) => {
    const predicate = plainObject(item, `${label}.errorPredicates[${index}]`);
    rejectUnknownFields(
      predicate,
      ["code", "count"],
      `${label}.errorPredicates[${index}]`,
    );
    const code = exactText(
      predicate.code,
      `${label}.errorPredicates[${index}].code`,
      ERROR_CODE,
      `${label}.errorPredicates[${index}].code is unsafe`,
    );
    if (
      !Number.isSafeInteger(predicate.count) ||
      predicate.count < 1 ||
      predicate.count > 1024
    ) {
      throw new OperationPairCasesError(`${label}.errorPredicates[${index}].count must be 1..1024`, {
        field: `${label}.errorPredicates[${index}].count`,
        value: predicate.count,
      });
    }
    return { code, count: predicate.count };
  });
  if (owner === "deferred") {
    if (output.outcome !== "unavailable") {
      throw new OperationPairCasesError("a deferred case must expect unavailable", {
        field: `${label}.outcome`,
      });
    }
  } else if (statePredicates.length === 0) {
    throw new OperationPairCasesError(`an executable case requires a state predicate`, {
      field: `${label}.statePredicates`,
    });
  }
  return { outcome: output.outcome, statePredicates, errorPredicates };
}

function pair(value, index) {
  const label = `pairs[${index}]`;
  const row = plainObject(value, label);
  rejectUnknownFields(
    row,
    [
      "kind", "pairId", "priority", "category", "a", "b", "fixture",
      "schedules", "expected", "expectedBySchedule", "executableOwner", "executableTarget",
      "deferredReason",
    ],
    label,
  );
  if (row.kind !== "live-namespace.operation-pair-case") {
    throw new OperationPairCasesError(`${label}.kind is not an operation-pair case`, {
      field: `${label}.kind`,
    });
  }
  const pairId = exactText(
    row.pairId,
    `${label}.pairId`,
    PAIR_ID,
    `${label}.pairId must be P1..P999`,
  );
  if (Number(pairId.slice(1)) > 576) {
    throw new OperationPairCasesError(`${label}.pairId is outside P001..P576`, {
      field: `${label}.pairId`,
    });
  }
  const priority = exactText(
    row.priority,
    `${label}.priority`,
    PRIORITY,
    `${label}.priority must be P1..P5`,
  );
  const category = exactText(
    row.category,
    `${label}.category`,
    /^[a-z0-9][a-z0-9._-]{2,127}[a-z0-9]$/,
    `${label}.category must be safe bounded text`,
  );
  const a = operationSide(row.a, `${label}.a`);
  const b = operationSide(row.b, `${label}.b`);
  const executableOwner = row.executableOwner;
  if (!EXECUTABLE_OWNERS.has(executableOwner)) {
    throw new OperationPairCasesError(`${label}.executableOwner is not an existing owner or deferred`, {
      field: `${label}.executableOwner`,
      value: executableOwner,
    });
  }
  const executableTarget = exactText(
    row.executableTarget,
    `${label}.executableTarget`,
    TARGET,
    `${label}.executableTarget must name a bounded owner target`,
  );
  const schedules = exactArray(row.schedules, `${label}.schedules`);
  if (
    schedules.length !== SCHEDULES.length ||
    schedules.some((schedule, scheduleIndex) => schedule !== SCHEDULES[scheduleIndex])
  ) {
    throw new OperationPairCasesError(`${label}.schedules must be the exact canonical five-schedule array`, {
      field: `${label}.schedules`,
    });
  }
  const deferredReason = row.deferredReason === null
    ? null
    : exactText(
      row.deferredReason,
      `${label}.deferredReason`,
      /^[a-z0-9][a-z0-9._-]{9,254}[a-z0-9]$/,
      `${label}.deferredReason must be safe bounded text`,
    );
  if (executableOwner === "deferred") {
    if (deferredReason === null) {
      throw new OperationPairCasesError(`${label}.deferredReason is required for a deferred row`, {
        field: `${label}.deferredReason`,
      });
    }
    if (executableTarget !== "runtime.not-admitted") {
      throw new OperationPairCasesError(`${label}.executableTarget must be runtime.not-admitted for a deferred row`, {
        field: `${label}.executableTarget`,
      });
    }
    for (const side of [a, b]) {
      if (side.executableOperation !== "not-admitted") {
        throw new OperationPairCasesError(`${label} deferred operations must be not-admitted`, {
          field: label,
        });
      }
    }
  } else {
    if (deferredReason !== null) {
      throw new OperationPairCasesError(`${label}.deferredReason must be null for an executable row`, {
        field: `${label}.deferredReason`,
      });
    }
    if (executableTarget === "runtime.not-admitted") {
      throw new OperationPairCasesError(`${label}.executableTarget claims no admission for an executable row`, {
        field: `${label}.executableTarget`,
      });
    }
  }
  return {
    kind: row.kind,
    pairId,
    priority,
    category,
    a,
    b,
    fixture: fixture(row.fixture, `${label}.fixture`),
    schedules: [...schedules],
    expected: expected(row.expected, executableOwner, `${label}.expected`),
    // A schedule may declare its OWN expectation, because the real engine showed that one
    // predicate cannot cover all five: replaying a guarded write is a second mismatch, and a
    // rename racing a delete on the same guard is a conflict, both of which the base row calls
    // "pass". Overrides are keyed by the canonical schedule name and must name one of the five.
    expectedBySchedule: expectedBySchedule(row.expectedBySchedule, executableOwner, schedules, `${label}.expectedBySchedule`),
    executableOwner,
    executableTarget,
    deferredReason,
  };
}

export function operationPairCasesFromCensus(input) {
  const source = plainObject(input, "input");
  rejectUnknownFields(source, ["schemaVersion", "selectedCaseIds", "pairs"], "input");
  if (source.schemaVersion !== SCHEMA_VERSION) {
    throw new OperationPairCasesError("input.schemaVersion must be live-namespace.operation-pair-census-with-five-schedules", {
      field: "input.schemaVersion",
      value: source.schemaVersion,
    });
  }
  const selected = exactArray(source.selectedCaseIds, "input.selectedCaseIds");
  if (selected.length === 0) {
    throw new OperationPairCasesError("input.selectedCaseIds must not be empty", {
      field: "input.selectedCaseIds",
    });
  }
  const selectedSet = new Set();
  for (const [index, value] of selected.entries()) {
    const pairId = exactText(value, `input.selectedCaseIds[${index}]`, PAIR_ID, "a selected case ID must be P1..P999");
    if (selectedSet.has(pairId)) {
      throw new OperationPairCasesError("input.selectedCaseIds contains a duplicate", {
        field: "input.selectedCaseIds",
        value: pairId,
      });
    }
    selectedSet.add(pairId);
  }

  const rawPairs = exactArray(source.pairs, "input.pairs");
  const pairsById = new Map();
  const duplicateCaseIds = [];
  const normalizedPairs = rawPairs.map((value, index) => pair(value, index));
  for (const row of normalizedPairs) {
    if (pairsById.has(row.pairId)) duplicateCaseIds.push(row.pairId);
    else pairsById.set(row.pairId, row);
  }

  const cases = [];
  const deferred = [];
  for (const pairId of selectedSet) {
    const row = pairsById.get(pairId);
    if (row === undefined) {
      throw new OperationPairCasesError("a selected case ID has no supplied pair", {
        field: "input.selectedCaseIds",
        value: pairId,
      });
    }
    if (row.executableOwner === "deferred") {
      deferred.push({
        kind: DEFERRAL_KIND,
        caseId: `${pairId.toLowerCase()}--deferred`,
        censusId: pairId,
        owner: "live-namespace",
        reason: row.deferredReason,
      });
      continue;
    }
    for (const schedule of row.schedules) {
      cases.push({
        kind: CASE_KIND,
        caseId: `${pairId.toLowerCase()}--${row.a.executableOperation}--${row.b.executableOperation}--${schedule}`,
        censusId: pairId,
        priority: row.priority,
        category: row.category,
        owner: "live-namespace",
        executableOwner: row.executableOwner,
        executableTarget: row.executableTarget,
        a: { ...row.a },
        b: { ...row.b },
        schedule,
        fixture: structuredClone(row.fixture),
        expected: structuredClone(row.expectedBySchedule[schedule] ?? row.expected),
      });
    }
  }

  return {
    kind: CASE_SET_KIND,
    schemaVersion: SCHEMA_VERSION,
    cases,
    summary: {
      supplied: normalizedPairs.length,
      selected: selectedSet.size,
      normalizedCases: cases.length,
      duplicateCaseIds: [...new Set(duplicateCaseIds)].sort(),
      deferred,
    },
  };
}
