// packages/group/do-work/board-document-exports.ts
//
// The board DOCUMENT-EXPORT registry — the generative primitive for "export the board as a <format>". Each
// format (Markdown, iCalendar, ...) is a DATA row `{key, label, ext, mime, serialize}`; the export surface
// (show/BoardExportPanel) is BLIND — it iterates this registry, never naming a format. Adding a new export
// format is ONE row + its serializer leaf, ZERO change to the panel or the dispatch (L069/L090/enum-
// dissolution). This dissolves the per-format wiring (the b67 Markdown had its own toggle/panel) into one
// data-driven surface. The serializers themselves live in their own leaves (board-markdown, board-icalendar).

import type { BoardItem } from '../read-data/group-board-model';
import { boardToMarkdown, boardTreeToMarkdown } from './board-markdown';
import { boardToICalendar } from './board-icalendar';
import { boardToCsv } from './board-csv';
import { boardToMermaid } from './board-mermaid';
import { boardToGraphml } from './board-graphml';
import { boardDigest, digestText } from './board-digest-actions';
import { boardSummary, summaryText } from '../read-data/board-summary';
import { boardAgenda, agendaText } from '../read-data/board-agenda';
import { nextActionsText, DEFAULT_PREREQ_SPEC } from './board-readiness-actions';
import { questionsText } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-questions.ts';
import { duplicateTitlesText } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-titles.ts';
import { tagHygieneText } from 'trillion-workshop/tools/organize-the-sidebar/do-work/board-tag-hygiene.ts';
import { clustersText } from '../read-data/board-islands';
import { duplicateConnectorsText } from '../read-data/duplicate-connectors';
import { boardToOpml } from './board-opml';
import { boardToFreemind } from './board-freemind';
import { boardToDot } from './board-dot';
import { sourcesSinksText } from './board-sources-sinks';
import { dateCoverageText } from './board-date-coverage';
import { themesText } from '../read-data/board-themes';
import { entityIndexText } from '../read-data/board-entity-index';
import { splitCandidatesText } from '../read-data/board-split-candidates';
import { tagCoverageText } from '../read-data/board-tag-coverage';
import { connectorLegendText } from '../read-data/board-connector-legend';
import { boardHealthText } from '../read-data/board-health';
import { numberedOutlineText } from '../read-data/board-numbered-outline';
import { facetCensusText } from '../read-data/board-facet-census';
import { colorFacetOf, kindFamilyOf } from '../show/board-item-facets';
import { readingOrderText } from '../read-data/board-reading-order';
import { cooccurrenceText, scoredCooccurrenceText } from '../read-data/board-cooccurrence';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { facetBalanceText } from '../read-data/board-facet-balance';
import { facetPivotText, aggregatorById } from '../read-data/board-facet-pivot';
import { dueMsToDateLabel } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-due-date.ts';
import { bucketDistributionText, bucketFacet } from '../read-data/board-measure-bucket';
import { crossTabText } from '../read-data/board-crosstab';
import { clusterFacet } from '../read-data/board-cluster-facet';
// The board's canonical measures/buckets live in board-report (the reducer-family SSOT) — imported, not
// redefined, so "a card's progress / deadline / word count" has ONE definition (b179).
import { PROGRESS_MEASURE, DEADLINE_MEASURE, WORDS_MEASURE, formatPercent, PROGRESS_BUCKETS, SIZE_BUCKETS } from '../read-data/board-report';
import type { RollupSpec } from './board-rollup-actions';
import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';

/** Options threaded to every serializer (each reads what it needs; extras are ignored). */
export interface BoardExportOptions {
  readonly title?: string;
  /**
   * The board's live tree (graph + the level being exported). When present, hierarchy-aware serializers
   * (Markdown) walk each level in its own coordinate space so section-nested cards land UNDER their heading
   * instead of being cross-level y-sorted into orphaned bullets. Absent -> serializers fall back to the flat
   * `items` list (correct for a single-level board). Order-agnostic serializers (ics/csv/status) ignore it.
   */
  readonly tree?: { readonly graph: GroupGraph; readonly rootRef: AddressRef };
  /**
   * The board's dependency relation for the "Next actions" readiness export — a card's prerequisites
   * (`{relationKind, childEndpoint}`, the same spec the rollup/critical-path use). Absent -> the canonical
   * `depends-on` spec (DEFAULT_PREREQ_SPEC). Other serializers ignore it.
   */
  readonly prereq?: RollupSpec;
}

/** One export format: how to label it, its file identity, and how to serialize a board to that format. */
export interface BoardDocumentExport {
  readonly key: string;
  readonly label: string;
  /** File extension (no dot) — for a future download affordance. */
  readonly ext: string;
  readonly mime: string;
  readonly serialize: (items: readonly BoardItem[], now: number, opts: BoardExportOptions) => string;
}

/**
 * The format registry — Society DATA. Order = display order. Add a format -> add a row (+ its serializer
 * leaf); the panel and dispatch never change.
 */
export const DOCUMENT_EXPORTS: readonly BoardDocumentExport[] = [
  {
    key: 'markdown',
    label: 'Markdown',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, now, opts) =>
      opts.tree
        ? boardTreeToMarkdown(opts.tree.graph, opts.tree.rootRef, now, { title: opts.title })
        : boardToMarkdown(items, now, { title: opts.title }),
  },
  {
    key: 'ics',
    label: 'Calendar',
    ext: 'ics',
    mime: 'text/calendar',
    serialize: (items, now) => boardToICalendar(items, now),
  },
  {
    key: 'csv',
    label: 'CSV',
    ext: 'csv',
    mime: 'text/csv',
    serialize: (items) => boardToCsv(items),
  },
  {
    // The board's connectors as a Mermaid flowchart (b134) — diagram-as-code to paste into a README /
    // GitHub / Notion / docs. One node per card, one edge per connector (labelled by relationship kind).
    key: 'mermaid',
    label: 'Mermaid',
    ext: 'mmd',
    mime: 'text/plain',
    serialize: (items) => boardToMermaid(items),
  },
  {
    // Not the board's cards — the board's SELF-ASSESSMENT as a shareable standup narrative (headline
    // verdict + a line per firing review lens + the next action), composed from the digest.
    key: 'status',
    label: 'Status',
    ext: 'txt',
    mime: 'text/plain',
    serialize: (items, now, opts) => digestText(boardDigest(items, null, now), opts.title),
  },
  {
    // The board's quantitative CENSUS (counts by kind + words + goals-with-due-dates/progress/complete +
    // orphans) — the "what's on this board" overview. Distinct from `status` (a qualitative review narrative);
    // a pure composition of the shipped readers (board-summary). Order-agnostic, ignores the tree.
    key: 'summary',
    label: 'Summary',
    ext: 'txt',
    mime: 'text/plain',
    serialize: (items, _now, opts) => summaryText(boardSummary(items), opts.title),
  },
  {
    // The board's dated cards as a human AGENDA — grouped by urgency (Overdue / Today / Due soon / Upcoming /
    // Later), nearest first. Distinct from `ics` (a machine calendar file) and `summary` (counts): the "what's
    // coming up" to-do readout. Composes the shipped due-date engine (relativeDue) — reads `now`.
    key: 'agenda',
    label: 'Agenda',
    ext: 'txt',
    mime: 'text/plain',
    serialize: (items, now, opts) => agendaText(boardAgenda(items, now), opts.title),
  },
  {
    // The board's DEPENDENCY frontier as a GTD-style "Next actions" list — "Ready to start" (cards whose
    // prerequisites are all cleared) + "Blocked" (each card + what it waits on). Distinct from `agenda`
    // (date order) and `status` (per-card progress): the only view that answers "what can I start NOW?".
    // Composes the readiness engine (dependency graph + completion); reads the prereq spec, ignores `now`.
    key: 'next-actions',
    label: 'Next actions',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => nextActionsText(items, opts.prereq ?? DEFAULT_PREREQ_SPEC, opts.title),
  },
  {
    // The board's relationship graph as GraphML — the standard XML interchange for Gephi / Cytoscape / yEd /
    // networkx, ENRICHED with each node's PageRank importance (b147), Louvain community (b148) + degree, so it
    // lands in the analysis tool already scored + partitioned. DISTINCT from `mermaid` (diagram-as-code for a
    // picture; this is DATA for analysis). Composes the graph + measure primitives; ignores `now`.
    key: 'graphml',
    label: 'Graph (GraphML)',
    ext: 'graphml',
    mime: 'application/xml',
    serialize: (items) => boardToGraphml(items),
  },
  {
    // Every OPEN QUESTION on the board pulled into one list — the interrogative lines across all cards (b150).
    // Distinct from the other readouts (census / agenda / next-actions): the board's unanswered THREADS, for a
    // research / brainstorm board. Composes the question detector; ignores `now`.
    key: 'questions',
    label: 'Open questions',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => questionsText(items, opts.title),
  },
  {
    // Every AMBIGUOUS title — a title borne by ≥2 cards (b151). Reference-integrity, not content: a shared
    // title means `[[link]]` resolves to the first card and shadows the rest, so this readout is the "fix your
    // ambiguous names" worklist for a wikilinked board. Composes the title collision detector; ignores `now`.
    key: 'duplicate-titles',
    label: 'Duplicate titles',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => duplicateTitlesText(items, opts.title),
  },
  {
    // The TAG-TAXONOMY audit (b152): near-duplicate tag spellings (`to-do`/`todo`) + one-off tags. A vocabulary
    // hygiene worklist for a tagged board — distinct from every content/schedule readout. Composes the tag
    // hygiene detector; ignores `now`.
    key: 'tag-hygiene',
    label: 'Tag hygiene',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => tagHygieneText(items, opts.title),
  },
  {
    // The board's TOPOLOGY (b153): how many separate connected clusters the connector graph holds + the loose
    // count — the "is my mind-map one structure or several disconnected pieces?" readout. Distinct from
    // graphml (the graph for analysis) — this is the human census of its components. Composes the island
    // detector; ignores `now`.
    key: 'clusters',
    label: 'Board clusters',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => clustersText(items, opts.title),
  },
  {
    // CONNECTOR HYGIENE (b154): the identical relationships drawn ≥2 times (same from/to/kind). A cleanup
    // worklist for a board whose lines have accumulated accidental double-draws. Composes the duplicate-
    // connector detector; ignores `now`.
    key: 'duplicate-connectors',
    label: 'Duplicate connectors',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => duplicateConnectorsText(items, opts.title),
  },
  {
    // The board's connector hierarchy as OPML (b155) — the standard NESTED outline interchange for
    // OmniOutliner / Workflowy / Dynalist / Bike / feed readers. DISTINCT from `markdown` (a flat human list)
    // and `graphml` (the graph for analysis): OPML is the editable tree an outliner re-opens. Composes the
    // connector-outline SSOT; ignores `now`.
    key: 'opml',
    label: 'Outline (OPML)',
    ext: 'opml',
    mime: 'text/x-opml',
    serialize: (items, _now, opts) => boardToOpml(items, opts.title),
  },
  {
    // The board's connector hierarchy as a FreeMind/Freeplane `.mm` mind-map (b173) — the de-facto interchange
    // for the most-used open-source mind-mapper. The mind-map counterpart of the OPML export via the SAME
    // nested-XML writer, a different DATA spec (`<node TEXT>` vs `<outline text>`). Round-trips with the import.
    key: 'freemind',
    label: 'Mind map (FreeMind)',
    ext: 'mm',
    mime: 'text/xml',
    serialize: (items) => boardToFreemind(items),
  },
  {
    // The board's relationship graph as DOT / Graphviz (b174) — the plain-text `digraph { A -> B }` lingua
    // franca virtually every graph tool reads. DISTINCT from `mermaid` (markdown diagram-as-code) and `graphml`
    // (XML for analysis): DOT is the round-trip partner of the DOT import, one `[label]` per card + one edge per
    // connector. Composes the relationship-graph SSOT; ignores `now`.
    key: 'dot',
    label: 'Graph (DOT)',
    ext: 'dot',
    mime: 'text/vnd.graphviz',
    serialize: (items) => boardToDot(items),
  },
  {
    // The board's dependency-flow endpoints (b157): the STARTING POINTS (nothing points to them) + the FINAL
    // OUTCOMES (they point to nothing). The "where does this plan begin / end?" readout. Composes the
    // sources/sinks detector; ignores `now`.
    key: 'sources-sinks',
    label: 'Starts & outcomes',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => sourcesSinksText(items, opts.title),
  },
  {
    // The board's scheduling coverage (b158): the timeline window (earliest → latest due) + the dated/undated
    // tally. The "how far out does this plan reach, and what still needs a date?" readout. Composes the
    // date-coverage detector; ignores `now` (the span is a property of the cards' own dates).
    key: 'date-coverage',
    label: 'Timeline span',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => dateCoverageText(items, opts.title),
  },
  {
    // The board's recurring themes (b159): the terms that repeat across the cards' prose (document frequency),
    // ranked — the implicit subject matter nobody explicitly tagged. Composes the themes detector; ignores `now`.
    key: 'themes',
    label: 'Recurring themes',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => themesText(items, opts.title),
  },
  {
    // Every external link across the board (b160): the URLs the cards cite, deduped, with the cards carrying
    // each. The board's references index. Composes the kind-parametric entity index over the 'url' kind;
    // ignores `now`. (An email/hashtag index is the same engine at a different kind — not a separate export.)
    key: 'links',
    label: 'Links',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => entityIndexText(items, 'url', 'Links'),
  },
  {
    // The cards that have grown into mini-documents (b161): each would split into ≥2 cards. The "what should I
    // break up?" readout that feeds the Split action. Composes the split-candidate detector; ignores `now`.
    key: 'split-candidates',
    label: 'Cards to split',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => splitCandidatesText(items, opts.title),
  },
  {
    // The board's tagging completeness (b162): tagged vs untagged cards + distinct tags in play. The "which
    // cards still need a tag?" readout — the tag-dimension sibling of date-coverage. Ignores `now`.
    key: 'tag-coverage',
    label: 'Tag coverage',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => tagCoverageText(items, opts.title),
  },
  {
    // The board's relationship legend (b163): each connector KIND with its real (non-dangling) edge count — the
    // key for reading a dense diagram. Composes the connector-legend detector; ignores `now`.
    key: 'connector-legend',
    label: 'Relationship legend',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => connectorLegendText(items, opts.title),
  },
  {
    // The board's tidiness roll-up (b164): a 0–100 health score + grade + which hygiene signals flagged
    // something. The "how tidy is this board and what should I fix?" readout. Composes the health reducer over
    // the shipped hygiene detectors; ignores `now`.
    key: 'board-health',
    label: 'Board health',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => boardHealthText(items, opts.title),
  },
  {
    // The board's connector tree as a decimal-numbered outline (b165): 1 / 1.1 / 1.2 / 2 …, the way a spec /
    // agenda / table-of-contents is numbered. Composes the numbered-outline reader; ignores `now`.
    key: 'numbered-outline',
    label: 'Numbered outline',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items, _now, opts) => numberedOutlineText(items, opts.title),
  },
  {
    // A COLOUR LEGEND — the cards tallied per fill-hue family (b166). ONE facetCensus over the board's
    // `colorFamily` extractor; the reducer names no colour. Ignores `now`/`title` (fixed heading).
    key: 'color-legend',
    label: 'Colour legend',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetCensusText(items, colorFacetOf, 'Colours'),
  },
  {
    // A TYPE CENSUS — the cards tallied per kind family (b166), from the SAME reducer as the colour
    // legend above with a DIFFERENT extractor. Two legends, zero legend-specific code (L069 emergence).
    key: 'type-census',
    label: 'Type census',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetCensusText(items, kindFamilyOf, 'Types'),
  },
  {
    // The board's cards in SPATIAL reading order (b167): row band by row band, top→bottom, left→right within a
    // row — the sequence you'd read a freeform (connector-free) board in. Composes the reading-order reader
    // (the bandCluster kernel); ignores `now`/`title` (fixed heading).
    key: 'reading-order',
    label: 'Reading order',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => readingOrderText(items),
  },
  {
    // Which two tags keep sharing a card (b168): the co-occurrence / affinity readout, strongest pair first —
    // "design + urgent — 4 cards". Composes the cooccurrence reducer over the `itemTags` extractor; ignores now.
    key: 'tag-affinity',
    label: 'Tag affinity',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => cooccurrenceText(items, itemTags, 'Tag affinity'),
  },
  {
    // Is the board dominated by one tag or evenly spread (b169)? The evenness measure over the tag census —
    // "Dominated — top 'design' is 70%". Composes the facet-balance reducer over `itemTags`; ignores now.
    key: 'tag-balance',
    label: 'Tag balance',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetBalanceText(items, itemTags, 'Tag balance'),
  },
  {
    // The SAME evenness measure over the colour census (b169) — one balance engine, a different facet. Proves
    // the measure is generic (colour balance falls out of the tag-balance reducer with zero new code).
    key: 'color-balance',
    label: 'Colour balance',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetBalanceText(items, colorFacetOf, 'Colour balance'),
  },
  {
    // Which tags are ATTRACTED beyond chance (b170) — the lift-scored affinity: two rare tags that always
    // travel together outrank two common tags that co-occur only because both are everywhere. Composes the
    // scored co-occurrence engine (which reuses the b117 measure catalog) over `itemTags` with measure 'lift'.
    key: 'tag-lift',
    label: 'Tag lift',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => scoredCooccurrenceText(items, itemTags, 'Tag lift (attraction vs chance)', { measure: 'lift' }),
  },
  {
    // AVERAGE PROGRESS per tag (b175) — the first facet-PIVOT: not how many cards a tag has (that's the
    // census) but how far along they are. ONE `facetPivot` over `itemTags` × the `cardCompletion` measure ×
    // the `mean` aggregator, rendered as a percent by the injected formatter. Ignores `now`.
    key: 'tag-progress',
    label: 'Progress by tag',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetPivotText(items, itemTags, PROGRESS_MEASURE, aggregatorById('mean')!, 'Average progress by tag', formatPercent),
  },
  {
    // The SAME progress pivot over the COLOUR facet (b175) — one pivot engine, a different dimension. Proves
    // the group-by axis is generic (colour-progress falls out with zero new code, like colour-balance did).
    key: 'color-progress',
    label: 'Progress by colour',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetPivotText(items, colorFacetOf, PROGRESS_MEASURE, aggregatorById('mean')!, 'Average progress by colour', formatPercent),
  },
  {
    // LATEST DEADLINE per tag (b175) — the SAME pivot engine with a DIFFERENT measure (due date), aggregator
    // (max), and value formatter (a date). Proves the measure + aggregator + format axes are all generic: a
    // date pivot needs zero engine change, only a DATA row. Reads each card's own due date (no clock).
    key: 'tag-deadline',
    label: 'Deadline by tag',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetPivotText(items, itemTags, DEADLINE_MEASURE, aggregatorById('max')!, 'Latest deadline by tag', dueMsToDateLabel),
  },
  {
    // PROGRESS DISTRIBUTION (b176) — a histogram of card completion into quartile bands (0–25% … 75–100%). A
    // histogram is a CONFIGURATION of the census (`bucketDistribution` = `facetCensus` over a bucketing
    // extractor), band-ordered + zero-filled. Ignores `now`.
    key: 'progress-distribution',
    label: 'Progress distribution',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => bucketDistributionText(items, PROGRESS_MEASURE, PROGRESS_BUCKETS, 'Progress distribution'),
  },
  {
    // CARD-SIZE DISTRIBUTION (b176) — the SAME histogram engine over a DIFFERENT measure (word count) + a
    // hand-written uneven `BucketSpec`, proving the measure + bucketing axes are generic (a word-count
    // histogram needs zero engine change, only DATA). Reads each card's own text (no clock).
    key: 'size-distribution',
    label: 'Card size distribution',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => bucketDistributionText(items, WORDS_MEASURE, SIZE_BUCKETS, 'Card size distribution'),
  },
  {
    // TAG × COLOUR contingency table (b177) — the 2-D cross-tab: cards counted per (tag, colour) pair, with
    // marginal totals. The 2-D completion of the census/pivot family (one cross-tab reducer, two facet axes).
    // Ignores `now`.
    key: 'tag-color-matrix',
    label: 'Tag × colour matrix',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => crossTabText(items, itemTags, colorFacetOf, 'Tags × colours'),
  },
  {
    // KIND × PROGRESS-BAND matrix (b177) — the SAME cross-tab with a CONTINUOUS axis bucketed via `bucketFacet`
    // (b176), proving the cross-tab composes the whole reducer family (any facet OR any bucketed measure is an
    // axis). Cards counted per (kind, progress-quartile). Ignores `now`.
    key: 'kind-progress-matrix',
    label: 'Kind × progress matrix',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => crossTabText(items, kindFamilyOf, bucketFacet(PROGRESS_MEASURE, PROGRESS_BUCKETS), 'Kind × progress'),
  },
  {
    // CARDS PER CLUSTER (b178) — the census reducing over the CONNECTOR-GRAPH dimension via `clusterFacet`:
    // how big is each separate connected piece of the board. Proves graph topology is a reduction dimension
    // (the census works per-cluster with zero new code). Ignores `now`.
    key: 'cluster-sizes',
    label: 'Cluster sizes',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetCensusText(items, clusterFacet(items), 'Cluster sizes'),
  },
  {
    // AVERAGE PROGRESS PER CLUSTER (b178) — the pivot reducing over the same graph dimension: which connected
    // piece of the plan is furthest along. Proves the WHOLE reducer family (not just the census) works per
    // cluster. Ignores `now`.
    key: 'cluster-progress',
    label: 'Progress by cluster',
    ext: 'md',
    mime: 'text/markdown',
    serialize: (items) => facetPivotText(items, clusterFacet(items), PROGRESS_MEASURE, aggregatorById('mean')!, 'Average progress by cluster', formatPercent),
  },
];

// PROGRESS_MEASURE / DEADLINE_MEASURE / WORDS_MEASURE / formatPercent / PROGRESS_BUCKETS / SIZE_BUCKETS are
// imported from board-report (the reducer-family SSOT) — see the import above (b179).

/** Look up a format by key (null when unknown). */
export function documentExport(key: string): BoardDocumentExport | null {
  return DOCUMENT_EXPORTS.find((e) => e.key === key) ?? null;
}

/** Serialize a board in the named format (empty string when the format is unknown). */
export function exportBoardAs(key: string, items: readonly BoardItem[], now: number, opts: BoardExportOptions = {}): string {
  const fmt = documentExport(key);
  return fmt ? fmt.serialize(items, now, opts) : '';
}

/** A safe download filename from a board title + a format extension: "My Vision" + "ics" -> "my-vision.ics"
 *  (slugified, non-alphanumerics collapsed to dashes; a blank title falls back to "board"). */
export function exportFilename(title: string | undefined, ext: string): string {
  const base = (typeof title === 'string' ? title : '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base.length > 0 ? base : 'board'}.${ext}`;
}
