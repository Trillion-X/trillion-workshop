// packages/group/do-work/__tests__/apply-grouping-intent.test.ts
//
// Uses node:test rather than vitest deliberately. This module imports only a
// TYPE from its sibling, and a type import is erased entirely by Node's type
// stripping, so the whole file runs under `node --test` with no bundler, no
// alias resolver and no config. That keeps the proof reachable through the
// declared-process path instead of a bespoke runner.
//
// Run: node --test <absolute path to this file>

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGroupingIntent } from '../../../../do-work/apply-grouping-intent.ts';

type Rec = {
  node_id: string;
  parent_id: string | null;
  ordinal: number | null;
  role: string | null;
  title: string;
  external_identity: string | null;
  attributes: Record<string, unknown>;
};

const record = (
  node_id: string,
  title: string,
  role: string,
  parent_id: string | null,
  ordinal: number | null = 0,
): Rec => ({
  node_id, parent_id, ordinal, role, title,
  external_identity: null, attributes: {},
});

/** Root container, three flat folders, one tab. The real shape, in miniature. */
const tree = (): Rec[] => [
  record('root', '', 'container', null, null),
  record('ui inspo', 'ui inspo', 'group', 'root', 0),
  record('ui libraries', 'ui libraries', 'group', 'root', 1),
  record('systems book', 'systems book', 'group', 'root', 2),
  record('t1', 'a tab', 'leaf', 'ui inspo', 0),
];

const mint = (title: string) => `minted:${title}`;

test('nests named folders under a parent that is created because it is absent', () => {
  const result = applyGroupingIntent(
    tree() as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['ui inspo', 'ui libraries'] }],
    },
    mint,
  );

  assert.deepEqual(result.created, ['minted:ui']);
  assert.deepEqual([...result.moved].sort(), ['ui inspo', 'ui libraries']);
  assert.deepEqual(result.refusals, []);

  const byId = new Map(result.records.map((r) => [r.node_id, r]));
  assert.equal(byId.get('ui inspo')!.parent_id, 'minted:ui');
  assert.equal(byId.get('ui libraries')!.parent_id, 'minted:ui');
  // A3: everything not named is untouched.
  assert.equal(byId.get('systems book')!.parent_id, 'root');
  assert.equal(byId.get('t1')!.parent_id, 'ui inspo');
});

test('the created parent carries an explicit materialize spec (A4)', () => {
  const result = applyGroupingIntent(
    tree() as never,
    {
      scope: { root_node_id: 'root' },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['ui inspo'] }],
    },
    mint,
  );
  const created = result.records.find((r) => r.node_id === 'minted:ui') as
    Rec & { materialize?: { kind: string } };
  assert.deepEqual(created.materialize, { kind: 'list' });
  assert.equal(created.role, 'group');
  assert.equal(created.title, 'ui');
});

test('refuses to invent a parent when the intent did not declare creation', () => {
  const result = applyGroupingIntent(
    tree() as never,
    { nest: [{ parent_title: 'ui', child_titles: ['ui inspo'] }] },
    mint,
  );
  assert.equal(result.created.length, 0);
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'parent_absent_and_creation_not_declared');
});

test('an ambiguous child title is refused, never guessed (A2)', () => {
  const records = [...tree(), record('dup', 'ui inspo', 'group', 'root', 3)];
  const result = applyGroupingIntent(
    records as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['ui inspo'] }],
    },
    mint,
  );
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'child_title_is_ambiguous');
});

test('one bad row does not stop the good rows in the same intent', () => {
  const result = applyGroupingIntent(
    tree() as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [
        { parent_title: 'ui', child_titles: ['ui inspo', 'does not exist'] },
      ],
    },
    mint,
  );
  assert.deepEqual(result.moved, ['ui inspo']);
  assert.equal(result.refusals[0].reason, 'child_title_not_found');
});

test('a title outside the declared scope is refused rather than moved', () => {
  const records = [
    ...tree(),
    record('other-root', '', 'container', null, null),
    record('elsewhere', 'ui inspo x', 'group', 'other-root', 0),
  ];
  const result = applyGroupingIntent(
    records as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['ui inspo x'] }],
    },
    mint,
  );
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'child_is_not_in_scope');
});

test('nesting a group under its own descendant is refused (A5)', () => {
  const records = [
    record('root', '', 'container', null, null),
    record('outer', 'outer', 'group', 'root', 0),
    record('inner', 'inner', 'group', 'outer', 0),
  ];
  const result = applyGroupingIntent(
    records as never,
    { nest: [{ parent_title: 'inner', child_titles: ['outer'] }] },
    mint,
  );
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals.some((r) => r.reason === 'would_create_a_cycle'), true);
});

test('an unused created parent is dropped rather than left as an empty folder', () => {
  const result = applyGroupingIntent(
    tree() as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['nothing matches this'] }],
    },
    mint,
  );
  assert.equal(result.created.length, 0);
  assert.equal(result.records.some((r) => r.node_id === 'minted:ui'), false);
});

test('applying the same intent twice changes nothing the second time', () => {
  const intent = {
    scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
    materialize_missing_parents: { kind: 'list' as const },
    nest: [{ parent_title: 'ui', child_titles: ['ui inspo', 'ui libraries'] }],
  };
  const once = applyGroupingIntent(tree() as never, intent, mint);
  const twice = applyGroupingIntent(once.records, intent, mint);
  assert.deepEqual(twice.moved, []);
  assert.equal(twice.created.length, 0);
});

test('record count never shrinks, so nothing is silently dropped', () => {
  const before = tree();
  const result = applyGroupingIntent(
    before as never,
    {
      scope: { root_node_id: 'root', applies_to_role: 'group', depth: 1 },
      materialize_missing_parents: { kind: 'list' },
      nest: [{ parent_title: 'ui', child_titles: ['ui inspo'] }],
    },
    mint,
  );
  assert.ok(result.records.length >= before.length);
  for (const original of before) {
    assert.ok(result.records.some((r) => r.node_id === original.node_id));
  }
});
