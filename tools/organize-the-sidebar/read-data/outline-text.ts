// packages/group/read-data/outline-text.ts
//
// The pure, lossless bridge between a note's plain TEXT and the structured outline
// (list-block-model's ListItem[]). A note is already lines of text; an "outline" just
// reads each line's leading indentation as a nesting depth. This leaf owns ONLY that
// text↔structure mapping — it renders nothing, mutates nothing, does no I/O, and knows
// nothing about markers or the editor. Deterministic: parse∘serialize and serialize∘parse
// are identity on well-formed input (normalizeIndents makes any input well-formed first).
//
// INDENT UNIT: two leading spaces = one level (tabs count as one level each). This is the
// same convention Markdown/org-mode use, so a pasted indented list round-trips unchanged.

import { normalizeIndents, type ListItem } from './list-block-model.ts';

const INDENT_SPACES = 2;

/** Depth of a single line from its leading whitespace (2 spaces or 1 tab per level). */
function depthOf(line: string): number {
  let spaces = 0;
  for (const ch of line) {
    if (ch === '\t') spaces += INDENT_SPACES;
    else if (ch === ' ') spaces += 1;
    else break;
  }
  return Math.floor(spaces / INDENT_SPACES);
}

/** Parse a note's text into a well-formed outline. Blank lines are dropped (an outline row
 *  must have content). Ids are positional+stable for a given text so re-parses are stable. */
export function parseOutline(text: string): ListItem[] {
  const rows: ListItem[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i].trim();
    if (content.length === 0) continue;
    rows.push({ id: `r${i}`, text: content, indent: depthOf(lines[i]) });
  }
  return normalizeIndents(rows);
}

/** Serialize an outline back to indented text (2 spaces per level). Lossless with parse. */
export function serializeOutline(items: readonly ListItem[]): string {
  return items.map((it) => `${' '.repeat(it.indent * INDENT_SPACES)}${it.text}`).join('\n');
}

/**
 * The 0-based ORDINAL of each row within its own level/parent group — the number a marker
 * ("1." / "a.") should show. Numbering RESTARTS under every new parent: descending to a
 * deeper level resets that level's counter, so `[0,1,1,0,1]` → `[0,0,1,1,0]` (top level
 * counts 1st/2nd; the children under each parent count from 1 again). Pure; a marker's
 * per-index producer (glyph is index-independent, ordinal/cycle use it) reads this.
 */
export function outlineOrdinals(items: readonly ListItem[]): number[] {
  const counters: number[] = [];
  return items.map((it) => {
    const d = it.indent;
    const ordinal = counters[d] ?? 0;
    counters[d] = ordinal + 1;
    counters.length = d + 1; // a deeper level restarts under this new parent
    return ordinal;
  });
}
