// packages/group/do-work/board-diff-actions.ts
//
// The bridge from portable board items (TemplateItem[] — what boardToTemplate + a saved arrangement both
// yield) to the blind board-diff engine (read-data/board-diff). It flattens the item tree into the SAME
// `BoardState` shape the CRDT merge uses (SSOT), diffs two of them, and renders a human "what changed"
// changelog. The saved-arrangement library is the natural two-state source: the current board vs a version
// you saved earlier (both resolve to TemplateItem[] over the same ids), so "Compare" answers "what have I
// changed since I saved this?".
//
// Owns no comparison logic (the engine does) and no field vocabulary in the engine sense — the changelog's
// field→human map (position/size/text/style/…) is a DATA label table here, the display twin of the raw
// `changedFields` keys the engine reports. A new tracked field is one label row, zero engine change (L090).

import type { TemplateItem } from '../read-data/board-template-apply';
import type { BoardState, MemberState } from '../read-data/board-merge';
import { diffBoardStates, hasBoardChanges, type BoardStateDiff } from '../read-data/board-diff';

/** Flatten a TemplateItem tree into a BoardState — each descriptor's diffable fields keyed by id. Nested
 *  section children are flattened with a `parent` field, so moving a card in/out of a section reads as a
 *  change. Only DEFINED fields are written, so two cards that both lack `text` compare equal on it. */
export function boardStateFromTemplateItems(items: readonly TemplateItem[]): BoardState {
  const state: Record<string, MemberState> = {};
  const walk = (list: readonly TemplateItem[], parent: string): void => {
    for (const it of list) {
      const fields: Record<string, unknown> = { kind: it.kind, x: it.x, y: it.y, w: it.w, h: it.h };
      if (it.text !== undefined) fields.text = it.text;
      if (it.extra !== undefined) fields.extra = it.extra;
      if (it.from !== undefined) fields.from = it.from;
      if (it.to !== undefined) fields.to = it.to;
      if (parent !== '') fields.parent = parent;
      state[it.id] = fields;
      if (it.children && it.children.length > 0) walk(it.children, it.id);
    }
  };
  walk(items, '');
  return state;
}

/** Diff two portable item lists (before → after). */
export function diffTemplates(before: readonly TemplateItem[], after: readonly TemplateItem[]): BoardStateDiff {
  return diffBoardStates(boardStateFromTemplateItems(before), boardStateFromTemplateItems(after));
}

// The field→human label map (DATA display twin of the engine's raw changedFields keys). Several keys collapse
// to one human word (x+y → "position", w+h → "size") so a moved card reads "position" once. A field with no
// entry falls back to its raw key — the changelog degrades gracefully, never hides an unknown change.
const FIELD_LABELS: Readonly<Record<string, string>> = {
  x: 'position', y: 'position', w: 'size', h: 'size', text: 'text', extra: 'style', parent: 'grouping', kind: 'type', from: 'link', to: 'link',
};

function humanFields(changedFields: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of changedFields) {
    const label = FIELD_LABELS[f] ?? f;
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out.join(', ');
}

/** A card's human label — its text (first non-empty line), else a connector marker, else its id. */
function labelOfItem(it: TemplateItem | undefined, id: string): string {
  const t = typeof it?.text === 'string' ? it.text.trim().split('\n')[0].trim() : '';
  if (t !== '') return t;
  if (it?.kind === 'connector') return 'connector';
  return id;
}

/**
 * Render the diff as a human changelog: an "N added · M removed · K changed" headline + Added / Removed /
 * Changed sections (each card by label; a changed card lists its human field groups). Empty sections are
 * dropped; an identical pair yields the honest "No changes".
 */
export function templateDiffText(before: readonly TemplateItem[], after: readonly TemplateItem[], title?: string): string {
  const diff = diffTemplates(before, after);
  const beforeById = new Map(flattenIds(before));
  const afterById = new Map(flattenIds(after));
  const label = (id: string): string => labelOfItem(afterById.get(id) ?? beforeById.get(id), id);

  const head: string[] = [];
  if (title && title.trim() !== '') head.push(`# ${title.trim()}`, '');
  if (!hasBoardChanges(diff)) return [...head, 'No changes'].join('\n');

  const lines: string[] = [...head];
  lines.push(`${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length} changed`);
  if (diff.added.length > 0) {
    lines.push('', `## Added (${diff.added.length})`);
    for (const id of diff.added) lines.push(`- ${label(id)}`);
  }
  if (diff.removed.length > 0) {
    lines.push('', `## Removed (${diff.removed.length})`);
    for (const id of diff.removed) lines.push(`- ${label(id)}`);
  }
  if (diff.changed.length > 0) {
    lines.push('', `## Changed (${diff.changed.length})`);
    for (const c of diff.changed) lines.push(`- ${label(c.memberId)} — ${humanFields(c.changedFields)}`);
  }
  return lines.join('\n');
}

/** One-call changelog for a surface: the rendered text AND whether anything actually changed (so a caller
 *  can show "Copied changes" vs "No changes" without re-diffing or string-sniffing the text). */
export function templateChangelog(
  before: readonly TemplateItem[],
  after: readonly TemplateItem[],
  title?: string,
): { readonly text: string; readonly changed: boolean } {
  return { text: templateDiffText(before, after, title), changed: hasBoardChanges(diffTemplates(before, after)) };
}

/** Flatten (id, item) pairs across nested section children — labels resolve for members inside sections too. */
function flattenIds(items: readonly TemplateItem[]): [string, TemplateItem][] {
  const out: [string, TemplateItem][] = [];
  const walk = (list: readonly TemplateItem[]): void => {
    for (const it of list) {
      out.push([it.id, it]);
      if (it.children && it.children.length > 0) walk(it.children);
    }
  };
  walk(items);
  return out;
}
