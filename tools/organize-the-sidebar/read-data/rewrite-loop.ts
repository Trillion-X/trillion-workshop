// packages/group/read-data/rewrite-loop.ts
//
// R14: the write-a-lot → CUT-to-nugget → rewrite-around-it loop. The AI GENERATION steps
// (writing the long draft, writing the rewrite) dispatch to model-selection owners — the owner
// boundary, no god package. Everything BETWEEN them is pure and self-contained: CUTTING a
// draft to its highest-value nugget (judge-ranked sentences) and the loop bookkeeping
// (versions, stages, best-so-far). Those are provable with no engine.
//
// The judge (writing-judge.ts) is the same one R13 ships, so "cut to the best bit" and
// "score the rewrite" reuse one scorer — a rubric is DATA (L090).

import {
  DEFAULT_SCORERS,
  judgeText,
  type Rubric,
  type TextScorer,
} from './writing-judge.ts';

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Every sentence ranked best-first by the rubric — the raw material for "cut to nugget". */
export function rankSentences(
  text: string,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): { sentence: string; score: number }[] {
  return sentences(text)
    .map((sentence) => ({ sentence, score: judgeText(sentence, rubric, scorers).overall }))
    .sort((a, b) => b.score - a.score || (a.sentence < b.sentence ? -1 : 1));
}

/** The single highest-value sentence — the nugget to rewrite around. Empty text → ''. */
export function nuggetOf(
  text: string,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): string {
  return rankSentences(text, rubric, scorers)[0]?.sentence ?? '';
}

/** Top-N nuggets, best-first (for "keep the 2 best bits"). */
export function topNuggets(
  text: string,
  rubric: Rubric,
  n: number,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): string[] {
  return rankSentences(text, rubric, scorers)
    .slice(0, Math.max(0, n))
    .map((r) => r.sentence);
}

export type LoopStage = 'draft' | 'nugget' | 'rewrite';

export interface LoopVersion {
  readonly id: string;
  readonly stage: LoopStage;
  readonly text: string;
  readonly score: number; // overall judge score at this version
}

export interface RewriteLoop {
  readonly versions: readonly LoopVersion[];
}

function scoreOf(text: string, rubric: Rubric, scorers: Readonly<Record<string, TextScorer>>): number {
  return judgeText(text, rubric, scorers).overall;
}

/** Start the loop from a long draft (produced by the AI generation step). */
export function startLoop(
  draft: string,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): RewriteLoop {
  return { versions: [{ id: 'v0', stage: 'draft', text: draft, score: scoreOf(draft, rubric, scorers) }] };
}

/** CUT the latest version to its nugget (pure — no model). Appends a 'nugget' version. */
export function cutToNugget(
  loop: RewriteLoop,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): RewriteLoop {
  const latest = loop.versions[loop.versions.length - 1];
  if (!latest) return loop;
  const nugget = nuggetOf(latest.text, rubric, scorers);
  return {
    versions: [
      ...loop.versions,
      { id: `v${loop.versions.length}`, stage: 'nugget', text: nugget, score: scoreOf(nugget, rubric, scorers) },
    ],
  };
}

/** Append a REWRITE (text produced by the AI generation step, built around the nugget). */
export function appendRewrite(
  loop: RewriteLoop,
  rewrittenText: string,
  rubric: Rubric,
  scorers: Readonly<Record<string, TextScorer>> = DEFAULT_SCORERS,
): RewriteLoop {
  return {
    versions: [
      ...loop.versions,
      { id: `v${loop.versions.length}`, stage: 'rewrite', text: rewrittenText, score: scoreOf(rewrittenText, rubric, scorers) },
    ],
  };
}

/** The best version produced so far (highest judge score; ties → earliest). */
export function bestVersion(loop: RewriteLoop): LoopVersion | null {
  let best: LoopVersion | null = null;
  for (const v of loop.versions) {
    if (!best || v.score > best.score) best = v;
  }
  return best;
}
