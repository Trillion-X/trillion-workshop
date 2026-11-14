// packages/group/show/board-item-facets.test.ts
//
// Proof of the board FOCUS facets running on the generic multi-facet engine (the cont.28
// facet-filter primitive, 2nd consumer over live board items). Covers: hue→name bucketing
// (boundaries + wrap + achromatic + unparseable + absent), the tag-facet EQUIVALENCE to the
// deleted `itemMatchesFilter` (empty→all / OR / case-insensitive / untagged-excluded), and
// multi-facet AND (tag AND colorFamily) — all through `matchesFacets`, one filter engine.

import { describe, expect, it } from 'vitest';
import { hueBucketName, colorFacetOf, kindFamilyOf, boardFocusMatch, focusedItemIds, nonFocusedVisibleIds, BOARD_ITEM_FACETS, BOARD_FOCUS_FACETS } from './board-item-facets';
import { matchesFacets, facetValues } from '../read-data/facet-filter';
import { seededFillStack } from './item-fill';
import type { BoardItem } from '../read-data/group-board-model';

const noteWith = (extra: Record<string, unknown>): BoardItem =>
  ({ memberId: 'm', kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra } as unknown as BoardItem);
const tagged = (...tags: string[]): BoardItem => noteWith({ tags });
const filled = (color: string): BoardItem => noteWith({ visualLayerStack: seededFillStack(color) });
const kinded = (kind: string): BoardItem =>
  ({ memberId: 'm', kind, x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, extra: {} } as unknown as BoardItem);

describe('hueBucketName (Society DATA hue ranges, blind range lookup)', () => {
  it('maps representative + BOUNDARY hues to the right family', () => {
    expect(hueBucketName(0)).toBe('Red');
    expect(hueBucketName(14.9)).toBe('Red');
    expect(hueBucketName(15)).toBe('Orange'); // boundary
    expect(hueBucketName(44.9)).toBe('Orange');
    expect(hueBucketName(45)).toBe('Yellow'); // boundary
    expect(hueBucketName(120)).toBe('Green');
    expect(hueBucketName(210)).toBe('Blue');
    expect(hueBucketName(270)).toBe('Purple');
    expect(hueBucketName(300)).toBe('Pink');
    expect(hueBucketName(344.9)).toBe('Pink');
    expect(hueBucketName(345)).toBe('Red'); // wrap boundary back into Red
  });

  it('normalizes out-of-range hues (wrap 360, negative)', () => {
    expect(hueBucketName(360)).toBe('Red'); // == 0
    expect(hueBucketName(-10)).toBe('Red'); // == 350 → Red band
    expect(hueBucketName(480)).toBe('Green'); // 480-360=120 → Green
  });
});

describe('colorFacetOf', () => {
  it('buckets a chromatic fill to its hue family', () => {
    expect(colorFacetOf(filled('#2563eb'))).toEqual(['Blue']);
    expect(colorFacetOf(filled('#ef4444'))).toEqual(['Red']);
    expect(colorFacetOf(filled('#22c55e'))).toEqual(['Green']);
  });
  it('an achromatic fill → Grey; an UNPARSEABLE fill → Grey (no hue)', () => {
    expect(colorFacetOf(filled('#888888'))).toEqual(['Grey']);
    expect(colorFacetOf(filled('var(--brand)'))).toEqual(['Grey']);
  });
  it('NO fill imposes no colour facet (empty → the item is colourless, not Grey)', () => {
    expect(colorFacetOf(tagged('a'))).toEqual([]);
  });
});

describe('kindFamilyOf (raw item kind → human TYPE family, no vocabulary leak)', () => {
  it('maps kinds to families; image + media COLLAPSE to one "Image"', () => {
    expect(kindFamilyOf(kinded('note'))).toEqual(['Note']);
    expect(kindFamilyOf(kinded('image'))).toEqual(['Image']);
    expect(kindFamilyOf(kinded('media'))).toEqual(['Image']); // same family, one chip
    expect(kindFamilyOf(kinded('link'))).toEqual(['Link']);
  });
  it('container/transient kinds impose NO type facet (section/pending → [])', () => {
    expect(kindFamilyOf(kinded('section'))).toEqual([]);
    expect(kindFamilyOf(kinded('pending'))).toEqual([]);
  });
  it('an UNMAPPED kind falls back to Title-case (never a raw lowercase key)', () => {
    expect(kindFamilyOf(kinded('widget'))).toEqual(['Widget']);
  });
  it('a prototype-chain kind is a plain Title-case chip, NEVER a live Object reference', () => {
    // cont.98 batch-17 (self-review + Codex): `kind` is untrusted item DATA and KIND_FAMILY was a plain
    // object, so `kind in KIND_FAMILY` matched inherited keys — kind '__proto__' → Object.prototype and
    // 'constructor' → Object were returned AS facet values, which downstream facet string reducers crash
    // on. hasOwn now routes every prototype-chain kind to the harmless Title-case fallback.
    for (const hostile of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
      const fam = kindFamilyOf(kinded(hostile));
      expect(Array.isArray(fam)).toBe(true);
      expect(fam.every((f) => typeof f === 'string')).toBe(true); // never Object.prototype / Object
      expect(fam).toEqual([hostile.charAt(0).toUpperCase() + hostile.slice(1)]);
    }
  });
});

describe('BOARD_ITEM_FACETS.tag — equivalence to the deleted itemMatchesFilter', () => {
  const sel = (tags: string[]) => ({ tag: tags });
  it('empty selection matches everything (no focus active)', () => {
    expect(matchesFacets(tagged('a'), {}, BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(tagged('a'), { tag: [] }, BOARD_ITEM_FACETS)).toBe(true);
  });
  it('OR within the tag facet + case-insensitive', () => {
    expect(matchesFacets(tagged('color', 'mood'), sel(['mood']), BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(tagged('color'), sel(['mood']), BOARD_ITEM_FACETS)).toBe(false);
    expect(matchesFacets(tagged('Color'), sel(['color']), BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(tagged('x'), sel(['a', 'x']), BOARD_ITEM_FACETS)).toBe(true);
  });
  it('an untagged item is excluded when a tag is active', () => {
    expect(matchesFacets(noteWith({}), sel(['mood']), BOARD_ITEM_FACETS)).toBe(false);
  });
});

describe('multi-facet AND — tag AND colorFamily (the cont.28 engine, board consumer)', () => {
  const blueA = noteWith({ tags: ['a'], visualLayerStack: seededFillStack('#2563eb') });
  it('an item must satisfy BOTH facets', () => {
    expect(matchesFacets(blueA, { tag: ['a'], colorFamily: ['Blue'] }, BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(blueA, { tag: ['a'], colorFamily: ['Red'] }, BOARD_ITEM_FACETS)).toBe(false);
    expect(matchesFacets(blueA, { tag: ['z'], colorFamily: ['Blue'] }, BOARD_ITEM_FACETS)).toBe(false);
  });
  it('facetValues derives the chip options per facet from the live items', () => {
    const items = [filled('#2563eb'), filled('#ef4444'), tagged('idea'), tagged('goal')];
    expect(facetValues(items, BOARD_ITEM_FACETS.colorFamily)).toEqual(['Blue', 'Red']);
    expect(facetValues(items, BOARD_ITEM_FACETS.tag)).toEqual(['goal', 'idea']);
  });
});

describe('kindFamily facet — the emergence proof (a new focus dimension = DATA only)', () => {
  it('BOARD_FOCUS_FACETS gained Type with ZERO panel/bar code (it iterates this DATA)', () => {
    expect(BOARD_FOCUS_FACETS.map((f) => f.key)).toEqual(['tag', 'colorFamily', 'kindFamily', 'progress', 'deadline']);
    expect(BOARD_FOCUS_FACETS.find((f) => f.key === 'kindFamily')?.label).toBe('Type');
  });
  it('filters the board by type family through the SAME matchesFacets engine', () => {
    expect(matchesFacets(kinded('link'), { kindFamily: ['Link'] }, BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(kinded('note'), { kindFamily: ['Link'] }, BOARD_ITEM_FACETS)).toBe(false);
    // image + media both satisfy the one 'Image' chip
    expect(matchesFacets(kinded('image'), { kindFamily: ['Image'] }, BOARD_ITEM_FACETS)).toBe(true);
    expect(matchesFacets(kinded('media'), { kindFamily: ['Image'] }, BOARD_ITEM_FACETS)).toBe(true);
  });
  it('facetValues derives the Type chips, collapsing image/media', () => {
    expect(facetValues([kinded('note'), kinded('image'), kinded('media'), kinded('link')], BOARD_ITEM_FACETS.kindFamily))
      .toEqual(['Image', 'Link', 'Note']); // sorted, image+media = one Image
  });
});

describe('boardFocusMatch + focusedItemIds — the focus→select bridge (one SSOT predicate)', () => {
  const items = [
    noteWith({ tags: ['idea'], visualLayerStack: seededFillStack('#2563eb') }), // n0: idea + Blue
    noteWith({ tags: ['risk'], visualLayerStack: seededFillStack('#ef4444') }), // n1: risk + Red
    noteWith({ tags: ['idea'], visualLayerStack: seededFillStack('#22c55e') }), // n2: idea + Green
  ].map((it, i) => ({ ...it, memberId: `n${i}` })) as BoardItem[];

  it('boardFocusMatch = matchesFacets AND matchesSearch (empty focus matches all)', () => {
    expect(boardFocusMatch(items[0], {}, '')).toBe(true); // no focus → all match
    expect(boardFocusMatch(items[0], { tag: ['idea'] }, '')).toBe(true);
    expect(boardFocusMatch(items[1], { tag: ['idea'] }, '')).toBe(false); // risk, not idea
  });

  it('the free-text query composes (AND) with the facets', () => {
    // items carry no searchable text here, so a non-matching query excludes everything
    expect(boardFocusMatch(items[0], { tag: ['idea'] }, 'zzz')).toBe(false);
  });

  it('focusedItemIds returns exactly the member ids in focus (tag idea AND Blue → n0)', () => {
    expect(focusedItemIds(items, { tag: ['idea'], colorFamily: ['Blue'] }, '')).toEqual(['n0']);
    expect(focusedItemIds(items, { tag: ['idea'] }, '')).toEqual(['n0', 'n2']);
    expect(focusedItemIds(items, {}, '')).toEqual(['n0', 'n1', 'n2']); // no focus → all
  });

  it('nonFocusedVisibleIds = the ISOLATE set: visible non-connector items NOT in focus', () => {
    const connector = { memberId: 'c0', kind: 'connector', x: 0, y: 0, w: 0, h: 0, isSection: false, childCount: 0, extra: { fromMemberId: 'n0', toMemberId: 'n1' } } as unknown as BoardItem;
    const hiddenIdea = { ...items[0], memberId: 'nh', extra: { ...(items[0].extra as object), hidden: true } } as BoardItem;
    const all = [...items, connector, hiddenIdea];
    // focus = tag idea → n0,n2,nh match; nh is already hidden; the complement to HIDE is n1 only
    // (n0/n2 stay in focus, the connector is never hidden, nh already hidden).
    expect(nonFocusedVisibleIds(all, { tag: ['idea'] }, '')).toEqual(['n1']);
    // no focus → nothing to hide (every visible item is "in focus")
    expect(nonFocusedVisibleIds(all, {}, '')).toEqual([]);
  });
});

describe('BOARD_FOCUS_FACETS descriptor DATA', () => {
  it('offers human-labelled facets, never the collided `color` key', () => {
    expect(BOARD_FOCUS_FACETS.find((f) => f.key === 'colorFamily')?.label).toBe('Color');
    expect(BOARD_FOCUS_FACETS.some((f) => f.key === 'color')).toBe(false); // no collision with the lens `color`
    expect(BOARD_FOCUS_FACETS.some((f) => f.key === 'kind')).toBe(false); // raw kind key never surfaced
  });
});

describe('progress + deadline focus facets (cont.98 batch-60): two zero-engine dimensions on the same facet engine', () => {
  const DUE = 1_760_000_000_000;
  const check = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ id: `c${i}`, text: `t${i}`, done: i < done }));
  const notStarted = noteWith({ checklist: check(0, 3) });
  const inProgress = noteWith({ checklist: check(1, 3) });
  const done = noteWith({ checklist: check(2, 2) });
  const noList = noteWith({});
  const sel = (key: string, ...vals: string[]) => ({ [key]: vals });

  it('progress buckets a checklist to Not started / In progress / Done', () => {
    expect(BOARD_ITEM_FACETS.progress(notStarted)).toEqual(['Not started']);
    expect(BOARD_ITEM_FACETS.progress(inProgress)).toEqual(['In progress']);
    expect(BOARD_ITEM_FACETS.progress(done)).toEqual(['Done']);
    expect(BOARD_ITEM_FACETS.progress(noList)).toEqual([]); // no checklist → no progress value
  });

  it('focusing by progress dims cards that are not in that bucket (and every no-checklist card)', () => {
    expect(boardFocusMatch(inProgress, sel('progress', 'In progress'), '')).toBe(true);
    expect(boardFocusMatch(done, sel('progress', 'In progress'), '')).toBe(false);
    expect(boardFocusMatch(noList, sel('progress', 'In progress'), '')).toBe(false); // fail-closed: no value → dims
    // OR within the dimension: pick two buckets → either matches
    expect(boardFocusMatch(done, sel('progress', 'In progress', 'Done'), '')).toBe(true);
  });

  it('deadline is presence (time-independent), never urgency: Has deadline vs No deadline', () => {
    expect(BOARD_ITEM_FACETS.deadline(noteWith({ dueDate: DUE }))).toEqual(['Has deadline']);
    expect(BOARD_ITEM_FACETS.deadline(noteWith({}))).toEqual(['No deadline']);
    expect(boardFocusMatch(noteWith({ dueDate: DUE }), sel('deadline', 'Has deadline'), '')).toBe(true);
    expect(boardFocusMatch(noteWith({}), sel('deadline', 'Has deadline'), '')).toBe(false);
  });

  it('the focus bar auto-collects the new facet chips from the DATA (zero panel code)', () => {
    expect(BOARD_FOCUS_FACETS.find((f) => f.key === 'progress')?.label).toBe('Progress');
    expect(BOARD_FOCUS_FACETS.find((f) => f.key === 'deadline')?.label).toBe('Deadline');
    const items = [notStarted, inProgress, done, noList];
    expect(facetValues(items, BOARD_ITEM_FACETS.progress).sort()).toEqual(['Done', 'In progress', 'Not started']);
  });

  it('progress AND deadline compose across dimensions (in-progress AND has-deadline)', () => {
    const both = noteWith({ checklist: check(1, 3), dueDate: DUE });
    expect(boardFocusMatch(both, { progress: ['In progress'], deadline: ['Has deadline'] }, '')).toBe(true);
    expect(boardFocusMatch(inProgress, { progress: ['In progress'], deadline: ['Has deadline'] }, '')).toBe(false); // no deadline → fails the AND
  });
});
