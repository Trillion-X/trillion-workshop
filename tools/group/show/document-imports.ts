// packages/group/show/document-imports.ts
//
// The board DOCUMENT-IMPORT registry — the generative primitive for "paste a <format> document onto the
// board", the mirror of the export registry (do-work/board-document-exports). Each format is a DATA row
// `{key, label, detect, parse}`; the paste funnel is BLIND — it asks `detectImport(text)` for the first row
// whose `detect` matches, calls that row's `parse`, and places the result. Adding a new import format is
// ONE row + its parser leaf, ZERO change to the paste handler (L069/L090/enum-dissolution).
//
// A parser returns a self-describing result: `{ tree }` (a board tree that may carry SECTIONS — the funnel
// places it hierarchically) or `{ drafts }` (a flat card list — the funnel drops it via the shared grid
// placement). The registry never names a format in the handler; the handler never names a format here.

import type { BoardItemDraft } from './item-add-strategies';
import type { BoardItem } from '../read-data/group-board-model';
import { looksLikeMarkdown, markdownToBoardTree, type MarkdownNode } from 'trillion-workshop/tools/organize-the-sidebar/show/markdown-to-drafts.ts';
import { looksLikeCsv, csvToDrafts } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-csv-import.ts';
import { looksLikeMermaid, mermaidToBoardItems } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-mermaid-import.ts';
import { looksLikeGraphml, graphmlToBoardItems } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-graphml-import.ts';
import { looksLikeOpml, opmlToBoardItems } from '../do-work/board-opml-import';
import { looksLikeFreemind, freemindToBoardItems } from '../do-work/board-freemind';
import { looksLikeDot, dotToBoardItems } from '../do-work/board-dot';
import { looksLikeICalendar, icalendarToDrafts } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-icalendar-import.ts';

/** A parsed import: a hierarchy-bearing board tree, a flat draft list, or a pre-built board FRAGMENT that
 *  already carries positions AND connectors (a graph — e.g. a Mermaid flowchart). Self-describing (L090) —
 *  the funnel dispatches on which key is present, never on a format name. */
export type ImportResult =
  | { readonly tree: readonly MarkdownNode[] }
  | { readonly drafts: readonly BoardItemDraft[] }
  | { readonly items: readonly BoardItem[] };

/** One import format: how to label it, whether a pasted text IS it, and how to parse it. */
export interface DocumentImport {
  readonly key: string;
  readonly label: string;
  /** Conservative recognizer — true iff this text is unambiguously this format (never hijacks a plain paste). */
  readonly detect: (text: string) => boolean;
  readonly parse: (text: string) => ImportResult;
  /** The file extensions this format ships as (no dot) — the SSOT for the import picker's `accept` AND the
   *  file-drop "is this a text document?" test, so neither hardcodes a second extension list (L063/SSOT). */
  readonly extensions: readonly string[];
}

/**
 * The import format registry — Society DATA. Order = detection priority (first match wins). Markdown is
 * tried before CSV; their recognizers are disjoint (markdown needs a `#`/task checkbox, CSV needs a `Title`
 * header row), so ordering only matters for pathological inputs. Add a format → add a row (+ its parser leaf).
 */
export const DOCUMENT_IMPORTS: readonly DocumentImport[] = [
  { key: 'markdown', label: 'Markdown', detect: looksLikeMarkdown, parse: (t) => ({ tree: markdownToBoardTree(t) }), extensions: ['md', 'markdown'] },
  { key: 'csv', label: 'CSV', detect: looksLikeCsv, parse: (t) => ({ drafts: csvToDrafts(t) }), extensions: ['csv'] },
  // Mermaid — a `flowchart`/`graph` header (disjoint from markdown's `#`/checkbox and CSV's `Title` row).
  // Parses to a positioned node+connector board fragment, the round-trip partner of the Mermaid export (b135).
  { key: 'mermaid', label: 'Mermaid', detect: looksLikeMermaid, parse: (t) => ({ items: mermaidToBoardItems(t) }), extensions: ['mmd', 'mermaid'] },
  // GraphML — a `<graphml` XML document (disjoint from all the above). Each <node> → a card, each <edge> →
  // a connector; a positioned board fragment, the round-trip partner of the GraphML export (b171).
  { key: 'graphml', label: 'GraphML', detect: looksLikeGraphml, parse: (t) => ({ items: graphmlToBoardItems(t) }), extensions: ['graphml', 'xml'] },
  // OPML — an `<opml` outliner document (disjoint from graphml's `<graphml`). Each nested <outline> → a card,
  // each parent→child nesting → a connector; a positioned board fragment, the round-trip partner of the OPML
  // export (b172). Feeds `{items}` like mermaid/graphml.
  { key: 'opml', label: 'OPML', detect: looksLikeOpml, parse: (t) => ({ items: opmlToBoardItems(t) }), extensions: ['opml'] },
  // FreeMind/Freeplane — a `<map>` + `<node TEXT=…>` mind-map (disjoint from OPML's `<outline>`). The same
  // nested-XML primitive as OPML, a different DATA spec; parses to a node+connector board fragment (b173).
  { key: 'freemind', label: 'FreeMind', detect: looksLikeFreemind, parse: (t) => ({ items: freemindToBoardItems(t) }), extensions: ['mm'] },
  // DOT/Graphviz — a `graph`/`digraph {` document (disjoint from the XML formats + mermaid's flowchart header).
  // Each node → a card, each `->`/`--` edge → a connector; a positioned board fragment, the round-trip partner
  // of the DOT export (b174), via the shared graph builder.
  { key: 'dot', label: 'Graphviz (DOT)', detect: looksLikeDot, parse: (t) => ({ items: dotToBoardItems(t) }), extensions: ['dot', 'gv'] },
  // iCalendar — a `BEGIN:VCALENDAR` document (disjoint from all the above). Each VEVENT → a dated card
  // (`extra.dueDate`); the round-trip partner of the .ics export (b136). Flat cards → a drafts placement.
  { key: 'icalendar', label: 'iCalendar', detect: looksLikeICalendar, parse: (t) => ({ drafts: icalendarToDrafts(t) }), extensions: ['ics', 'ical'] },
];

/** Every file extension any registered import format uses, PLUS plain `txt` (a brain-dump that matches no
 *  format → one note per line via the funnel's fallthrough). The SSOT for the import picker's `accept` and
 *  the file-drop text-document test — neither hardcodes a second extension list (L063/SSOT/L090). */
export const IMPORT_TEXT_EXTENSIONS: readonly string[] = [...DOCUMENT_IMPORTS.flatMap((i) => i.extensions), 'txt'];

/** True iff a filename is an importable text document (a registered format's extension OR plain `.txt`). */
export function isImportableTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && IMPORT_TEXT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** The first import format that recognizes this text, or null (the caller falls through to plain paste). */
export function detectImport(text: string): DocumentImport | null {
  return DOCUMENT_IMPORTS.find((imp) => imp.detect(text)) ?? null;
}
