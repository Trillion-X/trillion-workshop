// packages/group/read-data/board-themes.ts
//
// RECURRING THEMES — the implicit topics a board keeps coming back to, mined from the cards' own prose.
// Tags are the EXPLICIT labels a user typed; themes are the terms that recur across the free text WITHOUT
// anyone tagging them ("deadline" shows up on five cards even though nobody made a #deadline tag). This
// surfaces the board's real subject matter and, for the top theme, the exact cards that share it.
//
// The measure is DOCUMENT frequency — a theme is counted once per CARD it appears on, not once per mention —
// so one verbose card repeating a word never fabricates a theme, and a term only qualifies once it RECURS
// (appears on ≥2 cards). Distinct from `board-summary` (a single total word COUNT, no per-term breakdown),
// `tag-cooccurrence` (pairs of EXPLICIT tags), `board-questions` (interrogative cards), and the
// `writing-judge` keyword-coverage scorer (scores text against a SUPPLIED keyword list — this DISCOVERS the
// list). A pure reduction of the cards' text (reads `item.text` exactly as board-summary does, L069/L093 — owns
// no domain logic beyond tokenize + count) + the furniture guard (a generated region-heading is never a theme).
// The stopword set is an INJECTED default (L083 maximally-capable) — an owner can pass a domain list. Pure,
// deterministic (document-frequency tally, tie-break by term).

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import type { ReducedTable } from './reduced-table';

/** A recurring theme: the term, how many cards it appears on, and which ones (sorted). */
export interface ThemeGroup {
  readonly term: string;
  readonly cardCount: number;
  readonly cardIds: readonly string[];
}

export interface ThemeOptions {
  /** Terms to ignore (common words). Defaults to {@link DEFAULT_STOPWORDS}. */
  readonly stopwords?: ReadonlySet<string>;
  /** Minimum token length to consider a term. Default 3. */
  readonly minLength?: number;
  /** Minimum cards a term must appear on to count as recurring. Default 2. */
  readonly minCards?: number;
  /** Cap the returned themes (highest card-count first). Default: all. */
  readonly limit?: number;
}

/** A compact, domain-agnostic English stopword set — the words that carry no theme. An owner can override the
 *  whole set via {@link ThemeOptions.stopwords}; this is the maximally-capable default (L083). */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our', 'out',
  'has', 'had', 'his', 'she', 'him', 'how', 'its', 'who', 'get', 'let', 'put', 'see', 'use', 'via', 'per',
  'this', 'that', 'with', 'from', 'they', 'them', 'then', 'than', 'been', 'have', 'will', 'your', 'what',
  'when', 'were', 'into', 'each', 'more', 'most', 'some', 'such', 'only', 'over', 'also', 'just', 'like',
  'here', 'need', 'make', 'made', 'want', 'well', 'very', 'much', 'many', 'about', 'would', 'could', 'their',
  'there', 'these', 'those', 'which', 'while', 'after', 'before', 'being', 'other', 'still', 'should', 'because',
]);

/** Content card = not a connector and not generated furniture (only these carry meaningful prose). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** The unique terms in one card's text (deduped, lowercased, stopword- and length-filtered). Uniqueness here
 *  is what makes the tally a DOCUMENT frequency — a card counts once for a term no matter how often it repeats it. */
export function cardTerms(text: string, opts: ThemeOptions = {}): Set<string> {
  const stop = opts.stopwords ?? DEFAULT_STOPWORDS;
  const minLen = opts.minLength ?? 3;
  const terms = new Set<string>();
  // A token is an alphanumeric run, optionally carrying a TRAILING symbol run (+/#) when no letter follows —
  // so "c++" / "f#" survive as themselves while "a+b" still splits into a|b (the + there is an infix operator,
  // not part of a name). The min-length filter exists to drop short NOISE ("a", "it"); a symbol-bearing token
  // is self-evidently deliberate (nobody types "c#" by accident), so it is exempt from min-length (Codex
  // convergence 2026-07-09 finding 4 — the old split-on-non-alnum tokenizer made C++/C# structurally
  // un-themeable: split to "c" then dropped).
  for (const raw of text.toLowerCase().match(/[a-z0-9]+(?:[+#]+(?![a-z0-9]))?/g) ?? []) {
    const symbolic = /[+#]/.test(raw);
    if (!symbolic && raw.length < minLen) continue;
    if (stop.has(raw)) continue;
    terms.add(raw);
  }
  return terms;
}

/** The board's recurring themes: terms appearing on ≥ `minCards` cards, ranked by card-count desc then term asc. */
export function boardThemes(items: readonly BoardItem[], opts: ThemeOptions = {}): ThemeGroup[] {
  const minCards = opts.minCards ?? 2;
  const byTerm = new Map<string, string[]>();
  for (const card of contentCards(items)) {
    const id = card.memberId;
    const text = typeof card.text === 'string' ? card.text : '';
    for (const term of cardTerms(text, opts)) {
      const ids = byTerm.get(term);
      if (ids) ids.push(id);
      else byTerm.set(term, [id]);
    }
  }
  const groups: ThemeGroup[] = [];
  for (const [term, ids] of byTerm) {
    if (ids.length < minCards) continue;
    groups.push({ term, cardCount: ids.length, cardIds: [...ids].sort() });
  }
  groups.sort((a, b) => b.cardCount - a.cardCount || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return opts.limit != null ? groups.slice(0, opts.limit) : groups;
}

/** The single most recurring theme (highest card-count, tie → alpha), or null when the board has no theme. */
export function topTheme(items: readonly BoardItem[], opts: ThemeOptions = {}): ThemeGroup | null {
  return boardThemes(items, opts)[0] ?? null;
}

/** The cards sharing the board's top theme — what "Select cards about the top theme" selects. */
export function cardIdsForTopTheme(items: readonly BoardItem[], opts: ThemeOptions = {}): string[] {
  const top = topTheme(items, opts);
  return top ? [...top.cardIds] : [];
}

/** True when at least one term recurs across ≥ `minCards` cards — the gate for a themes surface. */
export function boardHasThemes(items: readonly BoardItem[], opts: ThemeOptions = {}): boolean {
  return boardThemes(items, opts).length > 0;
}

/** The themes as a {@link ReducedTable} — the SAME shape the census/pivot produce, so the blind
 *  `ReducedTablePanel` renders themes with zero new panel code (b224 emergence, L069). One section "Recurring
 *  themes", one group per term (label = the term, detail = its card tally, cardIds = the cards sharing it →
 *  click-to-select). Empty (no sections) when no term recurs. Pure. */
export function themesReducedTable(items: readonly BoardItem[], opts: ThemeOptions = {}): ReducedTable {
  const groups = boardThemes(items, opts);
  if (groups.length === 0) return { sections: [] };
  return {
    sections: [{
      key: 'themes',
      title: 'Recurring themes',
      groups: groups.map((g) => ({ key: `theme:${g.term}`, label: g.term, detail: String(g.cardCount), cardIds: g.cardIds })),
    }],
  };
}

/** A human "## Recurring themes" readout: each theme with its card tally, or an honest empty line. */
export function themesText(items: readonly BoardItem[], title?: string, opts: ThemeOptions = {}): string {
  const groups = boardThemes(items, opts);
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push('## Recurring themes');
  if (groups.length === 0) {
    lines.push('- No recurring themes');
    return lines.join('\n');
  }
  for (const g of groups) lines.push(`- ${g.term} — ${g.cardCount} card${g.cardCount === 1 ? '' : 's'}`);
  return lines.join('\n');
}
