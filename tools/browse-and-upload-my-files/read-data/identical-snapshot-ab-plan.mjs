// packages/live-namespace/read-data/identical-snapshot-ab-plan.mjs
//
// PURPOSE
// Normalize one identical-snapshot A/B comparison record for the six
// capability-edge alternatives. The result is a generic pure DATA planner:
// it compares measured records, separates immutable-byte and exact-result
// tracks, and never dispatches, schedules, caches, reads bytes, or grants a
// runtime capability.
//
// NON-NEGOTIABLE INVARIANTS
//  1. Every candidate must be measured from the exact same declared initial
//     receiver snapshot. A different snapshot is a comparison error.
//  2. Immutable-byte and exact-result candidates are never ranked across
//     tracks and neither output can substitute for the other.
//  3. A proof means measured:true plus the required counter-specific method
//     and a complete finite value. Missing proof is carried as unadmitted;
//     malformed claimed proof is refused.
//  4. This normalizer can mark a candidate measurement-complete, but it never
//     self-admits capability execution. execution_admitted stays false; an
//     externally reviewed T12.6 authority transition owns any later admission.

// Named for what the shape IS, never an ordinal (L206).
export const IDENTICAL_SNAPSHOT_AB_SHAPE = "live-namespace.identical-snapshot-ab-over-measured-records";
const SCHEMA_VERSION = IDENTICAL_SNAPSHOT_AB_SHAPE;
const MEASUREMENT_METHOD = "identical-snapshot-ab";
const IDENTITY_TEXT = /^[0-9a-f]+:[0-9a-f]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SUBJECT_KINDS = new Set(["immutable-bytes", "exact-result"]);

const ALTERNATIVE_EDGES = new Map([
  ["direct-exact-transfer", "direct-exact-read"],
  ["missing-range-read", "missing-range-read"],
  ["receiver-cache-read", "receiver-cache-read"],
  ["exact-delta-reconstruct", "exact-delta-reconstruct"],
  ["existing-exact-result", "existing-exact-result"],
  ["remote-compute-result", "remote-compute-result"],
]);

const REQUIRED_PROOFS = [
  "cold_setup",
  "payload_bytes",
  "cpu_time",
  "resident_memory_bytes",
  "page_cache",
  "network_counters",
  "wall_time_p50_p95_p99",
  "cancellations",
  "exact_equality",
];

const PROOF_METHODS = new Map([
  ["cold_setup", "monotonic-clock"],
  ["payload_bytes", "byte-counter"],
  ["cpu_time", "process-cpu-counter"],
  ["resident_memory_bytes", "process-rss-counter"],
  ["page_cache", "page-cache-counter"],
  ["network_counters", "socket-counter"],
  ["wall_time_p50_p95_p99", "monotonic-clock"],
  ["cancellations", "run-ledger"],
]);

export class IdenticalSnapshotAbError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IdenticalSnapshotAbError";
    this.details = details;
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new IdenticalSnapshotAbError(`${label} must be an object`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IdenticalSnapshotAbError(`${label} must be a plain object`, { field: label });
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const unknown = Reflect.ownKeys(value).filter((field) => (
    typeof field === "symbol" || !allowedSet.has(field)
  ));
  if (unknown.length !== 0) {
    throw new IdenticalSnapshotAbError(`${label} has fields outside this exact contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
}

function rejectUnknownArrayFields(value, label) {
  const unknown = Reflect.ownKeys(value).filter((field) => {
    if (typeof field === "symbol") return true;
    if (field === "length") return false;
    return typeof field !== "string" ||
      !/^\d+$/.test(field) ||
      String(Number(field)) !== field ||
      Number(field) >= value.length;
  });
  if (unknown.length !== 0) {
    throw new IdenticalSnapshotAbError(`${label} has fields outside this exact array contract`, {
      field: label,
      unknownFields: unknown.map(String).sort(),
    });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new IdenticalSnapshotAbError(`${label} contains a sparse hole`, {
        field: label,
        index,
      });
    }
  }
}

function exactText(value, label, maxLength = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new IdenticalSnapshotAbError(`${label} must be 1..${maxLength} exact non-whitespace characters`, {
      field: label,
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new IdenticalSnapshotAbError(`${label} contains control characters`, { field: label });
  }
  return value;
}

function finiteCount(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new IdenticalSnapshotAbError(`${label} must be a finite non-negative safe integer`, {
      field: label,
      received: String(value),
    });
  }
  return value;
}

function admittedSubject(value, label, expectedKind) {
  const subject = plainObject(value, label);
  const allowed = expectedKind === "exact-result"
    ? ["kind", "identity", "observable"]
    : ["kind", "identity"];
  rejectUnknownFields(subject, allowed, label);
  if (subject.kind !== expectedKind || !SUBJECT_KINDS.has(subject.kind)) {
    throw new IdenticalSnapshotAbError(`${label}.kind is incompatible with this comparison track`, {
      field: `${label}.kind`,
      expected: expectedKind,
    });
  }
  const identity = exactText(subject.identity, `${label}.identity`, 256);
  if (!IDENTITY_TEXT.test(identity)) {
    throw new IdenticalSnapshotAbError(`${label}.identity must be exact lowercase multihash text`, {
      field: `${label}.identity`,
    });
  }
  if (expectedKind !== "exact-result") return { kind: subject.kind, identity };
  return { kind: subject.kind, identity, observable: admittedObservable(subject.observable, `${label}.observable`) };
}

function admittedObservable(value, label) {
  const observable = plainObject(value, label);
  rejectUnknownFields(observable, ["source", "field"], label);
  return {
    source: exactText(observable.source, `${label}.source`),
    field: exactText(observable.field, `${label}.field`),
  };
}

function sameExactValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function admittedSnapshot(value) {
  const snapshot = plainObject(value, "snapshot");
  rejectUnknownFields(
    snapshot,
    [
      "snapshotId",
      "receiverId",
      "receiverStateVersion",
      "immutableSubject",
      "resultSubject",
    ],
    "snapshot",
  );
  const immutableSubject = admittedSubject(
    snapshot.immutableSubject,
    "snapshot.immutableSubject",
    "immutable-bytes",
  );
  const rawResultSubject = plainObject(snapshot.resultSubject, "snapshot.resultSubject");
  rejectUnknownFields(rawResultSubject, ["kind", "identity", "observable"], "snapshot.resultSubject");
  if (rawResultSubject.kind !== "exact-result") {
    throw new IdenticalSnapshotAbError("snapshot.resultSubject.kind must be exact-result", {
      field: "snapshot.resultSubject.kind",
    });
  }
  const resultIdentity = exactText(rawResultSubject.identity, "snapshot.resultSubject.identity");
  if (!IDENTITY_TEXT.test(resultIdentity)) {
    throw new IdenticalSnapshotAbError("snapshot.resultSubject.identity must be exact lowercase multihash text", {
      field: "snapshot.resultSubject.identity",
    });
  }
  const resultSubject = {
    kind: "exact-result",
    identity: resultIdentity,
    observable: admittedObservable(rawResultSubject.observable, "snapshot.resultSubject.observable"),
  };
  return {
    snapshotId: exactText(snapshot.snapshotId, "snapshot.snapshotId"),
    receiverId: exactText(snapshot.receiverId, "snapshot.receiverId"),
    receiverStateVersion: exactText(snapshot.receiverStateVersion, "snapshot.receiverStateVersion"),
    immutableSubject,
    resultSubject,
  };
}

function admittedProof(value, counter, label, track) {
  if (value === undefined) return null;
  const proof = plainObject(value, label);
  rejectUnknownFields(proof, ["measured", "source", "method"], label);
  if (proof.measured !== true) {
    throw new IdenticalSnapshotAbError(`${label}.measured must be true; DATA is not measurement proof`, {
      field: `${label}.measured`,
    });
  }
  const method = PROOF_METHODS.get(counter) ??
    (counter === "exact_equality"
      ? (track === "immutable-bytes" ? "byte-digest-comparison" : "declared-observable-comparison")
      : "");
  if (proof.method !== method) {
    throw new IdenticalSnapshotAbError(`${label}.method does not match the measured counter`, {
      field: `${label}.method`,
      expected: method,
    });
  }
  return {
    measured: true,
    source: exactText(proof.source, `${label}.source`),
    method,
  };
}

function admittedFiniteValue(value, label) {
  if (typeof value === "boolean" || value === null || !Number.isFinite(value)) {
    throw new IdenticalSnapshotAbError(`${label} must be a finite number`, {
      field: label,
      received: String(value),
    });
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IdenticalSnapshotAbError(`${label} must be a finite non-negative safe integer`, {
      field: label,
      received: String(value),
    });
  }
  return value;
}

function safeSum(left, right, label) {
  const sum = left + right;
  if (sum > Number.MAX_SAFE_INTEGER) {
    throw new IdenticalSnapshotAbError(`${label} exceeds the safe-integer counter space`, {
      field: label,
    });
  }
  return sum;
}

function admittedTransfer(value, label) {
  const transfer = plainObject(value, label);
  rejectUnknownFields(transfer, ["sent", "received", "total"], label);
  const sent = admittedFiniteValue(transfer.sent, `${label}.sent`);
  const received = admittedFiniteValue(transfer.received, `${label}.received`);
  const total = admittedFiniteValue(transfer.total, `${label}.total`);
  if (total !== safeSum(sent, received, label)) {
    throw new IdenticalSnapshotAbError(`${label}.total must equal sent plus received`, {
      field: `${label}.total`,
    });
  }
  return { sent, received, total };
}

function admittedColdSetup(value, label) {
  const cold = plainObject(value, label);
  rejectUnknownFields(
    cold,
    [
      "setupCount",
      "basis",
      "interpreter",
      "cachePlacement",
      "durationNanoseconds",
      "bytesRead",
      "bytesWritten",
    ],
    label,
  );
  const setupCount = admittedFiniteValue(cold.setupCount, `${label}.setupCount`);
  if (setupCount < 1) {
    throw new IdenticalSnapshotAbError(`${label}.setupCount must account for the measured setup`, {
      field: `${label}.setupCount`,
    });
  }
  if (!["fresh-process", "fresh-container", "fresh-vm"].includes(cold.basis)) {
    throw new IdenticalSnapshotAbError(`${label}.basis must name the exact cold-setup boundary`, {
      field: `${label}.basis`,
    });
  }
  const interpreter = plainObject(cold.interpreter, `${label}.interpreter`);
  rejectUnknownFields(interpreter, ["kind", "version", "coldStart"], label);
  if (interpreter.coldStart !== true) {
    throw new IdenticalSnapshotAbError(`${label}.interpreter.coldStart must be explicit`, {
      field: `${label}.interpreter.coldStart`,
    });
  }
  const cachePlacement = plainObject(cold.cachePlacement, `${label}.cachePlacement`);
  rejectUnknownFields(
    cachePlacement,
    ["instructionCache", "dataCache", "translationCache"],
    `${label}.cachePlacement`,
  );
  for (const [field, value] of Object.entries(cachePlacement)) {
    if (value !== "cold") {
      throw new IdenticalSnapshotAbError(`${label}.cachePlacement.${field} must explicitly say cold`, {
        field: `${label}.cachePlacement.${field}`,
      });
    }
  }
  return {
    setupCount,
    basis: cold.basis,
    interpreter: {
      kind: exactText(interpreter.kind, `${label}.interpreter.kind`),
      version: exactText(interpreter.version, `${label}.interpreter.version`),
      coldStart: true,
    },
    cachePlacement: {
      instructionCache: "cold",
      dataCache: "cold",
      translationCache: "cold",
    },
    durationNanoseconds: admittedFiniteValue(cold.durationNanoseconds, `${label}.durationNanoseconds`),
    bytesRead: admittedFiniteValue(cold.bytesRead, `${label}.bytesRead`),
    bytesWritten: admittedFiniteValue(cold.bytesWritten, `${label}.bytesWritten`),
  };
}

function admittedValue(value, counter, label) {
  if (value === undefined) return null;
  const raw = plainObject(value, label);
  switch (counter) {
    case "cold_setup": {
      return admittedColdSetup(raw, label);
    }
    case "payload_bytes": {
      rejectUnknownFields(raw, ["payload", "metadata"], label);
      return {
        payload: admittedTransfer(raw.payload, `${label}.payload`),
        metadata: admittedTransfer(raw.metadata, `${label}.metadata`),
      };
    }
    case "cpu_time": {
      rejectUnknownFields(raw, ["userNanoseconds", "systemNanoseconds", "totalNanoseconds"], label);
      const user = admittedFiniteValue(raw.userNanoseconds, `${label}.userNanoseconds`);
      const system = admittedFiniteValue(raw.systemNanoseconds, `${label}.systemNanoseconds`);
      const total = admittedFiniteValue(raw.totalNanoseconds, `${label}.totalNanoseconds`);
      if (total !== user + system) {
        throw new IdenticalSnapshotAbError(`${label}.totalNanoseconds must equal user plus system`, {
          field: `${label}.totalNanoseconds`,
        });
      }
      return { userNanoseconds: user, systemNanoseconds: system, totalNanoseconds: total };
    }
    case "resident_memory_bytes": {
      rejectUnknownFields(raw, ["peakBytes"], label);
      return { peakBytes: admittedFiniteValue(raw.peakBytes, `${label}.peakBytes`) };
    }
    case "page_cache": {
      rejectUnknownFields(raw, ["hits", "misses"], label);
      return {
        hits: admittedFiniteValue(raw.hits, `${label}.hits`),
        misses: admittedFiniteValue(raw.misses, `${label}.misses`),
      };
    }
    case "network_counters": {
      rejectUnknownFields(raw, ["origin", "relay_or_peer", "receiver"], label);
      const admittedCut = (value, cutLabel) => {
        const cut = plainObject(value, cutLabel);
        rejectUnknownFields(cut, ["bytesSent", "bytesReceived", "requests"], cutLabel);
        return {
          bytesSent: admittedFiniteValue(cut.bytesSent, `${cutLabel}.bytesSent`),
          bytesReceived: admittedFiniteValue(cut.bytesReceived, `${cutLabel}.bytesReceived`),
          requests: admittedFiniteValue(cut.requests, `${cutLabel}.requests`),
        };
      };
      return {
        origin: admittedCut(raw.origin, `${label}.origin`),
        relay_or_peer: admittedCut(raw.relay_or_peer, `${label}.relay_or_peer`),
        receiver: admittedCut(raw.receiver, `${label}.receiver`),
      };
    }
    case "wall_time_p50_p95_p99": {
      rejectUnknownFields(raw, ["p50Nanoseconds", "p95Nanoseconds", "p99Nanoseconds"], label);
      const p50 = admittedFiniteValue(raw.p50Nanoseconds, `${label}.p50Nanoseconds`);
      const p95 = admittedFiniteValue(raw.p95Nanoseconds, `${label}.p95Nanoseconds`);
      const p99 = admittedFiniteValue(raw.p99Nanoseconds, `${label}.p99Nanoseconds`);
      if (p50 > p95 || p95 > p99) {
        throw new IdenticalSnapshotAbError(`${label} percentiles must be monotonic p50 <= p95 <= p99`, {
          field: label,
        });
      }
      return { p50Nanoseconds: p50, p95Nanoseconds: p95, p99Nanoseconds: p99 };
    }
    case "cancellations": {
      rejectUnknownFields(raw, ["count", "retries", "deadlineMisses", "failedProofs"], label);
      return {
        count: admittedFiniteValue(raw.count, `${label}.count`),
        retries: admittedFiniteValue(raw.retries, `${label}.retries`),
        deadlineMisses: admittedFiniteValue(raw.deadlineMisses, `${label}.deadlineMisses`),
        failedProofs: admittedFiniteValue(raw.failedProofs, `${label}.failedProofs`),
      };
    }
    case "exact_equality":
      throw new IdenticalSnapshotAbError(`${label} needs track-specific exact equality admission`, {
        field: label,
      });
    default:
      throw new IdenticalSnapshotAbError(`${label} names an unknown counter`, {
        field: label,
        counter,
      });
  }
}

function admittedEquality(value, track, snapshot, label) {
  if (value === undefined) return null;
  const equality = plainObject(value, label);
  const allowed = ["isEqual", "equalityKind", "observed", "expected"];
  rejectUnknownFields(equality, track === "exact-result" ? [...allowed, "observable"] : allowed, label);
  if (typeof equality.isEqual !== "boolean") {
    throw new IdenticalSnapshotAbError(`${label}.isEqual must be boolean`, {
      field: `${label}.isEqual`,
    });
  }
  const equalityKind = track === "immutable-bytes" ? "sha256-exact" : "declared-observable-only";
  if (equality.equalityKind !== equalityKind) {
    throw new IdenticalSnapshotAbError(`${label}.equalityKind cannot substitute the subject kind`, {
      field: `${label}.equalityKind`,
      expected: equalityKind,
    });
  }
  const observed = exactText(equality.observed, `${label}.observed`, 1024);
  const expected = exactText(equality.expected, `${label}.expected`, 1024);
  if (equality.isEqual !== (observed === expected)) {
    throw new IdenticalSnapshotAbError(`${label}.isEqual must agree with the exact observed and expected values`, {
      field: `${label}.isEqual`,
    });
  }
  if (track === "immutable-bytes") {
    if (!SHA256_HEX.test(observed) || !SHA256_HEX.test(expected)) {
      throw new IdenticalSnapshotAbError(
        `${label} immutable-byte equality must compare two 64-character lowercase sha256 values`,
        { field: label },
      );
    }
  } else {
    const observable = admittedObservable(equality.observable, `${label}.observable`);
    if (!sameExactValue(observable, snapshot.resultSubject.observable)) {
      throw new IdenticalSnapshotAbError(`${label}.observable differs from the declared result observable`, {
        field: `${label}.observable`,
      });
    }
  }
  return {
    isEqual: equality.isEqual,
    equalityKind,
    observed,
    expected,
    ...(track === "exact-result" ? { observable: { ...snapshot.resultSubject.observable } } : {}),
  };
}

function sameSubject(left, right) {
  return sameExactValue(left, right);
}

function admittedAlternative(rawAlternative, index, snapshot) {
  const fallbackLabel = `alternatives[${index}]`;
  const alternative = plainObject(rawAlternative, fallbackLabel);
  rejectUnknownFields(
    alternative,
    ["alternativeId", "capabilityEdgeId", "snapshotId", "subject", "records"],
    fallbackLabel,
  );
  const alternativeId = exactText(alternative.alternativeId, `${fallbackLabel}.alternativeId`);
  const capabilityEdgeId = ALTERNATIVE_EDGES.get(alternativeId);
  if (!capabilityEdgeId) {
    throw new IdenticalSnapshotAbError(`${fallbackLabel}.alternativeId is outside the required comparison set`, {
      field: `${fallbackLabel}.alternativeId`,
    });
  }
  if (alternative.capabilityEdgeId !== capabilityEdgeId) {
    throw new IdenticalSnapshotAbError(`${fallbackLabel}.capabilityEdgeId does not own this alternative`, {
      field: `${fallbackLabel}.capabilityEdgeId`,
      expected: capabilityEdgeId,
    });
  }
  if (alternative.snapshotId !== snapshot.snapshotId) {
    throw new IdenticalSnapshotAbError(`${fallbackLabel} uses a divergent initial snapshot`, {
      alternativeId,
      expectedSnapshotId: snapshot.snapshotId,
      receivedSnapshotId: String(alternative.snapshotId),
    });
  }
  const track = alternativeId === "existing-exact-result" || alternativeId === "remote-compute-result"
    ? "exact-result"
    : "immutable-bytes";
  const expectedSubject = track === "exact-result" ? snapshot.resultSubject : snapshot.immutableSubject;
  const subject = admittedSubject(alternative.subject, `${fallbackLabel}.subject`, track);
  if (!sameSubject(subject, expectedSubject)) {
    throw new IdenticalSnapshotAbError(`${fallbackLabel}.subject differs from the declared snapshot subject`, {
      alternativeId,
    });
  }
  if (!Array.isArray(alternative.records) || alternative.records.length !== 1) {
    throw new IdenticalSnapshotAbError(`${fallbackLabel}.records must contain exactly one aggregate A/B record`, {
      field: `${fallbackLabel}.records`,
    });
  }
  rejectUnknownArrayFields(alternative.records, `${fallbackLabel}.records`);
  const record = plainObject(alternative.records[0], `${fallbackLabel}.records[0]`);
  const recordLabel = `${alternativeId}.record`;
  rejectUnknownFields(
    record,
    ["recordId", "alternativeId", "snapshotId", "method", "sampleCount", "proofs", "values"],
    recordLabel,
  );
  if (record.alternativeId !== alternativeId || record.snapshotId !== snapshot.snapshotId) {
    throw new IdenticalSnapshotAbError(`${recordLabel} uses a divergent initial snapshot`, {
      alternativeId,
    });
  }
  if (record.method !== MEASUREMENT_METHOD) {
    throw new IdenticalSnapshotAbError(`${recordLabel}.method must be ${MEASUREMENT_METHOD}`, {
      field: `${recordLabel}.method`,
    });
  }
  const sampleCount = finiteCount(record.sampleCount, `${recordLabel}.sampleCount`);
  if (sampleCount === 0) {
    throw new IdenticalSnapshotAbError(`${recordLabel}.sampleCount must be positive`, {
      field: `${recordLabel}.sampleCount`,
    });
  }

  const missingProofs = [];
  const missingValues = [];
  let proofsComplete = true;
  let valuesComplete = true;
  let normalizedProofs;
  let normalizedValues;

  if (record.proofs === undefined) {
    missingProofs.push(...REQUIRED_PROOFS);
    proofsComplete = false;
  } else {
    const rawProofs = plainObject(record.proofs, `${recordLabel}.proofs`);
    rejectUnknownFields(rawProofs, REQUIRED_PROOFS, `${recordLabel}.proofs`);
    normalizedProofs = {};
    for (const counter of REQUIRED_PROOFS) {
      if (!Object.hasOwn(rawProofs, counter)) {
        missingProofs.push(counter);
        proofsComplete = false;
        continue;
      }
      normalizedProofs[counter] = admittedProof(
        rawProofs[counter],
        counter,
        `${recordLabel}.proofs.${counter}`,
        track,
      );
    }
  }

  if (record.values === undefined) {
    missingValues.push(...REQUIRED_PROOFS);
    valuesComplete = false;
  } else {
    const rawValues = plainObject(record.values, `${recordLabel}.values`);
    rejectUnknownFields(rawValues, REQUIRED_PROOFS, `${recordLabel}.values`);
    normalizedValues = {};
    for (const counter of REQUIRED_PROOFS) {
      if (!Object.hasOwn(rawValues, counter)) {
        missingValues.push(counter);
        valuesComplete = false;
        continue;
      }
      normalizedValues[counter] = counter === "exact_equality"
        ? admittedEquality(rawValues[counter], track, snapshot, `${recordLabel}.values.${counter}`)
        : admittedValue(rawValues[counter], counter, `${recordLabel}.values.${counter}`);
    }
  }

  const cancellations = normalizedValues?.cancellations ?? null;
  const exactEquality = normalizedValues?.exact_equality?.isEqual ?? null;
  const failureFree = cancellations?.count === 0 &&
    cancellations?.retries === 0 &&
    cancellations?.deadlineMisses === 0 &&
    cancellations?.failedProofs === 0;
  const candidateMeasurementAdmitted = proofsComplete &&
    valuesComplete &&
    failureFree &&
    exactEquality === true;

  return {
    alternativeId,
    capabilityEdgeId,
    subjectKind: track,
    subject,
    records: [{
      recordId: exactText(record.recordId, `${recordLabel}.recordId`),
      alternativeId,
      snapshotId: snapshot.snapshotId,
      method: MEASUREMENT_METHOD,
      sampleCount,
      proofs: normalizedProofs ?? null,
      values: normalizedValues ?? null,
      proofComplete: proofsComplete,
      valueComplete: valuesComplete,
      missingProofs: missingProofs.sort(),
      missingValues: missingValues.sort(),
      candidateMeasurementAdmitted,
      execution_admitted: false,
    }],
    proofComplete: proofsComplete,
    valueComplete: valuesComplete,
    cancellations,
    exactEquality,
    candidateMeasurementAdmitted,
    executionAdmitted: false,
    execution_admitted: false,
  };
}

function candidateMetrics(alternative) {
  const values = alternative.records[0].values;
  // A candidate with no values is still a candidate in the plan: it sorts LAST and shows its
  // counters as null. Dropping it to `null` here crashed the sort on the first real receiver
  // run, where two of the six alternatives had no executing owner and were carried unmeasured,
  // which is exactly the shape invariant 3 says is admitted.
  if (!values) {
    return {
      alternativeId: alternative.alternativeId,
      capabilityEdgeId: alternative.capabilityEdgeId,
      candidateMeasurementAdmitted: false,
      coldSetup: null,
      payloadBytes: null,
      cpuTime: null,
      residentMemoryBytes: null,
      pageCache: null,
      networkCounters: null,
      wallTime: null,
      cancellations: null,
      exactEquality: null,
    };
  }
  return {
    alternativeId: alternative.alternativeId,
    capabilityEdgeId: alternative.capabilityEdgeId,
    candidateMeasurementAdmitted: alternative.candidateMeasurementAdmitted,
    coldSetup: values.cold_setup,
    payloadBytes: values.payload_bytes,
    cpuTime: values.cpu_time,
    residentMemoryBytes: values.resident_memory_bytes,
    pageCache: values.page_cache,
    networkCounters: values.network_counters,
    wallTime: values.wall_time_p50_p95_p99,
    cancellations: values.cancellations,
    exactEquality: values.exact_equality,
  };
}

function comparisonPlan(alternatives) {
  const groups = [
    {
      subjectKind: "immutable-bytes",
      declaredSubject: alternatives.find((item) => item.subjectKind === "immutable-bytes").subject,
      alternatives: [],
    },
    {
      subjectKind: "exact-result",
      declaredSubject: alternatives.find((item) => item.subjectKind === "exact-result").subject,
      alternatives: [],
    },
  ];
  for (const alternative of alternatives) {
    const group = groups.find((item) => item.subjectKind === alternative.subjectKind);
    group.alternatives.push(candidateMetrics(alternative));
  }
  for (const group of groups) {
    group.alternatives.sort((left, right) => {
      if (left.candidateMeasurementAdmitted !== right.candidateMeasurementAdmitted) {
        return left.candidateMeasurementAdmitted ? -1 : 1;
      }
      const leftP99 = left.wallTime?.p99Nanoseconds ?? Number.MAX_SAFE_INTEGER;
      const rightP99 = right.wallTime?.p99Nanoseconds ?? Number.MAX_SAFE_INTEGER;
      if (leftP99 !== rightP99) return leftP99 - rightP99;
      const leftPayload = left.payloadBytes?.total ?? Number.MAX_SAFE_INTEGER;
      const rightPayload = right.payloadBytes?.total ?? Number.MAX_SAFE_INTEGER;
      if (leftPayload !== rightPayload) return leftPayload - rightPayload;
      return left.alternativeId.localeCompare(right.alternativeId);
    });
    group.candidateSelectedAlternativeId = group.alternatives[0]?.candidateMeasurementAdmitted === true
      ? group.alternatives[0].alternativeId
      : null;
    group.executionSelectedAlternativeId = null;
  }
  return {
    groups,
    selectionPolicy:
      "lowest p99 wall time among measurement-complete candidates inside the same subject track; never cross subject kinds; execution selection remains an external T12.6 transition",
    crossTrackSubstitutionAdmitted: false,
  };
}

/**
 * Normalize a complete six-alternative identical-snapshot A/B comparison.
 * The input is not mutated and no work is dispatched.
 *
 * @param {object} input One snapshot, its immutable/result subjects, and six records.
 * @returns {object} A pure A/B comparison plan and canonical measurement records.
 */
export function identicalSnapshotAbPlanFromData(input) {
  const request = plainObject(input, "identical-snapshot A/B plan");
  rejectUnknownFields(request, ["schemaVersion", "snapshot", "alternatives"], "identical-snapshot A/B plan");
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw new IdenticalSnapshotAbError("identical-snapshot A/B schema version mismatch", {
      expected: SCHEMA_VERSION,
      received: request.schemaVersion,
    });
  }
  const snapshot = admittedSnapshot(request.snapshot);
  if (!Array.isArray(request.alternatives)) {
    throw new IdenticalSnapshotAbError("alternatives must be an array", { field: "alternatives" });
  }
  rejectUnknownArrayFields(request.alternatives, "alternatives");
  if (request.alternatives.length !== ALTERNATIVE_EDGES.size) {
    throw new IdenticalSnapshotAbError(
      "all six required alternatives are needed for one identical-snapshot comparison",
      { field: "alternatives", required: [...ALTERNATIVE_EDGES.keys()].sort() },
    );
  }

  const alternativesById = new Map();
  const alternatives = request.alternatives.map(
    (alternative, index) => {
      const admitted = admittedAlternative(alternative, index, snapshot);
      if (alternativesById.has(admitted.alternativeId)) {
        throw new IdenticalSnapshotAbError("duplicate alternativeId", {
          alternativeId: admitted.alternativeId,
        });
      }
      alternativesById.set(admitted.alternativeId, admitted);
      return admitted;
    },
  );
  for (const alternativeId of ALTERNATIVE_EDGES.keys()) {
    if (!alternativesById.has(alternativeId)) {
      throw new IdenticalSnapshotAbError("a required alternative is missing", {
        alternativeId,
      });
    }
  }

  const measurementCompleteCount = alternatives.filter((alternative) => alternative.candidateMeasurementAdmitted).length;
  const candidateMeasurementAdmitted = measurementCompleteCount === alternatives.length;
  return {
    kind: "live-namespace.identical-snapshot-ab-plan",
    schemaVersion: SCHEMA_VERSION,
    snapshot,
    alternatives: [...alternativesById.values()].sort((left, right) => left.alternativeId.localeCompare(right.alternativeId)),
    plan: comparisonPlan(alternatives),
    summary: {
      requiredAlternatives: ALTERNATIVE_EDGES.size,
      normalized: alternatives.length,
      proofCompleteAlternatives: alternatives.filter((item) => item.proofComplete && item.valueComplete).length,
      measurementCompleteAlternatives: measurementCompleteCount,
      candidateMeasurementAdmitted,
      executionAdmitted: false,
      execution_admitted: false,
      admissionTransition: "external-review-required",
      executionAuthorityGranted: false,
      runtimeWorkDispatched: false,
    },
  };
}
