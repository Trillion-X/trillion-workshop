// tools/lay-out-a-diagram: the SVG is standalone, themeable by page variables, and safe whatever the labels say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layOutDiagram } from '../do-work/requests.mjs';

const request = {
  nodes: [
    { id: 'Order received', label: 'Order <b>&', style: { fill: '#ffeecc', 'font-weight': 'bold' } },
    { id: 'Packed' },
    { id: 'Shipped' },
  ],
  edges: [{ from: 'Order received', to: 'Packed', label: 'a < b & "c"' }, { from: 'Packed', to: 'Shipped' }, { id: 'back', from: 'Shipped', to: 'Order received' }],
};

test('the drawing is one standalone SVG: no script, no event attribute, nothing outside the file', () => {
  const { svg } = layOutDiagram(request);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+"/);
  assert.ok(svg.endsWith('</svg>'));
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(svg, /(href|src)\s*=/i);
  for (const use of svg.matchAll(/url\(([^)]*)\)/g)) assert.match(use[1], /^#[\w-]+$/);
  assert.equal(svg.match(/<svg/g).length, 1);
});

test('every label is escaped, in nodes and on arrows', () => {
  const { svg } = layOutDiagram(request);
  assert.ok(svg.includes('Order &lt;b&gt;&amp;'));
  assert.ok(svg.includes('a &lt; b &amp; &quot;c&quot;') || svg.includes('a &lt; b &amp; "c"'));
  assert.ok(!svg.includes('<b>'));
});

test('colours are page variables with fallbacks, so setting them on the page themes the drawing', () => {
  const { svg } = layOutDiagram(request);
  for (const name of ['background', 'ink', 'node-fill', 'node-stroke', 'edge']) assert.match(svg, new RegExp(`var\\(--diagram-${name},#[0-9a-f]{6}\\)`));
  assert.equal(svg.match(/<style>/g).length, 1);
});

test('every node and every arrow carries its id, and a node\'s allowed style is written to its box and label', () => {
  const { svg, nodes, edges } = layOutDiagram(request);
  for (const node of nodes) assert.ok(svg.includes(`data-node-id="${node.id}"`), node.id);
  for (const edge of edges) assert.ok(svg.includes(`data-edge-id="${edge.id}"`), edge.id);
  assert.equal(svg.match(/data-node-id=/g).length, nodes.length);
  assert.equal(svg.match(/data-edge-id=/g).length, edges.length);
  assert.ok(svg.includes('style="fill:#ffeecc"'));
  assert.ok(svg.includes('style="font-weight:bold"'));
});

test('draw: false answers the layout without a drawing', () => {
  assert.equal('svg' in layOutDiagram({ ...request, draw: false }), false);
});

test('a style property outside the allowlist, or a value that could reach out, is refused with a sentence', () => {
  const styled = style => () => layOutDiagram({ nodes: [{ id: 'a', style }], edges: [] });
  assert.throws(styled({ fill: 'url(http://x)' }), /style\.fill must be a plain value.*url\(/);
  assert.throws(styled({ stroke: 'red; background:url(x)' }), /style\.stroke must be a plain value/);
  assert.throws(styled({ fill: '<script>' }), /style\.fill must be a plain value/);
  assert.throws(styled({ fill: 'expression(alert(1))' }), /style\.fill must be a plain value/);
  assert.throws(styled({ 'background-image': 'none' }), /style\.background-image is not a style property a node may carry; the ones allowed are fill, stroke/);
});
