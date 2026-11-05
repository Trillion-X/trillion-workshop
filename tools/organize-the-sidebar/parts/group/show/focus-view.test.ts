// packages/group/show/focus-view.test.ts
//
// Proof of the saved-focus-view DATA layer: make/parse/read-merge round-trip, DELETE via an
// `active:false` tombstone, per-BOARD scoping (no cross-board leak), immutable id, and the
// unknown-facet-key sanitize (an unknown selected facet fails closed and would hide everything).

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  makeFocusView,
  archiveFocusView,
  parseFocusViewRow,
  readFocusViews,
  sanitizeFocusView,
  FOCUS_VIEW_CATALOG_KIND,
} from '../../../show/focus-view.ts';
import { buildFocusViewWriteItem } from '../../../show/write-focus-view-live.ts';

const rec = (view: unknown) => ({ payload: { kind: FOCUS_VIEW_CATALOG_KIND, views: [view] } });

describe('makeFocusView', () => {
  it('captures a board-scoped view; drops empty facet keys + blank query; id is caller-supplied', () => {
    const v = makeFocusView('v1', '  Ideas  ', 'B1', { tag: ['idea'], colorFamily: [] }, '  ');
    expect(v).toEqual({ id: 'v1', name: 'Ideas', boardId: 'B1', facets: { tag: ['idea'] }, active: true });
  });
  it('keeps a non-blank query', () => {
    expect(makeFocusView('v2', 'Q', 'B1', {}, ' roadmap ').query).toBe('roadmap');
  });
});

describe('readFocusViews — merge + scope + tombstone', () => {
  const a = makeFocusView('a', 'Blue ideas', 'B1', { tag: ['idea'], colorFamily: ['Blue'] });
  const b = makeFocusView('b', 'Risks', 'B1', { tag: ['risk'] });
  const other = makeFocusView('c', 'Other board', 'B2', { tag: ['x'] });

  it('reads the views saved on THIS board only (no cross-board leak)', () => {
    const views = readFocusViews([rec(a), rec(b), rec(other)], 'B1');
    expect(views.map((v) => v.id).sort()).toEqual(['a', 'b']);
    expect(readFocusViews([rec(a), rec(b), rec(other)], 'B2').map((v) => v.id)).toEqual(['c']);
  });

  it('a later same-id row OVERRIDES (rename in place, no duplicate)', () => {
    const renamed = { ...a, name: 'Blue thoughts' };
    const views = readFocusViews([rec(a), rec(renamed)], 'B1');
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe('Blue thoughts');
  });

  it('DELETE: an active:false tombstone rewrite removes the view from the list', () => {
    const views = readFocusViews([rec(a), rec(b), rec(archiveFocusView(a))], 'B1');
    expect(views.map((v) => v.id)).toEqual(['b']); // 'a' tombstoned → gone
  });
});

describe('parseFocusViewRow — fail-safe decoder', () => {
  it('rejects rows missing id/name/boardId or with malformed facets', () => {
    expect(parseFocusViewRow({ name: 'x', boardId: 'B', facets: {} })).toBeNull(); // no id
    expect(parseFocusViewRow({ id: 'x', boardId: 'B', facets: {} })).toBeNull(); // no name
    expect(parseFocusViewRow({ id: 'x', name: 'y', facets: {} })).toBeNull(); // no boardId
    expect(parseFocusViewRow({ id: 'x', name: 'y', boardId: 'B', facets: { tag: 'not-array' } })).toBeNull();
  });
  it('reads is_active/active as the tombstone flag (absent → live)', () => {
    expect(parseFocusViewRow({ id: 'x', name: 'y', boardId: 'B', facets: { tag: ['a'] } })?.active).toBe(true);
    expect(parseFocusViewRow({ id: 'x', name: 'y', boardId: 'B', facets: { tag: ['a'] }, is_active: false })?.active).toBe(false);
  });
  it('a malformed row never crashes the read (skipped, catalog stays alive)', () => {
    const good = makeFocusView('g', 'Good', 'B1', { tag: ['ok'] });
    const views = readFocusViews([{ payload: { kind: FOCUS_VIEW_CATALOG_KIND, views: [null, 42, good] } }], 'B1');
    expect(views.map((v) => v.id)).toEqual(['g']);
  });
});

describe('sanitizeFocusView — drop unknown facet keys before applying', () => {
  it('keeps only facet keys the board still knows (unknown key would fail closed)', () => {
    const v = makeFocusView('v', 'Mixed', 'B1', { tag: ['idea'], gone: ['old'], colorFamily: ['Blue'] });
    const cleaned = sanitizeFocusView(v, ['tag', 'colorFamily', 'kindFamily']);
    expect(cleaned.facets).toEqual({ tag: ['idea'], colorFamily: ['Blue'] }); // 'gone' dropped
  });
});

describe('buildFocusViewWriteItem — the live-write shape (round-trips into readFocusViews)', () => {
  it('addresses on the IMMUTABLE id; payload is the exact {kind,version,views} readFocusViews merges', () => {
    const v = makeFocusView('vid', 'My view', 'B1', { tag: ['idea'] });
    const item = buildFocusViewWriteItem(v);
    expect(item.address).toBe('package::group::published-record::focus-view::vid');
    expect(item.path).toEqual(['current-item', 'published-record']);
    // the built payload, read back, yields the same view (scoped to its board)
    expect(readFocusViews([{ payload: item.payload }], 'B1')).toEqual([v]);
  });

  describe('focus-view red-team — a __proto__ facet key never corrupts the accumulator (cont.98 batch-40)', () => {
    it('parseFocusViewRow keeps a `__proto__` facet key as a plain OWN property (no prototype setter)', () => {
      // JSON.parse creates an OWN __proto__ key; a plain-object accumulator would hit the setter.
      const raw = JSON.parse('{"id":"i","name":"n","boardId":"b","facets":{"__proto__":["x"],"tag":["y"]}}');
      const view = parseFocusViewRow(raw)!;
      expect(view).not.toBeNull();
      // the facets object is uncorrupted: normal prototype-less bag, both keys are OWN
      expect(Object.getPrototypeOf(view.facets)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(view.facets, '__proto__')).toBe(true);
      expect(view.facets.tag).toEqual(['y']);
      // Object.prototype was NOT polluted
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('makeFocusView / sanitizeFocusView build proto-safe facet bags', () => {
      const v = makeFocusView('i', 'n', 'b', { __proto__: ['a'], tag: ['t'] } as never);
      expect(Object.getPrototypeOf(v.facets)).toBeNull();
      const s = sanitizeFocusView(v, ['tag']);
      expect(Object.getPrototypeOf(s.facets)).toBeNull();
      expect(s.facets.tag).toEqual(['t']); // known key kept, unknown dropped
    });
  });
});
