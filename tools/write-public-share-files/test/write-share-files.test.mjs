// tools/write-public-share-files/test/write-share-files.test.mjs
//
// The shell (do-work/write-share-files.mjs) over the records and files handed in as input, in a temporary folder: it writes every public
// file at its served path, a manifest with each file's BLAKE3 identity, writes nothing again when nothing changed,
// removes every file of a link that ended and names them in the manifest, refuses a file a row names that was not given,
// and asks to be woken at a link's expiry. Every name and address here is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeShareFiles } from '../do-work/write-share-files.mjs';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const CODE = 'k'.repeat(48);
const picture = new TextEncoder().encode('not really a png, but bytes');
const identity = makeHashCodeHexFromBytes(picture);

// The records the caller read from the person's own store and hands in as input.records: sharing, the List, its rows.
function recordsOf({ grant } = {}) {
  return [
    { id: 'sharing:list:menu', type: 'sharing', value: { record: 'list:menu', leave_out: [], match_only: [], link_grants: [grant] } },
    { id: 'list:menu', type: 'list', value: { label: 'Menu', about: 'What we bake.', row_type: 'dish', title_field: 'dish', fields: [{ id: 'dish', label: 'Dish', kind: 'text' }, { id: 'taste', label: 'Taste', kind: 'long-text' }, { id: 'photo', label: 'Photo', kind: 'file' }] } },
    { id: 'record:dish:d1', type: 'record:dish', value: { dish: 'Sea salt bun', taste: 'Plain and salty', photo: '/Menu/bun.png', cost: 'PRIVATE COST' } },
    { id: 'record:dish:d2', type: 'record:dish', value: { dish: 'Caramel twist', taste: 'Sweet' } },
  ];
}

// The files the caller read from the person's own files and hands in as input.stored.files.
const stored = (bytes = picture) => ({ files: { '/Menu/bun.png': { base64: Buffer.from(bytes).toString('base64'), media_type: 'image/png' } } });
const grantOf = extra => ({ share_id: 's1', code: CODE, scope: { kind: 'public' }, can: ['view'], created_at: '2026-10-01T00:00:00Z', address: 'menu', listed: true, revoked_at: null, expires_at: null, ...extra });
const exists = path => stat(path).then(() => true, () => false);

test('writes every public file at its served path with a BLAKE3 manifest, rewrites nothing unchanged, and removes an ended link\'s files', async t => {
  const folder = tempFolder(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const base = { origin: 'https://share.example', row_kind: 'record:dish' };
  const input = { input: { ...base, records: recordsOf({ grant: grantOf({ expires_at: '2026-11-01T00:00:00Z' }) }), stored: stored() }, folder };
  const first = await writeShareFiles(input, { now: NOW });
  assert.deepEqual(first.published, [{ code: CODE, name: 'menu', listed: true }]);
  assert.deepEqual(first.wake_effects, [{ wake: { tool: 'tool:write-public-share-files', at_ms: Date.parse('2026-11-01T00:00:00Z'), input: base } }], 'the wake carries no records: it asks for fresh ones');
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'trillion.public-share-files/v1');
  assert.deepEqual(manifest.files.map(file => file.path), [`files/${identity}`, `${CODE}.json`, 'llms.txt', 'menu.json', 'menu/caramel-twist/index.html', 'menu/index.html', 'menu/sea-salt-bun/index.html', 'sitemap.xml']);
  for (const file of manifest.files) {
    assert.match(file.identity, /^1f:[0-9a-f]{64}$/);
    assert.equal(makeHashCodeHexFromBytes(await readFile(join(folder, file.path))), file.identity, `${file.path} holds the bytes its identity names`);
  }
  assert.deepEqual(await readFile(join(folder, 'files', identity)), Buffer.from(picture));
  const data = JSON.parse(await readFile(join(folder, `${CODE}.json`), 'utf8'));
  assert.deepEqual(data.rows.map(row => row.title).sort(), ['Caramel twist', 'Sea salt bun']);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE COST/);
  assert.equal(first.written, 8);
  assert.deepEqual(first.host_files, { path: '/share/', folder, index: 'index.html', exclude: ['manifest.json'], media_types: { [`files/${identity}`]: 'image/png' } });

  const again = await writeShareFiles({ input: { ...base, records: recordsOf({ grant: grantOf({ expires_at: '2026-11-01T00:00:00Z' }) }), stored: stored() }, folder }, { now: NOW });
  assert.deepEqual([again.written, again.unchanged, again.removed], [0, 8, []]);

  const revoked = await writeShareFiles({ input: { ...base, records: recordsOf({ grant: grantOf({ revoked_at: '2026-10-05T12:00:00Z' }) }), stored: stored() }, folder }, { now: NOW });
  assert.deepEqual(revoked.ended, [CODE]);
  assert.deepEqual(revoked.host_files.media_types, {}, 'ended media no longer appears in desired host DATA');
  assert.deepEqual(revoked.removed, [`files/${identity}`, `${CODE}.json`, 'menu.json', 'menu/caramel-twist/index.html', 'menu/index.html', 'menu/sea-salt-bun/index.html']);
  for (const path of revoked.removed) assert.equal(await exists(join(folder, path)), false, `${path} is not kept`);
  assert.equal(await exists(join(folder, 'menu')), false, 'an emptied folder goes too');
  const after = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(after.removed, revoked.removed);
  assert.deepEqual(after.files.map(file => file.path), ['llms.txt', 'sitemap.xml']);
  assert.doesNotMatch(await readFile(join(folder, 'sitemap.xml'), 'utf8'), /menu/);
});

test('a file a shown row names that was not handed in is not published, and its row never points at it', async t => {
  const folder = tempFolder(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish', records: recordsOf({ grant: grantOf() }) }, folder }, { now: NOW });
  assert.deepEqual(out.published, [{ code: CODE, name: 'menu', listed: true }]);
  const files = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).files.map(file => file.path);
  assert.equal(files.some(path => path.startsWith('files/')), false);
  assert.doesNotMatch(await readFile(join(folder, `${CODE}.json`), 'utf8'), new RegExp(identity));
});

test('a link for named people writes no share files and none of the given files', async t => {
  const folder = tempFolder(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish', records: recordsOf({ grant: grantOf({ scope: { kind: 'email', value: 'user-23ef710c@example.com' } }) }), stored: stored() }, folder }, { now: NOW });
  assert.deepEqual(out.published, []);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).files.map(file => file.path), ['llms.txt', 'sitemap.xml']);
});

test('the folder is named, and nothing is written outside it', async () => {
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish', records: recordsOf({ grant: grantOf() }), stored: stored() } }), /Name the folder/);
});

test('a List whose rows are a kind this run was not granted is left out and none of its files are written', async t => {
  const folder = tempFolder(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:other', records: recordsOf({ grant: grantOf() }), stored: stored() }, folder }, { now: NOW });
  assert.deepEqual(out.published, []);
  assert.equal(out.left_out.length, 1);
  assert.equal(await exists(join(folder, 'files', identity)), false, 'no shared file of the other kind is written');
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example', records: [] }, folder }, { now: NOW }), /row_kind/);
});

test('the sharing rows are the consent: leaving them out is refused, while an empty list given on purpose publishes nothing', async t => {
  const folder = tempFolder(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish', stored: stored() }, folder }, { now: NOW }), /records are required/);
  assert.equal(await exists(join(folder, 'manifest.json')), false, 'a refused run changes nothing');
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish', records: [], stored: stored() }, folder }, { now: NOW });
  assert.deepEqual([out.published, out.left_out], [[], []]);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).files.map(file => file.path), ['llms.txt', 'sitemap.xml']);
});
