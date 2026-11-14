// packages/group/read-data/relation-kind-catalog.test.ts
//
// Proof of the relation-kind catalog resolvers, focused on `connectorLabelOf` — the ONE display-label
// resolver the live layer (buildConnectorModels) and the SVG export (board-svg) share, so a typed
// relationship's midpoint label is identical on screen and in the export (live == export, ML085).

import { describe, expect, it } from 'vitest';
import { relationKindSpec, connectorLabelOf, DEFAULT_RELATION_KINDS } from './relation-kind-catalog';

describe('relationKindSpec', () => {
  it('resolves a built-in kind to its spec', () => {
    expect(relationKindSpec('depends-on').label).toBe('depends on');
    expect(relationKindSpec('blocks').color).toBe('#e5484d');
  });
  it('an unknown kind falls back to a de-slugged generic spec (never fails, L083)', () => {
    expect(relationKindSpec('waits_for-thing').label).toBe('waits for thing');
  });
  it('honors an injected catalog override', () => {
    const custom = { ...DEFAULT_RELATION_KINDS, 'depends-on': { id: 'depends-on', label: 'needs', color: '#000000' } };
    expect(relationKindSpec('depends-on', custom).label).toBe('needs');
  });
});

describe('connectorLabelOf — the shared live==export label resolver', () => {
  it('an explicit extra.label ALWAYS wins', () => {
    expect(connectorLabelOf({ label: 'leads to', relationKind: 'depends-on' })).toBe('leads to');
    expect(connectorLabelOf({ label: 'custom' })).toBe('custom');
  });

  it('a relationKind (no explicit label) resolves to that kind\'s catalog label', () => {
    expect(connectorLabelOf({ relationKind: 'depends-on' })).toBe('depends on');
    expect(connectorLabelOf({ relationKind: 'blocks' })).toBe('blocks');
  });

  it('an unknown relationKind de-slugs (via relationKindSpec fallback)', () => {
    expect(connectorLabelOf({ relationKind: 'waits-for' })).toBe('waits for');
  });

  it('an explicit EMPTY label suppresses the label even with a relationKind (consistent live+export)', () => {
    expect(connectorLabelOf({ label: '', relationKind: 'depends-on' })).toBe('');
  });

  it('no label and no relationKind → undefined (a bare line)', () => {
    expect(connectorLabelOf({})).toBeUndefined();
    expect(connectorLabelOf(undefined)).toBeUndefined();
    expect(connectorLabelOf({ relationKind: '' })).toBeUndefined(); // empty kind is not a kind
  });

  it('honors an injected catalog (a product-defined relationship label)', () => {
    const custom = { ...DEFAULT_RELATION_KINDS, mentors: { id: 'mentors', label: 'mentors', color: '#123456' } };
    expect(connectorLabelOf({ relationKind: 'mentors' }, custom)).toBe('mentors');
  });
});

describe('prototype-key relation kind falls through to the generic fallback (cont.98 batch-16)', () => {
  it("'__proto__'/'constructor' resolve to a generic labelled spec, not a bogus proto object", () => {
    const s = relationKindSpec('__proto__');
    expect(s.id).toBe('__proto__');
    expect(typeof s.color).toBe('string');
    expect(s.arrow).toBe('end');
    expect(relationKindSpec('constructor').color).toBe('#8b8f98');
    // connectorLabelOf now returns the generic label (was: undefined — the fallback was skipped).
    expect(connectorLabelOf({ relationKind: '__proto__' })).toBe('  proto  ');
  });
  it('a real kind still resolves (zero regression)', () => {
    expect(relationKindSpec('blocks').label).toBe('blocks');
    expect(relationKindSpec('depends-on').color).toBe('#3b6fe0');
  });
});
