// Real records -> shared projection -> structural adapter -> committed visible feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKnowledgeGraph } from './read-knowledge-graph.ts';
import { connectionGraphToFeedModel } from 'trillion-workshop/tools/organize-the-sidebar/read-data/knowledge-graph-adapter.ts';
import { foldKnowledgeGraphFeed } from 'trillion-workshop/tools/organize-the-sidebar/read-data/knowledge-graph-feed.ts';
import { projectGraphRecords } from 'trillion-workshop/tools/record-graph/read-data/graph-walk.mjs';
import { MODEL } from 'trillion-workshop/tools/record-graph/read-data/graph-records.mjs';
import { buildKnowledgeGraphView } from './knowledge-graph-view.ts';

const rows = [
  { id: 'a', type: 'person', value: { name: 'Ada' } },
  { id: 'b', type: 'person', value: { label: 'Bo' } },
  { id: 'c', type: 'group', value: { title: 'Club' } },
  { id: 'r', type: 'relation', value: { subject: 'a', object: 'c', role: 'member' } },
  { id: 'm', type: 'activity', value: { kind: 'meeting', summary: 'Planning', participants: [
    { record: 'a', role: 'organiser' }, { record: 'b' }, { record: 'c', role: 'attendee' },
  ] } },
];

test('maintained records project all the way into named visible frames and activity spokes', () => {
  const projection = projectKnowledgeGraph(rows);
  const adapted = connectionGraphToFeedModel(projection);
  assert.deepEqual(adapted.dropped, { nodes: 0, connections: 0 });
  const feed = foldKnowledgeGraphFeed(adapted.model);
  assert.deepEqual(feed.diagnostics, { nodeCount: 4, edgeCount: 4, hubCount: 0, missingEndpointCount: 0 });
  assert.deepEqual(feed.items.filter(item => item.kind === 'note').map(item => item.text).sort(), ['Ada', 'Bo', 'Club', 'Planning']);
  const view = buildKnowledgeGraphView(projection);
  assert.equal(view.frames.length, 4);
  assert.equal(view.edgeRoutes.length, 4);
  assert.equal(view.nodes.get('kg-node:m')?.label, 'Planning');
  assert.ok(view.frames.every(frame => Number.isFinite(frame.x) && Number.isFinite(frame.y)));
});

test('absent endpoint is visibly Missing record rather than synthesized source truth', () => {
  const projection = projectKnowledgeGraph(rows.filter(row => row.id !== 'c'));
  assert.equal(projection.nodes.some(node => node.id === 'c'), false);
  const view = buildKnowledgeGraphView(projection);
  assert.equal(view.nodes.get('kg-node:c')?.missing, true);
  assert.equal(view.nodes.get('kg-node:c')?.label, 'Missing record');
  assert.equal(view.diagnostics.missingEndpointCount, 1);
});

test('known empty feeds stay complete and unavailable or malformed feeds stay incomplete in the real view', () => {
  for (const [input, complete] of [[[], true], [{ records: [] }, true], [undefined, false], [null, false], [{}, false], [[{ id: 'r', type: 'relation', value: { object: 'c' } }], false]]) {
    const projection = projectKnowledgeGraph(input);
    assert.equal(projection.complete, complete);
    const view = buildKnowledgeGraphView(projection);
    assert.equal(view.complete, complete);
    assert.equal(view.frames.length, 0);
    assert.equal(view.edgeRoutes.length, 0);
  }
});


test('partial projections retain completeness and bounded read evidence through the real view', () => {
  const projection = projectGraphRecords(rows, {}, { ...MODEL, graph: { ...MODEL.graph, scan_most: 1 } });
  const view = buildKnowledgeGraphView(projection);
  assert.equal(view.complete, false);
  assert.deepEqual(view.read, projection.read);
  assert.equal(view.frames.length, 4);
  assert.equal(buildKnowledgeGraphView({ nodes: [], connections: [] }).complete, undefined, 'unknown completeness is not presented as complete');
});


test('producer-scoped partial empty and nonempty feeds reach the actual view honestly', () => {
  for (const source of [[], rows]) {
    const view = buildKnowledgeGraphView(projectKnowledgeGraph({ records: source, complete: false }));
    assert.equal(view.complete, false);
    assert.equal(view.frames.length, source.length ? 4 : 0);
  }
});


test('conflicting current node identities reach the view as unresolved, never an arbitrary person label', () => {
  const view = buildKnowledgeGraphView(projectKnowledgeGraph([...rows, { id: 'a', type: 'person', value: { name: 'Other Ada' } }]));
  assert.equal(view.complete, false);
  assert.equal(view.nodes.get('kg-node:a')?.missing, true);
  assert.equal(view.nodes.get('kg-node:a')?.label, 'Missing record');
  assert.equal([...view.nodes.values()].some(node => node.label === 'Ada' || node.label === 'Other Ada'), false);
});
