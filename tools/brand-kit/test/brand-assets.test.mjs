import { test } from 'node:test';
import assert from 'node:assert/strict';
import looks from '../../choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };
import { assetForBrand, backgroundTone, fallbackBrandAssetPath, fallbackBrandPalette, presentationFromBrand, readOperatorBrandPresentation, runBrandKit } from '../read-data/brand-asset-actions.mjs';

const look = id => looks.themes.find(row => row.payload.id === id).payload;
const rows = family => [
  { id: 'brand', values: { role: 'selection', family } },
  ...['old', 'new'].flatMap(name => ['black', 'white'].flatMap(colour => ['svg', 'png'].map(format => ({
    id: `${name}-${colour}-${format}`, values: { family: name, role: 'wordmark', format,
      background: `${colour} on transparent`, url: `https://example.com/${name}-${colour}.${format}` },
  })))),
];

test('one family row changes light share and dark email wordmarks in both formats', () => {
  const before = rows('old');
  const after = rows('new');
  assert.equal(backgroundTone(presentationFromBrand(before, look('trillion')).palette), 'light');
  assert.equal(backgroundTone(presentationFromBrand(before, look('trillion-black')).palette), 'dark');
  assert.equal(presentationFromBrand(before, look('trillion')).wordmark_svg.url, 'https://example.com/old-black.svg');
  assert.equal(presentationFromBrand(before, look('trillion-black')).wordmark_png.url, 'https://example.com/old-white.png');
  assert.equal(presentationFromBrand(after, look('trillion')).wordmark_svg.url, 'https://example.com/new-black.svg');
  assert.equal(presentationFromBrand(after, look('trillion-black')).wordmark_png.url, 'https://example.com/new-white.png');
  assert.equal(assetForBrand([{ id: 'brand', values: { role: 'selection', family: 'old' } },
    { id: 'unsafe', values: { family: 'old', role: 'wordmark', format: 'svg', background: 'black on transparent', url: 'javascript:alert(1)' } }],
  { role: 'wordmark', format: 'svg' }), null);
});

test('a transient public brand read uses the approved bundled role, format and tone', () => {
  assert.equal(backgroundTone(fallbackBrandPalette), 'dark', 'the fallback wordmark and stylesheet share a dark look');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg'), '/brand/wordmark-white-transparent.svg');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg', null), '/brand/wordmark-white-transparent.svg', 'a share-page request has no tone query');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg', 'light'), '/brand/wordmark-black-transparent.svg');
  assert.equal(fallbackBrandAssetPath('wordmark', 'png', 'dark'), '/brand/wordmark-white-transparent.png');
  assert.equal(fallbackBrandAssetPath('mark', 'svg'), '/brand/mark-white-black.svg');
  assert.equal(fallbackBrandAssetPath('mark', 'svg', 'light'), '/brand/mark-black-white.svg');
  assert.equal(fallbackBrandAssetPath('mark', 'png', 'dark'), '/brand/mark-white-black.png');
  assert.equal(fallbackBrandAssetPath('unknown', 'svg'), null);
  assert.equal(fallbackBrandAssetPath('mark', 'html'), null);
});

test('builders manage brand rows through the same list and look owners', async () => {
  const saved = { rows: [], list: null };
  const lists = {
    read: () => { if (!saved.list) throw new Error('missing'); return { list: saved.list, rows: saved.rows }; },
    save: input => { saved.list = input.remove ? null : input; if (input.remove) saved.rows = []; return { list: saved.list }; },
    putRows: (_, input) => { saved.rows = [...saved.rows.filter(row => !(input.remove ?? []).includes(row.id) && !(input.rows ?? []).some(write => write.id === row.id)), ...(input.rows ?? [])]; return { kept: input.rows ?? [], removed: input.remove ?? [] }; },
  };
  const owner = { lists, looks: { list: async () => ({ worn: 'trillion' }), read: async () => ({ look: look('trillion') }) } };
  await runBrandKit(owner, { action: 'create' });
  assert.equal((await runBrandKit(owner, { action: 'create' })).rows.length, 0, 'retrying create keeps one list');
  await runBrandKit(owner, { action: 'import', rows: rows('new').slice(1) });
  await runBrandKit(owner, { action: 'import', rows: rows('new').slice(1) });
  assert.equal((await runBrandKit(owner, { action: 'read' })).rows.length, rows('new').length - 1, 'retrying import upserts the same rows');
  await runBrandKit(owner, { action: 'edit', row_id: 'new-black-svg', values: { family: 'new', role: 'wordmark', format: 'svg', background: 'black on transparent', url: 'https://example.com/new-black.svg' } });
  await runBrandKit(owner, { action: 'select', family: 'new' });
  assert.equal((await runBrandKit(owner, { action: 'export' })).rows.length, rows('new').length);
  assert.equal((await runBrandKit(owner, { action: 'resolve', role: 'wordmark', format: 'svg' })).asset.url, 'https://example.com/new-black.svg');
  await assert.rejects(runBrandKit(owner, { action: 'remove', row_id: 'new-black-svg' }), /Select another/);
  await runBrandKit(owner, { action: 'save', row_id: 'spare', values: { family: 'spare', role: 'mark' } });
  await runBrandKit(owner, { action: 'remove', row_id: 'spare' });
  assert.equal((await runBrandKit(owner, { action: 'read' })).rows.length, rows('new').length);
  await runBrandKit(owner, { action: 'delete' });
  assert.throws(() => lists.read('brand-assets'), /missing/);
  await runBrandKit(owner, { action: 'create' });
  await assert.rejects(runBrandKit({ ...owner, mayDelete: false }, { action: 'delete' }), /in use/);
});

test('public brand reads the operator\'s own list and worn look through their routes', async () => {
  const paths = [];
  const consume = async (path, body, method) => {
    paths.push(path);
    if (path === '/lists/brand-assets') { assert.equal(method, 'GET'); return { rows: rows('new') }; }
    if (path === '/looks') { assert.equal(method, 'GET'); return { worn: 'trillion-black' }; }
    if (path === '/looks/read') {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { look_id: 'trillion-black' });
      return { look: look('trillion-black') };
    }
    return null;
  };
  const env = { OPERATOR_ACCOUNT_ID: 'operator', PERSON: { idFromName: name => name, get: () => ({}) } };
  const presentation = await readOperatorBrandPresentation(env, { consume });
  assert.deepEqual(paths, ['/lists/brand-assets', '/looks', '/looks/read']);
  assert.equal(presentation.wordmark_png.url, 'https://example.com/new-white.png');
  await assert.rejects(readOperatorBrandPresentation(env, { consume: async () => null }), /no route for \/lists\/brand-assets/);
});
