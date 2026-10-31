// A tree as groups, and a tree regrouped by a person's own words. Carried from the original package's containment
// bridge tests (twelve cases) and grouping-intent tests (ten cases), on a made-up bakery's bookmark folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGroup, hasGroup, membersOf } from '../read-data/group-graph.mjs';
import { nestByIntent, treeToGroups } from '../read-data/tree-to-groups.mjs';

const FAMILY = 'tree-node';
const node = (node_id, parent_id, ordinal, role, extra = {}) => ({
  node_id, parent_id, ordinal, role, title: extra.title ?? '', external_identity: extra.external_identity ?? null, attributes: extra.attributes ?? {},
});
const ref = id => ({ family: FAMILY, parts: { node_id: id } });
const memberIds = (graph, id) => membersOf(graph, ref(id)).map(m => m.memberId);

test('every containing node becomes a group', () => {
  const result = treeToGroups([node('g', null, null, 'group'), node('a', 'g', 0, 'leaf')], FAMILY);
  assert.equal(hasGroup(result.graph, ref('g')), true);
  assert.equal(result.memberCount, 1);
});

test('siblings keep the order of their ordinals', () => {
  const result = treeToGroups([node('g', null, null, 'group'), node('c', 'g', 2, 'leaf'), node('a', 'g', 0, 'leaf'), node('b', 'g', 1, 'leaf')], FAMILY);
  assert.deepEqual(getGroup(result.graph, ref('g')).memberOrder, ['a', 'b', 'c']);
});

test('a group inside a group nests by its address', () => {
  const result = treeToGroups([node('outer', null, null, 'group'), node('inner', 'outer', 0, 'group'), node('a', 'inner', 0, 'leaf')], FAMILY);
  assert.deepEqual(memberIds(result.graph, 'outer'), ['inner']);
  assert.deepEqual(memberIds(result.graph, 'inner'), ['a']);
});

test('a parent is placed before its child whatever the input order', () => {
  const result = treeToGroups([node('a', 'inner', 0, 'leaf'), node('inner', 'outer', 0, 'group'), node('outer', null, null, 'group')], FAMILY);
  assert.deepEqual(result.unplaced.filter(entry => entry.reason !== 'no_parent'), []);
  assert.deepEqual(memberIds(result.graph, 'inner'), ['a']);
});

test('an opaque role is carried as it is', () => {
  const result = treeToGroups([node('g', null, null, 'group'), node('s', 'g', 0, 'paired')], FAMILY);
  assert.equal(membersOf(result.graph, ref('g'))[0].role, 'paired');
});

test('an unknown role is carried as it is, so a new kind needs no code', () => {
  const result = treeToGroups([node('g', null, null, 'group'), node('x', 'g', 0, 'separator')], FAMILY);
  assert.equal(membersOf(result.graph, ref('g'))[0].role, 'separator');
});

test('the source address is kept whole as presentation', () => {
  const url = 'https://bakery.example/recipes/rye?step=2&x=1';
  const result = treeToGroups([node('g', null, null, 'group'), node('a', 'g', 0, 'leaf', { external_identity: url })], FAMILY);
  assert.equal(membersOf(result.graph, ref('g'))[0].presentation.external_identity, url);
});

test('the source id is the member id, never a position', () => {
  const result = treeToGroups([node('g', null, null, 'group'), node('SOURCE-ID', 'g', 0, 'leaf')], FAMILY);
  assert.equal(membersOf(result.graph, ref('g'))[0].memberId, 'SOURCE-ID');
});

test('two groups that contain each other are reported as a cycle', () => {
  const result = treeToGroups([node('a', 'b', 0, 'group'), node('b', 'a', 0, 'group')], FAMILY);
  assert.equal(result.unplaced.some(entry => entry.reason === 'cycle'), true);
});

test('a node with no parent is reported, not dropped', () => {
  const result = treeToGroups([node('lonely', null, null, 'leaf')], FAMILY);
  assert.deepEqual(result.unplaced, [{ node_id: 'lonely', reason: 'no_parent', detail: 'record has no parent, so it is a root or an orphan of this tree' }]);
});

test('every node with a parent is placed or reported', () => {
  const records = [node('g', null, null, 'group'), node('a', 'g', 0, 'leaf'), node('b', 'g', 1, 'leaf'), node('c', 'g', 2, 'paired')];
  const result = treeToGroups(records, FAMILY);
  const failed = result.unplaced.filter(entry => entry.reason !== 'no_parent').length;
  assert.equal(result.memberCount + failed, records.filter(record => record.parent_id !== null).length);
});

test('the base graph is never changed', () => {
  const first = treeToGroups([node('g', null, null, 'group'), node('a', 'g', 0, 'leaf')], FAMILY);
  const before = JSON.stringify(first.graph);
  treeToGroups([node('g', null, null, 'group'), node('z', 'g', 0, 'leaf')], FAMILY, first.graph);
  assert.equal(JSON.stringify(first.graph), before);
});

// A root, three folders at depth 1 and one page.
const folder = (node_id, title, role, parent_id, ordinal = 0) => ({ node_id, parent_id, ordinal, role, title, external_identity: null, attributes: {} });
const tree = () => [
  folder('root', '', 'container', null, null),
  folder('bread recipes', 'bread recipes', 'group', 'root', 0),
  folder('bread tools', 'bread tools', 'group', 'root', 1),
  folder('cake book', 'cake book', 'group', 'root', 2),
  folder('p1', 'a page', 'leaf', 'bread recipes', 0),
];
const mint = title => `minted:${title}`;
const scoped = { root_node_id: 'root', applies_to_role: 'group', depth: 1 };

test('named folders move under a parent that is made because it is missing', () => {
  const result = nestByIntent(tree(), { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes', 'Bread Tools '] }] }, mint);
  assert.deepEqual(result.created, ['minted:bread']);
  assert.deepEqual([...result.moved].sort(), ['bread recipes', 'bread tools']);
  assert.deepEqual(result.refusals, []);
  const byId = new Map(result.records.map(record => [record.node_id, record]));
  assert.equal(byId.get('bread recipes').parent_id, 'minted:bread');
  assert.equal(byId.get('bread tools').parent_id, 'minted:bread');
  assert.equal(byId.get('cake book').parent_id, 'root');
  assert.equal(byId.get('p1').parent_id, 'bread recipes');
});

test('a made parent says so explicitly', () => {
  const result = nestByIntent(tree(), { scope: { root_node_id: 'root' }, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes'] }] }, mint);
  const created = result.records.find(record => record.node_id === 'minted:bread');
  assert.deepEqual(created.materialize, { kind: 'list' });
  assert.equal(created.role, 'group');
  assert.equal(created.title, 'bread');
});

test('a parent is not made when the intent did not ask for it', () => {
  const result = nestByIntent(tree(), { nest: [{ parent_title: 'bread', child_titles: ['bread recipes'] }] }, mint);
  assert.equal(result.created.length, 0);
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'parent_absent_and_creation_not_declared');
});

test('two folders with one title are refused, never guessed', () => {
  const records = [...tree(), folder('dup', 'bread recipes', 'group', 'root', 3)];
  const result = nestByIntent(records, { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes'] }] }, mint);
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'child_title_is_ambiguous');
});

test('one bad title does not stop the good ones in the same row', () => {
  const result = nestByIntent(tree(), { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes', 'does not exist'] }] }, mint);
  assert.deepEqual(result.moved, ['bread recipes']);
  assert.equal(result.refusals[0].reason, 'child_title_not_found');
});

test('a title outside the scope is refused rather than moved', () => {
  const records = [...tree(), folder('other-root', '', 'container', null, null), folder('elsewhere', 'bread recipes x', 'group', 'other-root', 0)];
  const result = nestByIntent(records, { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes x'] }] }, mint);
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals[0].reason, 'child_is_not_in_scope');
});

test('a group cannot be put under its own inner group', () => {
  const records = [folder('root', '', 'container', null, null), folder('outer', 'outer', 'group', 'root', 0), folder('inner', 'inner', 'group', 'outer', 0)];
  const result = nestByIntent(records, { nest: [{ parent_title: 'inner', child_titles: ['outer'] }] }, mint);
  assert.equal(result.moved.length, 0);
  assert.equal(result.refusals.some(entry => entry.reason === 'would_create_a_cycle'), true);
});

test('a made parent nothing moved into is dropped', () => {
  const result = nestByIntent(tree(), { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['nothing matches this'] }] }, mint);
  assert.equal(result.created.length, 0);
  assert.equal(result.records.some(record => record.node_id === 'minted:bread'), false);
});

test('the same intent twice changes nothing the second time', () => {
  const intent = { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes', 'bread tools'] }] };
  const once = nestByIntent(tree(), intent, mint);
  const twice = nestByIntent(once.records, intent, mint);
  assert.deepEqual(twice.moved, []);
  assert.equal(twice.created.length, 0);
});

test('no record is ever dropped', () => {
  const before = tree();
  const result = nestByIntent(before, { scope: scoped, materialize_missing_parents: { kind: 'list' }, nest: [{ parent_title: 'bread', child_titles: ['bread recipes'] }] }, mint);
  assert.ok(result.records.length >= before.length);
  for (const original of before) assert.ok(result.records.some(record => record.node_id === original.node_id));
});
