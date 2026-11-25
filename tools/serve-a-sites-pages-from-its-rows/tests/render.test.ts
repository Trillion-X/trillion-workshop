// Drawing: a layout's tool nodes take their tools' answers, the tree's JSON cannot close its script, a look row cannot end
// its declaration, and every tool's module screen is found from the cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pageOf } from '../do-work/pages.ts';
import { drawnTreeOf, lookCss, runsOf, screensOfTools, treeOf } from '../do-work/render.ts';
import { layoutElement, modulesOf } from '../do-work/render-layout.ts';

const tools = join(import.meta.dirname, '..', '..');
const TEXT = 'ui/show/text/Text.tsx';

test('the main node becomes the page\'s own tool with its slug, and each run is asked once', async () => {
  const page = pageOf({
    path: '/c/:slug', title: 'C', access: 'public', tool: 'tool:read-c', input: { id: ':slug' }, collection: null, updated_at: null,
    layout: { part: TEXT, export: 'Text', children: [{ main: true }, { tool: 'tool:read-c', input: { id: 'x' } }, { main: true }] },
  });
  const tree = treeOf(page, { slug: 'x' });
  assert.deepEqual(runsOf(tree), [{ tool: 'tool:read-c', input: { id: 'x' } }]);
  let asked = 0;
  const { drawn, timed } = await drawnTreeOf(tree, new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }]]), async () => { asked += 1; return { title: 'Seen' }; });
  assert.equal(asked, 1);
  assert.equal(timed.length, 1);
  assert.deepEqual(drawn, { module: `${TEXT}#Text`, children: [
    { module: 'c/show/C.tsx#View', props: { title: 'Seen' } }, { module: 'c/show/C.tsx#View', props: { title: 'Seen' } }, { module: 'c/show/C.tsx#View', props: { title: 'Seen' } },
  ] });
  assert.deepEqual(modulesOf(drawn), ['c/show/C.tsx#View', `${TEXT}#Text`]);
});

test('a tool with no module screen, or an answer that is not an object, refuses the page', async () => {
  const tree = { tool: 'tool:read-c', input: {} };
  await assert.rejects(drawnTreeOf(tree, new Map(), async () => ({})), /no module screen/);
  const screens = new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }]]);
  await assert.rejects(drawnTreeOf(tree, screens, async () => [1, 2]), /not an object/);
  await assert.rejects(drawnTreeOf(tree, screens, async () => { throw new Error('door down'); }), /door down/);
});

test('a drawn tree whose module the bundle lacks is never drawn with it left out', () => {
  assert.throws(() => layoutElement({ module: 'x/show/X.tsx#View' }, {}), /holds no module x\/show\/X.tsx#View/);
});

test('look rows become CSS variables only when no value can end its declaration', () => {
  assert.equal(lookCss([{ name: 'brand-ink', value: '#123456' }, { name: 'reading-font', value: '"Source Serif", serif' }]), ':root{--brand-ink:#123456;--reading-font:"Source Serif", serif;}');
  assert.equal(lookCss([]), '');
  assert.equal(lookCss([{ name: 'colour.accent-deep', value: '#006b41' }]), ':root{--colour-accent-deep:#006b41;}');
  for (const value of ['red;} body{display:none', 'x</style><script>', 'a\\62 c']) assert.throws(() => lookCss([{ name: 'ink', value }]), /one CSS value/);
  assert.throws(() => lookCss([{ name: 'Ink', value: 'red' }]), /lower-case/);
});

test('every tool card with a module screen is found, by its folder and entry', () => {
  const screens = screensOfTools(tools);
  for (const [id, screen] of screens) {
    assert.match(id, /^tool:/);
    assert.match(screen.file, /^[a-z0-9-]+\/.+\.(tsx?|mjs|jsx?)$/, id);
  }
});
