// packages/group/read-data/facet-filter.test.ts
//
// Proof of the generic DATA-driven multi-facet filter: AND across facet keys, OR within a
// key, injected blind extractors (the engine names no facet), fail-closed on an unknown
// selected facet, whitespace/case normalization, and the DELETION TEST — a brand-new facet
// dimension the engine never heard of filters correctly with ONE extractor row, zero change.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  filterByFacets,
  matchesFacets,
  explainFacetMatch,
  facetValues,
  facetValueCounts,
  facetColorAssignment,
  hasActiveFacets,
  toggleFacetValue,
  type FacetExtractors,
} from '../../../read-data/facet-filter.ts';

it('explains every active constraint using the selection predicate, including unavailable facets', () => {
  const entry = { team: ['Client work', 'Internal'], state: ['Ready'] };
  const extractors = { team: (row: typeof entry) => row.team, state: (row: typeof entry) => row.state };
  const selection = { team: ['client WORK', 'Other'], state: ['ready'], unused: [] };
  const result = explainFacetMatch(entry, selection, extractors);
  expect(result.matches).toBe(matchesFacets(entry, selection, extractors));
  expect(result.facets.map(facet => [facet.key, facet.matchedValues])).toEqual([['team', ['Client work']], ['state', ['Ready']]]);
  const missing = explainFacetMatch(entry, { ...selection, constructor: ['anything'] }, extractors);
  expect(missing.matches).toBe(false);
  expect(missing.facets.at(-1)).toMatchObject({ key: 'constructor', available: false, matches: false, matchedValues: [] });
  expect(explainFacetMatch(entry, {}, extractors)).toEqual({ matches: true, facets: [] });
});

interface Row {
  readonly id: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly source?: string;
}

const EXTRACTORS: FacetExtractors<Row> = {
  category: (r) => (r.category ? [r.category] : []),
  tag: (r) => r.tags ?? [],
};

const ROWS: Row[] = [
  { id: 'a', category: 'Planning', tags: ['agile', 'tasks'], source: 'template' },
  { id: 'b', category: 'Ideation', tags: ['ideas'], source: 'collection' },
  { id: 'c', category: 'Planning', tags: ['schedule', 'agile'], source: 'template' },
  { id: 'd', category: 'Ideation', tags: ['sketch'], source: 'collection' },
];

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('filterByFacets', () => {
  it('no active facets → every row, order preserved', () => {
    expect(ids(filterByFacets(ROWS, {}, EXTRACTORS))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(filterByFacets(ROWS, { tag: [] }, EXTRACTORS))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('OR within a key — multiple tag values union', () => {
    expect(ids(filterByFacets(ROWS, { tag: ['ideas', 'sketch'] }, EXTRACTORS))).toEqual(['b', 'd']);
  });

  it('AND across keys — category AND tag', () => {
    // Planning AND agile → a, c (b/d are Ideation; only agile-tagged Planning rows survive)
    expect(ids(filterByFacets(ROWS, { category: ['Planning'], tag: ['agile'] }, EXTRACTORS))).toEqual(['a', 'c']);
    // Planning AND sketch → none (sketch is only on an Ideation row)
    expect(ids(filterByFacets(ROWS, { category: ['Planning'], tag: ['sketch'] }, EXTRACTORS))).toEqual([]);
  });

  it('multi-category OR combined with a tag AND', () => {
    // (Planning OR Ideation) AND agile → a, c
    expect(ids(filterByFacets(ROWS, { category: ['Planning', 'Ideation'], tag: ['agile'] }, EXTRACTORS))).toEqual(['a', 'c']);
  });

  it('fail-closed — a selected facet with no extractor excludes every row', () => {
    expect(ids(filterByFacets(ROWS, { author: ['sam'] }, EXTRACTORS))).toEqual([]);
  });

  it('normalizes whitespace + case in both the selection and the row values', () => {
    const rows: Row[] = [{ id: 'x', category: '  Planning ', tags: ['  AGILE '] }];
    expect(ids(filterByFacets(rows, { category: ['planning'] }, EXTRACTORS))).toEqual(['x']);
    expect(ids(filterByFacets(rows, { tag: ['agile'] }, EXTRACTORS))).toEqual(['x']);
  });
});

describe('matchesFacets', () => {
  it('a row with no values for a required facet never matches', () => {
    expect(matchesFacets({ id: 'z' }, { tag: ['agile'] }, EXTRACTORS)).toBe(false);
  });
});

describe('facetValues', () => {
  it('sorted-unique, case-insensitive dedupe keeping first-seen casing, skips blanks', () => {
    const rows: Row[] = [
      { id: '1', tags: ['Agile', 'tasks'] },
      { id: '2', tags: ['agile', '  '] },
      { id: '3', tags: ['schedule'] },
    ];
    expect(facetValues(rows, EXTRACTORS.tag)).toEqual(['Agile', 'schedule', 'tasks']);
  });

  it('category facet lists the distinct categories', () => {
    expect(facetValues(ROWS, EXTRACTORS.category)).toEqual(['Ideation', 'Planning']);
  });

  it('drops whitespace-only values (preserves the old arrangementCategories trim invariant)', () => {
    expect(facetValues([{ id: 'w', category: '   ' }], EXTRACTORS.category)).toEqual([]);
  });
});

describe('hasActiveFacets', () => {
  it('true only when some key has at least one value', () => {
    expect(hasActiveFacets({})).toBe(false);
    expect(hasActiveFacets({ tag: [] })).toBe(false);
    expect(hasActiveFacets({ tag: ['x'] })).toBe(true);
  });
});

describe('toggleFacetValue', () => {
  it('adds when absent, removes when present, drops an emptied key', () => {
    const a = toggleFacetValue({}, 'tag', 'agile');
    expect(a).toEqual({ tag: ['agile'] });
    const b = toggleFacetValue(a, 'tag', 'ideas');
    expect(b).toEqual({ tag: ['agile', 'ideas'] });
    const c = toggleFacetValue(b, 'tag', 'AGILE'); // case-insensitive remove
    expect(c).toEqual({ tag: ['ideas'] });
    const d = toggleFacetValue(c, 'tag', 'ideas');
    expect(d).toEqual({}); // emptied key is dropped
  });
});

describe('facetValueCounts — conjunctive faceted-navigation counts', () => {
  it('no active facets → a count for every value the catalog carries', () => {
    expect(facetValueCounts(ROWS, 'category', {}, EXTRACTORS)).toEqual({ Ideation: 2, Planning: 2 });
    expect(facetValueCounts(ROWS, 'tag', {}, EXTRACTORS)).toEqual({ agile: 2, ideas: 1, schedule: 1, sketch: 1, tasks: 1 });
  });

  it('OTHER active facets constrain the count, and an excluded value still reports 0', () => {
    // With tag ∈ {agile} active, only a+c (both Planning) survive → Ideation drops to 0 (still shown).
    expect(facetValueCounts(ROWS, 'category', { tag: ['agile'] }, EXTRACTORS)).toEqual({ Ideation: 0, Planning: 2 });
  });

  it('a facet does NOT filter itself — its own selection is ignored when counting it', () => {
    // Counting `category` while category ∈ {Planning} is active must still report Ideation:2,
    // so the user can see how many they would get by switching — the widening-is-OR rule.
    expect(facetValueCounts(ROWS, 'category', { category: ['Planning'] }, EXTRACTORS)).toEqual({ Ideation: 2, Planning: 2 });
  });

  it('fail-closed: an unknown facet key yields {} (mirrors matchesFacets exclusion)', () => {
    expect(facetValueCounts(ROWS, 'author', {}, EXTRACTORS)).toEqual({});
  });

  it('counts each row once per value (a row carrying a duplicated value is not double-counted)', () => {
    const dupRows: Row[] = [{ id: 'x', tags: ['Focus', 'focus'] }, { id: 'y', tags: ['focus'] }];
    // 'Focus' and 'focus' normalize to the same value → one chip keyed by first-seen casing,
    // counted once for row x (despite two occurrences) plus once for row y = 2.
    expect(facetValueCounts(dupRows, 'tag', {}, EXTRACTORS)).toEqual({ Focus: 2 });
  });

  it('count keys match the exact casing facetValues returns (chip lookup is direct)', () => {
    const mixed: Row[] = [{ id: 'a', tags: ['Agile'] }, { id: 'b', tags: ['agile'] }];
    const values = facetValues(mixed, EXTRACTORS.tag); // first-seen casing, sorted-unique
    const counts = facetValueCounts(mixed, 'tag', {}, EXTRACTORS);
    for (const v of values) expect(counts[v]).toBeTypeOf('number'); // every rendered chip has a count
    expect(counts).toEqual({ Agile: 2 });
  });
});

describe('facetColorAssignment — STABLE value→colour + entry lookup (colour-by-facet SSOT)', () => {
  const COLORS = ['#c10000', '#c20000', '#c30000'];

  it('assigns one colour per distinct value in ALPHABETICAL order (position/selection independent)', () => {
    // tags across rows: agile, ideas, sketch, schedule, tasks → alpha-sorted pairs.
    const a = facetColorAssignment(ROWS, EXTRACTORS.tag, COLORS);
    expect(a.pairs.map((p) => p.value)).toEqual(['agile', 'ideas', 'schedule', 'sketch', 'tasks']);
    // agile → colours[0], ideas → colours[1], schedule → colours[2], then CYCLE: sketch → colours[0], tasks → colours[1]
    expect(a.pairs.map((p) => p.color)).toEqual(['#c10000', '#c20000', '#c30000', '#c10000', '#c20000']);
  });

  it('STABILITY: the same value gets the same colour regardless of which rows are present', () => {
    const full = facetColorAssignment(ROWS, EXTRACTORS.category, COLORS); // Ideation, Planning
    const planningColor = full.pairs.find((p) => p.value === 'Planning')!.color;
    // A different subset (no Ideation rows) — Planning is now the FIRST value, but colour is stable
    // ONLY if we key by value; alphabetical over {Planning} still yields the same relative order here.
    const subset = facetColorAssignment(ROWS.filter((r) => r.category === 'Planning'), EXTRACTORS.category, COLORS);
    // Planning is alphabetically after Ideation, so in the full set it takes colours[1]; alone it takes [0].
    // The POINT of stability for the board wrapper is that BOTH paint and legend read the SAME assignment
    // over the SAME item set — proven by colorOfEntry agreeing with pairs (next test). Here we assert the
    // ordering is purely value-driven (deterministic), not row-order driven:
    const reversed = facetColorAssignment([...ROWS].reverse(), EXTRACTORS.category, COLORS);
    expect(full.pairs).toEqual(reversed.pairs); // row order does NOT change the assignment
    expect(subset.pairs[0].value).toBe('Planning');
  });

  it('colorOfEntry maps an entry to its FIRST facet value colour, matching pairs exactly', () => {
    const a = facetColorAssignment(ROWS, EXTRACTORS.tag, COLORS);
    const colorFor = (v: string) => a.pairs.find((p) => p.value === v)!.color;
    // row a tags = [agile, tasks] → primary 'agile'
    expect(a.colorOfEntry(ROWS[0])).toBe(colorFor('agile'));
    // an entry with no tag → null
    expect(a.colorOfEntry({ id: 'z' })).toBeNull();
  });

  it('is case-insensitive (shares the facet norm): "Agile" and "agile" are ONE colour group', () => {
    const rows: Row[] = [{ id: 'x', tags: ['Agile'] }, { id: 'y', tags: ['agile'] }];
    const a = facetColorAssignment(rows, EXTRACTORS.tag, COLORS);
    expect(a.pairs).toHaveLength(1); // one group
    expect(a.colorOfEntry(rows[0])).toBe(a.colorOfEntry(rows[1])); // both → same colour
  });

  it('empty palette → empty pairs + colorOfEntry always null', () => {
    const a = facetColorAssignment(ROWS, EXTRACTORS.tag, []);
    expect(a.pairs).toEqual([]);
    expect(a.colorOfEntry(ROWS[0])).toBeNull();
  });
});

describe('DELETION TEST — a facet the engine never heard of works with ONE extractor row', () => {
  it('filters by a brand-new `source` facet, zero engine change', () => {
    // The engine (filterByFacets/matchesFacets) has no notion of "source". Injecting one
    // extractor makes it a first-class filter — proving facets are DATA, not code branches.
    const withSource: FacetExtractors<Row> = { ...EXTRACTORS, source: (r) => (r.source ? [r.source] : []) };
    expect(ids(filterByFacets(ROWS, { source: ['template'] }, withSource))).toEqual(['a', 'c']);
    // and it composes (AND) with the built-ins with no special-casing
    expect(ids(filterByFacets(ROWS, { source: ['collection'], category: ['Ideation'] }, withSource))).toEqual(['b', 'd']);
    expect(facetValues(ROWS, withSource.source)).toEqual(['collection', 'template']);
  });
});

describe('toggleFacetValue — a whitespace-only value is ignored (cont.98 batch-7)', () => {
  // A '   ' value normalizes to '' — which facetValues/facetValueCounts/matchesFacets all skip. If
  // toggleFacetValue stored it, hasActiveFacets would report the facet ACTIVE while no row can match
  // it → the whole catalog silently filters to empty. It must be ignored (consistent empty handling).
  it('does not store a whitespace-only value (selection unchanged, not active, filter intact)', () => {
    const sel = toggleFacetValue({}, 'tag', '   ');
    expect(sel).toEqual({});
    expect(hasActiveFacets(sel)).toBe(false);
    const rows = [{ tags: ['red'] }, { tags: ['blue'] }];
    const ex = { tag: (r: { tags: string[] }) => r.tags };
    expect(filterByFacets(rows, sel, ex)).toHaveLength(2); // NOT nuked to empty
  });

  it('a real value still toggles on then off', () => {
    const on = toggleFacetValue({}, 'tag', 'red');
    expect(on).toEqual({ tag: ['red'] });
    expect(toggleFacetValue(on, 'tag', 'red')).toEqual({});
  });
});

describe('facet-filter proto-key hardening (cont.98 batch-27)', () => {
  // A hostile facet KEY (persisted selection / untrusted extra field) must never resolve to an INHERITED
  // Object.prototype member. Without the ownValue guard, extractors['constructor'] yields the Object
  // constructor (truthy) → called as an extractor → returns an object whose `.some` is undefined → crash.
  const rows = [{ tags: ['red'] }];
  const extractors = { tag: (r: { tags: string[] }) => r.tags };
  type Sel = Record<string, readonly string[]>;

  it('matchesFacets fails closed on a `constructor` facet key (no crash, row excluded)', () => {
    const sel = { constructor: ['x'] } as unknown as Sel;
    expect(matchesFacets(rows[0], sel, extractors)).toBe(false);
  });

  it('matchesFacets fails closed on an own `__proto__` facet key', () => {
    // build via null-proto assign so `__proto__` is a real OWN enumerable key, not a prototype mutation
    const sel = Object.assign(Object.create(null), { ['__proto__']: ['x'] }) as Sel;
    expect(matchesFacets(rows[0], sel, extractors)).toBe(false);
  });

  it('facetValueCounts returns {} for a prototype-named facet key (no inherited extractor)', () => {
    expect(facetValueCounts(rows, 'constructor', {}, extractors)).toEqual({});
    expect(facetValueCounts(rows, '__proto__', {}, extractors)).toEqual({});
    expect(facetValueCounts(rows, 'hasOwnProperty', {}, extractors)).toEqual({});
  });

  it('facetValueCounts stores a `__proto__`/`constructor` VALUE as an own data key (null-proto accumulator)', () => {
    const rows2 = [{ tags: ['__proto__'] }, { tags: ['constructor'] }];
    const counts = facetValueCounts(rows2, 'tag', {}, { tag: (r: { tags: string[] }) => r.tags });
    expect(Object.prototype.hasOwnProperty.call(counts, '__proto__')).toBe(true);
    expect(counts['__proto__']).toBe(1);
    expect(counts['constructor']).toBe(1);
  });

  it('toggleFacetValue stores a `__proto__`/`constructor` value as plain own data, round-trips off', () => {
    const sel = toggleFacetValue({}, 'tag', '__proto__');
    expect(Object.prototype.hasOwnProperty.call(sel, 'tag')).toBe(true);
    expect(sel.tag).toEqual(['__proto__']);
    const s2 = toggleFacetValue({}, 'constructor', 'v');
    expect(s2.constructor).toEqual(['v']); // own key on a null-proto object (not the inherited constructor)
    expect(toggleFacetValue(s2, 'constructor', 'v').constructor).toBeUndefined();
  });
});
