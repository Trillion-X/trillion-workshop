// packages/group/show/markdown-to-drafts.ts
//
// The MARKDOWN IMPORT parser — the round-trip partner of the board -> Markdown export (do-work/board-
// markdown): pasting a structured Markdown document drops it onto the board as STRUCTURED content, not a
// flat note-per-line. It parses ONCE into a board TREE (`markdownToBoardTree`) — headings become sections,
// bullets become cards, a card's nested `- [ ]` / `- [x]` task lines become that card's CHECKLIST — and
// everything else is a PROJECTION of that one tree:
//   - `markdownToBoardTree(text)`  -> the section/card tree (the hierarchy-preserving import; heading depth
//                                     nests sections, so `## Goals` / `### Health` reconstruct drill-in
//                                     sections — the exact inverse of `boardTreeToMarkdown`).
//   - `markdownToDrafts(text)`     -> the tree FLATTENED to `BoardItemDraft[]` (the single-level import: a
//                                     section becomes a plain card, depth-first document order). This is the
//                                     back-compatible flat paste — same output as before the tree existed.
// ONE parser is the source of truth (L100/SSOT): the flat drafts are a fold of the tree, never a second
// parse. A pure leaf (zero I/O, zero DOM), parallel to paste-to-notes.
//
// CONSERVATIVE trigger: `looksLikeMarkdown` fires ONLY when the text has a heading (`#`) or a task checkbox
// (`- [ ]`). A plain bullet list ("- milk\n- eggs") is NOT treated as Markdown — it stays one-note-per-line
// (the existing paste behavior), so this never hijacks a brain-dump paste. A round bullet with no checkbox
// is a card only inside a doc that already looks like Markdown.

import type { BoardItemDraft } from './item-add-strategies';
import type { TemplateItem } from '../read-data/board-template-apply';

/** Max nodes (sections + cards) one Markdown paste can mint — a runaway paste is capped, never freezes. */
export const MAX_MARKDOWN_CARDS = 200;
/** Per-card / per-step / per-section text clamp. */
export const MAX_MARKDOWN_TEXT_LEN = 2000;
/** Max checklist steps attached to one card. */
export const MAX_MARKDOWN_STEPS = 100;

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/;
// A task line: a bullet marker, then [ ] / [x] / [X], then the text. Any leading indent (nesting).
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
// A plain bullet (no checkbox).
const BULLET_RE = /^(\s*)[-*+]\s+(.*\S)\s*$/;

/** True iff the text is structured Markdown worth importing (a heading or a task checkbox). */
export function looksLikeMarkdown(text: string): boolean {
  return text.split(/\r?\n/).some((line) => HEADING_RE.test(line) || TASK_RE.test(line));
}

/** A checklist step on an imported card. */
export interface MarkdownStep {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
}

/** A parsed Markdown node: a SECTION (a `#`-heading, with nested children) or a CARD (a bullet/line, with
 *  its checklist). The tree mirrors the board's own structure (sections contain items), so placing it
 *  reconstructs drill-in sections — the inverse of `boardTreeToMarkdown`. Self-describing (a `kind` tag),
 *  never an enum branch in the walker (L090). */
export type MarkdownNode =
  | { readonly kind: 'section'; readonly text: string; readonly children: MarkdownNode[] }
  | { readonly kind: 'card'; readonly text: string; readonly steps: MarkdownStep[] };

const clamp = (s: string): string => s.slice(0, MAX_MARKDOWN_TEXT_LEN);

/**
 * Parse a Markdown document into a board TREE. Heading depth nests sections (a deeper heading opens a
 * section inside the nearest shallower one); bullets + plain lines become cards under the current section
 * (or the root); a card's nested `- [ ]` / `- [x]` task lines become its checklist; a leading task with no
 * card starts its own card. Total nodes are capped (`MAX_MARKDOWN_CARDS`) so a runaway paste can't freeze
 * the board. Pure + deterministic. Returns `[]` for empty input (the caller falls through to plain paste).
 */
export function markdownToBoardTree(text: string): MarkdownNode[] {
  const roots: MarkdownNode[] = [];
  // Section stack: each level remembers the heading depth that opened it, so a `###` nests under the last
  // `##` while a sibling `##` pops back to the root. The container is the top section's children, else roots.
  const stack: { depth: number; node: Extract<MarkdownNode, { kind: 'section' }> }[] = [];
  let count = 0;
  let stepSeq = 0;
  let currentCard: Extract<MarkdownNode, { kind: 'card' }> | null = null;

  const atBudget = () => count >= MAX_MARKDOWN_CARDS;
  const container = (): MarkdownNode[] => (stack.length > 0 ? stack[stack.length - 1].node.children : roots);

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;

    const task = raw.match(TASK_RE);
    if (task) {
      const step: MarkdownStep = { id: `md-s${stepSeq++}`, text: clamp(task[3]), done: task[2].toLowerCase() === 'x' };
      if (currentCard) {
        if (currentCard.steps.length < MAX_MARKDOWN_STEPS) currentCard.steps.push(step);
      } else if (!atBudget()) {
        // a leading task with no card -> its own card (text = the task), in the current container
        const card: Extract<MarkdownNode, { kind: 'card' }> = { kind: 'card', text: clamp(task[3]), steps: [] };
        container().push(card);
        currentCard = card;
        count++;
      }
      continue;
    }

    const heading = raw.match(HEADING_RE);
    if (heading) {
      if (atBudget()) continue;
      const depth = heading[1].length; // number of `#`
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      const section: Extract<MarkdownNode, { kind: 'section' }> = { kind: 'section', text: clamp(heading[2]), children: [] };
      container().push(section);
      stack.push({ depth, node: section });
      currentCard = null;
      count++;
      continue;
    }

    // a bullet or a plain paragraph line -> a card in the current container
    if (atBudget()) continue;
    const bullet = raw.match(BULLET_RE);
    const label = bullet ? bullet[2] : raw.trim();
    const card: Extract<MarkdownNode, { kind: 'card' }> = { kind: 'card', text: clamp(label), steps: [] };
    container().push(card);
    currentCard = card;
    count++;
  }

  return roots;
}

/**
 * Flatten a Markdown tree to a FLAT list of card drafts (depth-first, document order): a section becomes a
 * plain card (its heading text), a card becomes a card (with its checklist). This is the single-level
 * projection used by the plain paste path — it loses the section nesting but keeps every card, in order.
 */
export function flattenTreeToDrafts(nodes: readonly MarkdownNode[]): BoardItemDraft[] {
  const drafts: BoardItemDraft[] = [];
  const walk = (list: readonly MarkdownNode[]): void => {
    for (const node of list) {
      if (node.kind === 'section') {
        drafts.push({ kind: 'note', text: node.text });
        walk(node.children);
      } else {
        drafts.push({ kind: 'note', text: node.text, ...(node.steps.length > 0 ? { extra: { checklist: node.steps } } : {}) });
      }
    }
  };
  walk(nodes);
  return drafts;
}

/**
 * Parse a Markdown document into FLAT board card drafts (the tree flattened, section headings become plain
 * cards). The back-compatible import used by the plain paste funnel. For the hierarchy-preserving import
 * (sections reconstructed), use `markdownToBoardTree` + `markdownTreeToTemplateItems`.
 */
export function markdownToDrafts(text: string): BoardItemDraft[] {
  return flattenTreeToDrafts(markdownToBoardTree(text));
}

// Layout constants for the hierarchy-preserving placement (vertical stack per level; sections framed
// around their children). Not Society preferences — just a tidy default arrangement, the same role the
// sqrt-grid plays for the flat paste. A later arrange/tidy pass can reflow; these only set the drop shape.
const CARD_W = 240;
const CARD_H = 64;
const NODE_GAP = 16;
const SECTION_PAD = 18;
const SECTION_HEADER = 46;
const SECTION_MIN_W = 280;

/**
 * Translate a Markdown TREE into `TemplateItem[]` positioned for placement — the bridge that lets the
 * import reuse the SHIPPED `materializeItems` deep-copy engine (which already mints ids, nests sections,
 * and fail-closes on over-deep trees) instead of any new placement code (L093/L069). A card becomes a note
 * descriptor (its checklist rides `extra.checklist`, exactly as the flat path); a section becomes a
 * `children`-bearing descriptor (which `materializeItems` places via `placeSection` and recurses into),
 * framed around its children which are laid out in the section's OWN local space. Each level is a vertical
 * stack; `originX`/`originY` place the top level (e.g. at the viewport center). Pure + deterministic.
 */
export function markdownTreeToTemplateItems(nodes: readonly MarkdownNode[], originX = 0, originY = 0): TemplateItem[] {
  let seq = 0;
  const nextId = (): string => `md-n${seq++}`;

  const layout = (list: readonly MarkdownNode[], ox: number, oy: number): { items: TemplateItem[]; width: number; height: number } => {
    const items: TemplateItem[] = [];
    let y = oy;
    let maxW = 0;
    for (const node of list) {
      if (node.kind === 'card') {
        items.push({
          id: nextId(), kind: 'note', x: ox, y, w: CARD_W, h: CARD_H, text: node.text,
          ...(node.steps.length > 0 ? { extra: { checklist: node.steps } } : {}),
        });
        maxW = Math.max(maxW, CARD_W);
        y += CARD_H + NODE_GAP;
      } else {
        // Lay the children out in the section's local space, then frame the section around them.
        const inner = layout(node.children, SECTION_PAD, SECTION_HEADER);
        const w = Math.max(SECTION_MIN_W, SECTION_PAD * 2 + inner.width);
        const h = SECTION_HEADER + inner.height + SECTION_PAD;
        items.push({ id: nextId(), kind: 'section', x: ox, y, w, h, text: node.text, children: inner.items });
        maxW = Math.max(maxW, w);
        y += h + NODE_GAP;
      }
    }
    const height = list.length > 0 ? y - oy - NODE_GAP : 0; // subtract the trailing gap
    return { items, width: maxW, height };
  };

  return layout(nodes, originX, originY).items;
}
