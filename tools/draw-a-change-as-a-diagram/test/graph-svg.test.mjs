// test/graph-svg.test.mjs
//
// A graph document as one standalone SVG (parts/ui/show/layer-diagram/graph-svg.mjs): the same bytes every run, no script
// and no outside reference, colours baked from DATA palettes, moving dots only where a look asks for them, geometry that
// matches the page drawing's atlas, and files named by the BLAKE3 identity of their own bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import svgRules from '../parts/ui/show/layer-diagram/graph-svg.json' with { type: 'json' };
import contract from '../parts/ui/show/layer-diagram/graph-contract.json' with { type: 'json' };
import { graphIdentity, renderGraphDocument } from '../parts/ui/show/layer-diagram/graph-contract.mjs';
import { graphDocumentSvg, graphSvgAssets } from '../parts/ui/show/layer-diagram/graph-svg.mjs';

const change = () => ({
  schema_version: 1, id: 'change', label: 'A change to <checkout> & "billing"', caption: 'Added, changed and removed parts.',
  lanes: [
    { id: 'callers', label: 'Callers', nodes: [{ id: 'web', label: 'Web checkout', kind: 'service', delta: 'unchanged' }, { id: 'app', label: 'Mobile app', delta: 'unchanged', mark: { image: 'https://example.com/a.png' } }] },
    { id: 'core', label: 'Core', nodes: [{ id: 'pay', label: 'Payment service', detail: 'Now retries once', kind: 'service', delta: 'modified' }, { id: 'old', label: 'Legacy gateway', delta: 'removed' }] },
    { id: 'data', label: 'Data', nodes: [{ id: 'ledger', label: 'Ledger', kind: 'store', delta: 'added' }] },
  ],
  edges: [
    { from: 'web', to: 'pay', kind: 'calls', delta: 'unchanged' }, { from: 'app', to: 'pay', delta: 'unchanged' },
    { from: 'pay', to: 'ledger', kind: 'writes', delta: 'added' }, { from: 'pay', to: 'old', label: 'no longer', delta: 'removed' },
  ],
});

test('the same document draws the same bytes, and the file is self-contained', () => {
  const one = graphDocumentSvg(change());
  const two = graphDocumentSvg(structuredClone(change()));
  assert.equal(one.ok, true, JSON.stringify(one.errors));
  assert.equal(one.svg, two.svg);
  assert.equal(one.identity, `1f:${bytesToHex(blake3(new TextEncoder().encode(one.svg)))}`);
  assert.ok(one.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(!/<script|<style|<foreignObject|\son\w+=|href=|url\(|src=/iu.test(one.svg), 'no script, style, embedded page, handler or reference');
  assert.deepEqual([...one.svg.matchAll(/https?:\/\/[^"'\s<]+/gu)].map((found) => found[0]), ['http://www.w3.org/2000/svg'], 'the namespace is the only address in the file');
  assert.ok(!one.svg.includes('example.com'), 'an image mark is an outside reference and is not drawn');
});

test('words are escaped and wrapped where the page drawing puts them', () => {
  const drawn = graphDocumentSvg(change());
  assert.ok(drawn.svg.includes('<title>A change to &lt;checkout&gt; &amp; &quot;billing&quot;</title>'));
  assert.ok(drawn.svg.includes('<desc>Added, changed and removed parts.</desc>'));
  const wordsOf = (id) => [...new RegExp(`<g data-id="${id}"[^>]*>(.*?)</g>`, 'u').exec(drawn.svg)[1].matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map((found) => found[1]).join(' ');
  assert.equal(wordsOf('web'), 'S Web checkout');
  assert.equal(wordsOf('pay'), 'S Payment service Changed · Now retries once', 'a node\'s words, wrapped, in reading order');
  assert.equal(wordsOf('old'), 'Legacy gateway Removed');
  for (const word of ['Callers', 'Core', 'Data', 'Removed · no longer']) assert.ok(drawn.svg.includes(`>${word}</text>`), word);
  assert.ok(drawn.svg.includes('Added') && drawn.svg.includes('Removed'), 'change states read without colour');
  assert.ok(drawn.svg.includes('data-delta="removed"') && drawn.svg.includes('data-id="pay"'));
});

test('the atlas is the page drawing\'s atlas and the viewBox is its size', () => {
  const drawn = graphDocumentSvg(change());
  const page = renderGraphDocument(change());
  assert.deepEqual(drawn.atlas, page.atlas.across);
  assert.ok(drawn.svg.includes(`viewBox="0 0 ${drawn.atlas.width} ${drawn.atlas.height}"`));
  const down = graphDocumentSvg(change(), { orientation: 'down' });
  assert.deepEqual(down.atlas, page.atlas.down);
  assert.notEqual(down.svg, drawn.svg);
});

test('each palette is literal colours from DATA, and the neutral one has its own ground under every word', () => {
  for (const [name, colours] of Object.entries(svgRules.palettes)) {
    const drawn = graphDocumentSvg(change(), { palette: name });
    assert.equal(drawn.ok, true);
    assert.ok(drawn.svg.includes(`fill="${colours.words}"`), `${name} words`);
    assert.ok(drawn.svg.includes(`fill="${colours.card}"`), `${name} card`);
    assert.equal(drawn.svg.includes(`<rect width="${drawn.atlas.width}" height="${drawn.atlas.height}" fill=`), colours.page !== null, `${name} page ground`);
    assert.ok(!/var\(|currentColor/u.test(drawn.svg), `${name} has no variable`);
  }
  const neutral = graphDocumentSvg(change(), { palette: 'neutral' });
  const heads = [...neutral.svg.matchAll(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="26" rx="6" fill="([^"]+)"/gu)];
  assert.equal(heads.length, 3);
  assert.ok(heads.every((found) => found[1] === svgRules.palettes.neutral.chip), 'every heading has a ground');
  const refused = graphDocumentSvg(change(), { palette: 'nowhere' });
  assert.deepEqual([refused.ok, refused.errors[0].code], [false, 'UNKNOWN_PALETTE']);
  assert.match(refused.errors[0].message, /light, dark, neutral/);
});

test('moving dots follow the edges whose look pulses, start mid-cycle, and can be turned off', () => {
  const drawn = graphDocumentSvg(change());
  const pulsing = svgRules.edge_looks;
  assert.equal(renderGraphDocument(change()).atlas.across.edges.length, 4);
  const moves = [...drawn.svg.matchAll(/<animateMotion dur="2.8s" repeatCount="indefinite" begin="(-[0-9.]+s)" path="([^"]+)"\/>/gu)];
  assert.equal(moves.length, 1, 'only the added edge is strong');
  assert.ok(moves.every((found) => Number.parseFloat(found[1]) <= 0), 'a negative begin starts it mid-cycle');
  assert.ok(Object.values(pulsing).filter((look) => look.pulse).length >= 1);
  assert.ok(drawn.atlas.edges.some((edge) => moves.some((found) => found[2] === edge.d)));
  const still = graphDocumentSvg(change(), { animated: false });
  assert.ok(!still.svg.includes('animateMotion'));
});

test('a refused document draws nothing and says why', () => {
  const broken = change();
  broken.edges.push({ from: 'web', to: 'ghost', delta: 'added' });
  const drawn = graphDocumentSvg(broken);
  assert.deepEqual([drawn.ok, drawn.svg, drawn.atlas, drawn.identity, drawn.name], [false, '', null, null, null]);
  assert.ok(drawn.errors.some((error) => error.code === 'BROKEN_REFERENCE'));
  assert.equal(graphSvgAssets(broken).ok, false);
});

test('assets are named by their own bytes and the manifest says which document and renderer they came from', () => {
  const assets = graphSvgAssets(change());
  assert.equal(assets.ok, true, JSON.stringify(assets.errors));
  assert.equal(assets.manifest.graph, graphIdentity(change()));
  assert.equal(assets.manifest.renderer_version, svgRules.renderer_version);
  assert.deepEqual(assets.manifest.assets.map((asset) => asset.palette), Object.keys(svgRules.palettes));
  for (const asset of assets.manifest.assets) {
    const bytes = new TextEncoder().encode(assets.files[asset.name]);
    const hex = bytesToHex(blake3(bytes));
    assert.equal(asset.identity, `1f:${hex}`);
    assert.equal(asset.bytes, bytes.length);
    assert.equal(asset.name, `change-${asset.palette}-${hex.slice(0, svgRules.hash_characters)}.svg`);
  }
  // A change of one word changes a name; the same document does not.
  const again = graphSvgAssets(change());
  assert.deepEqual(Object.keys(again.files), Object.keys(assets.files));
  const other = change(); other.lanes[0].nodes[0].label = 'Website checkout';
  assert.notDeepEqual(Object.keys(graphSvgAssets(other).files), Object.keys(assets.files));
});

test('a new palette and a new tone look are rows, not code', () => {
  const rules = structuredClone(svgRules);
  rules.palettes.sepia = { page: '#f4ecd8', chip: '#f4ecd8', card: '#fbf5e6', line: '#a89877', words: '#3b2f1b', quiet: '#7a6a4b', accent: '#8a3b12', on_accent: '#fff' };
  const drawn = graphDocumentSvg(change(), { palette: 'sepia' }, rules);
  assert.equal(drawn.ok, true);
  assert.ok(drawn.svg.includes('fill="#f4ecd8"') && drawn.name.startsWith('change-sepia-'));
  const contractRules = structuredClone(contract);
  contractRules.delta.states.parked = { node: 'parked', edge: 'parked', label: 'Parked' };
  rules.node_looks.parked = { fill: 'chip', line: 'quiet', width: 1, words: 'quiet', detail: 'quiet', mark: 'quiet', mark_words: 'card' };
  const document = change(); document.lanes[0].nodes[0].delta = 'parked';
  assert.ok(graphDocumentSvg(document, { palette: 'light' }, rules, contractRules).svg.includes(`fill="${rules.palettes.light.chip}" stroke="${rules.palettes.light.quiet}" stroke-width="1"`));
});

test('a surface is a row that picks the palette, the motion and the reveal; options beside it win; an unknown surface is refused', () => {
  for (const [name, row] of Object.entries(svgRules.surfaces)) {
    const drawn = graphDocumentSvg(change(), { surface: name });
    assert.equal(drawn.ok, true, name);
    assert.ok(drawn.name.startsWith(`change-${row.palette}-`), name);
    assert.equal(drawn.svg.includes('animateMotion'), row.animated, `${name} motion`);
    assert.equal(drawn.svg.includes('attributeName="stroke-dashoffset"') || drawn.svg.includes('attributeName="stroke-opacity"'), row.reveal, `${name} reveal`);
  }
  assert.ok(graphDocumentSvg(change(), { surface: 'email', palette: 'dark' }).name.startsWith('change-dark-'));
  assert.ok(graphDocumentSvg(change(), { surface: 'email', animated: true }).svg.includes('animateMotion'));
  const refused = graphDocumentSvg(change(), { surface: 'fax' });
  assert.deepEqual([refused.ok, refused.errors[0].code], [false, 'UNKNOWN_SURFACE']);
  assert.match(refused.errors[0].message, /email/);
});

test('lines draw themselves in one after another: solid ones along their length, dashed ones by fading in', () => {
  const drawn = graphDocumentSvg(change(), { surface: 'page-light' });
  const solid = [...drawn.svg.matchAll(/<path d="[^"]+" fill="none"[^>]*pathLength="1"[^>]*><animate attributeName="stroke-dashoffset" from="1" to="0" dur="0.9s" begin="([0-9.]+)s" fill="freeze"\/>/gu)];
  assert.equal(solid.length, 2, 'the two unchanged (solid) lines');
  const begins = solid.map((found) => Number(found[1]));
  assert.equal(begins[0], 0);
  assert.ok(begins[1] > begins[0], 'each line starts after the one before');
  const fades = [...drawn.svg.matchAll(/<animate attributeName="stroke-opacity" from="0" to="[0-9.]+" dur="0.9s" begin="[0-9.]+s" fill="freeze"\/>/gu)];
  assert.equal(fades.length, 2, 'the added (dashed, strong) and removed (dotted) lines');
  assert.ok(!graphDocumentSvg(change(), { surface: 'email' }).svg.includes('<animate '));
});
