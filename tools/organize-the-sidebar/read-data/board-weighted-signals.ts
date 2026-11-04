// packages/group/read-data/board-weighted-signals.ts
//
// The WEIGHTED-SIGNAL primitive (pure leaf, GENERIC engine): a blind reducer that turns a set of
// self-describing "signals" into a per-card score + the reasons behind it. This is the shared engine for
// EVERY board lens that ranks cards by a weighted set of derived signals — "Needs attention" (risk
// signals) and "On a roll" (momentum signals) are just two DATA registries fed to this ONE engine. It
// does NOT compute any signal and never names one (no `overdue`, no `recent-effort` here). The DERIVED
// signals are assembled by the bridges from the ALREADY-SHIPPED primitives' leaves and handed in as DATA;
// adding a new signal (or a whole new lens) is a DATA registry, ZERO change here (L069/L090/enum-
// dissolution). Physics only: weighted sum, no clock. NOTE: the score is additive and unbounded-ish — it
// is for ORDERING cards, never a "board is 82% healthy" fraction.

/** One self-describing signal: a stable key, a human reason label, a weight, and how strongly it fires. */
export interface WeightedSignal {
  readonly key: string;
  readonly label: string;
  /** Relative importance (>= 0). */
  readonly weight: number;
  /** How strongly this signal fires, 0..1 (0 = inactive). */
  readonly magnitude: number;
}

/** One active reason: the signal that fired + its contribution to the score (weight * magnitude). */
export interface SignalReason {
  readonly key: string;
  readonly label: string;
  readonly contribution: number;
}

/** A card's verdict for one lens: the total score + the active reasons, strongest first. */
export interface SignalScore {
  readonly score: number;
  readonly reasons: readonly SignalReason[];
}

const EMPTY: SignalScore = { score: 0, reasons: [] };
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Reduce a set of signals to a score. Each signal contributes `weight * clamp01(magnitude)`; the score is
 * the sum, and the reasons are the signals that actually fired (contribution > 0), strongest first.
 * Fail-closed: malformed signals (bad weight/magnitude) are skipped, never throw. Pure — the blind engine
 * never knows what a signal MEANS.
 */
export function weightedSignalScore(signals: readonly WeightedSignal[]): SignalScore {
  if (!Array.isArray(signals) || signals.length === 0) return EMPTY;
  const reasons: SignalReason[] = [];
  let score = 0;
  for (const s of signals) {
    if (!s || typeof s.key !== 'string' || !isFiniteNum(s.weight) || !isFiniteNum(s.magnitude)) continue;
    const contribution = Math.max(0, s.weight) * clamp01(s.magnitude);
    if (contribution > 0) {
      reasons.push({ key: s.key, label: typeof s.label === 'string' ? s.label : s.key, contribution });
      score += contribution;
    }
  }
  reasons.sort((a, b) => b.contribution - a.contribution);
  return { score, reasons };
}

/** A row for ranking items by a weighted-signal score. */
export interface SignalRow<T> {
  readonly item: T;
  readonly result: SignalScore;
}

/**
 * Rank items by score (highest first). Items whose score is 0 (no signals firing) are excluded. Pure —
 * no clock; `signalsOf` is where the caller injects the derived signals for each item (assembled from the
 * other primitives' leaves with an injected `now`).
 */
export function rankByWeightedSignals<T>(items: readonly T[], signalsOf: (item: T) => readonly WeightedSignal[]): SignalRow<T>[] {
  const rows: SignalRow<T>[] = [];
  items.forEach((item) => {
    const result = weightedSignalScore(signalsOf(item));
    if (result.score > 0) rows.push({ item, result });
  });
  return rows.sort((a, b) => b.result.score - a.result.score);
}
