// test/keep-lists-of-rows-link-graph.test.mjs
// Any link field of a list is a line of the list's graph. No field kind is named: a field the list says holds the ids of
// other records (`links`) draws one edge from each linked record to the record that holds the id, in any number: a record
// linked to many and linked from many, a chain of any depth, a cycle. Which link fields the view draws is the view's own
// setting (`link_fields`), every link field when it names none. "Parent" is a name a list gives one of its link fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = new URL('../tools/keep-lists-of-rows/', import.meta.url).pathname;
const { outputFiles } = await build({
  absWorkingDir: root, entryPoints: ['read-data/visual-database-input-from-list.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
});
const { listFieldRoles, listCanDraw, visualDatabaseInputFromList } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const tree = { id: 'tree', label: 'Tree', kind: 'graph', needs: ['link'] };
const title = { id: 'title', label: 'Title', kind: 'text' };
const link = (id, direction = 'from') => ({ id, label: id, kind: 'link', ruleKind: 'tags', links: { direction } });
const listOf = (fields, rows) => ({
  label: 'Works', fields, records: rows, identify: record => record.id,
});
const edgesOf = (context, row = tree) => visualDatabaseInputFromList(context, row).views.views[0].topology.edgeSources ?? [];
const payloadOf = (context, id) => visualDatabaseInputFromList(context, tree).records.find(record => record.id === id).payload;

test('a list with one link field of any name can draw the tree, and no kind is named', () => {
  assert.equal(listCanDraw(tree, [title, link('part_of')]), true);
  assert.equal(listCanDraw(tree, [title, { id: 'part_of', label: 'Part of', kind: 'whatever' }]), false);
  assert.equal(listFieldRoles([title, link('part_of')]).link?.id, 'part_of');
});

test('a field of kind parent is no longer special: without links it is nothing', () => {
  assert.equal(listCanDraw(tree, [title, { id: 'up', label: 'Up', kind: 'parent' }]), false);
});

test('every link field is a line of the graph, from the linked record to the record that holds the id', () => {
  const context = listOf([title, link('part_of'), link('related')], [{ id: 'a', title: 'A', part_of: ['b'], related: ['c', 'b'] }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
  assert.deepEqual(edgesOf(context), [
    { from: 'payload.part_of:ids', to: 'id' },
    { from: 'payload.related:ids', to: 'id' },
  ]);
});

test('the view names which link fields it draws; a link that leads to records is drawn from the record', () => {
  const context = listOf([title, link('part_of'), link('leads_to', 'to')], [{ id: 'a', title: 'A', part_of: ['b'], leads_to: ['c'] }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]);
  assert.deepEqual(edgesOf(context, { ...tree, link_fields: ['leads_to'] }), [{ from: 'id', to: 'payload.leads_to:ids' }]);
  assert.deepEqual(edgesOf({ ...context, linkFields: ['part_of'] }), [{ from: 'payload.part_of:ids', to: 'id' }]);
});

test('many to many: a record holds many ids and is held by many, each kept whole', () => {
  const rows = [{ id: 'a', title: 'A', part_of: ['x', 'y'] }, { id: 'b', title: 'B', part_of: ['x', 'y'] }, { id: 'x', title: 'X' }, { id: 'y', title: 'Y' }];
  const context = listOf([title, link('part_of')], rows);
  assert.deepEqual(payloadOf(context, 'a')['part_of:ids'], ['x', 'y']);
  assert.deepEqual(payloadOf(context, 'b')['part_of:ids'], ['x', 'y']);
});

test('a two-level chain and a five-level chain keep every hop', () => {
  const chain = depth => Array.from({ length: depth + 1 }, (_, level) => ({ id: `n${level}`, title: `N${level}`, ...(level > 0 ? { part_of: [`n${level - 1}`] } : {}) }));
  for (const depth of [2, 5]) {
    const context = listOf([title, link('part_of')], chain(depth));
    const input = visualDatabaseInputFromList(context, tree);
    assert.equal(input.records.length, depth + 1);
    for (let level = 1; level <= depth; level += 1) assert.deepEqual(payloadOf(context, `n${level}`)['part_of:ids'], [`n${level - 1}`]);
  }
});

test('a cycle is drawn as a graph, never refused', () => {
  const context = listOf([title, link('part_of')], [{ id: 'a', title: 'A', part_of: ['c'] }, { id: 'b', title: 'B', part_of: ['a'] }, { id: 'c', title: 'C', part_of: ['b'] }]);
  const input = visualDatabaseInputFromList(context, tree);
  assert.deepEqual(input.records.map(record => record.id), ['a', 'b', 'c']);
  assert.deepEqual(edgesOf(context), [{ from: 'payload.part_of:ids', to: 'id' }]);
});

test('rows of a list that links to this one join the graph as nodes under the rows they link to', () => {
  const works = listOf([title, link('part_of')], [{ id: 'w1', title: 'Course' }, { id: 'w2', title: 'Other' }]);
  const lessons = { fields: [title, { ...link('course'), linksTo: 'books', linkIds: record => record.course }, { ...link('unrelated'), linksTo: 'elsewhere' }], identify: record => record.id,
    records: [{ id: 'l1', title: 'Lesson 1', course: ['w1'], unrelated: ['zzz'] }, { id: 'l2', title: 'Lesson 2', course: ['w1', 'w2'] }] };
  const input = visualDatabaseInputFromList({ ...works, listKey: 'books', linked: [lessons] }, tree);
  assert.deepEqual(input.records.map(record => record.id), ['w1', 'w2', 'l1', 'l2']);
  assert.deepEqual(input.records[2].payload, { title: 'Lesson 1', ':linked-from': ['w1'] });
  assert.deepEqual(input.records[3].payload[':linked-from'], ['w1', 'w2']);
  assert.ok(input.views.views[0].topology.edgeSources.some(edge => edge.from === 'payload.:linked-from' && edge.to === 'id'));
  const other = visualDatabaseInputFromList({ ...works, listKey: 'books', linked: [lessons] }, { id: 'outline', label: 'Outline', kind: 'list', needs: [] });
  assert.equal(other.records.length, 2, 'only the graph reads the linked rows');
});

test('a link field that gives names for its cells still gives its ids to the graph', () => {
  const field = { ...link('part_of'), read: record => (record.part_of ?? []).map(id => id.toUpperCase()), linkIds: record => record.part_of ?? [] };
  const context = listOf([title, field], [{ id: 'a', title: 'A', part_of: ['b'] }, { id: 'b', title: 'B' }]);
  assert.deepEqual(payloadOf(context, 'a')['part_of:ids'], ['b']);
});
