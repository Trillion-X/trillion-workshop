// packages/ask-questions-sort-answers-follow-up/read-data/score-and-segment.ts
//
// The Physics of the DECIDE stage: score a respondent from their captured
// answers via DATA rules, then assign a segment from DATA thresholds. Pure +
// framework-agnostic + generic — every rule is a data row, NOTHING is hardcoded
// (no `weights={}`, no `if (archetype === 'hot')`). Generalizes the proven customer
// ScoringRule/TierRule shapes (database.extensions.ts) with generic-naming:
// `readKey` / `scoreLabel` / `segmentId`. Adding a score signal or a segment =
// one more data row; this code never changes (L063/L090).

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

/** Evaluate one rule against one answer value -> points contributed (0 if no match). */
export function evaluateRule(value: unknown, rule: ScoreRule): number {
  const m = rule.match;
  // value_map takes precedence: a direct value->points lookup.
  if (m.value_map) {
    const hit = m.value_map[asString(value)];
    return typeof hit === 'number' ? hit : 0;
  }
  const award = rule.points ?? 0;
  if (m.has_value !== undefined) {
    const present = value !== null && value !== undefined && value !== '';
    return present === m.has_value ? award : 0;
  }
  if (m.equals !== undefined) return value === m.equals ? award : 0;
  if (m.gte !== undefined) return Number(value) >= m.gte ? award : 0;
  if (m.lte !== undefined) return Number(value) <= m.lte ? award : 0;
  if (m.min_length !== undefined) return asString(value).length >= m.min_length ? award : 0;
  if (m.contains !== undefined) return m.contains.some((c) => c === value) ? award : 0;
  return 0;
}

export function scoreAnswers(
  answers: Readonly<Record<string, unknown>>,
  rules: readonly ScoreRule[],
): ScoreResult {
  const breakdown: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  let score = 0;
  for (const rule of rules) {
    const pts = evaluateRule(answers[rule.readKey], rule);
    if (pts === 0) continue;
    score += pts;
    breakdown[rule.readKey] = (breakdown[rule.readKey] ?? 0) + pts;
    if (rule.scoreLabel) byLabel[rule.scoreLabel] = (byLabel[rule.scoreLabel] ?? 0) + pts;
  }
  return { score, breakdown, byLabel };
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
