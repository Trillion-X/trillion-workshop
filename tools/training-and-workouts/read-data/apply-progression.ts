// packages/training-plan/read-data/apply-progression.ts
// Apply a progression decision's adjustment to a session prescription -> the next
// session. training-plan OWNS the prescription schema (dose/intensity), so it
// interprets its own adjustment keys here (L98 — the owner reads its own data).
// The adjustment payload comes from evaluate-progression (opaque to that module);
// the keys honored below are training-plan's contract. Pure + total: unknown keys
// are ignored, non-numeric dose/intensity values pass through untouched, and the
// input prescription is never mutated.

import type { TrainingSessionPrescription } from './training-plan';
import type { ProgressionDecision } from '@/packages/progression-evaluator/read-data/evaluate-progression';

/** The adjustment keys training-plan honors. Extra keys are preserved-but-ignored
 *  (downstream may read e.g. a next-level ref). All optional. */
export type PrescriptionAdjustment = {
  /** Multiply every numeric `dose` field by this factor (e.g. 0.85 = ease off). */
  doseScale?: number;
  /** Multiply every numeric `intensity` field by this factor. */
  intensityScale?: number;
  /** A coaching note carried onto the next prescription's intensity.note. */
  note?: string;
};

/** Scale every finite-number value in a flat record by `factor`; integers stay
 *  integers, others round to 2 dp. Non-number values pass through unchanged. */
function scaleNumericFields(
  record: Record<string, unknown>,
  factor: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const scaled = value * factor;
      out[key] = Number.isInteger(value) ? Math.round(scaled) : Math.round(scaled * 100) / 100;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Apply ONE adjustment to a prescription, returning a new prescription. Pure.
 * A `doseScale`/`intensityScale` scales the numeric fields of dose/intensity; a
 * `note` is recorded at `intensity.note`. Absent keys leave that part unchanged.
 */
export function applyAdjustmentToPrescription(
  prescription: TrainingSessionPrescription,
  adjustment: Record<string, unknown>,
): TrainingSessionPrescription {
  const doseScale = asFiniteNumber(adjustment.doseScale);
  const intensityScale = asFiniteNumber(adjustment.intensityScale);
  const note = typeof adjustment.note === 'string' ? adjustment.note : undefined;

  const dose = doseScale !== undefined ? scaleNumericFields(prescription.dose, doseScale) : { ...prescription.dose };
  const intensity = intensityScale !== undefined
    ? scaleNumericFields(prescription.intensity, intensityScale)
    : { ...prescription.intensity };
  if (note !== undefined) intensity.note = note;

  return { ...prescription, dose, intensity };
}

/**
 * Fold every adjustment of a ProgressionDecision onto a prescription, in order,
 * producing the next session's prescription. With no fired rules the prescription
 * is returned structurally cloned (unchanged). Pure + total.
 */
export function applyProgressionDecision(
  prescription: TrainingSessionPrescription,
  decision: ProgressionDecision,
): TrainingSessionPrescription {
  const adjustments = Array.isArray(decision?.adjustments) ? decision.adjustments : [];
  return adjustments.reduce<TrainingSessionPrescription>(
    (current, adjustment) => applyAdjustmentToPrescription(current, adjustment),
    applyAdjustmentToPrescription(prescription, {}),
  );
}
