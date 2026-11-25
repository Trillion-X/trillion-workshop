// packages/ask-questions-sort-answers-follow-up/read-data/score-and-segment.ts
//
// The Physics of the DECIDE stage: score a respondent from their captured
// answers via DATA rules, then assign a segment from DATA thresholds. Pure +
// framework-agnostic + generic — every rule is a data row, NOTHING is hardcoded
// (no `weights={}`, no `if (archetype === 'hot')`). Generalizes the proven customer
// ScoringRule/TierRule shapes (database.extensions.ts) with generic-naming:
// `readKey` / `scoreLabel` / `segmentId`. Adding a score signal or a segment =
// one more data row; this code never changes (L063/L090).

import { aggregateOf, measure } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';

/** How a rule decides whether (and how much) to contribute for an answer. */
export interface MatchSpec {
  /** Map the answer value (as string) -> points. Wins over `points` when hit. */
  value_map?: Record<string, number>;
  equals?: unknown;
  gte?: number;
  lte?: number;
  min_length?: number;
  has_value?: boolean;
  contains?: unknown[];
}

export interface ScoreRule {
  /** Which answer to read (a questionId / fact key). */
  readKey: string;
  /** Points to add when `match` is satisfied (skipped when `value_map` hits). */
  points?: number;
  match: MatchSpec;
  /** A named bucket this rule contributes to (multi-dimensional scoring), when set. */
  scoreLabel?: string;
}

export interface SegmentRule {
  /** Inclusive lower score bound. */
  min: number;
  segmentId: string;
  title?: string;
  meaning?: string;
  nextStep?: string;
}

export interface ScoreResult {
  score: number;
  /** readKey -> points contributed (audit trail; P6 structured delta). */
  breakdown: Record<string, number>;
  /** scoreLabel -> subtotal, when rules use named buckets. */
  byLabel: Record<string, number>;
}

function asString(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** The values an answer stands for: a picks answer ({ picked, other? }, validate-answer.ts) is each value picked; any other
 *  answer is itself. So a rule matches a pick the way it matches a written value, one pick or several. */
function valuesOf(value: unknown): unknown[] {
  const picked = value && typeof value === 'object' ? (value as { picked?: unknown }).picked : undefined;
  return Array.isArray(picked) ? picked : [value];
}

/** Evaluate one rule against one answer value -> points contributed (0 if no match). */
export function evaluateRule(value: unknown, rule: ScoreRule): number {
  const m = rule.match;
  const values = valuesOf(value);
  // value_map takes precedence: a direct value->points lookup, added up over every value picked.
  if (m.value_map) {
    return values.reduce<number>((sum, one) => {
      const hit = m.value_map![asString(one)];
      return sum + (typeof hit === 'number' ? hit : 0);
    }, 0);
  }
  const award = rule.points ?? 0;
  if (m.has_value !== undefined) {
    const present = values.some((one) => one !== null && one !== undefined && one !== '');
    return present === m.has_value ? award : 0;
  }
  if (m.equals !== undefined) return values.some((one) => one === m.equals) ? award : 0;
  if (m.gte !== undefined) return Number(value) >= m.gte ? award : 0;
  if (m.lte !== undefined) return Number(value) <= m.lte ? award : 0;
  if (m.min_length !== undefined) return asString(value).length >= m.min_length ? award : 0;
  if (m.contains !== undefined) return m.contains.some((c) => values.includes(c)) ? award : 0;
  return 0;
}

export function scoreAnswers(
  answers: Readonly<Record<string, unknown>>,
  rules: readonly ScoreRule[],
): ScoreResult {
  // The points each rule earned, kept per answer and per label; the totals are the list engine's `sum` measure.
  const earned: number[] = [];
  const perKey: Record<string, number[]> = {};
  const perLabel: Record<string, number[]> = {};
  for (const rule of rules) {
    const pts = evaluateRule(answers[rule.readKey], rule);
    if (pts === 0) continue;
    earned.push(pts);
    (perKey[rule.readKey] ??= []).push(pts);
    if (rule.scoreLabel) (perLabel[rule.scoreLabel] ??= []).push(pts);
  }
  const total = (points: number[]): number => Number(measure(points, aggregateOf('sum')) ?? 0);
  const totals = (groups: Record<string, number[]>): Record<string, number> =>
    Object.fromEntries(Object.entries(groups).map(([key, points]) => [key, total(points)]));
  return { score: total(earned), breakdown: totals(perKey), byLabel: totals(perLabel) };
}

/** Highest threshold whose `min` the score meets -> the assigned segment, or null. */
export function assignSegment(
  score: number,
  segmentRules: readonly SegmentRule[],
): string | null {
  let best: SegmentRule | null = null;
  for (const rule of segmentRules) {
    if (score >= rule.min && (best === null || rule.min > best.min)) best = rule;
  }
  return best?.segmentId ?? null;
}

export interface DecideResult extends ScoreResult {
  segmentId: string | null;
}

/** One call: score the answers, then assign the segment. */
export function decide(
  answers: Readonly<Record<string, unknown>>,
  scoreRules: readonly ScoreRule[],
  segmentRules: readonly SegmentRule[],
): DecideResult {
  const scored = scoreAnswers(answers, scoreRules);
  return { ...scored, segmentId: assignSegment(scored.score, segmentRules) };
}
