// Drawing: a layout's tool nodes take their tools' answers, the tree's JSON cannot close its script, a look row cannot end
// its declaration, and every tool's module screen is found from the cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pageOf } from '../do-work/pages.ts';
import { drawnTreeOf, fontFacesOf, lookCss, missingPartsOf, partExportsOf, runsOf, screensOfTools, treeOf, withoutModules } from '../do-work/render.ts';
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

test('a required tool with no module screen refuses the page; a required tool that fails, or answers no object, refuses it too', async () => {
  const tree = { tool: 'tool:read-c', input: {}, required: true as const };
  await assert.rejects(drawnTreeOf(tree, new Map(), async () => ({})), /no module screen/);
  const screens = new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }]]);
  await assert.rejects(drawnTreeOf(tree, screens, async () => [1, 2]), /not an object/);
  await assert.rejects(drawnTreeOf(tree, screens, async () => { throw new Error('door down'); }), /door down/);
});

test('one failing tool among good ones leaves only its own nodes out, says why, and the rest of the page is drawn', async () => {
  const tree = { part: TEXT, export: 'Text', children: [
    { tool: 'tool:read-c', input: { id: 'a' } }, { tool: 'tool:read-clips', input: {} }, { tool: 'tool:read-c', input: { id: 'b' } },
  ] };
  const screens = new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }], ['tool:read-clips', { file: 'c/show/Clips.tsx', export: 'View' }]]);
  const told: string[] = [];
  const { drawn, timed } = await drawnTreeOf(tree, screens, async call => {
    if (call.tool === 'tool:read-clips') throw new Error('the engine refused the read');
    return { title: (call.input as { id: string }).id };
  }, undefined, line => told.push(line));
  assert.deepEqual(drawn, { module: `${TEXT}#Text`, children: [
    { module: 'c/show/C.tsx#View', props: { title: 'a' } }, { nodes: [] }, { module: 'c/show/C.tsx#View', props: { title: 'b' } },
  ] });
  assert.equal(timed.length, 3, 'the failed run is timed too');
  assert.deepEqual(told, ['tool:read-clips did not answer, so its part of the page is left out: the engine refused the read']);
  // The same node marked required fails the page.
  const strict = { ...tree, children: [tree.children[0], { ...tree.children[1], required: true as const }] };
  await assert.rejects(drawnTreeOf(strict, screens, async call => { if (call.tool === 'tool:read-clips') throw new Error('refused'); return {}; }), /refused/);
});

test('a tool node whose tool has no module screen here draws nothing and is not run; the rest of the page is drawn', async () => {
  const tree = { part: TEXT, export: 'Text', children: [{ tool: 'tool:read-c', input: {} }, { tool: 'tool:newer-than-this-commit', input: {} }] };
  const told: string[] = [];
  const asked: string[] = [];
  const { drawn } = await drawnTreeOf(tree, new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }]]), async call => { asked.push(call.tool); return { title: 'c' }; }, undefined, line => told.push(line));
  assert.deepEqual(drawn, { module: `${TEXT}#Text`, children: [{ module: 'c/show/C.tsx#View', props: { title: 'c' } }, { nodes: [] }] });
  assert.deepEqual(asked, ['tool:read-c']);
  assert.deepEqual(told, ['tool:newer-than-this-commit has no module screen in this program\'s tools, so its part of the page is left out.']);
});

test('a part file this commit lacks, or one without the export a row names, is found as the page bundle reads it, and only its nodes are taken out', async () => {
  const missing = await missingPartsOf([`${TEXT}#Text`, `${TEXT}#Section`, 'ui/show/no-such-part/NoSuchPart.tsx#View', '../outside.tsx#View'], file => partExportsOf(tools, file));
  assert.deepEqual(missing.map(part => part.key), [`${TEXT}#Section`, 'ui/show/no-such-part/NoSuchPart.tsx#View', '../outside.tsx#View']);
  assert.equal(missing[0].why, `${TEXT} has no export Section`);
  assert.equal(missing[1].why, 'ui/show/no-such-part/NoSuchPart.tsx is not in the tools folder');
  assert.match(missing[2].why, /not a part file's name/);
  const tree = { module: `${TEXT}#Text`, children: [{ module: `${TEXT}#Section`, children: [{ text: 'gone with its part' }] }, { nodes: [{ text: 'kept' }] }] };
  assert.deepEqual(withoutModules(tree, new Set([`${TEXT}#Section`])), { module: `${TEXT}#Text`, children: [{ nodes: [] }, { nodes: [{ text: 'kept' }] }] });
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

test('a tool or main node\'s props are the page\'s own words under the answer, which always wins', async () => {
  const page = pageOf({
    path: '/l', title: 'L', access: 'public', tool: 'tool:read-c', input: {}, collection: null, updated_at: null,
    layout: [{ main: true, props: { heading: 'Articles', title: 'row words lose' } }],
  });
  const { drawn } = await drawnTreeOf(treeOf(page, {}), new Map([['tool:read-c', { file: 'c/show/C.tsx', export: 'View' }]]), async () => ({ title: 'Seen' }));
  assert.deepEqual(drawn, { nodes: [{ module: 'c/show/C.tsx#View', props: { heading: 'Articles', title: 'Seen' } }] });
});

test('a font-face row is a family, weight, style and font file; anything else refuses the set, and it is never a CSS variable', () => {
  assert.deepEqual(fontFacesOf([{ name: 'font-face.text-400', value: 'SF Pro Text|400|normal|/assets/fonts/SF-Pro-Text-Regular.woff2' }, { name: 'theme', value: 'paper' }]),
    [{ family: 'SF Pro Text', weight: '400', style: 'normal', src: '/assets/fonts/SF-Pro-Text-Regular.woff2' }]);
  for (const value of ['SF Pro|400|normal|/x.png', "Evil'}|400|normal|/x.woff2", 'SF|450|normal|/x.woff2', 'SF|400|oblique|/x.woff2', 'SF|400|normal|javascript:x.woff2']) {
    assert.throws(() => fontFacesOf([{ name: 'font-face.x', value }]), /a font face is/, value);
  }
  assert.equal(lookCss([{ name: 'font-face.x', value: 'SF|400|normal|/x.woff2' }]), '');
});

test('a tool node may name another screen file, drawn with that tool\'s answer and needing no card screen', async () => {
  const page = pageOf({
    path: '/p', title: 'P', access: 'public', tool: null, input: null, collection: null, updated_at: null,
    layout: [{ tool: 'tool:read-pairs', input: { n: 1 }, part: 'pairs/show/Showcase.tsx', export: 'View', props: { label: 'All pairs' } }],
  });
  const { drawn } = await drawnTreeOf(treeOf(page, {}), new Map(), async () => ({ pairs: [1, 2] }));
  assert.deepEqual(drawn, { nodes: [{ module: 'pairs/show/Showcase.tsx#View', props: { label: 'All pairs', pairs: [1, 2] } }] });
});

test('a ":name" in a node\'s props, or in a layout tool node\'s input, takes the path\'s value', () => {
  const page = pageOf({
    path: '/c/:slug', title: 'C', access: 'public', tool: 'tool:read-c', input: { id: ':slug' }, collection: null, updated_at: null,
    layout: { part: TEXT, export: 'Text', props: { current: ':slug', word: ':other' }, children: [{ main: true, props: { here: ':slug' } }, { tool: 'tool:read-list', input: { except: ':slug' } }] },
  });
  assert.deepEqual(treeOf(page, { slug: 'x' }), {
    part: TEXT, export: 'Text', props: { current: 'x', word: ':other' },
    children: [{ tool: 'tool:read-c', input: { id: 'x' }, required: true, props: { here: 'x' } }, { tool: 'tool:read-list', input: { except: 'x' } }],
  });
});
