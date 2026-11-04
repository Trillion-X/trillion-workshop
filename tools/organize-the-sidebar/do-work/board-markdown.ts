// packages/group/do-work/board-markdown.ts
//
// Board -> MARKDOWN export: serialize a board's content into a portable Markdown document you can paste
// into any editor, README, issue, or doc. The board's other exports are visual (board-svg) or structural-
// for-paste (board-clipboard); this is the human-readable TEXT export — the missing "take my board's
// content elsewhere" artifact. Pure + deterministic (`now` injected for relative-time annotations): a
// section becomes a `## heading`, a card becomes a `- bullet`, and a card's checklist becomes nested
// `- [ ]` / `- [x]` task lines. Items are emitted in reading order (top-to-bottom, then left-to-right).
//
// Card ANNOTATIONS (the inline "(80% · due in 3 days)" suffix) are a DATA registry `MARKDOWN_ANNOTATIONS`:
// each entry reads ONE shipped leaf and returns a token or null. Adding an annotation is ONE row, ZERO
// change to the serializer (L069/L090/enum-dissolution) — the serializer never names metric/due/etc.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector, readItems } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import { metricFromRaw, progressPct } from '../read-data/board-metric';
import { dueDateFromRaw, relativeDue } from '../read-data/board-due-date';
import { checklistFromRaw } from '../read-data/board-checklist';
import { groupKey, type GroupGraph, type AddressRef } from '../../ui/show/group/group-graph';

/** A card annotation: reads one leaf and returns an inline token (e.g. "80%", "due in 3 days") or null. */
interface MarkdownAnnotationDef {
  readonly key: string;
  readonly format: (item: BoardItem, now: number) => string | null;
}

/**
 * The annotation registry — Society DATA. Each reads ONLY a shipped leaf; the serializer stays blind. Add
 * an inline annotation (streak, effort, votes, ...) -> add a row. `now` is injected (relative-time).
 */
export const MARKDOWN_ANNOTATIONS: readonly MarkdownAnnotationDef[] = [
  {
    key: 'metric',
    format: (item) => {
      const m = metricFromRaw(item.extra?.metric);
      return m ? `${progressPct(m)}%` : null;
    },
  },
  {
    key: 'due',
    format: (item, now) => {
      const d = dueDateFromRaw(item.extra?.dueDate);
      return d !== null ? `due ${relativeDue(d, now).label}` : null;
    },
  },
];

/** The active inline annotations for a card (in registry order, nulls dropped). */
export function cardAnnotations(item: BoardItem, now: number): string[] {
  return MARKDOWN_ANNOTATIONS.map((a) => a.format(item, now)).filter((s): s is string => typeof s === 'string' && s.length > 0);
}

const labelOf = (item: BoardItem): string => {
  const t = typeof item.text === 'string' ? item.text.trim() : '';
  return t.length > 0 ? t : '(untitled)';
};

export interface BoardMarkdownOptions {
  /** Document title (when set), rendered as a leading `# {title}`. */
  readonly title?: string;
}

/** Emit one card as a `- bullet` (+ inline annotations) and its checklist as nested `- [ ]`/`- [x]` lines. */
function emitCard(lines: string[], item: BoardItem, now: number): void {
  const anns = cardAnnotations(item, now);
  lines.push(`- ${labelOf(item)}${anns.length > 0 ? ` (${anns.join(' · ')})` : ''}`);
  for (const step of checklistFromRaw(item.extra?.checklist)) {
    const text = typeof step.text === 'string' && step.text.trim().length > 0 ? step.text.trim() : '(untitled)';
    lines.push(`  - [${step.done ? 'x' : ' '}] ${text}`);
  }
}

/**
 * Serialize a FLAT list of same-level board items to Markdown at `now`. Connectors + furniture are skipped;
 * sections become `## headings`, other cards become `- bullets` with inline annotations + nested checklist
 * task lines. Reading order = y then x. This is the single-level serializer — for a board with drill-in
 * sections, use `boardTreeToMarkdown` (which recurses so nested cards land UNDER their section heading);
 * a flat list from different levels cannot be reading-order-sorted across levels without orphaning them.
 */
export function boardToMarkdown(items: readonly BoardItem[], now: number, opts: BoardMarkdownOptions = {}): string {
  const content = items.filter((it) => !itemIsConnector(it) && !itemIsBoardFurniture(it));
  const ordered = [...content].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: string[] = [];

  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (title.length > 0) lines.push(`# ${title}`, '');

  for (const it of ordered) {
    if (it.isSection) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`## ${labelOf(it)}`, '');
      continue;
    }
    emitCard(lines, it, now);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** ECMAScript recursion guard for adversarial deep section nesting (mirrors board-tree's MAX_TREE_DEPTH). */
const MAX_MARKDOWN_DEPTH = 64;

/**
 * Serialize a board TREE to Markdown — the hierarchy-correct serializer. Walks each level in its OWN
 * coordinate space (so reading-order y-then-x is valid per level), emits each section as a `## heading`
 * (deepening to `###`… by nesting depth) and RECURSES into its children so a card nested inside a drill-in
 * section lands UNDER that section's heading (never orphaned above it, which a flat cross-level y-sort
 * does). Cards stay at `- ` regardless of depth (Markdown hierarchy is the heading, not bullet indent).
 * Cycle/duplicate-nesting safe (visited set) + depth-capped. This is what a board with sections exports.
 */
export function boardTreeToMarkdown(graph: GroupGraph, rootRef: AddressRef, now: number, opts: BoardMarkdownOptions = {}): string {
  const lines: string[] = [];
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (title.length > 0) lines.push(`# ${title}`, '');

  const seen = new Set<string>([groupKey(rootRef)]);
  const walkLevel = (ref: AddressRef, headingDepth: number): void => {
    if (headingDepth > MAX_MARKDOWN_DEPTH) return;
    const content = readItems(graph, ref).filter((it) => !itemIsConnector(it) && !itemIsBoardFurniture(it));
    const ordered = [...content].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of ordered) {
      if (it.isSection) {
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`${'#'.repeat(Math.min(headingDepth, 6))} ${labelOf(it)}`, '');
        const key = groupKey(it.nodeRef);
        if (!seen.has(key)) {
          seen.add(key);
          walkLevel(it.nodeRef, headingDepth + 1);
        }
      } else {
        emitCard(lines, it, now);
      }
    }
  };
  walkLevel(rootRef, 2); // top-level sections start at `##` (`#` is reserved for the document title)

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
