// packages/training-plan/read-data/select-adaptive-next-session.ts
//
// =============================================================================
// PURPOSE — pick the session to adapt from the feed, then run the brain
// =============================================================================
//
// `derive-next-session.ts` answers "given THIS prescription + signals + rules,
// what is the next prescription?" This module answers the surface's question:
// "given the whole training-plan feed, IS there an adapted next session to show,
// and which prescription does it come from?" It reads the optional `lastResult`
// (the signals measured from the most recently finished session) and the stored
// `progression_rule` rows that travel alongside the plan, finds the prescription
// that result belongs to, and runs the brain. It returns null when there is
// nothing to adapt from yet — so the surface shows an honest empty state instead
// of fabricated progress (L117).
//
// =============================================================================
// WHY THIS SHAPE (1000x gauntlet trace)
// =============================================================================
//
// L098 owner interprets own data: training-plan reads its own feed shape
//   (progressionRules / lastResult keys) here; the surface stays a dumb renderer.
// L117 no fake data: returns null (-> honest empty state) when no result exists,
//   never a placeholder "next session".
// SSOT / purity: pure + total — reads only the raw feed, no I/O, no clock.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { deriveNextSession, type DeriveNextSessionResult } from './derive-next-session';
import type { ProgressionSignal } from '@/packages/progression-evaluator/read-data/evaluate-progression';
import { decodeTrainingPlan, type TrainingPlan, type TrainingSessionPrescription } from './training-plan';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Decode the optional `lastResult` block: which session finished and the signals
 *  it produced. Accepts `lastResult` or `last_result`; signals carry metricRef +
 *  value (camel or snake). Returns null when no usable signals are present. */
export function decodeLastResult(
  raw: unknown,
): { sessionId: string; signals: ProgressionSignal[] } | null {
  const root = asObject(raw);
  const block = asObject(root.lastResult ?? root.last_result);
  const sessionId = readString(block.sessionId ?? block.session_id);
  const rawSignals = Array.isArray(block.signals) ? block.signals : [];
  const signals: ProgressionSignal[] = [];
  for (const entry of rawSignals) {
    const row = asObject(entry);
    const metricRef = readString(row.metricRef ?? row.metric_ref);
    const value = row.value;
    if (metricRef && typeof value === 'number' && Number.isFinite(value)) {
      signals.push({ metricRef, value });
    }
  }
  if (signals.length === 0) return null;
  return { sessionId, signals };
}

/** Find the prescription a result belongs to: the named session, else the last
 *  session in the plan (the one most likely just finished). Null when no
 *  sessions exist. */
function currentPrescription(
  plan: TrainingPlan,
  sessionId: string,
): TrainingSessionPrescription | null {
  if (sessionId) {
    const named = plan.sessions.find((session) => session.id === sessionId);
    if (named) return named;
  }
  return plan.sessions.length > 0 ? plan.sessions[plan.sessions.length - 1] : null;
}

export type AdaptiveNextSession = DeriveNextSessionResult & {
  /** The prescription the adaptation was computed FROM (for "before vs after"). */
  from: TrainingSessionPrescription;
};

/**
 * Given the raw training-plan feed, return the adapted next session (with the
 * prescription it came from), or null when there is nothing to adapt yet (no
 * measured result, or no session to adapt). Pure + total — the surface calls
 * this once and renders the card only when it is non-null.
 */
export function selectAdaptiveNextSession(raw: unknown): AdaptiveNextSession | null {
  const root = asObject(raw);
  const lastResult = decodeLastResult(raw);
  if (!lastResult) return null;

  const plan = decodeTrainingPlan(raw);
  const from = currentPrescription(plan, lastResult.sessionId);
  if (!from) return null;

  const ruleRecords = root.progressionRules ?? root.progression_rules ?? [];
  const result = deriveNextSession({ current: from, signals: lastResult.signals, ruleRecords });
  return { ...result, from };
}
