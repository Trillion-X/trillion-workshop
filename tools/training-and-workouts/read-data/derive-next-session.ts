// packages/training-plan/read-data/derive-next-session.ts
//
// =============================================================================
// PURPOSE — the wiring that turns the progression brain into a live next session
// =============================================================================
//
// `evaluate-progression.ts` is the pure rule evaluator and `apply-progression.ts`
// is the pure composer. Both are generic and band-DATA driven, but until this
// module nothing CALLED them over the package's actual stored data, so a finished
// session still never changed the next one (the contract was declared-but-dead).
//
// training-plan OWNS the stored `progression_rule` schema
// ({ id, applies_to, condition: structured_json, adjustment: structured_json }),
// so this module is where training-plan reads its OWN stored shape (L098): it
// decodes the stored rows into the generic evaluator's input, runs the evaluator
// against the measured signals, and applies the resulting decision to the current
// prescription — producing the next session's prescription. The evaluator core
// stays untouched; this is the translation boundary between stored DATA and the
// generic compute.
//
// =============================================================================
// WHY THIS SHAPE (1000x gauntlet trace)
// =============================================================================
//
// L098 owner interprets own data: the stored `condition` blob carries the metric
//   and band; only training-plan knows that layout, so the mapping condition ->
//   { metricRef, band } lives HERE, not inside the generic evaluator.
// L090 self-describing data, generic handler: the decoder reads metricRef + band
//   FROM the record; it never enumerates which metrics or directions are legal.
// L101: this completes the `progression_rule` + `adjust_session` contract the
//   schema already promised, by actually calling the evaluator + composer.
// SSOT / purity: pure + total — it reads only its inputs and never performs I/O,
//   reads a clock, or mutates the input prescription.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  evaluateProgression,
  type ProgressionRule,
  type ProgressionSignal,
  type ProgressionDecision,
} from '@/packages/progression-evaluator/read-data/evaluate-progression';
import { applyProgressionDecision } from './apply-progression';
import type { TrainingSessionPrescription } from './training-plan';

/** Unwrap a stored record's payload envelope (matches the convention used across
 *  read-data decoders: a row may be the payload itself or wrap it). */
function payloadOf(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const record = row as Record<string, unknown>;
  const inner = (record.payload ?? record.value ?? record) as unknown;
  return inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : {};
}

/** Read the first present string among the given keys, else ''. */
function readStringField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof row[key] === 'string') return row[key] as string;
  }
  return '';
}

/** A finite number from a value, else undefined. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Decode ONE stored `progression_rule` row into the generic evaluator's
 * `ProgressionRule`. The stored shape nests the metric + band inside `condition`
 * (a structured_json blob). Two condition layouts are accepted, both pure DATA:
 *   - flat:   { metricRef, min?, max? }
 *   - nested: { metricRef, band: { min?, max? } }
 * snake_case fallbacks (`metric_ref`, `applies_to`) are read too, since stored
 * records may use either casing. Returns null when the row carries no usable
 * metric reference (a malformed rule is dropped, never throws).
 */
export function decodeProgressionRule(raw: unknown): ProgressionRule | null {
  const row = payloadOf(raw);
  const id = readStringField(row, 'id');
  const appliesTo = readStringField(row, 'appliesTo', 'applies_to');
  const label = readStringField(row, 'label');

  const condition = asObject(row.condition);
  const metricRef = readStringField(condition, 'metricRef', 'metric_ref')
    || readStringField(row, 'metricRef', 'metric_ref');
  if (!metricRef) return null;

  // Band may be nested under `band` or flat on the condition.
  const bandSource = condition.band !== undefined ? asObject(condition.band) : condition;
  const min = asFiniteNumber(bandSource.min);
  const max = asFiniteNumber(bandSource.max);

  const adjustment = asObject(row.adjustment);

  return {
    id,
    metricRef,
    band: {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    },
    adjustment,
    ...(appliesTo ? { appliesTo } : {}),
    ...(label ? { label } : {}),
  };
}

/** Decode every stored `progression_rule` row (an array, or a `{ rules: [...] }`
 *  wrapper). Malformed rows are dropped. Order is preserved. */
export function decodeProgressionRules(raw: unknown): ProgressionRule[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.rules)
      ? ((raw as Record<string, unknown>).rules as unknown[])
      : [];
  const out: ProgressionRule[] = [];
  for (const row of rows) {
    const rule = decodeProgressionRule(row);
    if (rule) out.push(rule);
  }
  return out;
}

export type DeriveNextSessionInput = {
  /** The prescription of the session that was just completed. */
  current: TrainingSessionPrescription;
  /** Signals measured from that finished session (metricRef + value). */
  signals: ProgressionSignal[];
  /** Stored `progression_rule` records (raw), decoded here. */
  ruleRecords: unknown;
};

export type DeriveNextSessionResult = {
  /** The next session's prescription (the current one when nothing fired). */
  next: TrainingSessionPrescription;
  /** The decision that produced it (fired rules + adjustments), for proof. */
  decision: ProgressionDecision;
};

/**
 * The live wiring: decode the stored rules, evaluate them against the measured
 * signals, and apply the decision to the current prescription. Pure + total —
 * with no fired rule the next prescription is a structural clone of the current
 * one. This is the single call a workflow/surface makes to advance the plan.
 */
export function deriveNextSession(input: DeriveNextSessionInput): DeriveNextSessionResult {
  const rules = decodeProgressionRules(input.ruleRecords);
  const signals = Array.isArray(input.signals) ? input.signals : [];
  const decision = evaluateProgression({ signals, rules });
  const next = applyProgressionDecision(input.current, decision);
  return { next, decision };
}
