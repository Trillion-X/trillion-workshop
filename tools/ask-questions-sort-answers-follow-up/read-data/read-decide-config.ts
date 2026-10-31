// packages/ask-questions-sort-answers-follow-up/read-data/read-decide-config.ts
//
// Decode the DECIDE + ACT configuration (score rules, segment rules, follow-up
// sequences) from the live published-records aggregate. All three are DATA rows
// filtered by `kind` from the same entry the capture pipeline reads — the View
// reads ONE input and builds the whole config. Pure + defensive (drops malformed
// rows). Generic: a new rule is a DATA row, this decoder never changes.

import type {
  ScoreRule,
  SegmentRule,
  MatchSpec,
} from './score-and-segment.ts';
import {
  readFollowUpSequences,
  type FollowUpSequence,
} from './follow-up-sequences.ts';

const SCORE_RULE_KIND = 'score-rule';
const SEGMENT_RULE_KIND = 'segment-rule';

export interface DecideConfig {
  scoreRules: ScoreRule[];
  segmentRules: SegmentRule[];
  followUpSequences: FollowUpSequence[];
}

function payloadOf(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const inner = (row as { payload?: unknown }).payload ?? row;
  return inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function rowsOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

// Form scoping (L090): a rule with a `formId` applies ONLY to that form; a rule
// with no `formId` is global. When the caller does not request a form (`formId`
// undefined) every rule is returned — preserving the original global behavior so
// existing configs are unchanged. This lets one form (e.g. a feedback
// satisfaction survey) carry its own score/segment rules WITHOUT mis-segmenting
// another form whose answers lack those keys.
function ruleMatchesForm(p: Record<string, unknown>, formId: string | undefined): boolean {
  if (formId === undefined) return true;
  const ruleForm = typeof p.formId === 'string' ? p.formId : undefined;
  return ruleForm === undefined || ruleForm === formId;
}

export function readScoreRules(raw: unknown, formId?: string): ScoreRule[] {
  const out: ScoreRule[] = [];
  for (const row of rowsOf(raw)) {
    const p = payloadOf(row);
    if (!p || p.kind !== SCORE_RULE_KIND) continue;
    if (!ruleMatchesForm(p, formId)) continue;
    if (typeof p.readKey !== 'string') continue;
    if (!p.match || typeof p.match !== 'object' || Array.isArray(p.match)) continue;
    out.push({
      readKey: p.readKey,
      match: p.match as MatchSpec,
      points: typeof p.points === 'number' ? p.points : undefined,
      scoreLabel: typeof p.scoreLabel === 'string' ? p.scoreLabel : undefined,
    });
  }
  return out;
}

export function readSegmentRules(raw: unknown, formId?: string): SegmentRule[] {
  const out: SegmentRule[] = [];
  for (const row of rowsOf(raw)) {
    const p = payloadOf(row);
    if (!p || p.kind !== SEGMENT_RULE_KIND) continue;
    if (!ruleMatchesForm(p, formId)) continue;
    if (typeof p.min !== 'number' || typeof p.segmentId !== 'string') continue;
    const rule: SegmentRule = { min: p.min, segmentId: p.segmentId };
    if (typeof p.title === 'string') rule.title = p.title;
    if (typeof p.meaning === 'string') rule.meaning = p.meaning;
    if (typeof p.nextStep === 'string') rule.nextStep = p.nextStep;
    out.push(rule);
  }
  return out;
}

/**
 * Decode the whole DECIDE + ACT config from the published-records entry, scoped
 * to `formId` when given (that form's score/segment rules + any global rules).
 * Omit `formId` for the legacy global view.
 */
export function readDecideConfig(raw: unknown, formId?: string): DecideConfig {
  return {
    scoreRules: readScoreRules(raw, formId),
    segmentRules: readSegmentRules(raw, formId),
    followUpSequences: readFollowUpSequences(raw),
  };
}
