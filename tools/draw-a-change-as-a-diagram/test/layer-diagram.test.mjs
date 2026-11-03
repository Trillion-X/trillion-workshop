// test/layer-diagram.test.mjs
//
// The layer diagram draws who connects to what from DATA, in React and in server pages, from one layout.
// It must be deterministic, drop what it cannot draw, never pass a caller value into markup unescaped,
// and know nothing about any product (a kitchen reads the same as people and their AIs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramImageSrc, layerDiagramHtml, layerDiagramLayout, layerDiagramNodeParts, LAYER_DIAGRAM_CSS } from '../parts/ui/show/layer-diagram/layer-diagram.mjs';
import { documentPageHtml } from '../parts/ui/show/document-page/document-page-html.mjs';

const spaces = {
  id: 'spaces',
  label: 'Three people, each with their own AI, in one space',
  caption: 'Each AI reaches only the spaces its person allows.',
  layers: [
    { id: 'people', label: 'People', nodes: [{ id: 'a', label: 'Ann' }, { id: 'b', label: 'Ben' }, { id: 'c', label: 'Cai' }] },
    { id: 'ais', label: 'Their AIs', nodes: [{ id: 'a-ai', label: 'Claude', mark: { image: '/claude.svg' } }, { id: 'b-ai', label: 'Grok', mark: { letters: 'G' } }, { id: 'c-ai', label: 'Muse', mark: { letters: 'M' } }] },
    { id: 'spaces', label: 'Spaces', nodes: [{ id: 'shared', label: 'Space', tone: 'highlighted' }, { id: 'own', label: "Ann's own space", detail: 'Only Ann' }] },
  ],
  edges: [
    { from: 'a', to: 'a-ai' }, { from: 'b', to: 'b-ai' }, { from: 'c', to: 'c-ai' },
    { from: 'a-ai', to: 'shared', tone: 'strong' }, { from: 'b-ai', to: 'shared', tone: 'strong' }, { from: 'c-ai', to: 'shared', tone: 'strong' },
    { from: 'b-ai', to: 'own', tone: 'refused', label: 'not allowed' },
  ],
};

test('the same diagram always lays out to the same numbers, in both orientations', () => {
  for (const way of ['across', 'down']) {
    const one = layerDiagramLayout(spaces, way);
    assert.deepEqual(layerDiagramLayout(structuredClone(spaces), way), one);
    assert.equal(one.orientation, way);
    assert.equal(one.nodes.length, 8);
    assert.equal(one.edges.length, 7);
    for (const node of one.nodes) {
      assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= one.width && node.y + node.h <= one.height, `${way} ${node.id} inside`);
    }
  }
});

test('across puts layers left to right, down puts them top to bottom', () => {
  const across = layerDiagramLayout(spaces, 'across');
  const at = (layout, id) => layout.nodes.find((node) => node.id === id);
  assert.ok(at(across, 'a').x < at(across, 'a-ai').x && at(across, 'a-ai').x < at(across, 'shared').x);
  const down = layerDiagramLayout(spaces, 'down');
  assert.ok(at(down, 'a').y < at(down, 'a-ai').y && at(down, 'a-ai').y < at(down, 'shared').y);
  assert.ok(down.width < across.width, 'the phone drawing is narrower');
  assert.ok(at(down, 'own').w > at(down, 'a-ai').w, 'a short row widens its boxes so longer words fit');
  const ais = ['a-ai', 'b-ai', 'c-ai'].map((id) => at(down, id));
  assert.equal(new Set(ais.map((node) => node.y)).size, 1, 'three AIs share one phone row');
});

test('long node words wrap inside growing boxes in both drawings', () => {
  const diagram = {
    id: 'long-words', label: 'Things reaching a service',
    layers: [
      { id: 'things', nodes: [{ id: 'a', label: 'A video' }, { id: 'b', label: 'A document' }, { id: 'c', label: 'A workflow' }] },
      { id: 'service', nodes: [{ id: 'center', label: 'Your original files', detail: 'Read the parts an app asks for', mark: { letters: 'S' } }] },
      { id: 'uses', nodes: [{ id: 'desktop', label: 'Finder and desktop apps' }, { id: 'web', label: 'Web preview' }, { id: 'ai', label: 'Your connected AIs' }, { id: 'share', label: 'One link', detail: 'The selection you chose' }] },
    ],
    edges: [{ from: 'a', to: 'center' }, { from: 'center', to: 'desktop' }],
  };
  for (const way of ['across', 'down']) {
    const layout = layerDiagramLayout(diagram, way);
    for (const node of layout.nodes) {
      const parts = layerDiagramNodeParts(node, way);
      assert.equal(parts.label.lines.join('').replace(/\s+/gu, ''), node.label.replace(/\s+/gu, ''), `${way} ${node.id} keeps its complete label`);
      if (node.detail) assert.equal(parts.detail.lines.join('').replace(/\s+/gu, ''), node.detail.replace(/\s+/gu, ''), `${way} ${node.id} keeps its complete detail`);
      const last = parts.detail ?? parts.label;
      assert.ok(last.y + (last.lines.length - 1) * last.line_height < node.h - 4, `${way} ${node.id} text remains inside its box`);
    }
    const center = layout.nodes.find((node) => node.id === 'center');
    assert.ok(center.h > (way === 'down' ? 62 : 58), `${way} highlighted box grows for its contents`);
  }
  const down = layerDiagramLayout(diagram, 'down');
  const uses = ['desktop', 'web', 'ai'].map((id) => down.nodes.find((node) => node.id === id));
  assert.ok(uses[0].y === uses[1].y && uses[2].y > uses[1].y, 'long labels use two phone columns');
  const html = layerDiagramHtml(diagram);
  assert.match(html, /<span class="layer-diagram__line">Read the parts an<\/span>/);
  assert.match(html, /<span class="layer-diagram__line">desktop apps<\/span>/);
});

test('phone mark and layer heading have clear space in both server drawings', () => {
  const diagram = {
    id: 'clearance', label: 'A shared source',
    layers: [
      { id: 'source', label: 'Files and work', nodes: [{ id: 'file', label: 'A file' }] },
      { id: 'kept', label: 'Your place', nodes: [{ id: 'original', label: 'Your original files', detail: 'Reads needed bytes', mark: { image: '/mark.svg' }, tone: 'highlighted' }] },
      { id: 'uses', label: 'Where they are used', nodes: [{ id: 'app', label: 'Desktop apps' }] },
    ],
    edges: [{ from: 'file', to: 'original', tone: 'strong' }, { from: 'original', to: 'app' }],
  };
  const down = layerDiagramLayout(diagram, 'down');
  const original = down.nodes.find((node) => node.id === 'original');
  const at = layerDiagramNodeParts(original, 'down');
  assert.ok(at.mark.x + at.mark.size + 6 <= at.label.x, 'the image mark has its own slot beside the words');
  assert.ok(at.detail.y + (at.detail.lines.length - 1) * at.detail.line_height < original.h - 4, 'the detail clears the bottom edge');
  for (const head of down.heads) assert.ok(head.w > 0 && head.w <= down.width, 'each heading has a measured backing');
  const html = layerDiagramHtml(diagram);
  assert.match(html, /<foreignObject[^>]*><h3 class="layer-diagram__head">Files and work<\/h3><\/foreignObject>/, 'a heading is a real heading with its own page-colour backing');
  assert.match(html, /layer-diagram__mark layer-diagram__mark--image/);
});

test('phone connectors clear every heading and unrelated card', () => {
  const diagram = {
    id: 'mixed', label: 'Work reaching apps',
    layers: [
      { id: 'work', label: 'Files and work you choose', nodes: [{ id: 'video', label: 'Video' }, { id: 'document', label: 'Document' }, { id: 'workflow', label: 'Workflow' }] },
      { id: 'kept', label: 'Your place', nodes: [{ id: 'original', label: 'Original files', mark: { image: '/mark.svg' } }] },
      { id: 'uses', label: 'Where they are used', nodes: [{ id: 'desktop', label: 'Desktop apps' }, { id: 'web', label: 'Web preview' }, { id: 'ai', label: 'Your AIs' }, { id: 'share', label: 'One link' }] },
    ],
    edges: [
      { from: 'video', to: 'original' }, { from: 'document', to: 'original' },
      { from: 'workflow', to: 'share' }, { from: 'original', to: 'desktop' },
      { from: 'original', to: 'web' }, { from: 'original', to: 'ai' }, { from: 'original', to: 'share' },
    ],
  };
  const layout = layerDiagramLayout(diagram, 'down');
  const sample = (d) => {
    const tokens = d.match(/[MCL]|-?\d+(?:\.\d+)?/gu);
    const points = [];
    let at = [0, 0];
    for (let index = 0; index < tokens.length;) {
      const command = tokens[index++];
      if (command === 'M' || command === 'L') {
        at = [Number(tokens[index++]), Number(tokens[index++])];
        points.push(at);
      } else if (command === 'C') {
        const one = [Number(tokens[index++]), Number(tokens[index++])];
        const two = [Number(tokens[index++]), Number(tokens[index++])];
        const end = [Number(tokens[index++]), Number(tokens[index++])];
        for (let step = 1; step <= 40; step++) {
          const t = step / 40; const u = 1 - t;
          points.push([0, 1].map(axis => u ** 3 * at[axis] + 3 * u ** 2 * t * one[axis] + 3 * u * t ** 2 * two[axis] + t ** 3 * end[axis]));
        }
        at = end;
      } else assert.fail(`unexpected path token ${command}`);
    }
    return points;
  };
  for (const edge of layout.edges) {
    for (const [x, y] of sample(edge.d)) {
      for (const head of layout.heads) {
        const inside = x >= head.x - head.w / 2 - 2 && x <= head.x + head.w / 2 + 2 && y >= head.y - 18 && y <= head.y + 9;
        assert.ok(!inside, `${edge.from}→${edge.to} clears heading ${head.label} at ${x}, ${y}`);
      }
      for (const node of layout.nodes.filter(node => node.id !== edge.from && node.id !== edge.to)) {
        const inside = x >= node.x - 2 && x <= node.x + node.w + 2 && y >= node.y - 2 && y <= node.y + node.h + 2;
        assert.ok(!inside, `${edge.from}→${edge.to} clears ${node.id} at ${x}, ${y}`);
      }
    }
  }
});

test('an edge to a missing node is dropped, a repeated node keeps its first place, a bad picture is not drawn', () => {
  const layout = layerDiagramLayout({
    id: 'x', label: 'x',
    layers: [{ id: 'l', nodes: [{ id: 'n', label: 'First' }, { id: 'n', label: 'Second' }, { id: 'm', label: 'Pic', mark: { image: 'javascript:alert(1)' } }, { id: 'no-label' }] }],
    edges: [{ from: 'n', to: 'ghost' }, { from: 'n', to: 'n' }, { from: 'n', to: 'm' }],
  });
  assert.deepEqual(layout.nodes.map((node) => node.label), ['First', 'Pic']);
  assert.equal(layout.nodes[1].mark, null);
  assert.equal(layout.edges.length, 1);
  assert.equal(diagramImageSrc('//evil.example/x.svg'), null);
  assert.equal(diagramImageSrc('https://example.com/x.svg'), 'https://example.com/x.svg');
});

test('an empty diagram draws nothing', () => {
  assert.equal(layerDiagramHtml({ id: 'e', label: 'e', layers: [], edges: [] }), '');
  assert.equal(layerDiagramHtml(null), '');
});

test('server markup escapes every caller value and carries tones as classes', () => {
  const html = layerDiagramHtml({
    ...spaces,
    label: '"><script>x()</script>',
    layers: [...spaces.layers, { id: 'evil', nodes: [{ id: 'e', label: '<img onerror=x>', detail: '&', tone: 'Bad Tone' }] }],
  });
  assert.doesNotMatch(html, /<script>|<img onerror/);
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /layer-diagram__edge layer-diagram__edge--refused/);
  assert.match(html, /layer-diagram__node layer-diagram__node--highlighted/);
  assert.doesNotMatch(html, /--Bad Tone/);
  assert.match(html, /layer-diagram__svg--across/);
  assert.match(html, /layer-diagram__svg--down/);
  assert.match(html, /<figcaption class="layer-diagram__caption">Each AI reaches only the spaces its person allows.<\/figcaption>/);
  assert.match(html, />not allowed</);
});

test('the look names no colour, only theme roles', () => {
  assert.doesNotMatch(LAYER_DIAGRAM_CSS, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  assert.match(LAYER_DIAGRAM_CSS, /prefers-reduced-motion/);
});

test('surfaces are HTML backgrounds and words are HTML text, so a colour-adapting extension can pair them', () => {
  // Dark Reader reads an SVG `fill` as a text colour: a card filled that way stays light while its words turn light.
  assert.doesNotMatch(LAYER_DIAGRAM_CSS, /fill:var\(--ld-(?:ground|words)/);
  const html = layerDiagramHtml(spaces);
  assert.doesNotMatch(html, /<text|<tspan|<rect|<circle/, 'no words or surface are drawn as SVG shapes');
  assert.match(html, /<div class="layer-diagram__node layer-diagram__node--highlighted">/);
  assert.match(LAYER_DIAGRAM_CSS, /\.layer-diagram__node\{[^}]*background:var\(--ld-ground-card\)/);
  assert.match(LAYER_DIAGRAM_CSS, /forced-colors:active/);
  assert.doesNotMatch(LAYER_DIAGRAM_CSS, /text-transform:uppercase|letter-spacing:-/, 'no capital eyebrow, no tightened letters');
});

test('it knows no product: a kitchen lays out like people and their AIs', () => {
  const kitchen = layerDiagramLayout({
    id: 'kitchen', label: 'Who cooks what',
    layers: [{ id: 'cooks', nodes: [{ id: 'chef', label: 'Chef' }] }, { id: 'dishes', nodes: [{ id: 'soup', label: 'Soup' }, { id: 'cake', label: 'Cake' }] }],
    edges: [{ from: 'chef', to: 'soup' }, { from: 'chef', to: 'cake', tone: 'refused', label: 'not today' }],
  });
  assert.equal(kitchen.nodes.length, 3);
  assert.equal(kitchen.edges[1].label, 'not today');
});

test('a document block draws its diagram, and the look is sent only with a page that has one', () => {
  const withDiagram = documentPageHtml({ title: 't', description: 'd', blocks: [{ heading: 'Spaces', diagram: spaces }] });
  assert.match(withDiagram, /<figure class="layer-diagram" role="img"/);
  assert.match(withDiagram, /\.layer-diagram__edge--strong/);
  const without = documentPageHtml({ title: 't', description: 'd', blocks: [{ heading: 'Plain', markdown: 'words' }] });
  assert.doesNotMatch(without, /layer-diagram/);
});
