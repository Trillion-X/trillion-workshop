// packages/group/do-work/group-from-containment-projection.test.ts
//
// The point of these is that the bridge COMPOSES the ontology rather than
// hand-building JSON that looks like a graph. Every invariant asserted here is
// enforced by group-graph itself; the bridge earns them by going through
// ensureGroup and addMember instead of around them.

import { describe, expect, it } from 'vitest';
import { groupGraphFromContainment, type ContainmentRecord } from 'trillion-workshop/tools/organize-the-sidebar/do-work/group-from-containment-projection.ts';
import { getGroup, hasGroup, membersOf } from '../../ui/show/group/group-graph';

const FAMILY = 'tree-node';

const record = (
  node_id: string,
  parent_id: string | null,
  ordinal: number | null,
  role: string | null,
  extra: Partial<ContainmentRecord> = {},
): ContainmentRecord => ({
  node_id,
  parent_id,
  ordinal,
  role,
  title: extra.title ?? '',
  external_identity: extra.external_identity ?? null,
  attributes: extra.attributes ?? {},
});

const ref = (id: string) => ({ family: FAMILY, parts: [id] }) as never;

describe('groupGraphFromContainment', () => {
  it('creates a group for every containing node', () => {
    const result = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('a', 'g', 0, 'leaf')],
      FAMILY,
    );
    expect(hasGroup(result.graph, ref('g'))).toBe(true);
    expect(result.memberCount).toBe(1);
  });

  it('preserves sibling order from the ordinal', () => {
    const result = groupGraphFromContainment(
      [
        record('g', null, null, 'group'),
        record('c', 'g', 2, 'leaf'),
        record('a', 'g', 0, 'leaf'),
        record('b', 'g', 1, 'leaf'),
      ],
      FAMILY,
    );
    expect(getGroup(result.graph, ref('g'))?.memberOrder).toEqual(['a', 'b', 'c']);
  });

  it('nests a group inside a group by reference (I2)', () => {
    const result = groupGraphFromContainment(
      [
        record('outer', null, null, 'group'),
        record('inner', 'outer', 0, 'group'),
        record('a', 'inner', 0, 'leaf'),
      ],
      FAMILY,
    );
    expect(membersOf(result.graph, ref('outer')).map((m) => m.memberId)).toEqual(['inner']);
    expect(membersOf(result.graph, ref('inner')).map((m) => m.memberId)).toEqual(['a']);
  });

  it('places a parent before its child regardless of input order', () => {
    // The child appears FIRST. Depth ordering must still place the parent first,
    // or the nested group would be added to a group that does not exist yet.
    const result = groupGraphFromContainment(
      [
        record('a', 'inner', 0, 'leaf'),
        record('inner', 'outer', 0, 'group'),
        record('outer', null, null, 'group'),
      ],
      FAMILY,
    );
    expect(result.unplaced.filter((u) => u.reason !== 'no_parent')).toEqual([]);
    expect(membersOf(result.graph, ref('inner')).map((m) => m.memberId)).toEqual(['a']);
  });

  it('carries an opaque role verbatim, so paired needs no core support', () => {
    const result = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('s', 'g', 0, 'paired')],
      FAMILY,
    );
    expect(membersOf(result.graph, ref('g'))[0].role).toBe('paired');
  });

  it('carries an unknown role verbatim, so a new kind costs zero code', () => {
    const result = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('x', 'g', 0, 'separator')],
      FAMILY,
    );
    expect(membersOf(result.graph, ref('g'))[0].role).toBe('separator');
  });

  it('carries the verbatim address as opaque presentation', () => {
    const url = 'https://www.github.com/org/repo/pull/42?x=1';
    const result = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('a', 'g', 0, 'leaf', { external_identity: url })],
      FAMILY,
    );
    expect(membersOf(result.graph, ref('g'))[0].presentation?.external_identity).toBe(url);
  });

  it('uses the source id as the member id, never a positional one', () => {
    const result = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('SOURCE-ID', 'g', 0, 'leaf')],
      FAMILY,
    );
    expect(membersOf(result.graph, ref('g'))[0].memberId).toBe('SOURCE-ID');
  });

  it('reports a cycle instead of building an impossible graph (I4)', () => {
    // Two groups each claiming the other as a member.
    const result = groupGraphFromContainment(
      [
        record('a', 'b', 0, 'group'),
        record('b', 'a', 0, 'group'),
      ],
      FAMILY,
    );
    expect(result.unplaced.some((u) => u.reason === 'cycle')).toBe(true);
  });

  it('reports parentless records rather than dropping them', () => {
    const result = groupGraphFromContainment([record('lonely', null, null, 'leaf')], FAMILY);
    expect(result.unplaced).toEqual([
      {
        node_id: 'lonely',
        reason: 'no_parent',
        detail: 'record has no parent, so it is a root or an orphan of this tree',
      },
    ]);
  });

  it('conserves membership: every parented record is placed or reported', () => {
    const records = [
      record('g', null, null, 'group'),
      record('a', 'g', 0, 'leaf'),
      record('b', 'g', 1, 'leaf'),
      record('c', 'g', 2, 'paired'),
    ];
    const result = groupGraphFromContainment(records, FAMILY);
    const parented = records.filter((r) => r.parent_id !== null).length;
    const failed = result.unplaced.filter((u) => u.reason !== 'no_parent').length;
    expect(result.memberCount + failed).toBe(parented);
  });

  it('is pure: the base graph is never mutated', () => {
    const first = groupGraphFromContainment(
      [record('g', null, null, 'group'), record('a', 'g', 0, 'leaf')],
      FAMILY,
    );
    const before = JSON.stringify(first.graph);
    groupGraphFromContainment([record('g', null, null, 'group'), record('z', 'g', 0, 'leaf')], FAMILY, first.graph);
    expect(JSON.stringify(first.graph)).toBe(before);
  });
});
