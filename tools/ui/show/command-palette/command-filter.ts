// The command palette's rows and its pure filter, apart from the component so the match contract is proven without a DOM
// (command-filter.test.ts). CommandPalette.tsx draws what this decides and re-exports both.

export interface CommandPaletteItem {
  /** Stable id (dedupe / key). */
  readonly id: string;
  /** Human label — what the user reads and types against. */
  readonly label: string;
  /** Lucide icon NAME (data, resolved by NamedIcon) when the row shows an icon. */
  readonly icon?: string;
  /** A second quieter line under the label (where a thing came from, when it changed). */
  readonly detail?: string;
  /** A right-aligned hint (a shortcut like "⌘G", or a category) when present. */
  readonly hint?: string;
  /** A group header the row files under (order preserved) when grouped. */
  readonly section?: string;
  /** Other words that find this row (a nickname, an older name, a verb someone reaches for). Never shown. */
  readonly aliases?: readonly string[];
  /** Where this row stands among the rows a query matches: higher first, equal scores keep the caller's order.
   *  Without one every row scores 0, so the caller's order stands. */
  readonly score?: number;
  /** The effect to run when the row is chosen. The palette closes after. */
  readonly run: () => void;
}

/**
 * Pure filter: keep every item whose label, section, detail or aliases contain EVERY
 * whitespace-separated token of the query (case-insensitive) — so "al le" matches
 * "Align left", and an item aliased "nickname" is found by "nick". An empty query keeps
 * everything, in the caller's order. The matches are ordered by `score` (higher first);
 * equal scores keep the caller's order, so items without a score read exactly as before.
 * Deterministic → the whole match contract is unit-testable without a DOM.
 */
export function filterCommands(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  return items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => {
      const hay = (it.label + ' ' + (it.section ?? '') + ' ' + (it.detail ?? '') + ' ' + (it.aliases ?? []).join(' ')).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .sort((a, b) => (b.it.score ?? 0) - (a.it.score ?? 0) || a.index - b.index)
    .map(({ it }) => it);
}
