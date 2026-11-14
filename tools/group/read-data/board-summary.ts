// packages/group/read-data/board-summary.ts
//
// BOARD SUMMARY — the quantitative "what's on this board" overview: counts by kind, total words, how many
// goals carry a due date / a progress metric / are complete, and how many cards are orphans. DISTINCT from
// the `status` export (a qualitative review-lens narrative) and `board-rollup` (a per-node child rollup): this
// is a flat, board-wide census. A pure COMPOSITION of the shipped readers (due-date, metric, orphans, the
// connector/section predicates) — it owns no domain logic beyond a trivial word count (L069/L093, no god
// package). Pure + deterministic.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { dueDateFromRaw } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-due-date.ts';
import { metricFromRaw, progressPct } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-metric.ts';
import { orphanCards } from './board-orphans';

export interface BoardSummary {
  /** Content cards — not connectors, not sections. */
  readonly cards: number;
  readonly connectors: number;
  readonly sections: number;
  /** Image/video/audio cards (`kind:'media'`). */
  readonly media: number;
  /** Total words across all card text. */
  readonly words: number;
  readonly withDueDate: number;
  /** Cards carrying a progress metric. */
  readonly withProgress: number;
  /** Cards whose progress is at 100%. */
  readonly complete: number;
  readonly orphans: number;
  /** Mean progress % across cards WITH a metric (rounded), or null when none carry one. */
  readonly avgProgress: number | null;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/** Census the board into a {@link BoardSummary}. Pure + deterministic. */
export function boardSummary(items: readonly BoardItem[]): BoardSummary {
  let cards = 0;
  let connectors = 0;
  let sections = 0;
  let media = 0;
  let words = 0;
  let withDueDate = 0;
  let withProgress = 0;
  let complete = 0;
  let progressSum = 0;
  for (const it of items) {
    if (itemIsConnector(it)) {
      connectors += 1;
      continue;
    }
    if (it.isSection) {
      sections += 1;
      continue;
    }
    cards += 1;
    if (it.kind === 'media') media += 1;
    words += wordCount(typeof it.text === 'string' ? it.text : '');
    if (dueDateFromRaw(it.extra?.dueDate) !== null) withDueDate += 1;
    const m = metricFromRaw(it.extra?.metric);
    if (m) {
      withProgress += 1;
      const p = progressPct(m);
      progressSum += p;
      if (p >= 100) complete += 1;
    }
  }
  return {
    cards,
    connectors,
    sections,
    media,
    words,
    withDueDate,
    withProgress,
    complete,
    orphans: orphanCards(items).length,
    avgProgress: withProgress > 0 ? Math.round(progressSum / withProgress) : null,
  };
}

/** One vital-stat row of a summary — a label + its value as a display string. The structured twin of
 *  `summaryText`: same non-zero-omission logic, but as DATA rows a blind panel renders (label left, value
 *  right) instead of prose. `BoardSummary` is the SSOT; both are pure renderings of it. */
export interface SummaryStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** The visible vital-stat rows of a summary — cards + words always; media/connectors/sections/due-date/goals/
 *  orphans only when non-zero (so a plain board reads as just "Cards / Words", no filler, L118). A blind panel
 *  iterates these; adding a stat is one push here, zero panel code (L090). */
export function summaryStatRows(s: BoardSummary): SummaryStat[] {
  const rows: SummaryStat[] = [{ key: 'cards', label: 'Cards', value: String(s.cards) }];
  if (s.media > 0) rows.push({ key: 'media', label: 'Media', value: String(s.media) });
  if (s.connectors > 0) rows.push({ key: 'connectors', label: 'Connectors', value: String(s.connectors) });
  if (s.sections > 0) rows.push({ key: 'sections', label: 'Sections', value: String(s.sections) });
  rows.push({ key: 'words', label: 'Words', value: String(s.words) });
  if (s.withDueDate > 0) rows.push({ key: 'due', label: 'With a due date', value: String(s.withDueDate) });
  if (s.withProgress > 0) {
    rows.push({ key: 'complete', label: 'Goals complete', value: `${s.complete}/${s.withProgress}${s.avgProgress !== null ? ` · ${s.avgProgress}% avg` : ''}` });
  }
  if (s.orphans > 0) rows.push({ key: 'orphans', label: 'Unconnected', value: String(s.orphans) });
  return rows;
}

/** A compact human report of a summary — one fact per line, omitting the zero-valued optional lines so a
 *  plain board reads as just "N cards / M words". The `summary` document-export format renders this. */
export function summaryText(s: BoardSummary, title?: string): string {
  const lines: string[] = [];
  if (title && title.trim().length > 0) lines.push(title.trim(), '');
  lines.push(`${s.cards} card${s.cards === 1 ? '' : 's'}`);
  if (s.media > 0) lines.push(`${s.media} media`);
  if (s.connectors > 0) lines.push(`${s.connectors} connector${s.connectors === 1 ? '' : 's'}`);
  if (s.sections > 0) lines.push(`${s.sections} section${s.sections === 1 ? '' : 's'}`);
  lines.push(`${s.words} word${s.words === 1 ? '' : 's'}`);
  if (s.withDueDate > 0) lines.push(`${s.withDueDate} with a due date`);
  if (s.withProgress > 0) lines.push(`${s.complete}/${s.withProgress} goals complete${s.avgProgress !== null ? ` (${s.avgProgress}% avg)` : ''}`);
  if (s.orphans > 0) lines.push(`${s.orphans} unconnected`);
  return lines.join('\n');
}
