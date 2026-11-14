// packages/group/show/connector-models.test.ts
//
// Pure proof of the connector-model derivation. connectorEndpoints partitions
// items by SHAPE (extra.from/toMemberId), and buildConnectorModels reads each
// connector's self-describing DATA with fail-soft guards + suppresses hidden lines.

import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { connectorEndpoints, buildConnectorModels } from './connector-models';

function base(memberId: string, extra: Record<string, unknown>): BoardItem {
  return {
    memberId,
    nodeRef: { family: 'group.board-item', parts: { board: 'b', item: memberId } },
    kind: 'note',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    isSection: false,
    childCount: 0,
    extra,
  };
}
const conn = (memberId: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  base(memberId, { fromMemberId: from, toMemberId: to, ...extra });

describe('connectorEndpoints — self-describing connector predicate', () => {
  it('reads both endpoint ids when present', () => {
    expect(connectorEndpoints(conn('c', 'a', 'b'))).toEqual({ from: 'a', to: 'b' });
  });
  it('a plain note (no endpoint DATA) is NOT a connector → null', () => {
    expect(connectorEndpoints(base('n', {}))).toBeNull();
  });
  it('a half-specified / malformed connector → null (both ids must be strings)', () => {
    expect(connectorEndpoints(base('c', { fromMemberId: 'a' }))).toBeNull();
    expect(connectorEndpoints(base('c', { fromMemberId: 'a', toMemberId: 5 }))).toBeNull();
  });
});

describe('buildConnectorModels — DATA fold with fail-soft guards', () => {
  const opts = { selectedIds: new Set<string>(), hiddenIds: new Set<string>(), showHidden: false };

  it('maps endpoints + selection, defaulting every optional facet to undefined', () => {
    const [m] = buildConnectorModels([conn('c', 'a', 'b')], { ...opts, selectedIds: new Set(['c']) });
    expect(m).toEqual({
      memberId: 'c',
      fromMemberId: 'a',
      toMemberId: 'b',
      selected: true,
      label: undefined,
      color: undefined,
      dashed: false,
      arrow: undefined,
      routing: undefined,
      thickness: undefined,
      waypoints: [],
      fromAnchor: undefined,
      toAnchor: undefined,
    });
  });

  it('reads valid style DATA and rejects invalid enum values (fail-soft → undefined)', () => {
    const [ok] = buildConnectorModels(
      [conn('c', 'a', 'b', { label: 'likes', color: '#f00', dashed: true, arrow: 'both', routing: 'elbow' })],
      opts,
    );
    expect(ok).toMatchObject({ label: 'likes', color: '#f00', dashed: true, arrow: 'both', routing: 'elbow' });
    // Fail-soft to undefined: `arrow: 'end'` is the closed-enum default (the arrow guard
    // only stores the non-default 'both'/'none'); a non-string `routing` and non-string
    // color/label are malformed → left unset. (A non-empty routing STRING is now passed
    // through — the algorithm map is open — proven in the L090 test below.)
    const [bad] = buildConnectorModels(
      [conn('c', 'a', 'b', { arrow: 'end', routing: 99, color: 42, label: 7 })],
      opts,
    );
    expect(bad.arrow).toBeUndefined();
    expect(bad.routing).toBeUndefined();
    expect(bad.color).toBeUndefined();
    expect(bad.label).toBeUndefined();
  });

  it('reads {nx,ny} fixed-port anchors and ignores malformed ones', () => {
    const [m] = buildConnectorModels(
      [conn('c', 'a', 'b', { fromAnchor: { nx: 0.5, ny: 0 }, toAnchor: { nx: 'x' } })],
      opts,
    );
    expect(m.fromAnchor).toEqual({ nx: 0.5, ny: 0 });
    expect(m.toAnchor).toBeUndefined();
  });

  it('reads routing:"waypoints" + the ordered bend list, dropping malformed bends (#194)', () => {
    const [m] = buildConnectorModels(
      [
        conn('c', 'a', 'b', {
          routing: 'waypoints',
          waypoints: [{ x: 10, y: 20 }, { x: 'bad', y: 1 }, { x: 30, y: 40 }],
        }),
      ],
      opts,
    );
    expect(m.routing).toBe('waypoints');
    expect(m.waypoints).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  it('absent waypoints DATA reads as an empty bend list (clean straight line)', () => {
    const [m] = buildConnectorModels([conn('c', 'a', 'b')], opts);
    expect(m.waypoints).toEqual([]);
  });

  it('reads a positive numeric thickness, rejecting non-positive / non-finite / non-number (#197)', () => {
    const [ok] = buildConnectorModels([conn('c', 'a', 'b', { thickness: 4 })], opts);
    expect(ok.thickness).toBe(4);
    // A fractional weight is equally valid — it's a free number, not a preset enum.
    const [frac] = buildConnectorModels([conn('d', 'a', 'b', { thickness: 2.5 })], opts);
    expect(frac.thickness).toBe(2.5);
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
      const [m] = buildConnectorModels([conn('e', 'a', 'b', { thickness: bad })], opts);
      expect(m.thickness).toBeUndefined();
    }
  });

  it('passes ANY non-empty routing name straight through — the algorithm map is OPEN (L090/enum-dissolution)', () => {
    // A routing algorithm a composition root registers (never shipped by core) must
    // reach the open dispatcher, not be silently narrowed to straight at this fold.
    const [m] = buildConnectorModels([conn('c', 'a', 'b', { routing: 'orthogonal-rounded' })], opts);
    expect(m.routing).toBe('orthogonal-rounded');
    // A non-string / empty routing is still cleanly "no override" (undefined).
    const [bad] = buildConnectorModels([conn('d', 'a', 'b', { routing: 42 })], opts);
    expect(bad.routing).toBeUndefined();
    const [empty] = buildConnectorModels([conn('e', 'a', 'b', { routing: '' })], opts);
    expect(empty.routing).toBeUndefined();
  });

  it('suppresses a connector touching a hidden endpoint — unless showHidden', () => {
    const items = [conn('c', 'a', 'b')];
    const hiddenIds = new Set(['b']);
    expect(buildConnectorModels(items, { ...opts, hiddenIds })).toHaveLength(0);
    expect(buildConnectorModels(items, { ...opts, hiddenIds, showHidden: true })).toHaveLength(1);
  });

  it('keeps connectors whose both endpoints are visible', () => {
    expect(buildConnectorModels([conn('c', 'a', 'b')], { ...opts, hiddenIds: new Set(['z']) })).toHaveLength(1);
  });

  it('suppresses a connector by its OWN hidden flag — so Hide/Show works on a line (both endpoints visible)', () => {
    const items = [conn('c', 'a', 'b')]; // a and b are NOT hidden — only the connector itself is
    const hiddenIds = new Set(['c']);
    expect(buildConnectorModels(items, { ...opts, hiddenIds })).toHaveLength(0); // the line hides
    expect(buildConnectorModels(items, { ...opts, hiddenIds, showHidden: true })).toHaveLength(1); // reveal shows it
  });
});

describe('buildConnectorModels — R9 typed relationships drive the line look', () => {
  const opts = { selectedIds: new Set<string>(), hiddenIds: new Set<string>(), showHidden: false };

  it('relationKind supplies default colour + label + arrow from the catalog', () => {
    const [dep] = buildConnectorModels([conn('c', 'a', 'b', { relationKind: 'depends-on' })], opts);
    expect(dep.color).toBe('#3b6fe0');
    expect(dep.label).toBe('depends on');
    // depends-on arrow is 'end' → left undefined (renderer default), never mislabeled
    expect(dep.arrow).toBeUndefined();

    const [blk] = buildConnectorModels([conn('c', 'a', 'b', { relationKind: 'blocks' })], opts);
    expect(blk.color).toBe('#e5484d');
    expect(blk.label).toBe('blocks');
  });

  it('explicit extra.color / label / arrow always win over the catalog', () => {
    const [m] = buildConnectorModels(
      [conn('c', 'a', 'b', { relationKind: 'depends-on', color: '#000', label: 'my label', arrow: 'both' })],
      opts,
    );
    expect(m.color).toBe('#000');
    expect(m.label).toBe('my label');
    expect(m.arrow).toBe('both');
  });

  it('an unknown relationKind falls back to a generic labelled spec (never throws)', () => {
    const [m] = buildConnectorModels([conn('c', 'a', 'b', { relationKind: 'supersedes' })], opts);
    expect(m.label).toBe('supersedes');
    expect(m.color).toBe('#8b8f98');
  });

  it('zero-regression: a connector with NO relationKind is unchanged (all defaults undefined)', () => {
    const [m] = buildConnectorModels([conn('c', 'a', 'b')], opts);
    expect(m.color).toBeUndefined();
    expect(m.label).toBeUndefined();
    expect(m.arrow).toBeUndefined();
  });

  it('honours an injected relationCatalog (L090)', () => {
    const [m] = buildConnectorModels([conn('c', 'a', 'b', { relationKind: 'mentors' })], {
      ...opts,
      relationCatalog: { mentors: { id: 'mentors', label: 'mentors', color: '#123456' } },
    });
    expect(m.color).toBe('#123456');
    expect(m.label).toBe('mentors');
  });
});

describe('connector roughness rejects a non-finite value (cont.98 batch-16)', () => {
  const opts = { selectedIds: new Set<string>(), hiddenIds: new Set<string>(), showHidden: true };
  it('Infinity roughness -> undefined (matches the bowing/thickness finite guards)', () => {
    expect(buildConnectorModels([conn('c', 'a', 'b', { roughness: Infinity })], opts)[0].roughness).toBeUndefined();
    expect(buildConnectorModels([conn('c2', 'a', 'b', { roughness: 1.5 })], opts)[0].roughness).toBe(1.5);
  });
});
