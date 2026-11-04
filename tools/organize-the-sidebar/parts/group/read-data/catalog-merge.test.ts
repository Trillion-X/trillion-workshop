// packages/group/read-data/catalog-merge.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { mergeCatalog, parseRows, type CatalogMergeSpec } from '../../../read-data/catalog-merge.ts';

// A catalog type this leaf NEVER heard of — the L069 deletion test: the primitive must work
// for an arbitrary row shape configured purely by DATA, with ZERO change to mergeCatalog.
interface Widget { readonly id: string; readonly label: string; readonly weight?: number }
const WIDGET_SPEC: CatalogMergeSpec<Widget> = {
  kind: 'widget-catalog',
  arrayKey: 'widgets',
  idOf: (w) => w.id,
  parseRow: (row) =>
    typeof row.id === 'string' && typeof row.label === 'string'
      ? { id: row.id, label: row.label, ...(typeof row.weight === 'number' ? { weight: row.weight } : {}) }
      : null,
  builtins: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
};
const rec = (kind: string, key: string, rows: unknown) => ({ payload: { kind, [key]: rows } });

describe('mergeCatalog — the generic board-catalog DATA merge primitive', () => {
  it('returns built-ins verbatim when no DATA rows exist', () => {
    expect(mergeCatalog([], WIDGET_SPEC).map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('APPENDS a new DATA row (built-ins first, new after)', () => {
    const cat = mergeCatalog([rec('widget-catalog', 'widgets', [{ id: 'c', label: 'C', weight: 3 }])], WIDGET_SPEC);
    expect(cat.map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(cat[2].weight).toBe(3);
  });

  it('OVERRIDES a built-in by id IN PLACE (order preserved)', () => {
    const cat = mergeCatalog([rec('widget-catalog', 'widgets', [{ id: 'a', label: 'A-prime' }])], WIDGET_SPEC);
    expect(cat.map((w) => w.id)).toEqual(['a', 'b']); // no reorder, no growth
    expect(cat[0].label).toBe('A-prime');
  });

  it('skips malformed rows and non-matching record kinds (never throws)', () => {
    const cat = mergeCatalog(
      [
        rec('other-kind', 'widgets', [{ id: 'x', label: 'X' }]), // wrong kind
        rec('widget-catalog', 'widgets', [{ label: 'no id' }, { id: 'ok', label: 'Ok' }]),
      ],
      WIDGET_SPEC,
    );
    expect(cat.map((w) => w.id)).toEqual(['a', 'b', 'ok']);
  });

  it('supports a purely-DATA catalog (no builtins)', () => {
    const spec: CatalogMergeSpec<Widget> = { ...WIDGET_SPEC, builtins: undefined };
    expect(mergeCatalog([rec('widget-catalog', 'widgets', [{ id: 'z', label: 'Z' }])], spec).map((w) => w.id)).toEqual(['z']);
  });

  it('later DATA rows override earlier DATA rows (last write wins)', () => {
    const cat = mergeCatalog(
      [
        rec('widget-catalog', 'widgets', [{ id: 'c', label: 'first' }]),
        rec('widget-catalog', 'widgets', [{ id: 'c', label: 'second' }]),
      ],
      WIDGET_SPEC,
    );
    expect(cat.find((w) => w.id === 'c')?.label).toBe('second');
  });

  // ── Adversarial: untrusted DATA must never crash the whole catalog (fail-safe, L083) ──

  it('a stray null / primitive row is skipped, the rest of the catalog still loads', () => {
    // A naive parseRow that does `row.id` would throw on `null` → without the guard this wipes
    // every built-in. The primitive must survive it and keep the good rows.
    const cat = mergeCatalog(
      [rec('widget-catalog', 'widgets', [null, 'nope', 42, { id: 'c', label: 'C' }])],
      WIDGET_SPEC,
    );
    expect(cat.map((w) => w.id)).toEqual(['a', 'b', 'c']); // builtins + the one good row
  });

  it('a THROWING parseRow skips only that row — the catalog stays alive', () => {
    const boomOnBad: CatalogMergeSpec<Widget> = {
      ...WIDGET_SPEC,
      parseRow: (row) => {
        if (row.explode) throw new Error('boom'); // a hostile/naive row handler
        return typeof row.id === 'string' && typeof row.label === 'string' ? { id: row.id, label: row.label } : null;
      },
    };
    const cat = mergeCatalog(
      [rec('widget-catalog', 'widgets', [{ explode: true }, { id: 'c', label: 'C' }])],
      boomOnBad,
    );
    expect(cat.map((w) => w.id)).toEqual(['a', 'b', 'c']); // the throwing row is skipped, not fatal
  });

  it('arrayKey present but not an array (null / object / string) → record ignored, no throw', () => {
    for (const bad of [null, {}, 'x', 5]) {
      expect(mergeCatalog([rec('widget-catalog', 'widgets', bad)], WIDGET_SPEC).map((w) => w.id)).toEqual(['a', 'b']);
    }
  });

  it('a record with no payload / null payload is ignored', () => {
    expect(mergeCatalog([{ payload: undefined }, { payload: null } as never], WIDGET_SPEC).map((w) => w.id)).toEqual(['a', 'b']);
  });
});

describe('parseRows — the shared fail-safe untrusted-row parser (L063 one owner, L083 fail-safe)', () => {
  const toId = (row: Record<string, unknown>): string | null => (typeof row.id === 'string' ? row.id : null);

  it('non-array input → [] (no throw)', () => {
    for (const bad of [null, undefined, {}, 'x', 5]) expect(parseRows(bad, toId)).toEqual([]);
  });

  it('skips non-object rows (null / primitive) and keeps the good ones', () => {
    expect(parseRows([null, 'nope', 3, { id: 'a' }, undefined, { id: 'b' }], toId)).toEqual(['a', 'b']);
  });

  it('a THROWING parseRow skips only that row, never crashes the read', () => {
    const rows = [{ id: 'a' }, { boom: true }, { id: 'b' }];
    const parsed = parseRows(rows, (r) => {
      if (r.boom) throw new Error('boom');
      return typeof r.id === 'string' ? r.id : null;
    });
    expect(parsed).toEqual(['a', 'b']);
  });

  it('rows that parseRow rejects (returns null) are dropped', () => {
    expect(parseRows([{ id: 'a' }, { nope: 1 }], toId)).toEqual(['a']);
  });
});

describe('null-envelope safety (cont.98 batch-13)', () => {
  const rows = { payload: { kind: 'widget-catalog', widgets: [{ id: 'z', label: 'Z' }] } };
  it('a null / malformed record entry is skipped, never crashes mergeCatalog', () => {
    expect(() => mergeCatalog([null as never, rows] as never, WIDGET_SPEC)).not.toThrow();
    expect(mergeCatalog([null as never, rows] as never, WIDGET_SPEC).map((w) => w.id)).toContain('z');
  });
});
