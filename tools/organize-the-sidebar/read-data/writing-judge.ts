// packages/group/read-data/writing-judge.ts
//
// R13: a DATA-configurable judge for writing. A rubric is DATA — a list of weighted criteria,
// each naming a scorer. The judge runs each criterion's scorer over the text and returns a
// weighted overall score plus a per-criterion breakdown. Adding a criterion or a whole new
// rubric (blog post vs tweet vs headline) is DATA; the judge never branches on criterion id
// (L090) — it dispatches through an INJECTED scorer map.
//
// The built-in scorers here are PURE heuristics (length target, keyword coverage, sentence
// variety, readability) — self-contained and provable with no engine. A model-backed scorer
// (an LLM rating quality) is just another entry in the injected map that dispatches to
// model-selection owners — owner-gated, no god package — but the rubric mechanism is complete without
// it. This mirrors the progression-evaluator judge pattern, kept self-contained for the board.

import { ownValue } from './facet-filter.ts';

/** A rubric's `keywords` config is UNTRUSTED DATA — cap the count so a hostile rubric can't run
 *  unbounded case-folding substring searches over the text (DoS). No real rubric needs this many. */
const MAX_KEYWORDS = 256;

export interface RubricCriterion {
  readonly id: string;
  readonly label: string;
  readonly weight: number; // relative weight (any positive number)
  readonly scorer: string; // key into the injected scorer map (DATA-selected)
  readonly config?: Readonly<Record<string, unknown>>; // scorer parameters
}

export interface Rubric {
  readonly id: string;
  readonly name: string;
  readonly criteria: readonly RubricCriterion[];
}

export interface CriterionScore {
  readonly id: string;
  readonly label: string;
  readonly score: number; // 0..1
  readonly weight: number;
}

export interface JudgeResult {
  readonly overall: number; // 0..1 weighted mean
  readonly breakdown: readonly CriterionScore[];
}

/** A scorer maps text (+ its config) to a 0..1 quality score. */
export type TextScorer = (text: string, config?: Readonly<Record<string, unknown>>) => number;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
const sentences = (text: string): string[] =>
  text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);

function num(config: Readonly<Record<string, unknown>> | undefined, key: string, fallback: number): number {
  const v = config?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Built-in pure heuristic scorers. A product may pass its own map to override/extend. */
export const DEFAULT_SCORERS: Readonly<Record<string, TextScorer>> = {
  // Full credit inside [min,max] words; linear falloff outside, floored at 0.
  'length-target': (text, cfg) => {
    const n = words(text).length;
    const min = num(cfg, 'min', 20);
    const max = num(cfg, 'max', 120);
    if (n >= min && n <= max) return 1;
    if (n < min) return clamp01(n / Math.max(1, min));
    return clamp01(1 - (n - max) / Math.max(1, max));
  },
  // Fraction of the target keywords present (case-insensitive substring).
  'keyword-coverage': (text, cfg) => {
    const kws = Array.isArray(cfg?.keywords)
      ? (cfg!.keywords as unknown[]).slice(0, MAX_KEYWORDS).filter((k) => typeof k === 'string')
      : [];
    if (kws.length === 0) return 1;
    const hay = text.toLowerCase();
    const hit = (kws as string[]).filter((k) => hay.includes(k.toLowerCase())).length;
    return clamp01(hit / kws.length);
  },
  // Sentence-length variety — coefficient of variation, normalised (more variety → higher).
  'sentence-variety': (text) => {
    const lens = sentences(text).map((s) => words(s).length);
    if (lens.length < 2) return 0;
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (mean === 0) return 0;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / mean;
    return clamp01(cv / 0.6); // cv ~0.6 → full marks
  },
  // Readability by average words-per-sentence; ideal ~11-18, falloff outside.
  readability: (text) => {
    const sents = sentences(text);
    if (sents.length === 0) return 0;
    const wps = words(text).length / sents.length;
    if (wps >= 11 && wps <= 18) return 1;
    if (wps < 11) return clamp01(wps / 11);
    return clamp01(1 - (wps - 18) / 22);
  },
  nonempty: (text) => (text.trim().length > 0 ? 1 : 0),
};

/** Judge `text` against a `rubric`. Weighted mean of per-criterion scores; unknown scorer →
 *  0 for that criterion (never throws). */
export function judgeText(
  text: string,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): JudgeResult {
  const breakdown: CriterionScore[] = rubric.criteria.map((c) => {
    // `c.scorer` is UNTRUSTED DATA (a shareable rubric). A raw `scorers[c.scorer]` resolves a prototype
    // key: `'__proto__'` -> Object.prototype (truthy, NOT callable) -> a TypeError CRASH on `scorer(...)`;
    // `'constructor'` -> an inherited function. `ownValue` (own-key SSOT) + a function check fail closed to 0.
    const scorer = ownValue<TextScorer>(scorers, c.scorer);
    const score = typeof scorer === 'function' ? clamp01(scorer(text, c.config)) : 0;
    return { id: c.id, label: c.label, score, weight: c.weight };
  });
  const totalWeight = breakdown.reduce((s, c) => s + c.weight, 0) || 1;
  const overall = breakdown.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  return { overall: clamp01(overall), breakdown };
}

/** A sensible general-purpose clarity rubric (DATA — a product may swap it). Rewards tight,
 *  varied, readable, non-empty writing; the default when a caller judges board text without
 *  a domain rubric (L083 maximally-capable default). */
export const DEFAULT_WRITING_RUBRIC: Rubric = {
  id: 'clarity',
  name: 'Clarity',
  criteria: [
    { id: 'len', label: 'Concise', weight: 2, scorer: 'length-target', config: { min: 6, max: 40 } },
    { id: 'var', label: 'Varied', weight: 1, scorer: 'sentence-variety' },
    { id: 'read', label: 'Readable', weight: 1, scorer: 'readability' },
    { id: 'ne', label: 'Non-empty', weight: 1, scorer: 'nonempty' },
  ],
};

/** Rank several drafts best-first by overall score — the sparring/judge use case. */
export function rankDrafts(
  drafts: readonly { readonly id: string; readonly text: string }[],
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): { id: string; overall: number }[] {
  return drafts
    .map((d) => ({ id: d.id, overall: judgeText(d.text, rubric, scorers).overall }))
    .sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
}
