// tools/run-experiments/read-data/attribute-outcomes.ts
//
// attributeOutcomes: pure join from assignment records and outcome records to
// per-candidate observation facts, configured entirely by an attribution-join
// record. No I/O. Skipped records are reported in findings.

import type { ObserveOptions } from '../do-work/observe.ts';

/** Keep a record only when the value at `path` strictly equals `equals`. */
export interface AttributionWhere {
  path: string[];
  equals: unknown;
}

/**
 * attribution-join config record.
 *
 * `join_id`   — stamped as `basis` on every emitted observation.
 * `assignment.observer_key_path`  — path to the observer key on an assignment record.
 * `assignment.candidate_key_path` — path to the assigned candidate id.
 * `assignment.where`              — optional record filter.
 * `outcome.observer_key_path`     — path to the observer key on an outcome record.
 * `outcome.metric_path`           — path to the raw metric name on an outcome record.
 * `outcome.value_path`            — optional path to a numeric value.
 * `outcome.where`                 — optional record filter.
 * `emit.observe_address`          — address the emitted observations belong to.
 * `emit.metric_map`               — raw metric → emitted count metric; only
 *                                   mapped metrics emit, each occurrence counts 1.
 * `emit.value_metric`             — optional emitted metric for summed numeric values.
 * `emit.trust_ref`                — trust descriptor on emitted observations
 *                                   (default "trust:derived").
 */
export interface AttributionJoin {
  entity_type: 'attribution-join';
  join_id: string;
  assignment: {
    observer_key_path: string[];
    candidate_key_path: string[];
    where?: AttributionWhere;
  };
  outcome: {
    observer_key_path: string[];
    metric_path: string[];
    value_path?: string[];
    where?: AttributionWhere;
  };
  emit: {
    observe_address: string;
    metric_map: Record<string, string>;
    value_metric?: string;
    trust_ref?: string;
  };
}

/** Result of one attributeOutcomes fold. */
export interface AttributeOutcomesResult {
  observations: ObserveOptions[];
  findings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringPath(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(
    (segment) => typeof segment === 'string' && segment.length > 0,
  );
}

/** Walk a structured path through nested records/arrays. Undefined on any miss. */
export function readAtPath(record: unknown, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function matchesWhere(record: unknown, where: AttributionWhere | undefined): boolean {
  if (!where) return true;
  return readAtPath(record, where.path) === where.equals;
}

function checkWhere(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !isStringPath(value.path) || !('equals' in value)) {
    errors.push(`${label}.where must be {path: string[], equals: value} when present.`);
  }
}

/** Result of `validateAttributionJoin`. Lists every problem found. */
export interface AttributionJoinValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate an attribution-join config record. */
export function validateAttributionJoin(record: unknown): AttributionJoinValidationResult {
  const errors: string[] = [];
  if (!isRecord(record)) {
    return { valid: false, errors: ['attribution-join record must be a non-null object.'] };
  }
  if (record.entity_type !== 'attribution-join') {
    errors.push(`entity_type must be "attribution-join"; got ${JSON.stringify(record.entity_type)}.`);
  }
  if (typeof record.join_id !== 'string' || record.join_id.trim().length === 0) {
    errors.push('join_id must be a non-empty string.');
  }
  const assignment = record.assignment;
  if (!isRecord(assignment)) {
    errors.push('assignment must be an object.');
  } else {
    if (!isStringPath(assignment.observer_key_path)) errors.push('assignment.observer_key_path must be a non-empty string[].');
    if (!isStringPath(assignment.candidate_key_path)) errors.push('assignment.candidate_key_path must be a non-empty string[].');
    checkWhere(assignment.where, 'assignment', errors);
  }
  const outcome = record.outcome;
  if (!isRecord(outcome)) {
    errors.push('outcome must be an object.');
  } else {
    if (!isStringPath(outcome.observer_key_path)) errors.push('outcome.observer_key_path must be a non-empty string[].');
    if (!isStringPath(outcome.metric_path)) errors.push('outcome.metric_path must be a non-empty string[].');
    if (outcome.value_path !== undefined && !isStringPath(outcome.value_path)) {
      errors.push('outcome.value_path must be a non-empty string[] when present.');
    }
    checkWhere(outcome.where, 'outcome', errors);
  }
  const emit = record.emit;
  if (!isRecord(emit)) {
    errors.push('emit must be an object.');
  } else {
    if (typeof emit.observe_address !== 'string' || emit.observe_address.trim().length === 0) {
      errors.push('emit.observe_address must be a non-empty string.');
    }
    if (!isRecord(emit.metric_map) || Object.values(emit.metric_map).some((v) => typeof v !== 'string' || v.length === 0)) {
      errors.push('emit.metric_map must be a record of non-empty string values.');
    }
    if (emit.value_metric !== undefined && (typeof emit.value_metric !== 'string' || emit.value_metric.length === 0)) {
      errors.push('emit.value_metric must be a non-empty string when present.');
    }
    if (emit.trust_ref !== undefined && (typeof emit.trust_ref !== 'string' || emit.trust_ref.length === 0)) {
      errors.push('emit.trust_ref must be a non-empty string when present.');
    }
  }
  return { valid: errors.length === 0, errors };
}

const DEFAULT_TRUST_REF = 'trust:derived';

/**
 * Join assignment records with outcome records per the config and emit
 * per-candidate observations at fact-path
 * ["candidate","outcome",<metric>,<candidate_id>].
 *
 * Counts and values are summed per (observer, metric, candidate), so a re-run
 * over the same inputs produces the same addresses and values.
 *
 * `at` — caller-supplied ISO timestamp stamped on every emitted observation.
 */
export function attributeOutcomes(
  config: AttributionJoin,
  assignmentRecords: readonly unknown[],
  outcomeRecords: readonly unknown[],
  at: string,
): AttributeOutcomesResult {
  const validation = validateAttributionJoin(config);
  if (!validation.valid) {
    return { observations: [], findings: validation.errors.map((error) => `config: ${error}`) };
  }

  const findings: string[] = [];

  // Index assignments: observer key → candidate id. First assignment wins;
  // a conflicting later assignment for the same observer is reported.
  const assignedCandidateByObserver = new Map<string, string>();
  assignmentRecords.forEach((record, index) => {
    if (!matchesWhere(record, config.assignment.where)) return;
    const observerKey = readAtPath(record, config.assignment.observer_key_path);
    const candidateId = readAtPath(record, config.assignment.candidate_key_path);
    if (typeof observerKey !== 'string' || observerKey.length === 0) {
      findings.push(`assignment[${index}]: observer key missing at ${config.assignment.observer_key_path.join('.')} — skipped.`);
      return;
    }
    if (typeof candidateId !== 'string' || candidateId.length === 0) {
      findings.push(`assignment[${index}]: candidate id missing at ${config.assignment.candidate_key_path.join('.')} — skipped.`);
      return;
    }
    const existing = assignedCandidateByObserver.get(observerKey);
    if (existing !== undefined && existing !== candidateId) {
      findings.push(`assignment[${index}]: observer ${observerKey} already assigned ${existing}; conflicting ${candidateId} ignored.`);
      return;
    }
    assignedCandidateByObserver.set(observerKey, candidateId);
  });

  // Fold outcomes into per-(observer, emitted metric, candidate) aggregates.
  type Aggregate = { observerId: string; metric: string; candidateId: string; total: number };
  const aggregates = new Map<string, Aggregate>();
  const accumulate = (observerId: string, metric: string, candidateId: string, amount: number) => {
    const key = `${observerId} ${metric} ${candidateId}`;
    const existing = aggregates.get(key);
    if (existing) existing.total += amount;
    else aggregates.set(key, { observerId, metric, candidateId, total: amount });
  };

  outcomeRecords.forEach((record, index) => {
    if (!matchesWhere(record, config.outcome.where)) return;
    const observerKey = readAtPath(record, config.outcome.observer_key_path);
    if (typeof observerKey !== 'string' || observerKey.length === 0) {
      findings.push(`outcome[${index}]: observer key missing at ${config.outcome.observer_key_path.join('.')} — skipped.`);
      return;
    }
    const candidateId = assignedCandidateByObserver.get(observerKey);
    if (candidateId === undefined) {
      findings.push(`outcome[${index}]: observer ${observerKey} has no assignment — skipped.`);
      return;
    }
    const rawMetric = readAtPath(record, config.outcome.metric_path);
    if (typeof rawMetric !== 'string' || rawMetric.length === 0) {
      findings.push(`outcome[${index}]: metric missing at ${config.outcome.metric_path.join('.')} — skipped.`);
      return;
    }
    const emittedMetric = config.emit.metric_map[rawMetric];
    if (emittedMetric === undefined) {
      findings.push(`outcome[${index}]: metric "${rawMetric}" not in emit.metric_map — skipped.`);
      return;
    }
    accumulate(observerKey, emittedMetric, candidateId, 1);

    if (config.outcome.value_path && config.emit.value_metric) {
      const rawValue = readAtPath(record, config.outcome.value_path);
      if (rawValue === undefined) {
        // Absent value is a valid count-only outcome.
      } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        accumulate(observerKey, config.emit.value_metric, candidateId, rawValue);
      } else {
        findings.push(`outcome[${index}]: value at ${config.outcome.value_path.join('.')} is not a finite number — value skipped.`);
      }
    }
  });

  const trustRef = config.emit.trust_ref ?? DEFAULT_TRUST_REF;
  const observations: ObserveOptions[] = [...aggregates.values()].map((aggregate) => ({
    observerId: aggregate.observerId,
    trustRef,
    path: ['candidate', 'outcome', aggregate.metric, aggregate.candidateId],
    value: aggregate.total,
    at,
    basis: config.join_id,
  }));

  return { observations, findings };
}
