// test/graph-contract.test.mjs
//
// The typed graph contract (parts/ui/show/layer-diagram/graph-contract.mjs) checks a graph document in two passes and
// draws a valid one through the layer diagram's one layout: the same document is the same bytes, its geometry sidecar
// matches the drawing, a refusal carries a machine code and a path, and every vocabulary is DATA.

import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import contract from '../parts/ui/show/layer-diagram/graph-contract.json' with { type: 'json' };
import { graphDocumentHtml, renderGraphDocument, validateGraphDocument } from '../parts/ui/show/layer-diagram/graph-contract.mjs';
import { layerDiagramLayout } from '../parts/ui/show/layer-diagram/layer-diagram.mjs';
import { documentPageHtml } from '../parts/ui/show/document-page/document-page-html.mjs';

const change = () => ({
  schema_version: 1, id: 'change', label: 'A change to checkout', caption: 'Added, modified and removed parts with their context.',
  lanes: [
    { id: 'callers', label: 'Callers', nodes: [{ id: 'web', label: 'Web checkout', kind: 'service', delta: 'unchanged' }, { id: 'app', label: 'Mobile app', delta: 'unchanged' }] },
    { id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Payment service', detail: 'Now retries once', kind: 'service', delta: 'modified', min_height: 120 }, { id: 'old', label: 'Legacy gateway', delta: 'removed' }] },
    { id: 'data', label: 'Data', nodes: [{ id: 'ledger', label: 'Ledger', kind: 'store', delta: 'added' }] },
  ],
  edges: [
    { from: 'web', to: 'pay', kind: 'calls', delta: 'unchanged' }, { from: 'app', to: 'pay', delta: 'unchanged' },
    { from: 'pay', to: 'ledger', kind: 'writes', delta: 'added' }, { from: 'pay', to: 'old', label: 'no longer', delta: 'removed' },
  ],
});
const codes = (document, rules) => validateGraphDocument(document, rules).errors.map((error) => error.code);

test('a valid document draws the same bytes, atlas and identities on every run', () => {
  const one = renderGraphDocument(change());
  const two = renderGraphDocument(structuredClone(change()));
  assert.equal(one.ok, true, JSON.stringify(one.errors));
  assert.equal(one.html, two.html);
  assert.equal(JSON.stringify(one.atlas), JSON.stringify(two.atlas));
  assert.deepEqual(one.identity, two.identity);
  assert.equal(one.identity.html, `1f:${bytesToHex(blake3(new TextEncoder().encode(one.html)))}`);
  assert.match(one.identity.html, /^1f:[0-9a-f]{64}$/);
  assert.match(one.identity.atlas, /^1f:[0-9a-f]{64}$/);
  assert.ok(one.html.includes('data-delta="removed"') && one.html.includes('data-delta="modified"'), 'change state survives as metadata');
  for (const label of ['Added', 'Changed', 'Removed']) assert.ok(one.html.includes(label), `${label} is readable without color`);
  assert.ok(!/<script|on\w+=|Date|random/i.test(one.html), 'no script in the drawing');
  assert.ok(one.html.includes('layer-diagram__node--highlighted') && one.html.includes('layer-diagram__edge--refused'), 'change states carry their DATA looks');
});

test('the atlas is where the drawing put every box, by id, in both orientations', () => {
  const drawn = renderGraphDocument(change());
  for (const way of ['across', 'down']) {
    const layout = layerDiagramLayout(validateGraphDocument(change()).diagram, way);
    const atlas = drawn.atlas[way];
    assert.equal(atlas.width, layout.width);
    assert.equal(atlas.height, layout.height);
    for (const node of layout.nodes) {
      const box = atlas.boxes.find((found) => found.role === 'node' && found.id === node.id);
      assert.deepEqual([box.x, box.y, box.w, box.h], [node.x, node.y, node.w, node.h], `${way} ${node.id}`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= atlas.width && box.y + box.h <= atlas.height, `${way} ${node.id} inside`);
    }
    assert.deepEqual(atlas.boxes.filter((box) => box.role === 'heading').map((box) => box.id), ['callers', 'core', 'data']);
    assert.equal(atlas.edges.length, 4);
    // The drawn markup places the node at the atlas's box.
    const pay = atlas.boxes.find((box) => box.id === 'pay');
    assert.ok(drawn.html.includes(`x="${pay.x}" y="${pay.y}" width="${pay.w}" height="${pay.h}"`), `${way} markup at atlas box`);
  }
  const pay = drawn.atlas.across.boxes.find((box) => box.id === 'pay');
  assert.ok(pay.h >= 120, 'a min_height is a floor');
});

test('references are checked, never silently dropped', () => {
  const broken = change();
  broken.edges.push({ from: 'pay', to: 'ghost', delta: 'added' });
  broken.lanes[2].nodes.push({ id: 'web', label: 'Again', delta: 'added' });
  const result = validateGraphDocument(broken);
  assert.equal(result.ok, false);
  assert.equal(result.diagram, null);
  assert.deepEqual(result.errors.map((error) => [error.code, error.path]), [['DUPLICATE_ID', 'document.lanes[2].nodes[1].id'], ['BROKEN_REFERENCE', 'document.edges[4].to']]);
  assert.match(result.errors[1].message, /"ghost"/);
  const selfEdge = change();
  selfEdge.edges.push({ from: 'pay', to: 'pay', delta: 'added' });
  assert.deepEqual(codes(selfEdge), ['SELF_EDGE']);
  const refused = renderGraphDocument(broken);
  assert.deepEqual([refused.ok, refused.html, refused.atlas, refused.identity], [false, '', null, null]);
});

test('a document says what and how connected, never where; a change state is required and named by the DATA', () => {
  const placed = change();
  placed.lanes[0].nodes[0].x = 40;
  placed.lanes[0].nodes[1].min_height = -1;
  placed.edges[0].d = 'M0 0';
  assert.deepEqual(codes(placed).sort(), ['BAD_FLOOR', 'POSITION_NOT_ALLOWED', 'POSITION_NOT_ALLOWED']);
  const noDelta = change();
  delete noDelta.lanes[0].nodes[0].delta;
  noDelta.edges[0].delta = 'moved';
  assert.deepEqual(codes(noDelta), ['MISSING_DELTA', 'INVALID_DELTA']);
  assert.match(validateGraphDocument(noDelta).errors[1].message, /added, modified, removed, unchanged/);
  const unlisted = change();
  unlisted.lanes[0].nodes[0].left = 24;
  unlisted.lanes[0].nodes[0].transform = 'translate(2px)';
  unlisted.edges[0].top = 10;
  assert.deepEqual(codes(unlisted), ['UNKNOWN_FIELD', 'UNKNOWN_FIELD', 'UNKNOWN_FIELD']);
});

test('newer versions, wrong types, limits and non-objects are refused without throwing', () => {
  assert.deepEqual(codes({ ...change(), schema_version: 2 }), ['UNSUPPORTED_VERSION']);
  for (const nonsense of [null, undefined, 4, 'text', [], { lanes: 'no' }]) assert.equal(validateGraphDocument(nonsense).ok, false);
  assert.equal(validateGraphDocument({ ...change(), lanes: 'no' }).ok, false, 'a non-list of lanes returns findings');
  assert.deepEqual(codes({ ...change(), lanes: [{ id: 'empty', nodes: [] }], edges: [] }), ['EMPTY_GRAPH']);
  const long = change();
  long.lanes[0].nodes[0].label = 'x'.repeat(contract.limits.label_characters + 1);
  assert.deepEqual(codes(long), ['TOO_LONG']);
  const big = { ...change(), lanes: [{ id: 'l', nodes: Array.from({ length: contract.limits.nodes + 1 }, (_, at) => ({ id: `n${at}`, label: 'n', delta: 'added' })) }], edges: [] };
  assert.deepEqual(codes(big), ['TOO_MANY']);
});

test('every vocabulary is DATA: a kind or change state added to the contract is understood with no code change', () => {
  const rules = structuredClone(contract);
  rules.kinds.node.queue = { letters: 'Q' };
  rules.delta.states.moved = { node: 'strong', edge: 'strong' };
  const document = change();
  document.lanes[0].nodes[0].kind = 'queue';
  document.lanes[0].nodes[1].delta = 'moved';
  const result = validateGraphDocument(document, rules);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.diagram.layers[0].nodes[0].mark, { letters: 'Q' });
  assert.equal(result.diagram.layers[0].nodes[1].tone, 'strong');
  assert.equal(validateGraphDocument(document).ok, false, 'the shipped DATA does not know "moved"');
});

test('an unknown kind draws plain with a warning, or is refused, as the DATA says', () => {
  const document = change();
  document.lanes[0].nodes[0].kind = 'spaceship';
  const plain = validateGraphDocument(document);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.warnings.map((warning) => warning.code), ['UNKNOWN_KIND']);
  assert.equal(plain.diagram.layers[0].nodes[0].mark, undefined);
  const strict = structuredClone(contract);
  strict.kinds.unknown = 'refuse';
  assert.deepEqual(codes(document, strict), ['REFUSED_KIND']);
});

test('a document page block draws a valid graph and says why an invalid one cannot be drawn, escaped', () => {
  const page = (graph) => documentPageHtml({ title: 'T', blocks: [{ heading: 'H', graph }] });
  const ok = page(change());
  assert.ok(ok.includes('class="layer-diagram"') && ok.includes('Ledger') && ok.includes('.layer-diagram__node'));
  const refused = page({ ...change(), lanes: [{ id: 'l', nodes: [{ id: '<b>', label: 'x', delta: 'added' }] }] });
  assert.ok(refused.includes('layer-diagram-refused') && refused.includes('BAD_ID') && !refused.includes('<b>'));
  assert.equal(graphDocumentHtml(undefined), '');
});
