// tools/write-public-share-files/test/write-share-files.test.mjs
//
// The shell (do-work/write-share-files.mjs) over a stand-in records door and a temporary folder: it writes every public
// file at its served path, a manifest with each file's BLAKE3 identity, writes nothing again when nothing changed,
// removes every file of a link that ended and names them in the manifest, refuses bytes that are not the identity a row
// names, and asks to be woken at a link's expiry. Every name and address here is made up.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeShareFiles } from '../do-work/write-share-files.mjs';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const CODE = 'k'.repeat(48);
const picture = new TextEncoder().encode('not really a png, but bytes');
const identity = makeHashCodeHexFromBytes(picture);

function doorOf({ grant, bytes = picture } = {}) {
  const records = {
    sharing: [{ id: 'sharing:list:menu', type: 'sharing', value: { record: 'list:menu', leave_out: [], match_only: [], link_grants: [grant] } }],
    'record:dish': [
      { id: 'record:dish:d1', type: 'record:dish', value: { dish: 'Sea salt bun', taste: 'Plain and salty', photo: '/Menu/bun.png', cost: 'PRIVATE COST' } },
      { id: 'record:dish:d2', type: 'record:dish', value: { dish: 'Caramel twist', taste: 'Sweet' } },
    ],
  };
  const reads = [];
  return {
    reads,
    async read(type, id) { reads.push(`${type} ${id}`); return type === 'list' && id === 'list:menu'
      ? { label: 'Menu', about: 'What we bake.', row_type: 'dish', title_field: 'dish', fields: [{ id: 'dish', label: 'Dish', kind: 'text' }, { id: 'taste', label: 'Taste', kind: 'long-text' }, { id: 'photo', label: 'Photo', kind: 'file' }] } : null; },
    async *list({ type }) { reads.push(`list ${type}`); yield* records[type] ?? []; },
    async files(method, { name_or_identity: name, offset, length }) {
      reads.push(`${method} ${name} ${length}`);
      if (name !== '/Menu/bun.png' && name !== identity) throw new Error('no such file');
      const part = Buffer.from(bytes).subarray(offset, offset + length);
      return { identity, byte_length: bytes.length, media_type: 'image/png', bytes_returned: part.length, content: part.toString('base64'), encoding: 'base64' };
    },
  };
}
const grantOf = extra => ({ share_id: 's1', code: CODE, scope: { kind: 'public' }, can: ['view'], created_at: '2026-10-01T00:00:00Z', address: 'menu', listed: true, revoked_at: null, expires_at: null, ...extra });
const exists = path => stat(path).then(() => true, () => false);

test('writes every public file at its served path with a BLAKE3 manifest, rewrites nothing unchanged, and removes an ended link\'s files', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = { input: { origin: 'https://share.example', row_kind: 'record:dish' }, folder };
  const first = await writeShareFiles(input, { door: doorOf({ grant: grantOf({ expires_at: '2026-11-01T00:00:00Z' }) }), now: NOW });
  assert.deepEqual(first.published, [{ code: CODE, name: 'menu', listed: true }]);
  assert.deepEqual(first.wake_effects, [{ wake: { tool: 'tool:write-public-share-files', at_ms: Date.parse('2026-11-01T00:00:00Z'), input: { origin: 'https://share.example', row_kind: 'record:dish' } } }]);
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

  const again = await writeShareFiles(input, { door: doorOf({ grant: grantOf({ expires_at: '2026-11-01T00:00:00Z' }) }), now: NOW });
  assert.deepEqual([again.written, again.unchanged, again.removed], [0, 8, []]);

  const revoked = await writeShareFiles(input, { door: doorOf({ grant: grantOf({ revoked_at: '2026-10-05T12:00:00Z' }) }), now: NOW });
  assert.deepEqual(revoked.ended, [CODE]);
  assert.deepEqual(revoked.removed, [`files/${identity}`, `${CODE}.json`, 'menu.json', 'menu/caramel-twist/index.html', 'menu/index.html', 'menu/sea-salt-bun/index.html']);
  for (const path of revoked.removed) assert.equal(await exists(join(folder, path)), false, `${path} is not kept`);
  assert.equal(await exists(join(folder, 'menu')), false, 'an emptied folder goes too');
  const after = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(after.removed, revoked.removed);
  assert.deepEqual(after.files.map(file => file.path), ['llms.txt', 'sitemap.xml']);
  assert.doesNotMatch(await readFile(join(folder, 'sitemap.xml'), 'utf8'), /menu/);
});

test('a shared file whose bytes are not the identity its row names stops the run before the manifest changes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish' }, folder }, { door: doorOf({ grant: grantOf(), bytes: new TextEncoder().encode('other bytes') }), now: NOW }), /changed|identity/);
  assert.equal(await exists(join(folder, 'manifest.json')), false);
});

test('a link for named people reads no file of the person and writes no share files', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const door = doorOf({ grant: grantOf({ scope: { kind: 'email', value: 'bo@example.com' } }) });
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish' }, folder }, { door, now: NOW });
  assert.deepEqual(out.published, []);
  assert.equal(door.reads.some(read => read.startsWith('read_file')), false);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).files.map(file => file.path), ['llms.txt', 'sitemap.xml']);
});

test('the folder is named, and nothing is written outside it', async () => {
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:dish' } }, { door: doorOf({ grant: grantOf() }) }), /Name the folder/);
});

test('a List whose rows are a kind this run was not granted is left out and its rows are never listed', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'share-files-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const door = doorOf({ grant: grantOf() });
  const out = await writeShareFiles({ input: { origin: 'https://share.example', row_kind: 'record:other' }, folder }, { door, now: NOW });
  assert.deepEqual(out.published, []);
  assert.equal(out.left_out.length, 1);
  assert.equal(door.reads.includes('list record:dish'), false);
  await assert.rejects(writeShareFiles({ input: { origin: 'https://share.example' }, folder }, { door, now: NOW }), /row_kind/);
});
