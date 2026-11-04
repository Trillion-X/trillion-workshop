// packages/group/read-data/facet-filter.ts
//
// =============================================================================
// PURPOSE — a pure, blind, DATA-driven MULTI-FACET filter over any row type.
// =============================================================================
//
// A "facet" is a named dimension you can filter a catalog by (category, tag, author,
// board-of-origin, …). The engine here NEVER names a facet: each facet is an INJECTED
// extractor `(entry) => string[]` (the values that entry has for that dimension), and a
// selection is `Record<facetKey, string[]>` (the values the user picked per dimension).
// So adding a new facet is ONE extractor row in the caller's map — ZERO change here
// (L069/L090/enum-dissolution). This dissolves the old closed `{ tag?, category? }`
// SearchQuery union (a 2-facet enum-in-a-type) into open DATA.
//
// Semantics (canonical faceted search): AND ACROSS facet keys, OR WITHIN a key. Picking
// category ∈ {Ideation, Planning} AND tag ∈ {sketch} keeps rows that are (Ideation OR
// Planning) AND carry the sketch tag. A facet key with an empty/absent selection imposes
// no constraint. Matching is case-insensitive exact (same as the leaf it replaces).
//
// Fail-closed: a selected facet key with NO extractor cannot be evaluated, so the row is
// excluded (a loud, deterministic failure the caller will notice) rather than silently
// passing. No I/O, no domain knowledge beyond the injected extractors.
// =============================================================================

/** The values a user has selected per facet dimension. Empty/absent key = no constraint. */
export type FacetSelection = Readonly<Record<string, readonly string[]>>;

/** Pull the values a single row carries for one facet dimension (e.g. its tags). */
export type FacetExtractor<T> = (entry: T) => readonly string[];

/** The injected facet map: which dimensions exist + how to read each from a row. */
export type FacetExtractors<T> = Readonly<Record<string, FacetExtractor<T>>>;

/** True iff `selection` has at least one facet key with at least one chosen value. */
export function hasActiveFacets(selection: FacetSelection): boolean {
  return Object.values(selection).some((vals) => vals.length > 0);
}

/** Canonical facet-value form — trimmed + lowercased. ONE normalizer shared by match,
 *  toggle, and value-listing so whitespace/case never split or leak a value (preserves the
 *  old `arrangementCategories` `trim()` invariant Codex flagged). */
function norm(v: string): string {
  return v.trim().toLowerCase();
}

function normSet(values: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (const v of values) s.add(norm(v));
  return s;
}

/**
 * Own-property lookup of an UNTRUSTED string key into an injected map/selection. A facet key or a
 * selection key flows from persisted/imported DATA (a selection is `Record<facetKey, string[]>` that
 * can be JSON with an own `'__proto__'` key). A plain `map[key]` INHERITS from Object.prototype, so
 * `key === '__proto__'` resolves to a non-callable object and `key === 'constructor'` to the Object
 * constructor — either crashes the extractor call / `.some`. Restricting to OWN properties makes every
 * prototype-named key ABSENT, which every caller here already treats as fail-closed (exclude the row /
 * empty counts / no current selection) — the intended behavior, no crash.
 */
export function ownValue<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export interface FacetMatchReason {
  readonly key: string;
  readonly selected: readonly string[];
  readonly matchedValues: readonly string[];
  readonly available: boolean;
  readonly matches: boolean;
}

/** Matching and explanation share the same normalized comparison, including unknown-facet refusal. */
function evaluateFacet<T>(entry: T, key: string, selected: readonly string[], extractors: FacetExtractors<T>): FacetMatchReason {
  const extractor = ownValue(extractors, key);
  const wanted = normSet(selected);
  const matchedValues = extractor ? [...new Set(extractor(entry).filter(value => wanted.has(norm(value))))] : [];
  return { key, selected, matchedValues, available: !!extractor, matches: matchedValues.length > 0 };
}

/** Read-only reasons for every active constraint, in query order. No domain-specific facet names. */
export function explainFacetMatch<T>(entry: T, selection: FacetSelection, extractors: FacetExtractors<T>): {
  readonly matches: boolean;
  readonly facets: readonly FacetMatchReason[];
} {
  const facets = Object.entries(selection).filter(([, chosen]) => chosen.length > 0)
    .map(([key, chosen]) => evaluateFacet(entry, key, chosen, extractors));
  return { matches: facets.every(facet => facet.matches), facets };
}

/**
 * Does `entry` satisfy every active facet in `selection`? AND across keys, OR within a
 * key. A key with no chosen values is skipped; a chosen key with no extractor excludes
 * the row (fail-closed). Case-insensitive exact value match.
 */
export function matchesFacets<T>(
  entry: T,
  selection: FacetSelection,
  extractors: FacetExtractors<T>,
): boolean {
  for (const [key, chosen] of Object.entries(selection)) {
    if (chosen.length === 0) continue; // no constraint on this dimension
    if (!evaluateFacet(entry, key, chosen, extractors).matches) return false;
  }
  return true;
}

/** Keep only the rows that satisfy every active facet (order preserved). */
export function filterByFacets<T>(
  entries: readonly T[],
  selection: FacetSelection,
  extractors: FacetExtractors<T>,
): T[] {
  if (!hasActiveFacets(selection)) return [...entries];
  return entries.filter((e) => matchesFacets(e, selection, extractors));
}

/**
 * The available values for ONE facet across a catalog — sorted-unique, case-insensitive
 * de-duplication keeping the first-seen casing. This is what a filter-chip group renders
 * (generalizes the old bespoke `arrangementCategories`: category becomes just one facet).
 */
export function facetValues<T>(entries: readonly T[], extractor: FacetExtractor<T>): string[] {
  const seen = new Map<string, string>(); // normalized → first-seen trimmed original casing
  for (const e of entries) {
    for (const raw of extractor(e)) {
      const key = norm(raw);
      if (key === '') continue; // skip empty/whitespace-only (preserves the old category trim invariant)
      if (!seen.has(key)) seen.set(key, raw.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Conjunctive faceted-navigation counts for ONE facet: for every value that facet carries
 * across the catalog, how many rows would match if the user picked it — GIVEN the other
 * active facets. Standard faceted-search rule: a facet does NOT filter itself, so the count
 * reflects the OTHER active constraints only (widening within this facet is OR, so its own
 * current picks are excluded from the constraint). One count per row per value (a row with a
 * duplicated value is not double-counted).
 *
 * Keyed by the SAME display casing `facetValues` returns (first-seen trimmed original), so a
 * chip group can look up `counts[value]` directly for each value it renders. EVERY value the
 * catalog carries gets an entry — including 0 when the other facets exclude all its rows (so
 * a chip can show "0" / disable rather than silently vanish). Fail-closed: an unknown facet
 * key yields `{}` (mirrors `matchesFacets` excluding a selected-but-unknown facet).
 */
export function facetValueCounts<T>(
  entries: readonly T[],
  facetKey: string,
  selection: FacetSelection,
  extractors: FacetExtractors<T>,
): Record<string, number> {
  const extractor = ownValue(extractors, facetKey);
  if (!extractor) return {}; // fail-closed: cannot read this dimension
  // A facet never constrains itself — count against every OTHER active facet (widening = OR).
  const others: FacetSelection = { ...selection, [facetKey]: [] };
  const display = new Map<string, string>(); // norm → first-seen trimmed casing (same rule as facetValues)
  const byNorm = new Map<string, number>(); // norm → matching-row count
  for (const e of entries) {
    const passesOthers = matchesFacets(e, others, extractors);
    const seen = new Set<string>(); // one increment per row per value
    for (const raw of extractor(e)) {
      const key = norm(raw);
      if (key === '') continue; // skip empty/whitespace-only (same as facetValues)
      if (!display.has(key)) display.set(key, raw.trim()); // establish the chip label casing
      if (passesOthers && !seen.has(key)) {
        seen.add(key);
        byNorm.set(key, (byNorm.get(key) ?? 0) + 1);
      }
    }
  }
  // NULL-PROTOTYPE accumulator: `label` is an untrusted facet VALUE (e.g. from a hostile `extra.tags`),
  // so `counts['__proto__'] = n` on a plain {} would hit the prototype SETTER instead of creating an own
  // data key — the returned record would then have no usable '__proto__' count. A null-proto map stores
  // every value as a plain own key.
  const counts: Record<string, number> = Object.create(null);
  for (const [key, label] of display) counts[label] = byNorm.get(key) ?? 0;
  return counts;
}

/** One facet value paired with the colour assigned to it — the row a colour legend renders. */
export interface FacetColorPair {
  readonly value: string; // the display value (same casing `facetValues` returns)
  readonly color: string; // the colour from the supplied palette
}

/** A STABLE facet→colour assignment: every distinct facet value maps to a fixed palette colour,
 *  plus a lookup from any entry to its colour. Both the "colour BY facet" paint and its legend
 *  read from this ONE structure, so the swatch shown always equals the colour painted. */
export interface FacetColorAssignment<T> {
  /** value → colour, one per distinct facet value, in `facetValues` order (alphabetical → STABLE:
   *  a value keeps its colour regardless of selection or spatial position). Cycles the palette
   *  when values outnumber colours. Empty when the palette is empty. */
  readonly pairs: readonly FacetColorPair[];
  /** The colour for an ENTRY = the colour of its FIRST non-empty facet value, or `null` when the
   *  entry carries no value (or the palette is empty). Case-insensitive (shares the facet `norm`). */
  colorOfEntry(entry: T): string | null;
}

/**
 * Assign a STABLE colour to every distinct facet value (the "colour by tag / by type" mapping and
 * its legend, one source). Values are taken in {@link facetValues} order — alphabetical, so the
 * mapping is INDEPENDENT of selection subset and spatial layout: a given value ("idea") always
 * gets the same colour, unlike a reading-order assignment where the same value drifts colour as the
 * selection/position changes. Colours come from the caller's palette (kept generic — a `string[]`,
 * so this leaf never imports a board palette), cycling when values outnumber colours. `colorOfEntry`
 * resolves any entry to its colour through the SAME normalized keys, so the legend and the paint can
 * never disagree. Empty palette → empty pairs + `colorOfEntry` always null (no colour to assign).
 */
export function facetColorAssignment<T>(
  entries: readonly T[],
  extractor: FacetExtractor<T>,
  colors: readonly string[],
): FacetColorAssignment<T> {
  const pairs: FacetColorPair[] = [];
  const byNorm = new Map<string, string>(); // normalized value → colour
  if (colors.length > 0) {
    facetValues(entries, extractor).forEach((value, i) => {
      const color = colors[i % colors.length];
      pairs.push({ value, color });
      byNorm.set(norm(value), color);
    });
  }
  return {
    pairs,
    colorOfEntry(entry: T): string | null {
      if (byNorm.size === 0) return null;
      for (const raw of extractor(entry)) {
        const key = norm(raw);
        if (key === '') continue; // skip empty/whitespace — not a group
        const color = byNorm.get(key);
        if (color !== undefined) return color; // FIRST non-empty value that maps (the primary)
      }
      return null;
    },
  };
}

/**
 * Toggle one value in a facet selection (immutable) — the chip-click reducer. Adds the
 * value if absent, removes it if present; a facet key that empties out is dropped.
 */
export function toggleFacetValue(
  selection: FacetSelection,
  key: string,
  value: string,
): FacetSelection {
  // A whitespace-only value normalizes to '' — which facetValues / facetValueCounts / matchesFacets
  // all SKIP — so storing it would make hasActiveFacets treat the facet as active while no row can
  // ever match it, silently filtering EVERYTHING out. Ignore it (consistent empty-value handling).
  if (norm(value) === '') return selection;
  // Own-property read (a prototype-named key would otherwise resolve to Object.prototype, whose `.some`
  // is undefined → crash) and a null-proto accumulator (a literal `'__proto__'` facet key assigned on a
  // plain {} would hit the prototype setter instead of storing an own key).
  const current = ownValue(selection, key) ?? [];
  const has = current.some((v) => norm(v) === norm(value));
  const nextVals = has ? current.filter((v) => norm(v) !== norm(value)) : [...current, value];
  const next: Record<string, readonly string[]> = Object.assign(Object.create(null), selection);
  if (nextVals.length === 0) delete next[key];
  else next[key] = nextVals;
  return next;
}
