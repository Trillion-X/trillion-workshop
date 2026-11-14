import { describe, it, expect } from 'vitest';
import {
  arrangeByField,
  arrangeByFieldWithRegions,
  arrangeColumns,
  orderedClusterKeys,
  regionLabelFor,
  regionHeadingSpecs,
  type ArrangeItem,
  type ClusterRegion,
} from './arrange-by-field';

// A square item helper so geometry math stays readable.
const item = (memberId: string, groupKey: string, w = 100, h = 100): ArrangeItem => ({
  memberId,
  groupKey,
  w,
  h,
});

const byId = (positions: { memberId: string; x: number; y: number }[]) =>
  new Map(positions.map((p) => [p.memberId, p]));

describe('arrangeByField', () => {
  it('empty input → []', () => {
    expect(arrangeByField([])).toEqual([]);
  });

  it('two groups cluster separately with the 2nd cluster below the 1st', () => {
    // Group "a": one 100-tall item at cluster top. Group "b" starts below it.
    const positions = arrangeByField(
      [item('a1', 'a'), item('b1', 'b')],
      { originX: 0, originY: 0, clusterGap: 64, maxPerRow: 4 },
    );
    const m = byId(positions);

    // Cluster "a" (sorted first) lands at the origin.
    expect(m.get('a1')).toEqual({ memberId: 'a1', x: 0, y: 0 });

    // Cluster "b" starts at originY + a's height (100) + clusterGap (64) = 164.
    expect(m.get('b1')).toEqual({ memberId: 'b1', x: 0, y: 164 });
  });

  it('wraps at maxPerRow within a cluster', () => {
    const positions = arrangeByField(
      [
        item('i1', 'g'),
        item('i2', 'g'),
        item('i3', 'g'),
      ],
      { originX: 0, originY: 0, colGap: 24, rowGap: 24, maxPerRow: 2 },
    );
    const m = byId(positions);

    // Row 0: i1 at x=0, i2 at x = 100 + 24 = 124, both y=0.
    expect(m.get('i1')).toEqual({ memberId: 'i1', x: 0, y: 0 });
    expect(m.get('i2')).toEqual({ memberId: 'i2', x: 124, y: 0 });

    // maxPerRow=2 → i3 wraps to row 1: x back to origin (0), y = rowHeight(100) + rowGap(24) = 124.
    expect(m.get('i3')).toEqual({ memberId: 'i3', x: 0, y: 124 });
  });

  it('deterministic group order regardless of input order', () => {
    // Same items, two different input orderings — clusters must sort ascending by groupKey.
    const forward = arrangeByField(
      [item('z1', 'z'), item('a1', 'a'), item('m1', 'm')],
      { clusterGap: 64 },
    );
    const shuffled = arrangeByField(
      [item('m1', 'm'), item('z1', 'z'), item('a1', 'a')],
      { clusterGap: 64 },
    );

    const yOf = (positions: { memberId: string; y: number }[], id: string) =>
      positions.find((p) => p.memberId === id)!.y;

    // "a" cluster is first (y=0), then "m", then "z" — identical for both orderings.
    for (const positions of [forward, shuffled]) {
      const yA = yOf(positions, 'a1');
      const yM = yOf(positions, 'm1');
      const yZ = yOf(positions, 'z1');
      expect(yA).toBeLessThan(yM);
      expect(yM).toBeLessThan(yZ);
    }

    // And the exact positions match between the two input orderings.
    expect(byId(forward)).toEqual(byId(shuffled));
  });

  it('respects origin and gaps', () => {
    const positions = arrangeByField(
      [
        item('a1', 'a', 50, 50),
        item('a2', 'a', 50, 50),
        item('b1', 'b', 50, 50),
      ],
      { originX: 10, originY: 20, colGap: 5, rowGap: 5, clusterGap: 30, maxPerRow: 4 },
    );
    const m = byId(positions);

    // Cluster "a" row 0: a1 at origin (10,20); a2 at x = 10 + 50 + 5 = 65, y=20.
    expect(m.get('a1')).toEqual({ memberId: 'a1', x: 10, y: 20 });
    expect(m.get('a2')).toEqual({ memberId: 'a2', x: 65, y: 20 });

    // Cluster "b" starts at originY(20) + a's height(50) + clusterGap(30) = 100, x back to originX(10).
    expect(m.get('b1')).toEqual({ memberId: 'b1', x: 10, y: 100 });
  });

  it('returns exactly one position per input memberId (same set)', () => {
    const inputs = [
      item('i1', 'b'),
      item('i2', 'a'),
      item('i3', 'a'),
      item('i4', 'c'),
      item('i5', 'b'),
    ];
    const positions = arrangeByField(inputs, { maxPerRow: 2 });

    expect(positions).toHaveLength(inputs.length);
    const outIds = positions.map((p) => p.memberId).sort();
    const inIds = inputs.map((i) => i.memberId).sort();
    expect(outIds).toEqual(inIds);
    // No duplicate memberId in output.
    expect(new Set(outIds).size).toBe(inputs.length);
  });

  it('does not mutate the input array', () => {
    const inputs = [item('a1', 'z'), item('a2', 'a')] as const;
    const snapshot = JSON.stringify(inputs);
    arrangeByField(inputs);
    expect(JSON.stringify(inputs)).toBe(snapshot);
  });

  it('is a byte-identical projection of arrangeByFieldWithRegions().positions (SSOT, zero-regression)', () => {
    const inputs = [item('i1', 'b'), item('i2', 'a'), item('i3', 'a'), item('i4', 'c', 80, 60)];
    const opts = { originX: 10, originY: 20, colGap: 5, rowGap: 5, clusterGap: 30, maxPerRow: 2 };
    expect(arrangeByField(inputs, opts)).toEqual(arrangeByFieldWithRegions(inputs, opts).positions);
  });
});

const byKey = (regions: ClusterRegion[]) => new Map(regions.map((r) => [r.key, r]));

describe('arrangeByFieldWithRegions — the cluster REGION half (which area is which group)', () => {
  it('empty input → no positions, no regions', () => {
    expect(arrangeByFieldWithRegions([])).toEqual({ positions: [], regions: [] });
  });

  it('one region per distinct groupKey, sorted ascending, with the right count', () => {
    const { regions } = arrangeByFieldWithRegions(
      [item('a1', 'a'), item('a2', 'a'), item('b1', 'b'), item('c1', 'c')],
      { maxPerRow: 4 },
    );
    expect(regions.map((r) => r.key)).toEqual(['a', 'b', 'c']); // sorted ascending
    expect(regions.map((r) => r.count)).toEqual([2, 1, 1]);
  });

  it("a region's box tightly encloses its cluster's placed items (single full row)", () => {
    // Two 100×100 items in group "a", colGap 24 → row spans x[0..224], y[0..100].
    const { regions } = arrangeByFieldWithRegions(
      [item('a1', 'a'), item('a2', 'a')],
      { originX: 0, originY: 0, colGap: 24, maxPerRow: 4 },
    );
    const r = byKey(regions).get('a')!;
    expect({ x: r.x, y: r.y, w: r.w, h: r.h }).toEqual({ x: 0, y: 0, w: 224, h: 100 });
  });

  it('a wrapped cluster box encloses the widest row (width) and both rows (height)', () => {
    // 3 items, maxPerRow 2: row0 = i1,i2 (x 0..224), row1 = i3 (x 0..100). Height = 100 + 24 + 100.
    const { regions } = arrangeByFieldWithRegions(
      [item('i1', 'g'), item('i2', 'g'), item('i3', 'g')],
      { originX: 0, originY: 0, colGap: 24, rowGap: 24, maxPerRow: 2 },
    );
    const r = byKey(regions).get('g')!;
    expect({ x: r.x, y: r.y, w: r.w, h: r.h }).toEqual({ x: 0, y: 0, w: 224, h: 224 });
  });

  it("the 2nd cluster's box starts below the 1st (clusterGap), enclosing only its own items", () => {
    const { regions } = arrangeByFieldWithRegions(
      [item('a1', 'a'), item('b1', 'b')],
      { originX: 0, originY: 0, clusterGap: 64, maxPerRow: 4 },
    );
    const b = byKey(regions).get('b')!;
    // "a" is 100 tall at y=0..100; "b" starts at 100 + clusterGap 64 = 164.
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual({ x: 0, y: 164, w: 100, h: 100 });
  });

  it('respects a non-zero origin for the first region', () => {
    const { regions } = arrangeByFieldWithRegions([item('a1', 'a', 50, 50)], { originX: 10, originY: 20 });
    expect(byKey(regions).get('a')).toEqual({ key: 'a', x: 10, y: 20, w: 50, h: 50, count: 1 });
  });

  it('the empty-key ("" no-facet) pile is its own region, sorted first', () => {
    const { regions } = arrangeByFieldWithRegions([item('x', 'tag'), item('y', '')], { clusterGap: 64 });
    expect(regions[0].key).toBe(''); // '' sorts before any non-empty key
    expect(regions[0].count).toBe(1);
  });
});

describe('arrangeByFieldWithRegions — LANE mode (kanban: explicit ordered lanes, empty lanes visible)', () => {
  it('follows laneKeys ORDER (not sorted) and gives every lane a region — even empty ones', () => {
    // "doing" has no items, but the lane still appears (a visible empty column).
    const { regions } = arrangeByFieldWithRegions(
      [item('t1', 'todo'), item('d1', 'done')],
      { laneKeys: ['todo', 'doing', 'done'], clusterGap: 40 },
    );
    expect(regions.map((r) => r.key)).toEqual(['todo', 'doing', 'done']); // given order, not alphabetical
    expect(regions.map((r) => r.count)).toEqual([1, 0, 1]);
    // the empty "doing" lane has zero height (no items) but is still a real region between the two.
    const doing = regions[1];
    expect({ key: doing.key, count: doing.count, h: doing.h }).toEqual({ key: 'doing', count: 0, h: 0 });
  });

  it('appends unlisted item keys after the lanes, sorted (nothing is ever dropped)', () => {
    const { regions } = arrangeByFieldWithRegions(
      [item('t1', 'todo'), item('z1', 'zeta'), item('a1', 'alpha')],
      { laneKeys: ['todo'] },
    );
    // 'todo' first (a lane), then the extras 'alpha','zeta' appended sorted.
    expect(regions.map((r) => r.key)).toEqual(['todo', 'alpha', 'zeta']);
  });

  it('all lanes take the UNIFORM owned-footprint width (= widest cluster) so columns align', () => {
    // "wide" cluster has two items (content width 224); "narrow" + empty "gap" get the same width.
    const { regions } = arrangeByFieldWithRegions(
      [item('w1', 'wide'), item('w2', 'wide'), item('n1', 'narrow')],
      { laneKeys: ['wide', 'gap', 'narrow'], colGap: 24, maxPerRow: 4 },
    );
    const widths = new Set(regions.map((r) => r.w));
    expect(widths.size).toBe(1); // every lane the same width
    expect([...widths][0]).toBe(224); // = the widest lane's content width
  });

  it('lane mode with NO items still yields the lanes as regions (all empty drop zones)', () => {
    const { positions, regions } = arrangeByFieldWithRegions([], { laneKeys: ['a', 'b'] });
    expect(positions).toEqual([]);
    expect(regions.map((r) => ({ key: r.key, count: r.count }))).toEqual([
      { key: 'a', count: 0 },
      { key: 'b', count: 0 },
    ]);
  });

  it('item POSITIONS in lane mode match sorted mode for the same effective order (only region.w widens)', () => {
    const items = [item('t1', 'todo'), item('t2', 'todo'), item('d1', 'zdone')];
    // laneKeys in the same order the sort would produce ('todo' < 'zdone') → identical positions.
    const lane = arrangeByFieldWithRegions(items, { laneKeys: ['todo', 'zdone'] });
    const sorted = arrangeByFieldWithRegions(items);
    expect(lane.positions).toEqual(sorted.positions);
  });
});

describe('arrangeByFieldWithRegions — headerReserve band (space for a group heading above items)', () => {
  it('headerReserve=0 (default) is byte-identical (zero regression)', () => {
    const items = [item('a1', 'a'), item('a2', 'a'), item('b1', 'b')];
    expect(arrangeByFieldWithRegions(items, { headerReserve: 0 })).toEqual(arrangeByFieldWithRegions(items));
  });

  it('pushes each cluster’s items DOWN by the reserve; the region box grows UP to include the band', () => {
    const { positions, regions } = arrangeByFieldWithRegions(
      [item('a1', 'a')],
      { originX: 0, originY: 0, headerReserve: 40 },
    );
    // Item sits below the 40px band.
    expect(positions[0]).toEqual({ memberId: 'a1', x: 0, y: 40 });
    // Region starts at the band top (y=0) and its height includes the band (40 + 100).
    expect(regions[0]).toEqual({ key: 'a', x: 0, y: 0, w: 100, h: 140, count: 1 });
  });

  it('an empty lane with a header band has height = the reserve (a visible labelled empty column)', () => {
    const { regions } = arrangeByFieldWithRegions([], { laneKeys: ['todo'], headerReserve: 30 });
    expect(regions[0]).toEqual({ key: 'todo', x: 0, y: 0, w: 0, h: 30, count: 0 });
  });

  it('the 2nd cluster clears the 1st including its band and clusterGap', () => {
    const { regions } = arrangeByFieldWithRegions(
      [item('a1', 'a'), item('b1', 'b')],
      { originX: 0, originY: 0, headerReserve: 20, clusterGap: 50 },
    );
    // "a": band 20 + item 100 → spans y[0..120]. "b" starts at 120 + 50 = 170.
    expect(regions[1].y).toBe(170);
  });
});

describe('regionHeadingSpecs — regions → placeable labelled headings', () => {
  const regions = (): ClusterRegion[] =>
    arrangeByFieldWithRegions([item('a1', 'a'), item('a2', 'a'), item('b1', 'b')], { headerReserve: 40 }).regions;

  it('one heading per region, positioned at the region band (x,y,w), with the mapped label', () => {
    const specs = regionHeadingSpecs(regions(), { labelMap: { a: 'Ideas', b: 'Done' } });
    expect(specs.map((s) => s.text)).toEqual(['Ideas', 'Done']);
    // First region (key 'a') → its band top-left + width.
    expect({ x: specs[0].x, y: specs[0].y, w: specs[0].w }).toEqual({ x: 0, y: 0, w: 224 });
  });

  it('showCount appends " · N"', () => {
    const specs = regionHeadingSpecs(regions(), { labelMap: { a: 'Ideas' }, showCount: true });
    expect(specs[0].text).toBe('Ideas · 2');
    expect(specs[1].text).toBe('b · 1'); // unmapped key renders as-is
  });

  it('carries the raw key (for idempotent heading ids) and the count', () => {
    const specs = regionHeadingSpecs(regions());
    expect(specs.map((s) => ({ key: s.key, count: s.count }))).toEqual([
      { key: 'a', count: 2 },
      { key: 'b', count: 1 },
    ]);
  });

  it('empty input → no headings', () => {
    expect(regionHeadingSpecs([])).toEqual([]);
  });
});

describe('regionLabelFor — the render-boundary key→label resolver (L090/L118 translation)', () => {
  it('a labelMap hit wins (raw key → human label)', () => {
    expect(regionLabelFor('#fde68a', { '#fde68a': 'Yellow' })).toBe('Yellow');
  });

  it('no map entry → the key renders as-is (a tag string is already human)', () => {
    expect(regionLabelFor('urgent')).toBe('urgent');
    expect(regionLabelFor('urgent', { other: 'x' })).toBe('urgent');
  });

  it('an empty/whitespace map value is treated as "no override" (falls through to the key)', () => {
    expect(regionLabelFor('urgent', { urgent: '' })).toBe('urgent');
  });

  it("the no-key pile ('') gets the emptyLabel, default 'Ungrouped', overridable", () => {
    expect(regionLabelFor('')).toBe('Ungrouped');
    expect(regionLabelFor('', {}, 'No tag')).toBe('No tag');
    expect(regionLabelFor('', { '': 'Inbox' })).toBe('Inbox'); // an explicit map entry still wins
  });
});

describe('orderedClusterKeys (shared cluster ordering)', () => {
  it('SORTED mode (no laneKeys): present keys ascending', () => {
    expect(orderedClusterKeys(['risk', 'idea', 'goal'])).toEqual(['goal', 'idea', 'risk']);
  });
  it('LANE mode: laneKeys order first (incl. absent ones), then extra present keys sorted', () => {
    // Fixed columns To do, Doing, Done — Done has no items (kept), and an extra "blocked" appends.
    expect(orderedClusterKeys(['blocked', 'doing', 'todo'], ['todo', 'doing', 'done'])).toEqual(['todo', 'doing', 'done', 'blocked']);
  });
  it('LANE mode dedups repeated laneKeys', () => {
    expect(orderedClusterKeys(['a'], ['x', 'x', 'y'])).toEqual(['x', 'y', 'a']);
  });
});

describe('arrangeColumns (kanban / columns-by-value)', () => {
  it('empty input (no lanes) → empty', () => {
    expect(arrangeColumns([])).toEqual({ positions: [], regions: [] });
  });

  it('lays each value as a VERTICAL column placed LEFT-TO-RIGHT (columns advance in x, items in y)', () => {
    // Two tags: "a" (a1,a2), "b" (b1). 100x100 items, colGap/rowGap 20, header band 0.
    const { positions, regions } = arrangeColumns(
      [item('a1', 'a'), item('a2', 'a'), item('b1', 'b')],
      { colGap: 20, rowGap: 20, headerReserve: 0, originX: 0, originY: 0 },
    );
    const p = byId(positions);
    // Column "a" at x=0: a1 at y=0, a2 stacked below at y=120 (100 + 20 gap).
    expect(p.get('a1')).toEqual({ memberId: 'a1', x: 0, y: 0 });
    expect(p.get('a2')).toEqual({ memberId: 'a2', x: 0, y: 120 });
    // Column "b" is to the RIGHT: x = columnWidth(100) + colGap(20) = 120; b1 at column top.
    expect(p.get('b1')).toEqual({ memberId: 'b1', x: 120, y: 0 });
    // Regions: one per column, uniform width 100, at their column x; "a" spans two items tall.
    expect(regions.map((r) => [r.key, r.x, r.w, r.count])).toEqual([
      ['a', 0, 100, 2],
      ['b', 120, 100, 1],
    ]);
    expect(regions[0].h).toBe(220); // a1 (100) + gap (20) + a2 (100)
  });

  it('LANE mode keeps an EMPTY column visible as a drop zone (kanban with a fixed column set)', () => {
    const { positions, regions } = arrangeColumns([item('t1', 'todo')], {
      laneKeys: ['todo', 'doing', 'done'],
      colGap: 20,
      headerReserve: 10,
    });
    expect(positions).toHaveLength(1); // only one real item
    // Three columns in laneKeys order; the two empty ones still get a region (just the header band).
    expect(regions.map((r) => r.key)).toEqual(['todo', 'doing', 'done']);
    expect(regions[1].count).toBe(0); // "doing" empty
    expect(regions[1].h).toBe(10); // just the reserved header band
    expect(regions[1].x).toBe(120); // 2nd column at columnWidth(100)+colGap(20)
  });

  it('reserves a header band: items start below it (kanban column titles sit above the cards)', () => {
    const { positions } = arrangeColumns([item('a1', 'a')], { headerReserve: 40, originY: 5 });
    expect(positions[0].y).toBe(45); // originY(5) + headerReserve(40)
  });
});

describe('arrange-by-field red-team — untrusted geometry + label hardening (cont.98 batch-31)', () => {
  // #3: a persisted MAX_VALUE / NaN item dimension keeps every position + region finite (row + column layouts).
  it('clamps MAX_VALUE / NaN item dimensions to finite positions and regions', () => {
    const items: ArrangeItem[] = [
      { memberId: 'a', w: Number.MAX_VALUE, h: Number.NaN, groupKey: 'g' },
      { memberId: 'b', w: 100, h: 100, groupKey: 'g' },
    ];
    const { positions, regions } = arrangeByFieldWithRegions(items);
    for (const p of positions) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
    for (const r of regions) { expect(Number.isFinite(r.w)).toBe(true); expect(Number.isFinite(r.h)).toBe(true); }
    const cols = arrangeColumns(items, { laneKeys: ['g'] });
    for (const p of cols.positions) expect(Number.isFinite(p.x)).toBe(true);
    for (const r of cols.regions) expect(Number.isFinite(r.w)).toBe(true);
  });

  // #6: a maxPerRow of 0 no longer shifts the first item below a phantom empty row (clamped to >= 1).
  it('a maxPerRow of 0 keeps the first item at the cluster top', () => {
    const { positions } = arrangeByFieldWithRegions([item('a', 'g'), item('b', 'g')], { maxPerRow: 0 });
    expect(positions[0].y).toBe(0); // not shifted down by a phantom row-wrap
    expect(Number.isFinite(positions[1].y)).toBe(true);
  });

  // #1: an INHERITED (non-own) string label is not leaked as a false label — own-key lookup only.
  it('regionLabelFor ignores an inherited label, returns the raw key; own keys still resolve', () => {
    const map = Object.create({ ghost: 'INHERITED' }) as Record<string, string>;
    expect(regionLabelFor('ghost', map)).toBe('ghost'); // inherited 'INHERITED' is NOT used
    map.real = 'Real Label';
    expect(regionLabelFor('real', map)).toBe('Real Label'); // own key resolves normally
  });
});
