// packages/group/read-data/saved-arrangement.ts
//
// One projection over every reusable board arrangement, from any source. A static
// board template (#147) and a user-saved collection (W6) are the SAME thing: a
// portable BoardTemplate payload the applyTemplate engine can place. This reads
// BOARD_TEMPLATES + the collection store into one flat SavedArrangement[] a blind
// gallery renders — templates + collections + (future) board snapshots as rows,
// each carrying its own capabilities so the view never branches on source.

import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardTemplate, TemplateItem } from './board-template-apply';
import { boardToTemplate } from './group-board-model';
import { parseRows } from 'trillion-workshop/tools/organize-the-sidebar/read-data/catalog-merge.ts';
import { BOARD_TEMPLATES } from 'trillion-workshop/tools/organize-the-sidebar/show/board-templates.ts';
import {
  readActiveCollections,
  readArchivedCollections,
  saveCollection,
  type StoredCollection,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/collection-store.ts';
import {
  type ArrangementArtifact,
  type ArrangementProducer,
  resolveArtifact,
  snapshotProducer,
  facetLensProducer,
  axisLensProducer,
  timelineLensProducer,
  snapshotArtifact,
  facetLensArtifact,
  axisLensArtifact,
  timelineLensArtifact,
  type NumericFields,
  SNAPSHOT_CAPABILITY,
  FACET_LENS_CAPABILITY,
  AXIS_LENS_CAPABILITY,
  TIMELINE_LENS_CAPABILITY,
} from './arrangement-artifact';
import { itemTags } from 'trillion-workshop/tools/organize-the-sidebar/show/item-tags.ts';
import { itemFillColor } from 'trillion-workshop/tools/organize-the-sidebar/show/item-fill.ts';
import { searchCollections, COLLECTION_FACETS, type SearchQuery, type SearchableCollection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/collection-search.ts';
import { facetValues, facetValueCounts, ownValue, type FacetSelection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import { finiteCoord } from './finite-coord';

// ---- untrusted-DATA bounds (a lens catalog + collection index are persisted records) ----------
// GUARDS, not feature caps: no real library approaches them, but a corrupted/hostile persisted record
// can carry an arbitrarily large array. Each bound stops the read from spreading an unbounded array into
// a `.push(...arr)` (RangeError past the JS argument limit) or allocating without end. Fail-closed = drop
// the overflow, still render what fits.
const MAX_LENSES = 5_000; // lens specs read from ONE arrangement-lens-catalog record
const MAX_LIBRARY_ROWS = 100_000; // total rows the merged library will assemble

/** What a caller may DO with an arrangement row, carried as DATA so the view
 *  renders action affordances per-row without knowing the source (L090). */
export interface ArrangementCapabilities {
  /** Place the payload onto a board — every arrangement is applicable. */
  readonly apply: boolean;
  /** Rename the row (store-backed rows only; static templates are immutable). */
  readonly rename: boolean;
  /** Toggle archived state (store-backed rows only). */
  readonly archive: boolean;
  /** Copy into a new saved collection — any arrangement can be duplicated. */
  readonly duplicate: boolean;
}

/** One reusable arrangement, source-agnostic. `payload` is the portable body
 *  applyTemplate places; `memberId` is the store handle for mutate ops (absent
 *  for static templates). `source` is an opaque provenance tag for display/group
 *  only — never a behavior switch (behavior comes from `capabilities`). */
export interface SavedArrangement {
  /** Row id, unique ACROSS sources (source-prefixed so a template and a
   *  collection sharing a raw id never collide). */
  readonly id: string;
  readonly label: string;
  readonly category?: string;
  /** One-line human summary shown under the title in the library card (R4). */
  readonly description?: string;
  /** Free-form labels — rendered as chips + fed to ranked search/filter (R4). */
  readonly tags?: readonly string[];
  /** Provenance tag: 'template' | 'collection' | future. Display/grouping only. */
  readonly source: string;
  /** Store handle for rename/archive/duplicate — undefined for static templates. */
  readonly memberId?: string;
  readonly archived: boolean;
  readonly savedAt?: number;
  readonly capabilities: ArrangementCapabilities;
  /** The concrete snapshot body — present for snapshot rows (template/collection),
   *  used for the thumbnail + duplicate. A live-lens row has no fixed body (it re-derives
   *  on apply), so this is undefined there and consumers guard on it. */
  readonly payload?: BoardTemplate;
  /** §9.2 — how this row RESOLVES to a placeable BoardTemplate at apply time. Snapshot
   *  rows carry a snapshot artifact; live-lens rows carry a facet-lens artifact. Absent
   *  → treated as a snapshot of `payload` (back-compat). One resolve path for all kinds. */
  readonly artifact?: ArrangementArtifact;
}

/** The board's facet extractors as DATA — the SAME criteria the "Group by tag/kind/color"
 *  ops inject into arrangeByFacet, here made available to live-lens producers. A new facet
 *  is one entry, zero producer change (L090). Extractors read TemplateItem (portable). */
export const BOARD_FACETS: Readonly<Record<string, (item: TemplateItem) => string | readonly string[]>> = {
  tag: (i) => itemTags(i),
  kind: (i) => i.kind,
  color: (i) => itemFillColor(i) ?? '',
};

/** The board's NUMERIC fields as DATA — the SAME numbers the "Line up by length" / "Plot size vs
 *  length" ops use, made available to the continuous (axis/roadmap) live-lens producers. A new
 *  plottable number is one entry, zero producer change (L090). */
export const BOARD_NUMERIC_FIELDS: NumericFields = {
  // Clamp each dimension (a persisted Number.MAX_VALUE w/h is valid JSON) BEFORE the multiply, else
  // `MAX_VALUE * MAX_VALUE` overflows to Infinity and poisons the axis/scatter plot it feeds. finiteCoord
  // bounds both non-finite and finite-huge; the product is re-clamped so `size` is always a finite coord.
  size: (i) => finiteCoord(Math.max(0, finiteCoord(i.w)) * Math.max(0, finiteCoord(i.h))),
  length: (i) => (typeof i.text === 'string' && i.text.length > 0 ? i.text.length : null),
};

/** The default producer registry: snapshot (constant) + facet-lens (re-cluster by a named board
 *  facet) + axis-lens (plot on a continuous axis / scatter) + timeline-lens (roadmap: continuous X ×
 *  discrete swimlanes). Adding a producer here surfaces a new arrangement kind everywhere the library
 *  resolves, with zero consumer change. */
export const DEFAULT_ARRANGEMENT_PRODUCERS: Readonly<Record<string, ArrangementProducer>> = {
  [SNAPSHOT_CAPABILITY]: snapshotProducer,
  [FACET_LENS_CAPABILITY]: facetLensProducer(BOARD_FACETS),
  [AXIS_LENS_CAPABILITY]: axisLensProducer(BOARD_NUMERIC_FIELDS),
  [TIMELINE_LENS_CAPABILITY]: timelineLensProducer(BOARD_NUMERIC_FIELDS, BOARD_FACETS),
};

/**
 * Resolve a library row to a concrete, placeable BoardTemplate — the ONE apply chokepoint
 * for every arrangement kind (§9.2). `targetItems` is the board the arrangement is being
 * placed against, as portable TemplateItems (empty for a fresh board); a snapshot ignores
 * it, a live lens re-clusters it. A row with neither `artifact` nor `payload` is a hard
 * error (fail-closed — never a silent empty board).
 */
export function resolveArrangementTemplate(
  row: SavedArrangement,
  targetItems: readonly TemplateItem[],
  producers: Readonly<Record<string, ArrangementProducer>> = DEFAULT_ARRANGEMENT_PRODUCERS,
): BoardTemplate {
  const artifact = row.artifact ?? (row.payload ? snapshotArtifact(row.payload) : undefined);
  if (!artifact) {
    throw new Error(`arrangement row "${row.id}" has no artifact or payload to resolve`);
  }
  return resolveArtifact(artifact, { targetItems }, producers);
}

/** A live facet-lens library row — the emergent §9.2 capability: a saved, named lens that
 *  re-clusters the CURRENT board by a facet on apply, instead of placing fixed items. No
 *  fixed payload; its thumbnail is a lens preview, and it is applicable + duplicable. */
export function facetLensRow(facet: string, opts: { label?: string; category?: string } = {}): SavedArrangement {
  const label = opts.label ?? `Grouped by ${facet}`;
  return {
    id: `lens:${facet}`,
    label,
    category: opts.category,
    source: 'lens',
    archived: false,
    capabilities: { apply: true, rename: false, archive: false, duplicate: false },
    artifact: facetLensArtifact(facet, { name: label, category: opts.category }),
  };
}

/** A live AXIS-lens library row (§9.4): a saved, named lens that re-plots the CURRENT board on a
 *  continuous axis (1-D by `xField`, or 2-D scatter when `yField` is given) on apply. */
export function axisLensRow(xField: string, opts: { yField?: string; label?: string; category?: string } = {}): SavedArrangement {
  const label = opts.label ?? (opts.yField ? `${xField} vs ${opts.yField}` : `Lined up by ${xField}`);
  return {
    id: `lens:axis:${xField}${opts.yField ? `x${opts.yField}` : ''}`,
    label,
    category: opts.category,
    source: 'lens',
    archived: false,
    capabilities: { apply: true, rename: false, archive: false, duplicate: false },
    artifact: axisLensArtifact(xField, { yField: opts.yField, name: label, category: opts.category }),
  };
}

/** A live ROADMAP-lens library row (§9.5): a saved, named lens that re-lays the CURRENT board as a
 *  timeline (continuous X × discrete swimlanes) on apply. */
export function timelineLensRow(xField: string, laneField: string, opts: { label?: string; category?: string } = {}): SavedArrangement {
  const label = opts.label ?? `Roadmap by ${laneField}`;
  return {
    id: `lens:timeline:${xField}:${laneField}`,
    label,
    category: opts.category,
    source: 'lens',
    archived: false,
    capabilities: { apply: true, rename: false, archive: false, duplicate: false },
    artifact: timelineLensArtifact(xField, laneField, { name: label, category: opts.category }),
  };
}

/** Build a library row from a DATA lens spec — the ONE bridge from `arrangement-lens-catalog` DATA to
 *  a resolvable row. A legacy facet spec routes through {@link facetLensRow} (stable `lens:<facet>`
 *  id); any generic `{capability, input}` spec (axis-lens / timeline-lens / future) wraps directly
 *  into an artifact — the producer map resolves it (L090). A spec with neither → null (fail-closed). */
export function lensRowFromSpec(spec: ArrangementLensSpec): SavedArrangement | null {
  if (typeof spec.facet === 'string') return facetLensRow(spec.facet, { label: spec.label, category: spec.category });
  if (typeof spec.capability !== 'string') return null;
  const slug = spec.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `lens:${spec.capability}:${slug}`;
  return {
    id,
    label: spec.label,
    category: spec.category,
    source: 'lens',
    archived: false,
    capabilities: { apply: true, rename: false, archive: false, duplicate: false },
    artifact: { id, name: spec.label, category: spec.category, producer: { capability: spec.capability, input: spec.input } },
  };
}

const TEMPLATE_CAPABILITIES: ArrangementCapabilities = { apply: true, rename: false, archive: false, duplicate: true };
const COLLECTION_CAPABILITIES: ArrangementCapabilities = { apply: true, rename: true, archive: true, duplicate: true };

/** A static board template as a SavedArrangement row (immutable, no store handle).
 *  Exported so a templates-only gallery renders through the SAME row shape. */
export function templateRow(template: BoardTemplate): SavedArrangement {
  return {
    id: `template:${template.id}`,
    label: template.name,
    category: template.category,
    description: template.description,
    tags: template.tags,
    source: 'template',
    archived: false,
    capabilities: TEMPLATE_CAPABILITIES,
    payload: template,
  };
}

/** A stored collection as a SavedArrangement row (mutable, store-backed). */
function collectionRow(collection: StoredCollection): SavedArrangement {
  return {
    id: `collection:${collection.collectionId}`,
    label: collection.name,
    category: collection.record.category,
    description: collection.record.description,
    tags: collection.record.tags,
    source: 'collection',
    memberId: collection.memberId,
    archived: collection.archived,
    savedAt: collection.savedAt,
    capabilities: COLLECTION_CAPABILITIES,
    payload: collection.record,
  };
}

/** One facet lens as DATA — the SSOT is the `arrangement-lens-catalog` published record
 *  (group's `things`), NOT a hardcoded list. `facet` keys the Physics extractor in
 *  BOARD_FACETS; `label` is the human name. */
export interface ArrangementLensSpec {
  readonly label: string;
  readonly category?: string;
  /** Legacy facet-lens shorthand — when present the lens re-clusters by this board facet. */
  readonly facet?: string;
  /** OR a generic producer descriptor: WHICH registered producer resolves this lens + its opaque
   *  input (axis-lens / timeline-lens / any future kind) — the lens KIND is DATA, not a code branch
   *  (L090 / enum-dissolution). A spec with neither `facet` nor `capability` is dropped (fail-closed). */
  readonly capability?: string;
  readonly input?: unknown;
}

/** The catalog kind published in group's `things-to-store-and-run.json`. */
const ARRANGEMENT_LENS_CATALOG_KIND = 'arrangement-lens-catalog';

/**
 * Read the live facet-lens catalog from published records (SSOT — Physics-vs-Society:
 * WHICH lenses the library offers is Society DATA, authored in `things`, never hardcoded).
 * Mirrors `readInspectionFieldSets`: filter by `payload.kind`, flatten each catalog's
 * `lenses[]`. No catalog records → no lenses (honest empty), not a code default.
 */
export function readArrangementLensCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): ArrangementLensSpec[] {
  const specs: ArrangementLensSpec[] = [];
  for (const record of records) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || payload.kind !== ARRANGEMENT_LENS_CATALOG_KIND) continue;
    // Untrusted DATA rows through the shared fail-safe `parseRows` — a stray null lens no longer
    // crashes the read via `l.facet` (L083; the SAME guard mergeCatalog uses, one owner: L063).
    // Append in a LOOP with a cap — NEVER `specs.push(...parseRows(...))`: a hostile `payload.lenses`
    // of millions of rows would spread past the JS argument limit (RangeError). Stop at MAX_LENSES.
    const parsed = parseRows(payload.lenses, (l): ArrangementLensSpec | null => {
      if (typeof l.label !== 'string') return null;
      const category = typeof l.category === 'string' ? l.category : 'Live lenses';
      // Legacy facet shorthand (unchanged shape) OR a generic {capability, input} lens (L090).
      if (typeof l.facet === 'string') return { facet: l.facet, label: l.label, category };
      if (typeof l.capability === 'string') return { capability: l.capability, input: l.input, label: l.label, category };
      return null;
    });
    for (const spec of parsed) {
      if (specs.length >= MAX_LENSES) return specs; // fail-closed DoS bound
      specs.push(spec);
    }
  }
  return specs;
}

export interface SavedArrangementLibraryOptions {
  /** Include the built-in board templates (default true). */
  readonly includeTemplates?: boolean;
  /** Include archived collections after the active rows (default false). */
  readonly includeArchived?: boolean;
  /** The live facet lenses to offer, read from the `arrangement-lens-catalog` DATA (SSOT).
   *  Absent/empty → no lens rows (the library still renders templates + collections). */
  readonly lensCatalog?: readonly ArrangementLensSpec[];
}

/**
 * The merged library: built-in templates, then live facet lenses (from DATA), then active
 * collections (then archived when asked). Pure read over BOARD_TEMPLATES + the injected
 * lens catalog + the collection store — the ONE list a gallery/sidebar renders. Adding a
 * new source is one more map here; adding a new lens is one more DATA row (zero code).
 */
export function readSavedArrangementLibrary(
  graph: GroupGraph,
  collectionIndexRef: AddressRef,
  opts: SavedArrangementLibraryOptions = {},
): SavedArrangement[] {
  const includeTemplates = opts.includeTemplates !== false;
  const rows: SavedArrangement[] = [];
  // Append one row at a time with a hard total cap — NEVER `rows.push(...persistedArray)`: a corrupted
  // collection index (or lens catalog) with millions of members would spread past the JS argument limit
  // (RangeError). `pushRow` returns false once the library is full so every source stops cleanly.
  const pushRow = (r: SavedArrangement): boolean => {
    if (rows.length >= MAX_LIBRARY_ROWS) return false;
    rows.push(r);
    return true;
  };
  if (includeTemplates) for (const t of BOARD_TEMPLATES) if (!pushRow(templateRow(t))) return rows;
  for (const spec of opts.lensCatalog ?? []) {
    const row = lensRowFromSpec(spec);
    if (row && !pushRow(row)) return rows;
  }
  for (const c of readActiveCollections(graph, collectionIndexRef)) if (!pushRow(collectionRow(c))) return rows;
  if (opts.includeArchived) for (const c of readArchivedCollections(graph, collectionIndexRef)) if (!pushRow(collectionRow(c))) return rows;
  return rows;
}

/** The distinct, non-empty categories present in a library, sorted ascending — the DATA
 *  behind the gallery's category filter (R4). No hardcoded category list; the filter is
 *  whatever the rows actually carry (a new template category needs zero UI change). */
export function arrangementCategories(rows: readonly SavedArrangement[]): string[] {
  return arrangementFacetValues(rows, 'category');
}

/** The available values for ANY facet dimension across the library (category, tag, or any
 *  injected facet), sorted-unique — what each filter-chip group renders. Generalizes
 *  `arrangementCategories` onto the ONE facet SSOT (`facetValues` + `COLLECTION_FACETS`):
 *  tag chips, category chips, and a future author/origin facet all read from here, zero
 *  new derivation code (L069/L100). A new template value needs zero UI change. */
export function arrangementFacetValues(rows: readonly SavedArrangement[], facet: string): string[] {
  // Own-key lookup (the shared proto-safe SSOT): `facet` is an exported-API string — a prototype-named
  // key ('__proto__'/'constructor') would otherwise resolve to a truthy inherited member and be called
  // as an extractor → crash. `ownValue` makes it ABSENT → the fail-closed empty list.
  const extractor = ownValue(COLLECTION_FACETS, facet);
  if (!extractor) return [];
  return facetValues(rows.map(toSearchable), extractor);
}

/** ONE shaper: a library row → the generic searchable-catalog shape the facet/search SSOT
 *  consumes (name = label). Shared by value-listing, counts, and ranked search so all three
 *  read the same fields (DRY / one boundary, L063/L098). */
function toSearchable(r: SavedArrangement): SearchableCollection {
  return { id: r.id, name: r.label, description: r.description, tags: r.tags, category: r.category };
}

/** Per-value MATCH COUNTS for one facet across the library, given the OTHER active filters
 *  (conjunctive faceted-navigation): how many arrangements each chip would match. Keyed by the
 *  same casing `arrangementFacetValues` returns, so a chip group looks up `counts[value]`
 *  directly. Reuses the `facetValueCounts` SSOT over the same `COLLECTION_FACETS` extractors —
 *  zero new counting code, a new facet needs zero change here (L069/L090). */
export function arrangementFacetCounts(
  rows: readonly SavedArrangement[],
  facet: string,
  selection: FacetSelection,
): Record<string, number> {
  return facetValueCounts(rows.map(toSearchable), facet, selection, COLLECTION_FACETS);
}

/**
 * Search + filter a library of arrangements (R4). The SSOT search path — maps each row to the
 * generic `searchCollections` catalog shape (name = label, plus description/tags/category) and
 * returns the survivors as SavedArrangement[] in RANKED order (name > tag > description hits;
 * exact tag/category filters). Empty query → every row, original order preserved. Reuses the
 * purpose-built ranked search leaf instead of a second keyword matcher (one search SSOT).
 */
export function searchArrangements(
  rows: readonly SavedArrangement[],
  query: SearchQuery,
): SavedArrangement[] {
  // Key search on the row INDEX, not `row.id`: two persisted collections can share a `collectionId`
  // (→ duplicate `collection:<id>` row ids). A `Map` keyed by id would keep only the LAST such row, so
  // an earlier duplicate vanishes and a ranked duplicate id resolves the wrong row (possibly twice). A
  // synthetic per-row index is unique by construction, so every matching row maps back to ITS OWN row.
  const searchables = rows.map((r, i) => ({ ...toSearchable(r), id: String(i) }));
  const ranked = searchCollections(searchables, query);
  const out: SavedArrangement[] = [];
  for (const { id } of ranked) {
    const row = rows[Number(id)];
    if (row) out.push(row);
  }
  return out;
}

/**
 * Duplicate any arrangement (template OR collection) into a NEW saved collection —
 * pure compose of saveCollection with the source row's payload under fresh ids.
 * This is how "duplicate" works uniformly for every source (Codex: a template
 * duplicated becomes an editable collection).
 */
export function duplicateSavedArrangement(
  graph: GroupGraph,
  collectionIndexRef: AddressRef,
  arrangement: SavedArrangement,
  next: { memberId: string; collectionId: string; name: string },
): GroupGraph {
  if (!arrangement.payload) {
    // Live-lens rows have no fixed body to copy — duplicate is disabled for them
    // (capabilities.duplicate === false), so this is a defensive fail-closed guard.
    throw new Error(`cannot duplicate arrangement "${arrangement.id}" — it has no snapshot body (live lens)`);
  }
  return saveCollection(graph, collectionIndexRef, {
    memberId: next.memberId,
    collectionId: next.collectionId,
    name: next.name,
    record: { ...arrangement.payload, id: next.collectionId, name: next.name },
  });
}

/**
 * Snapshot a LIVE board into the arrangement library (library source (c)). Reads the
 * board's current contents into a portable `BoardTemplate` via `boardToTemplate` — the
 * same DATA the deep-copy/template engine places — and saves it as a collection. This
 * is the emergent capability the copyBoardContents SSOT unification unlocked: because a
 * live board and a catalog template share one representation, "save this board as a
 * reusable arrangement" is a pure compose (`boardToTemplate` → `saveCollection`), no new
 * engine. The saved snapshot then re-applies onto any board through the same path.
 * Pure: the source board is only read; the graph returned adds the collection.
 */
export function saveBoardAsArrangement(
  graph: GroupGraph,
  collectionIndexRef: AddressRef,
  srcBoardId: string,
  next: { memberId: string; collectionId: string; name: string },
): GroupGraph {
  return saveCollection(graph, collectionIndexRef, {
    memberId: next.memberId,
    collectionId: next.collectionId,
    name: next.name,
    record: { id: next.collectionId, name: next.name, items: boardToTemplate(graph, srcBoardId) },
  });
}
