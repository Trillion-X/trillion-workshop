// Fabricated records exercise the actual maintained topology and bounded API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGraph, projectGraphRecords } from '../read-data/graph-walk.mjs';
import { MODEL } from '../read-data/graph-records.mjs';
import { freshDoor } from './graph-door.mjs';

const rows = [
  { id: 'person:a', type: 'person', value: { name: 'Ada' } },
  { id: 'person:b', type: 'person', value: { name: 'Bo' } },
  { id: 'group:c', type: 'group', value: { name: 'Club' } },
  { id: 'relation:r', type: 'relation', value: { subject: 'person:a', object: 'group:c', role: 'member' } },
  { id: 'relation:ended', type: 'relation', value: { subject: 'person:a', object: 'person:b', role: 'colleague', alive: false } },
  { id: 'activity:m', type: 'activity', value: { kind: 'meeting', summary: 'Planning', participants: [
    { record: 'person:a', role: 'organiser' }, { record: 'person:b' }, { record: 'person:unseen', role: 'attendee' },
  ] } },
];

test('relations and activities retain record identities, roles, labels and actual activity hubs', () => {
  const graph = projectGraphRecords(rows);
  assert.deepEqual(graph.nodes.map(node => node.id), ['person:a', 'group:c', 'activity:m', 'person:b']);
  assert.equal(graph.nodes.find(node => node.id === 'activity:m').attributes.label, 'Planning');
  assert.equal(graph.connections.length, 4);
  assert.deepEqual(graph.connections[0].endpoints, [{ node_id: 'person:a', role: 'subject' }, { node_id: 'group:c', role: 'object' }]);
  assert.equal(graph.connections[0].attributes.relation, 'member');
  assert.equal(graph.connections[1].endpoints[1].role, 'organiser');
  assert.equal(graph.connections[2].endpoints[1].role, 'participant');
  assert.equal(graph.connections[3].endpoints[1].node_id, 'person:unseen');
  assert.equal(graph.nodes.some(node => node.id === 'person:unseen'), false, 'an absent record stays an endpoint, never an invented node');
  assert.equal(graph.complete, true);
});

test('feed envelopes require explicit model types, not address or relationship-shaped guesses', () => {
  const graph = projectGraphRecords(rows.map(({ id, type, value }) => ({ address: id, type, payload: value })));
  assert.deepEqual(graph, projectGraphRecords(rows));
  assert.equal(projectGraphRecords([{ address: 'relation:guess', payload: { subject: 'a', object: 'b', role: 'member' } }]).connections.length, 0);
  assert.equal(projectGraphRecords([{ address: 'r', payload: { type: 'relation', subject: 'a', object: 'b', role: 'member' } }]).connections.length, 1);
});

test('empty, malformed and unrelated records do not invent graph membership', () => {
  for (const value of [undefined, null, {}, [], [null, 5, {}, { id: '', value: {} },
    { id: 'bad', type: 'relation', value: { subject: 'a', object: '', role: 'member' } },
    { id: 'bad-activity', type: 'activity', value: { participants: [null, { record: '' }] } },
    { id: 'note', type: 'note', value: { text: 'Unrelated' } }]]) {
    assert.deepEqual(projectGraphRecords(value).nodes, []);
    assert.deepEqual(projectGraphRecords(value).connections, []);
  }
});

test('supplied rows and records-door loadGraph share topology, filters and ended semantics', async t => {
  const { door } = await freshDoor(t, { records: rows.filter(row => ['relation', 'activity'].includes(row.type)) });
  for (const options of [{}, { ended: true }, { roles: ['member'] }, { activities: false }, { kinds: ['call'] }]) {
    const projected = projectGraphRecords(rows, options);
    const loaded = await loadGraph(door, options);
    const edges = graph => [...graph.edges].flatMap(([from, list]) => list.map(edge => `${[from, edge.to].sort().join('|')}|${edge.role}`));
    const expected = [...new Set(edges(loaded))].sort();
    const actual = projected.connections.map(connection => `${connection.endpoints.map(end => end.node_id).sort().join('|')}|${connection.attributes.relation ?? connection.attributes.role}`).sort();
    assert.deepEqual(actual, expected);
  }
});

test('editable DATA bounds and duplicate source IDs are honored with explicit incompleteness', () => {
  const model = { ...MODEL, graph: { ...MODEL.graph, scan_most: 1 } };
  const graph = projectGraphRecords(rows, {}, model);
  assert.equal(graph.complete, false);
  assert.deepEqual(graph.read, { relations: 1, activities: 1, records: 1 });
  assert.deepEqual(projectGraphRecords([...rows, ...rows]), projectGraphRecords(rows));
  assert.equal(projectGraphRecords(rows, { activities: false }).connections.length, 1);
  assert.equal(projectGraphRecords(rows, { ended: true, activities: false }).connections.length, 2);
});


test('ambiguous row identities and explicit type conflicts are dropped rather than guessed', () => {
  const relation = { subject: 'a', object: 'b', role: 'member' };
  assert.equal(projectGraphRecords([{ id: 'one', address: 'another', type: 'relation', value: relation }]).connections.length, 0);
  assert.equal(projectGraphRecords([{ id: 'r', type: 'relation', value: { ...relation, type: 'person' } }]).connections.length, 0);
  assert.equal(projectGraphRecords([{ id: 'r', type: 'relation', value: { subject: 'a', object: 'a', role: 'same' } }]).connections.length, 1, 'valid self relations stay visible even though traversal skips self steps');
});

test('role and kind filters are applied before the shared per-kind DATA read bound', async t => {
  const model = { ...MODEL, graph: { ...MODEL.graph, scan_most: 1 } };
  const onlyGraphRows = rows.filter(row => ['relation', 'activity'].includes(row.type));
  const { door } = await freshDoor(t, { records: onlyGraphRows });
  const options = { roles: ['colleague'], ended: true, activities: false };
  const projected = projectGraphRecords(onlyGraphRows, options, model);
  const loaded = await loadGraph(door, options, model);
  assert.equal(projected.connections[0].id, 'relation:ended');
  assert.equal(projected.complete, loaded.complete);
  assert.deepEqual(projected.read, { ...loaded.read, records: 0 });
});


test('explicit producer incompleteness survives without guessing the whole account scope', () => {
  assert.equal(projectGraphRecords({ records: rows, complete: false }).complete, false);
  assert.deepEqual(projectGraphRecords({ records: rows, complete: true }), projectGraphRecords(rows));
  assert.deepEqual(projectGraphRecords({ records: [], complete: false }).connections, []);
  assert.equal(projectGraphRecords({ records: [], complete: false }).complete, false);
  assert.deepEqual(projectGraphRecords({ records: 'bad' }).nodes, []);
});


test('valid self relations stay visible while loadGraph retains its established self-step exclusion', async t => {
  const self = [{ id: 'self', type: 'relation', value: { subject: 'a', object: 'a', role: 'same' } }];
  const { door } = await freshDoor(t, { records: self });
  assert.equal((await loadGraph(door)).edges.size, 0);
  const projected = projectGraphRecords([...self, { id: 'a', type: 'person', value: { name: 'Ada' } }]);
  assert.equal(projected.connections.length, 1);
  assert.deepEqual(projected.connections[0].endpoints.map(end => end.node_id), ['a', 'a']);
});

test('untyped endpoint records and conflicting identities are not invented source membership', () => {
  const graph = projectGraphRecords([
    { id: 'a', value: { name: 'Untyped' } },
    { id: 'b', type: 'person', value: { name: 'Bo' } },
    { id: 'r', type: 'relation', value: { subject: 'a', object: 'b', role: 'member' } },
  ]);
  assert.deepEqual(graph.nodes.map(node => node.id), ['b']);
  assert.equal(graph.complete, false);
  assert.equal(projectGraphRecords([{ id: 'r', type: 'relation', value: { type: 'person' } }]).complete, false);
});

test('both graph readers honor the editable per-activity participant bound and preserve partial evidence', async t => {
  const model = { ...MODEL, activities: { ...MODEL.activities, participants_most: 2 } };
  const activity = { id: 'meeting', type: 'activity', value: { kind: 'meeting', participants: [
    { record: 'a' }, { record: 'b' }, { record: 'c' },
  ] } };
  const { door } = await freshDoor(t, { records: [activity] });
  const loaded = await loadGraph(door, {}, model);
  const projected = projectGraphRecords([activity], {}, model);
  assert.equal(loaded.complete, false);
  assert.equal(loaded.edges.has('c'), false);
  assert.equal(projected.complete, false);
  assert.equal(projected.connections.length, 2);
  assert.equal(projected.nodes[0].attributes.participants.length, 2);
});


test('known empty feeds are complete; unavailable, unsupported and corrupt feeds are not false absence', () => {
  for (const source of [[], { records: [] }, { records: [], complete: true }]) {
    const graph = projectGraphRecords(source);
    assert.equal(graph.complete, true);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.connections, []);
  }
  for (const source of [undefined, null, {}, { records: null }, { records: 'bad', complete: true },
    { records: [], complete: 'yes' }, [null], [{ type: 'relation', value: {} }],
    [{ id: 'r', type: 'relation', value: { subject: 'a', object: 'b' } }],
    [{ id: 'r', type: 'relation', value: { subject: 'a', object: 'b', role: 'member', alive: 'false' } }],
    [{ id: 'm', type: 'activity', value: { kind: 'meeting', participants: [] } }],
    [{ id: 'm', type: 'activity', value: { participants: [{ record: 'a' }] } }],
    [{ id: 'm', type: 'activity', value: { kind: 'meeting', participants: [null, { record: '' }, { record: 'a', role: '' }] } }]]) {
    const graph = projectGraphRecords(source);
    assert.equal(graph.complete, false);
    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.connections, []);
  }
});

test('valid filtered and ended rows remain legitimate complete exclusions', () => {
  for (const [source, options] of [
    [[rows[4]], {}],
    [[rows[3]], { roles: ['colleague'] }],
    [[rows[5]], { kinds: ['call'] }],
    [[rows[5]], { activities: false }],
  ]) {
    const graph = projectGraphRecords(source, options);
    assert.equal(graph.complete, true);
    assert.deepEqual(graph.connections, []);
  }
  const mixed = projectGraphRecords([...rows, { id: 'broken', type: 'relation', value: {} }]);
  assert.equal(mixed.complete, false);
  assert.equal(mixed.connections.length, projectGraphRecords(rows).connections.length);
  const partialActivity = projectGraphRecords([{ id: 'm', type: 'activity', value: { kind: 'meeting', participants: [{ record: 'a' }, null] } }]);
  assert.equal(partialActivity.complete, false);
  assert.equal(partialActivity.connections.length, 1, 'the valid participant survives without inventing the missing one');
});


test('identical duplicate identities dedupe, but conflicting current values or types choose neither row', () => {
  const original = { id: 'a', type: 'person', value: { name: 'Ada', details: { one: 1, two: 2 } } };
  const reordered = { address: 'a', type: 'person', payload: { details: { two: 2, one: 1 }, name: 'Ada' } };
  const relation = { id: 'r', type: 'relation', value: { subject: 'a', object: 'b', role: 'member' } };
  const base = [original, relation];
  assert.deepEqual(projectGraphRecords([...base, reordered]), projectGraphRecords(base));
  for (const conflicting of [
    { ...original, value: { name: 'Other Ada' } },
    { ...original, type: 'group' },
    { ...original, value: null },
    { ...original, address: 'conflicting-address' },
  ]) {
    for (const source of [[...base, conflicting, original], [conflicting, ...base]]) {
      const graph = projectGraphRecords(source);
      assert.equal(graph.complete, false);
      assert.equal(graph.nodes.some(node => node.id === 'a'), false, 'neither conflicting record is authoritative');
      assert.equal(graph.connections.length, 1, 'the valid relation retains its unresolved endpoint');
    }
  }
  const otherRelation = { ...relation, value: { subject: 'a', object: 'c', role: 'member' } };
  assert.equal(projectGraphRecords([relation, otherRelation]).connections.length, 0);
  const filtered = { ...relation, value: { ...relation.value, role: 'excluded' } };
  const graph = projectGraphRecords([filtered, relation], { roles: ['member'] });
  assert.equal(graph.complete, false);
  assert.equal(graph.connections.length, 0, 'filters cannot conceal a conflicting current identity');
});

test('stored row and endpoint identities keep exact admitted bytes instead of trimming into another record', () => {
  const graph = projectGraphRecords([
    { id: ' a ', type: 'person', value: { name: 'Spaced Ada' } },
    { id: 'a', type: 'person', value: { name: 'Other Ada' } },
    { address: ' b ', type: 'person', payload: { name: 'Spaced Bo' } },
    { id: ' r ', type: 'relation', value: { subject: ' a ', object: ' b ', role: 'member' } },
    { id: ' m ', type: 'activity', value: { kind: 'meeting', participants: [{ record: ' a ' }] } },
  ]);
  assert.equal(graph.complete, true);
  assert.deepEqual(graph.nodes.map(node => node.id), [' a ', ' b ', ' m ']);
  assert.equal(graph.connections[0].id, ' r ');
  assert.deepEqual(graph.connections[0].endpoints.map(end => end.node_id), [' a ', ' b ']);
  assert.equal(graph.connections[1].endpoints[0].node_id, ' m ');
  assert.equal(graph.connections[1].endpoints[1].node_id, ' a ');
  const blank = projectGraphRecords([{ id: '   ', type: 'person', value: { name: 'Invalid' } }]);
  assert.equal(blank.complete, false);
  assert.deepEqual(blank.nodes, []);
});
