// packages/group/read-data/arrangement-artifact.test.ts
import { describe, it, expect } from 'vitest';
import type { BoardTemplate, TemplateItem } from './board-template-apply';
import {
  resolveArtifact,
  snapshotProducer,
  facetLensProducer,
  snapshotArtifact,
  facetLensArtifact,
  axisLensProducer,
  timelineLensProducer,
  axisLensArtifact,
  timelineLensArtifact,
  AXIS_LENS_CAPABILITY,
  TIMELINE_LENS_CAPABILITY,
  SNAPSHOT_CAPABILITY,
  FACET_LENS_CAPABILITY,
  type ArrangementProducer,
} from './arrangement-artifact';

const item = (id: string, x: number, y: number, extra?: Record<string, unknown>): TemplateItem => ({ id, kind: 'note', x, y, w: 100, h: 60, extra });

const TEMPLATE: BoardTemplate = { id: 't1', name: 'Fixed', category: 'demo', items: [item('a', 5, 5), item('b', 5, 200)] };

// A tag facet over TemplateItem.extra.tags (mirrors the board's itemTags extractor shape).
const tagFacets = { tag: (i: TemplateItem) => (i.extra?.tags as string[] | undefined) ?? [] };

describe('snapshotProducer — the constant producer', () => {
  it('returns the stored template verbatim and ignores the target board', () => {
    const out = snapshotProducer(TEMPLATE, { targetItems: [item('z', 999, 999)] });
    expect(out).toBe(TEMPLATE);
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('facetLensProducer — the live-recipe producer', () => {
  it('re-clusters the TARGET board items by the named facet, keeping the same items', () => {
    const produce = facetLensProducer(tagFacets);
    const targetItems = [
      item('a', 0, 0, { tags: ['red'] }),
      item('b', 0, 0, { tags: ['blue'] }),
      item('c', 0, 0, { tags: ['red'] }),
    ];
    const out = produce({ facet: 'tag', gap: 10 }, { targetItems });
    // same items, same set of ids — only positions change
    expect(out.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    // red cluster (a,c) and blue cluster (b) are laid on different vertical bands
    const y = Object.fromEntries(out.items.map((i) => [i.id, i.y]));
    expect(y.a).toBe(y.c); // same cluster → same row band
    expect(y.b).not.toBe(y.a); // different cluster → different band
  });

  it('untagged items form the "" cluster (does not crash on keyless items)', () => {
    const produce = facetLensProducer(tagFacets);
    const out = produce({ facet: 'tag' }, { targetItems: [item('a', 0, 0), item('b', 0, 0, { tags: ['x'] })] });
    expect(out.items).toHaveLength(2);
  });

  it('throws (fail-closed) on a facet the injected map does not know', () => {
    const produce = facetLensProducer(tagFacets);
    expect(() => produce({ facet: 'nope' }, { targetItems: [] })).toThrow(/no facet extractor.*nope/);
  });
});

describe('resolveArtifact — open dispatch, no capability branch', () => {
  const producers = { [SNAPSHOT_CAPABILITY]: snapshotProducer, [FACET_LENS_CAPABILITY]: facetLensProducer(tagFacets) };

  it('resolves a snapshot artifact to its stored template', () => {
    const out = resolveArtifact(snapshotArtifact(TEMPLATE), { targetItems: [] }, producers);
    expect(out.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('resolves a facet-lens artifact by re-clustering the target board', () => {
    const targetItems = [item('a', 0, 0, { tags: ['red'] }), item('b', 0, 0, { tags: ['blue'] })];
    const out = resolveArtifact(facetLensArtifact('tag', { gap: 10 }), { targetItems }, producers);
    expect(out.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('throws (fail-closed) when the capability has no registered producer', () => {
    const orphan = facetLensArtifact('tag');
    expect(() => resolveArtifact({ ...orphan, producer: { ...orphan.producer, capability: 'ghost' } }, { targetItems: [] }, producers)).toThrow(/no arrangement producer.*ghost/);
  });

  it('L090 emergence: a NEW producer resolves with ZERO resolver change (injected map)', () => {
    // A custom producer nobody coded into the resolver — e.g. "always one row".
    const rowProducer: ArrangementProducer = (_input, ctx) => ({
      id: 'row', name: 'One row', items: ctx.targetItems.map((it, i) => ({ ...it, x: i * 120, y: 0 })),
    });
    const artifact = { id: 'x', name: 'Row lens', producer: { capability: 'one-row', input: {} } };
    const out = resolveArtifact(artifact, { targetItems: [item('a', 9, 9), item('b', 9, 9)] }, { 'one-row': rowProducer });
    expect(out.items.map((i) => i.y)).toEqual([0, 0]);
    expect(out.items.map((i) => i.x)).toEqual([0, 120]);
  });
});

describe('artifact constructors', () => {
  it('snapshotArtifact wraps a template under the snapshot capability', () => {
    const a = snapshotArtifact(TEMPLATE);
    expect(a.producer.capability).toBe(SNAPSHOT_CAPABILITY);
    expect(a.producer.input).toBe(TEMPLATE);
    expect(a.name).toBe('Fixed');
  });

  it('facetLensArtifact carries the facet as serialisable DATA (persistable row)', () => {
    const a = facetLensArtifact('tag', { name: 'By tag' });
    expect(a.producer.capability).toBe(FACET_LENS_CAPABILITY);
    expect(a.producer.input).toMatchObject({ facet: 'tag', name: 'By tag' });
    expect(JSON.parse(JSON.stringify(a))).toEqual(a); // fully serialisable
  });
});

describe('axisLensProducer — save a scatter/timeline as a reusable lens (§9.4)', () => {
  // Numeric fields as DATA (the continuous analog of the facet map): size = area, len = text length.
  const numFields: NumericFields = {
    size: (i: TemplateItem) => i.w * i.h,
    len: (i: TemplateItem) => (typeof i.text === 'string' ? i.text.length : null),
  };
  const ctx = {
    targetItems: [
      { id: 'small', kind: 'note', x: 0, y: 0, w: 40, h: 40, text: 'hi' },
      { id: 'big', kind: 'note', x: 0, y: 0, w: 200, h: 120, text: 'a much longer note' },
    ] as TemplateItem[],
  };

  it('1-D lens re-plots the CURRENT board by a numeric field (bigger area → further along X)', () => {
    const produce = axisLensProducer(numFields);
    const tpl = produce({ xField: 'size' }, ctx);
    const by = Object.fromEntries(tpl.items.map((i) => [i.id, i]));
    expect(by.big.x).toBeGreaterThan(by.small.x); // larger size plotted further right
    expect(tpl.items.map((i) => i.id).sort()).toEqual(['big', 'small']); // same items, re-placed
  });

  it('2-D scatter lens (xField + yField) resolves through the registered producer', () => {
    const tpl = axisLensProducer(numFields)({ xField: 'size', yField: 'len' }, ctx);
    expect(tpl.items).toHaveLength(2);
    for (const i of tpl.items) expect(Number.isFinite(i.x) && Number.isFinite(i.y)).toBe(true);
  });

  it('resolveArtifact dispatches an axis-lens artifact via the capability map', () => {
    const artifact = axisLensArtifact('size');
    const tpl = resolveArtifact(artifact, ctx, { [AXIS_LENS_CAPABILITY]: axisLensProducer(numFields) });
    expect(tpl.items).toHaveLength(2);
    expect(artifact.producer.capability).toBe(AXIS_LENS_CAPABILITY);
  });

  it('unknown numeric field → hard named error (fail-closed, no silent mis-placement)', () => {
    expect(() => axisLensProducer(numFields)({ xField: 'nope' }, ctx)).toThrow(/no numeric field/);
  });
});

describe('timelineLensProducer — save a roadmap as a reusable lens (§9.5)', () => {
  const numFields: NumericFields = { size: (i: TemplateItem) => i.w * i.h };
  const laneFacets = { kind: (i: TemplateItem) => i.kind };
  const ctx = {
    targetItems: [
      { id: 'n1', kind: 'note', x: 0, y: 0, w: 60, h: 40 },
      { id: 'n2', kind: 'note', x: 0, y: 0, w: 120, h: 40 },
      { id: 'f1', kind: 'frame', x: 0, y: 0, w: 80, h: 40 },
    ] as TemplateItem[],
  };

  it('roadmap lens lays cards by value within their lane band (notes vs frames separate on Y)', () => {
    const tpl = timelineLensProducer(numFields, laneFacets)({ xField: 'size', laneField: 'kind' }, ctx);
    const by = Object.fromEntries(tpl.items.map((i) => [i.id, i]));
    expect(by.n1.y).toBe(by.n2.y); // same lane (note) → same band
    expect(by.f1.y).not.toBe(by.n1.y); // different lane (frame) → different band
    expect(by.n1.x).toBeLessThan(by.n2.x); // within the note lane, smaller size is further left
  });

  it('resolveArtifact dispatches a timeline-lens artifact; unknown lane → fail-closed', () => {
    const tpl = resolveArtifact(timelineLensArtifact('size', 'kind'), ctx, { [TIMELINE_LENS_CAPABILITY]: timelineLensProducer(numFields, laneFacets) });
    expect(tpl.items).toHaveLength(3);
    expect(() => timelineLensProducer(numFields, laneFacets)({ xField: 'size', laneField: 'nope' }, ctx)).toThrow(/no facet extractor/);
  });
});

describe('facetLensProducer — a malformed gap in the untrusted DATA config never poisons positions (cont.98 batch-7)', () => {
  // `cfg` is untrusted DATA (a saved-lens config, typed unknown): `cfg.gap ?? 24` misses a NaN, which
  // would flow as colGap/rowGap/clusterGap and NaN every placed x/y. finiteness-guarded → fail-closed.
  it('NaN gap falls back to the default — every placed item has finite x/y', () => {
    const produce = facetLensProducer(tagFacets);
    const out = produce(
      { facet: 'tag', gap: NaN } as never,
      { targetItems: [item('a', 0, 0, { tags: ['x'] }), item('b', 0, 0, { tags: ['x'] })] },
    );
    for (const it of out.items) expect(Number.isFinite(it.x) && Number.isFinite(it.y)).toBe(true);
  });
});

describe('arrangement-artifact — prototype-key dispatch fails CLOSED, not into a phantom Object (cont.98 batch-22)', () => {
  // The capability / facet / numeric-field KEY is UNTRUSTED DATA (it flows from a persisted/imported
  // artifact's producer.capability / producer.input.*, parsed from the arrangement-lens-catalog records
  // via lensRowFromSpec). A plain map[key] INHERITS from Object.prototype, so 'constructor' would resolve
  // to the Object constructor — a truthy value that SKIPS the fail-closed "no X registered" error and
  // becomes a phantom producer/extractor (mis-clustering every item), and '__proto__' would resolve to a
  // non-callable object. The own-property guard makes every prototype-named key ABSENT → the named error.
  const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  const targetItems = [item('a', 0, 0, { tags: ['x'] }), item('b', 0, 0, { tags: ['y'] })];

  it('resolveArtifact: a prototype-named capability throws the named error, never returns a phantom template', () => {
    const producers: Record<string, ArrangementProducer> = { [SNAPSHOT_CAPABILITY]: snapshotProducer };
    for (const cap of PROTO_KEYS) {
      const artifact = { id: 'x', name: 'x', producer: { capability: cap, input: { id: 'fake', name: 'Fake', items: [] } } };
      expect(() => resolveArtifact(artifact, { targetItems: [] }, producers)).toThrow(/no arrangement producer registered/);
    }
    // a real registered capability still resolves (no false negative)
    const ok = resolveArtifact(snapshotArtifact(TEMPLATE), { targetItems: [] }, producers);
    expect(ok).toBe(TEMPLATE);
  });

  it('facetLensProducer: a prototype-named facet throws instead of piling every item into the "" cluster', () => {
    const produce = facetLensProducer(tagFacets);
    for (const facet of PROTO_KEYS) {
      expect(() => produce({ facet }, { targetItems })).toThrow(/no facet extractor registered/);
    }
    // the real facet still clusters
    expect(() => produce({ facet: 'tag' }, { targetItems })).not.toThrow();
  });

  it('axisLensProducer: a prototype-named xField/yField throws instead of parking every item in the no-value pile', () => {
    const produce = axisLensProducer({ size: (i) => i.w * i.h });
    for (const field of PROTO_KEYS) {
      expect(() => produce({ xField: field }, { targetItems })).toThrow(/no numeric field registered/);
      expect(() => produce({ xField: 'size', yField: field }, { targetItems })).toThrow(/no numeric field registered/);
    }
    expect(() => produce({ xField: 'size' }, { targetItems })).not.toThrow();
  });

  it('timelineLensProducer: a prototype-named laneField/xField throws instead of dumping all cards into one lane', () => {
    const produce = timelineLensProducer({ size: (i) => i.w * i.h }, tagFacets);
    for (const field of PROTO_KEYS) {
      expect(() => produce({ xField: 'size', laneField: field }, { targetItems })).toThrow(/no facet extractor registered/);
      expect(() => produce({ xField: field, laneField: 'tag' }, { targetItems })).toThrow(/no numeric field registered/);
    }
    expect(() => produce({ xField: 'size', laneField: 'tag' }, { targetItems })).not.toThrow();
  });
});
