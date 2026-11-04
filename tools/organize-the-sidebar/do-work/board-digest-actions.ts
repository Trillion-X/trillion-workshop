// packages/group/do-work/board-digest-actions.ts
//
// The board DIGEST — a scannable self-assessment the board makes of ITSELF. Where ReviewPanel is the
// interactive surface you open and scan lens-by-lens, the digest is the ONE-glance / copy-into-a-journal /
// send-to-an-accountability-partner readout: a headline verdict + a compact stat line + the single next
// action. It is a pure COMPOSITION of the already-shipped readings (boardCompletion + the three review
// lenses + nextFocus) — it owns no new signal and no storage.
//
// The one piece of NEW logic here is the HEADLINE: a plain-language priority verdict the board does not
// express anywhere else — "3 goals are overdue, triage today" vs "you're close on 2, finish those first"
// vs "2 on a roll, keep it up". That priority ladder is a DATA registry (`DIGEST_HEADLINES`): an ordered
// list of {key, when, message}, first match wins. Adding/retuning a headline rule is ONE row, ZERO change
// to the reducer (L069/L090/enum-dissolution). The ladder ENCODES the board's advice about where attention
// pays off most: unblock what is slipping first, then close out what is nearly done (highest ROI), then
// ride momentum, then — if nothing is tracked — prompt the user to start tracking.

import type { BoardItem } from '../read-data/group-board-model';
import type { RollupSpec } from './board-rollup-actions';
import { boardCompletion } from '../read-data/board-completion';
import { attentionRows } from './board-attention-actions';
import { momentumRows } from './board-momentum-actions';
import { finishLineRows } from './board-finish-line-actions';
import { nextFocus, type FocusPick } from './board-next-focus-actions';

/** The reduced board state the digest headline + stat line are computed from (all counts are of content cards). */
export interface BoardDigest {
  /** How many content cards track progress at all (metric or checklist). */
  readonly tracked: number;
  /** Of the tracked cards, how many are 100% done. */
  readonly complete: number;
  /** Mean completion across tracked cards, 0..100 (whole percent). */
  readonly avgPct: number;
  readonly overdueCount: number;
  readonly attentionCount: number;
  readonly momentumCount: number;
  readonly finishLineCount: number;
  /** The strongest card in each lens (label), or null when that lens is empty. */
  readonly topAttention: string | null;
  readonly topMomentum: string | null;
  readonly topFinishLine: string | null;
  /** The single next action the board recommends (null when nothing is actionable). */
  readonly next: FocusPick | null;
  /** The plain-language priority verdict (never empty — see DIGEST_HEADLINES). */
  readonly headline: string;
}

/** The inputs the headline ladder reads — the reduced digest WITHOUT the headline (avoids self-reference). */
type DigestFacts = Omit<BoardDigest, 'headline'>;

const pluralCards = (n: number): string => `${n} ${n === 1 ? 'goal' : 'goals'}`;

/** One headline rule: fires when `when` is true; `message` renders the plain-language verdict from the facts. */
interface DigestHeadlineDef {
  readonly key: string;
  readonly when: (d: DigestFacts) => boolean;
  readonly message: (d: DigestFacts) => string;
}

/**
 * The headline priority ladder — Society DATA, ordered by where attention pays off most. First match wins;
 * the final rule is a catch-all so a headline is ALWAYS produced. Retuning priority = reorder rows; adding
 * a verdict = add a row. The reducer never changes.
 */
export const DIGEST_HEADLINES: readonly DigestHeadlineDef[] = [
  {
    key: 'overdue',
    when: (d) => d.overdueCount > 0,
    message: (d) => `${pluralCards(d.overdueCount)} overdue — triage today.`,
  },
  {
    key: 'finish-line',
    when: (d) => d.finishLineCount > 0,
    message: (d) => `You're close on ${pluralCards(d.finishLineCount)} — finish those first.`,
  },
  {
    key: 'attention',
    when: (d) => d.attentionCount > 0,
    message: (d) => `${pluralCards(d.attentionCount)} need attention — take a look.`,
  },
  {
    key: 'momentum',
    when: (d) => d.momentumCount > 0,
    message: (d) => `${pluralCards(d.momentumCount)} on a roll — keep it up.`,
  },
  {
    key: 'untracked',
    when: (d) => d.tracked === 0,
    message: () => `No goals tracked yet — add a metric or a due date to start.`,
  },
  {
    key: 'steady',
    when: () => true, // catch-all: something is tracked, nothing is slipping/close/moving
    message: (d) => `Steady — ${d.complete}/${d.tracked} done, nothing urgent.`,
  },
];

/** Resolve the headline for a set of digest facts via the ladder (first matching rule; always non-empty). */
export function digestHeadline(facts: DigestFacts): string {
  const rule = DIGEST_HEADLINES.find((r) => r.when(facts));
  return rule ? rule.message(facts) : '';
}

/**
 * Reduce a board to its digest at `now`. `spec` (the rollup relation, or null) lets `nextFocus` prefer a
 * critical-path bottleneck; without it the next action falls back to the most at-risk forecast goal. Pure —
 * `now` is injected. Composes boardCompletion + the three lenses + nextFocus, then resolves the headline.
 */
export function boardDigest(items: readonly BoardItem[], spec: RollupSpec | null, now: number): BoardDigest {
  const completion = boardCompletion(items);
  const attention = attentionRows(items, now);
  const momentum = momentumRows(items, now);
  const finishLine = finishLineRows(items, now);
  const overdueCount = attention.filter((r) => r.reasons.includes('Overdue')).length;

  const facts: DigestFacts = {
    tracked: completion.tracked,
    complete: completion.complete,
    avgPct: completion.avgPct,
    overdueCount,
    attentionCount: attention.length,
    momentumCount: momentum.length,
    finishLineCount: finishLine.length,
    topAttention: attention[0]?.label ?? null,
    topMomentum: momentum[0]?.label ?? null,
    topFinishLine: finishLine[0]?.label ?? null,
    next: nextFocus(items, spec, now),
  };

  return { ...facts, headline: digestHeadline(facts) };
}

/**
 * Render a digest as a plain-language STATUS narrative — a copy-into-a-standup / journal / accountability
 * message. The board's self-assessment as SHAREABLE TEXT (distinct from the content exports, which
 * serialize the cards): the headline verdict, a line per firing review lens (count + its strongest card),
 * and the single next action. An optional title leads. Pure — reads only the digest.
 */
export function digestText(digest: BoardDigest, title?: string): string {
  const t = typeof title === 'string' ? title.trim() : '';
  const lines: string[] = [t.length > 0 ? `${t} — ${digest.headline}` : digest.headline];

  const lenses: readonly [number, string, string | null][] = [
    [digest.attentionCount, 'Needs attention', digest.topAttention],
    [digest.finishLineCount, 'Almost there', digest.topFinishLine],
    [digest.momentumCount, 'On a roll', digest.topMomentum],
  ];
  const body = lenses
    .filter(([count]) => count > 0)
    .map(([count, label, top]) => `${label} (${count})${top ? `: ${top}` : ''}`);
  if (body.length > 0) lines.push('', ...body);

  if (digest.next) lines.push('', `Next: ${digest.next.label} — ${digest.next.reason}`);

  return lines.join('\n').trim();
}
