// tools/draw-a-change-as-a-diagram/test/diagram-tools.test.mjs
//
// draw_diagram (do-work/diagram-tools.mjs): without a document it gives the writing brief and the exact outbound list; with one it is
// checked, contained, drawn as standalone SVG and a live command is checked against its ids; a bad document is refused with the
// validator's words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { diagramTools } from '../do-work/diagram-tools.mjs';

const tool = diagramTools().find((item) => item.name === 'draw_diagram');
const document = { lanes: [{ id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Payment', delta: 'modified' }, { id: 'ledger', label: 'Ledger', delta: 'added' }] }], edges: [{ from: 'pay', to: 'ledger', delta: 'added' }] };
const OPEN = String.fromCharCode(60);

test('with no document it gives the brief and what of a large input a model would be shown', async () => {
  const out = await tool.run({ request: 'show the change', files: [{ path: 'src/a.mjs', text: 'x' }, { path: '.env', text: 'KEY=1' }, { path: 'package-lock.json', text: '{}' }] });
  assert.equal(out.ok, true);
  assert.ok(out.brief.system && out.brief.schema);
  assert.ok(out.outbound.some((line) => line.includes('src/a.mjs')));
  assert.ok(out.outbound.some((line) => line.includes('.env')));
  assert.ok(!out.outbound.some((line) => /^\s+\.env \(/u.test(line)), '.env is named only as not sent');
});

test('a document is checked, drawn as SVG files, and a live command is checked against its ids', async () => {
  const out = await tool.run({ document, host: { id: 'change', label: 'A change' }, command: { kind: 'show', focus: ['pay'], note: 'this' } });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.page_block.graph.id, 'change');
  assert.ok(Object.values(out.svg_files).every((svg) => svg.startsWith(`${OPEN}svg`)));
  assert.ok(out.identity.startsWith('1f:'));
  assert.ok(out.identifiers && 'byId' in out.identifiers);
  assert.ok(out.live);
});

test('a bad document is refused with each problem, and a live command naming an unknown id is refused', async () => {
  const bad = await tool.run({ document: { ...document, edges: [{ from: 'pay', to: 'nowhere', delta: 'added' }] }, host: { id: 'c', label: 'C' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  const live = await tool.run({ document, host: { id: 'c', label: 'C' }, command: { kind: 'show', focus: ['ghost'] } });
  assert.equal(live.live.ok, false);
  assert.equal(live.live.errors[0].code, 'UNKNOWN_ID');
});
