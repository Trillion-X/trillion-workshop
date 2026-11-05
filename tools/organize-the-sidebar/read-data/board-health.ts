// packages/group/read-data/board-health.ts
//
// BOARD HEALTH — one number for "how tidy is this board?", rolled up from the hygiene detectors that already
// exist. Each detector (orphans, untagged, ambiguous titles, unlinked mentions, duplicate connectors,
// mini-documents) flags a set of AFFECTED items out of an ELIGIBLE population; health is the weighted fraction
// of the board that is clean, 0–100, plus a per-signal breakdown so you know WHAT to fix.
//
// The signal set is an INJECTED catalog (`HEALTH_SIGNALS`, overridable, L083): each row is DATA carrying a
// weight + a `detect(items) → {affected, eligible}` that COMPOSES an existing detector (L069/L093 — this leaf
// owns no hygiene logic of its own; it only reduces). A new signal is one row with ZERO engine change (the
// deletion test: drop `orphans`, add any `{weight, detect}`, the score still computes). The reducer is blind —
// it never names a signal. Pure, deterministic.

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { itemIsBoardFurniture } from '../do-work/batch-actions.ts';
import { buildRelationGraph } from './relationship-graph.ts';
import { orphanCards } from './board-orphans.ts';
import { ambiguousTitleIds } from './board-titles.ts';
import { cardsWithUnlinkedMentions } from './board-mentions.ts';
import { redundantConnectorIds } from './duplicate-connectors.ts';
import { untaggedCardIds, tagCoverage } from './board-tag-coverage.ts';
import { splitCandidateIds } from './board-split-candidates.ts';

/** What one signal found: the affected item ids + the population the ratio is measured against. */
export interface HealthSignalResult {
  readonly affected: readonly string[];
  readonly eligible: number;
}

/** A health signal = DATA: a weight + a detector composing an existing hygiene reader. */
export interface HealthSignal {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly detect: (items: readonly BoardItem[]) => HealthSignalResult;
}

/** Content card = not a connector and not generated furniture — the denominator most signals measure against. */
function contentCardCount(items: readonly BoardItem[]): number {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i)).length;
}

/** The default hygiene signal catalog — each a thin DATA wrapper over a shipped detector (L069/L093). An owner
 *  can pass its own set to {@link boardHealth}; the reducer never assumes these specific ids. */
export const HEALTH_SIGNALS: readonly HealthSignal[] = [
  { id: 'orphans', label: 'Disconnected cards', weight: 1, detect: (i) => ({ affected: orphanCards(i), eligible: contentCardCount(i) }) },
  { id: 'untagged', label: 'Untagged cards', weight: 0.5, detect: (i) => ({ affected: untaggedCardIds(i), eligible: tagCoverage(i).taggedCount > 0 ? contentCardCount(i) : 0 }) },
  { id: 'ambiguous-titles', label: 'Ambiguous titles', weight: 1, detect: (i) => ({ affected: ambiguousTitleIds(i), eligible: contentCardCount(i) }) },
  { id: 'unlinked-mentions', label: 'Unlinked mentions', weight: 0.5, detect: (i) => ({ affected: cardsWithUnlinkedMentions(i), eligible: contentCardCount(i) }) },
  { id: 'duplicate-connectors', label: 'Duplicate connectors', weight: 0.75, detect: (i) => ({ affected: redundantConnectorIds(i), eligible: buildRelationGraph(i).edges.length }) },
  { id: 'overlong-cards', label: 'Cards to split', weight: 0.5, detect: (i) => ({ affected: splitCandidateIds(i), eligible: contentCardCount(i) }) },
];

/** One signal's contribution to the score. `applicable` is false when nothing in the board could exhibit it
 *  (eligible 0) — such a signal neither penalizes nor dilutes the score. */
export interface HealthSignalBreakdown {
  readonly id: string;
  readonly label: string;
  readonly affected: number;
  readonly eligible: number;
  readonly ratio: number;
  readonly applicable: boolean;
}

export interface BoardHealth {
  /** 0–100 (higher = cleaner), or null when no signal applies (an empty board). */
  readonly score: number | null;
  readonly grade: string;
  readonly breakdown: readonly HealthSignalBreakdown[];
}

/** Grade bands as DATA (highest `min` first wins). */
export const HEALTH_GRADES: readonly { readonly min: number; readonly label: string }[] = [
  { min: 90, label: 'Excellent' },
  { min: 75, label: 'Good' },
  { min: 50, label: 'Fair' },
  { min: 0, label: 'Needs work' },
];

/** Map a 0–100 score to its grade band. */
export function healthGrade(score: number): string {
  for (const g of HEALTH_GRADES) if (score >= g.min) return g.label;
  return HEALTH_GRADES[HEALTH_GRADES.length - 1].label;
}

/** One signal's DETAIL including the affected item IDS — the jumpable twin of the count-only
 *  {@link HealthSignalBreakdown}, for an interactive health lens that navigates to each signal's cards. */
export interface HealthSignalDetail {
  readonly id: string;
  readonly label: string;
  readonly affected: readonly string[];
  readonly eligible: number;
  readonly ratio: number;
  readonly applicable: boolean;
}

/** Run every signal's detector once → per-signal detail (ids + ratio). The SSOT the score and the interactive
 *  health lens both read (so a signal is detected once, L030). */
export function healthSignalDetails(items: readonly BoardItem[], signals: readonly HealthSignal[] = HEALTH_SIGNALS): HealthSignalDetail[] {
  return signals.map((s) => {
    const r = s.detect(items);
    const applicable = r.eligible > 0;
    const ratio = applicable ? Math.min(r.affected.length / r.eligible, 1) : 0;
    return { id: s.id, label: s.label, affected: r.affected, eligible: r.eligible, ratio, applicable };
  });
}

/** Roll the signals up into a 0–100 health score (weighted fraction clean) + a per-signal breakdown. Derives
 *  from {@link healthSignalDetails} so the detectors run once and the count-breakdown never drifts from the ids. */
export function boardHealth(items: readonly BoardItem[], signals: readonly HealthSignal[] = HEALTH_SIGNALS): BoardHealth {
  const weightById = new Map(signals.map((s) => [s.id, s.weight]));
  const details = healthSignalDetails(items, signals);
  const applicable = details.filter((d) => d.applicable);
  const weightSum = applicable.reduce((a, d) => a + (weightById.get(d.id) ?? 0), 0);
  const penalty = weightSum === 0 ? 0 : applicable.reduce((a, d) => a + (weightById.get(d.id) ?? 0) * d.ratio, 0) / weightSum;
  const score = weightSum === 0 ? null : Math.round(100 * (1 - penalty));
  const grade = score === null ? 'No cards' : healthGrade(score);
  const breakdown = details.map((d) => ({ id: d.id, label: d.label, affected: d.affected.length, eligible: d.eligible, ratio: d.ratio, applicable: d.applicable }));
  return { score, grade, breakdown };
}

/** The content cards flagged by ANY signal (sorted union) — what "Select cards with issues" selects. Connector
 *  ids (e.g. from duplicate-connectors) are excluded so the selection stays on the proven card-selection model. */
export function cardIdsWithHealthIssues(items: readonly BoardItem[], signals: readonly HealthSignal[] = HEALTH_SIGNALS): string[] {
  const cardIds = new Set(items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i)).map((i) => i.memberId));
  const flagged = new Set<string>();
  for (const s of signals) for (const id of s.detect(items).affected) if (cardIds.has(id)) flagged.add(id);
  return [...flagged].sort();
}

/** True when ≥1 content card is flagged by a signal — the gate for the "Select cards with issues" surface. */
export function boardHasHealthIssues(items: readonly BoardItem[], signals: readonly HealthSignal[] = HEALTH_SIGNALS): boolean {
  return cardIdsWithHealthIssues(items, signals).length > 0;
}

/** A human "## Board health" readout: the score + grade, then one line per signal that flagged something (or a
 *  "Nothing to fix" line when clean), and an honest "No cards" for an empty board. */
export function boardHealthText(items: readonly BoardItem[], title?: string, signals: readonly HealthSignal[] = HEALTH_SIGNALS): string {
  const health = boardHealth(items, signals);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Board health');
  if (health.score === null) {
    lines.push('- No cards');
    return lines.join('\n');
  }
  lines.push(`- Score: ${health.score}/100 (${health.grade})`);
  const issues = health.breakdown.filter((b) => b.affected > 0);
  if (issues.length === 0) lines.push('- Nothing to fix');
  else for (const b of issues) lines.push(`- ${b.label}: ${b.affected}`);
  return lines.join('\n');
}
