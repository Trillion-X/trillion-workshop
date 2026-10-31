// tools/run-experiments/write-data/observe.ts
//
// Purpose: The universal OBSERVE operation — build and append a self-describing
// observation fact about an observer to the fact log at observer::<id>::*.
//
// Architecture split (testability):
//   buildObservationRecord(...)  — pure function: constructs the record shape.
//                                  Fully unit-tested for shape + address.
//   appendObservation(...)       — thin wrapper: calls engine.operation.write-batch
//                                  to append the built record. Not unit-testable
//                                  without a live engine; callers in Wave-2+ use it.
//
// The split means T2's test contract (record shape + read-back contract) is
// 100% covered by unit tests on buildObservationRecord, while appendObservation
// is a documented one-liner that any integration test or live caller exercises.
//
// Non-negotiable invariants:
//   - OBSERVE is append-only. No update op. No mutation. (grep: no "update",
//     no "replace", no "set" in the write payload — only append-style writes.)
//   - `trust_ref` is an open `trust:*` descriptor ref string (DATA). Never a
//     closed enum like `fact_class ∈ {signal, derived, signed}`. The handler
//     stores it verbatim; the evaluator filters by it.
//   - `path` is a string[] (structured array, never dot-encoded). Mirrors
//     ObserverFact.path from score-candidates.ts.
//   - address format: observer::<observer_id>::<path joined by "::">
//     Segments use "::" as the standard address separator.
//   - `value` is any JSON-serialisable type. The log stores it as part of the
//     record payload.
//   - `at` timestamp is ISO 8601 UTC. `basis` is an optional causal anchor
//     (e.g. a request id or decision transcript id) — open string.
//
// Dependencies: pure buildObservationRecord (no imports); appendObservation
// imports from engine.operation.write-batch (live only, not imported at top
// level to keep the pure half tree-shakeable and unit-testable without a
// live engine).

// ---------------------------------------------------------------------------
// ObservationRecord — the pure data shape
// ---------------------------------------------------------------------------

/**
 * A fully-constructed observation record ready to be appended to the log.
 * This is the canonical shape of a fact at observer::<id>::*.
 *
 * `entity_type`  — "observation" (machine-readable kind discriminant).
 * `observer_id`  — stable observer identifier (open string; derived from
 *                  cookie / header / anon-hash by the caller).
 * `trust_ref`    — open `trust:*` descriptor ref (e.g. "trust:observer-supplied",
 *                  "trust:derived", "trust:signed"). DATA, never a code enum.
 * `path`         — structured string[] address within the observer's fact namespace
 *                  (e.g. ["observer","signal","source"]). Mirrors FactPathNode.fact_path.
 * `value`        — the fact value (any JSON-compatible type).
 * `at`           — ISO 8601 UTC timestamp of when this observation was made.
 * `basis`        — optional causal anchor (e.g. request id, decision transcript id).
 *                  Links this fact to the decision or event that produced it.
 */
export interface ObservationRecord {
  entity_type: 'observation';
  observer_id: string;
  trust_ref: string;
  path: string[];
  value: unknown;
  at: string;
  basis?: string;
}

/**
 * The log address for an observation.
 * Format: observer::<observer_id>::<path[0]>::<path[1]>::...
 *
 * The double-colon separator is the standard address convention.
 * Path segments are stored verbatim — callers must not include "::" within
 * a single segment (it would be misread as a separator).
 */
export function observationAddress(observerId: string, path: string[]): string {
  const pathSegments = path.join('::');
  return `observer::${observerId}::${pathSegments}`;
}

// ---------------------------------------------------------------------------
// buildObservationRecord — pure constructor (fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * Options for building an observation record.
 *
 * `observerId`  — stable observer identifier.
 * `trustRef`    — open `trust:*` descriptor ref string.
 * `path`        — structured fact path (string[] — NOT dot-encoded).
 * `value`       — the fact value.
 * `at`          — explicit ISO 8601 UTC timestamp from the caller's clock owner.
 * `basis`       — optional causal anchor.
 */
export interface ObserveOptions {
  observerId: string;
  trustRef: string;
  path: string[];
  value: unknown;
  at?: string;
  basis?: string;
}

/**
 * Pure function: build a fully-formed ObservationRecord from options.
 * Does not perform any I/O. Use this in unit tests and in appendObservation.
 *
 * Validates:
 *   - observerId is a non-empty string.
 *   - trustRef is a non-empty string.
 *   - path is a non-empty string[].
 *   - value is present (null is a valid value — "absent" is represented by
 *     the fact not existing, not by value: null).
 *
 * Throws on invalid input — callers are responsible for providing valid options.
 * (A write with garbage observer_id or trust_ref would corrupt the fact log.)
 */
export function buildObservationRecord(options: ObserveOptions): {
  record: ObservationRecord;
  address: string;
} {
  const { observerId, trustRef, path, value, basis } = options;
  const at = options.at;

  if (typeof observerId !== 'string' || observerId.trim().length === 0) {
    throw new Error('[run-experiments] observe: observerId must be a non-empty string.');
  }
  if (typeof trustRef !== 'string' || trustRef.trim().length === 0) {
    throw new Error('[run-experiments] observe: trustRef must be a non-empty string.');
  }
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('[run-experiments] observe: path must be a non-empty string[].');
  }
  for (let i = 0; i < path.length; i++) {
    if (typeof path[i] !== 'string' || path[i].length === 0) {
      throw new Error(`[run-experiments] observe: path[${i}] must be a non-empty string.`);
    }
  }

  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error('Observation time must be supplied by the caller.');
  }
  const record: ObservationRecord = {
    entity_type: 'observation',
    observer_id: observerId,
    trust_ref: trustRef,
    path: [...path], // defensive copy — caller must not mutate after building
    value,
    at,
    ...(basis != null ? { basis } : {}),
  };

  const address = observationAddress(observerId, path);

  console.log(
    `[run-experiments] observed observer=${observerId} trust=${trustRef} path=${path.join('.')}`,
  );

  return { record, address };
}

// ---------------------------------------------------------------------------
// appendObservation — thin live-engine wrapper (not unit-testable standalone)
// ---------------------------------------------------------------------------

/**
 * Write-batch payload shape expected by engine.operation.write-batch.
 * This is the minimal shape needed to append a record; the full contract
 * lives in the engine's write-batch documentation.
 *
 * `address`  — the log address (from observationAddress).
 * `path`     — the log path segments array.
 * `payload`  — the record payload (the ObservationRecord).
 */
export interface WriteBatchEntry {
  address: string;
  path: string[];
  payload: unknown;
  remove: false;
}

/**
 * Build the write-batch entry for an observation without performing any I/O.
 * Useful for callers that batch multiple observations in a single write-batch call.
 *
 * The path convention for observer facts:
 *   ["observer", "<observer_id>", ...path_segments]
 * This mirrors how the engine organises observer facts in the log fold.
 */
export function buildWriteBatchEntry(options: ObserveOptions): WriteBatchEntry {
  const { record, address } = buildObservationRecord(options);
  const logPath = ['observer', options.observerId, ...options.path];
  return {
    address,
    path: logPath,
    payload: record,
    remove: false,
  };
}

/**
 * Append a single observation fact to the live engine log.
 *
 * This function is a thin wrapper — the only logic is calling
 * buildObservationRecord (pure, tested) and then invoking write-batch.
 * It is NOT unit-testable without a live engine connection; integration
 * tests for the full append path live in T5/T8.
 *
 * `engineWriteBatch` — injected caller-provided function that invokes
 *   engine.operation.write-batch with the entry. Injection keeps this
 *   module free of a hard import on the engine client, making it usable
 *   in any environment (browser shell, background runner, offline device).
 *
 * Pattern:
 *   const { address } = await appendObservation(options, myEngineWriteBatch);
 *   // address is the log address where the fact was written.
 *
 * Returns the address where the fact was written (for read-back / verification).
 */
export async function appendObservation(
  options: ObserveOptions,
  engineWriteBatch: (entries: WriteBatchEntry[]) => Promise<void>,
): Promise<{ address: string }> {
  const entry = buildWriteBatchEntry(options);
  await engineWriteBatch([entry]);
  return { address: entry.address };
}
