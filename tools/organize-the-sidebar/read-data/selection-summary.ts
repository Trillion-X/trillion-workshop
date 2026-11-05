// packages/group/read-data/selection-summary.ts
//
// SELECTION SUMMARY — the live "what did I just select?" readout. The board already censuses any items array
// into a BoardSummary (board-summary.ts) and the report catalogs already reduce; what was missing is scoping
// that census to the CURRENT SELECTION and projecting it as compact chips for a live bar. This is the free
// L069 emergent of selection (a subset) x board-summary (a census) — it owns NO census logic (it calls
// boardSummary verbatim; SSOT) and NO hardcoded stat list: the chips come from a self-describing spec table
// (L090), so adding a chip is one descriptor row, never a new branch. Pure + deterministic.

import type { BoardItem } from './group-board-model.ts';
import type { BoardSummary } from './board-summary.ts';
import { boardSummary } from './board-summary.ts';

/** One compact fact in the selection bar — `key` is stable (for React keys / testing), `label` is human. */
export interface SummaryChip {
  readonly key: string;
  readonly label: string;
}

/** A chip's scope declares WHAT its number is relative to. `intrinsic` facts (count, words, progress) are true
 *  of any bag of cards on their own; `board` facts (orphan-ness) are relational to the WHOLE board — an item is
 *  an orphan because nothing on the board links it — so they are meaningless over an arbitrary subset. A
 *  selection readout asks for intrinsic chips only; a board-wide readout takes everything. */
export type ChipScope = 'intrinsic' | 'board';

/** Self-describing chip specs (L090): each row decides its scope, whether it applies, and how it reads. The
 *  projector is a blind filter+map — it never enumerates which chips exist. Adding a chip = one row here. The
 *  omit-when-absent rule keeps a plain selection reading as just "N cards / M words" (mirrors summaryText). */
interface ChipSpec {
  readonly key: string;
  readonly scope: ChipScope;
  readonly present: (s: BoardSummary) => boolean;
  readonly label: (s: BoardSummary) => string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const CHIP_SPECS: readonly ChipSpec[] = [
  { key: 'cards', scope: 'intrinsic', present: (s) => s.cards > 0, label: (s) => plural(s.cards, 'card') },
  { key: 'media', scope: 'intrinsic', present: (s) => s.media > 0, label: (s) => `${s.media} media` },
  { key: 'connectors', scope: 'intrinsic', present: (s) => s.connectors > 0, label: (s) => plural(s.connectors, 'link') },
  { key: 'sections', scope: 'intrinsic', present: (s) => s.sections > 0, label: (s) => plural(s.sections, 'section') },
  { key: 'words', scope: 'intrinsic', present: (s) => s.words > 0, label: (s) => plural(s.words, 'word') },
  { key: 'due', scope: 'intrinsic', present: (s) => s.withDueDate > 0, label: (s) => `${s.withDueDate} dated` },
  { key: 'progress', scope: 'intrinsic', present: (s) => s.withProgress > 0, label: (s) => `${s.complete}/${s.withProgress} done` },
  { key: 'avg', scope: 'intrinsic', present: (s) => s.avgProgress !== null, label: (s) => `${s.avgProgress}% avg` },
  { key: 'orphans', scope: 'board', present: (s) => s.orphans > 0, label: (s) => `${s.orphans} unlinked` },
];

/** Project a summary into its present chips, in spec order. Zero-valued facts are omitted. `scopes` restricts
 *  to chips of those scopes (default: every scope — a board-wide readout); pass `['intrinsic']` for a subset. */
export function summaryChips(s: BoardSummary, scopes?: readonly ChipScope[]): readonly SummaryChip[] {
  return CHIP_SPECS
    .filter((spec) => (scopes ? scopes.includes(spec.scope) : true) && spec.present(s))
    .map((spec) => ({ key: spec.key, label: spec.label(s) }));
}

export interface SelectionSummary {
  /** How many of the passed selectedIds actually matched a board item. */
  readonly count: number;
  readonly summary: BoardSummary;
  readonly chips: readonly SummaryChip[];
}

/** Census JUST the selected subset and project its chips. `selectedIds` are memberIds; ids that match no item
 *  are ignored (fail-open — a stale id never throws). An empty selection yields count 0 and an empty chip list. */
export function selectionSummary(items: readonly BoardItem[], selectedIds: readonly string[]): SelectionSummary {
  const want = new Set(selectedIds);
  const subset = items.filter((it) => want.has(it.memberId));
  const summary = boardSummary(subset);
  // intrinsic-only: orphan-ness is board-relational and would falsely fire on any connector-less subset.
  return { count: subset.length, summary, chips: summaryChips(summary, ['intrinsic']) };
}
