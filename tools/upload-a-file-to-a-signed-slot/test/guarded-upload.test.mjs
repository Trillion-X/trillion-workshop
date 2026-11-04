// tools/upload-a-file-to-a-signed-slot/test/guarded-upload.test.mjs
//
// A hosted page may have this computer upload a file only to a destination a row names (read-data/guarded-upload.mjs): the slot is
// checked whole before any byte leaves; the page learns a size, not the file; the held file is used once and expires.
// Moved from Trillion-X/trillion test/guarded-upload.test.mjs (dc79bb0a87^) with its import repointed; the last tests are
// the Workshop entry, which reads the file from the folder the person granted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSlot, makeGuardedUploads, uploadFromFolder, uploadSettings } from '../read-data/guarded-upload.mjs';

const settings = { ...uploadSettings(), destinations: [{ host: 'storage.example.test', path_prefix: '/diagnostics-bucket', max_fields: 4, content_types: ['application/zip'] }] };
const good = { url: 'https://storage.example.test/diagnostics-bucket', fields: { key: 'a/b.zip', policy: 'p', signature: 's' } };
const refused = (call, status, words) => assert.throws(call, error => { assert.equal(error.status, status); assert.match(error.message, words); return true; });

test('the shipped list uploads nowhere', () => {
  assert.deepEqual(uploadSettings().destinations, []);
  refused(() => checkSlot(good, 'application/zip'), 403, /does not upload to storage.example.test/);
});

test('a slot is allowed only when every part fits its row', () => {
  assert.equal(checkSlot(good, 'application/zip', settings).row.host, 'storage.example.test');
  assert.ok(checkSlot({ ...good, url: `${good.url}/inner/dir` }, 'application/zip', settings));
  refused(() => checkSlot({ ...good, url: 'http://storage.example.test/diagnostics-bucket' }, 'application/zip', settings), 400, /https/);
  refused(() => checkSlot({ ...good, url: 'https://evil.example.test/diagnostics-bucket' }, 'application/zip', settings), 403, /does not upload to evil/);
  refused(() => checkSlot({ ...good, url: 'https://storage.example.test/other-bucket' }, 'application/zip', settings), 403, /outside the folder/);
  refused(() => checkSlot({ ...good, url: 'https://storage.example.test/diagnostics-bucket-evil' }, 'application/zip', settings), 403, /outside the folder/);
  refused(() => checkSlot({ ...good, url: 'https://storage.example.test/diagnostics-bucket/../x' }, 'application/zip', settings), 403, /outside the folder/);
  for (const url of ['https://storage.example.test/diagnostics-bucket?x=1', 'https://u:user-1c314559@example.com/diagnostics-bucket', 'https://storage.example.test:8443/diagnostics-bucket', 'https://storage.example.test/diagnostics-bucket#f', 'not a url'])
    refused(() => checkSlot({ ...good, url }, 'application/zip', settings), 400, /query, credentials, a port or no host/);
  refused(() => checkSlot({ ...good, fields: { a: '1', b: '2', c: '3', d: '4', e: '5' } }, 'application/zip', settings), 400, /5 fields; at most 4/);
  refused(() => checkSlot({ ...good, fields: { a: { x: 1 } } }, 'application/zip', settings), 400, /field a is not text/);
  refused(() => checkSlot(good, 'text/html', settings), 403, /files of type text\/html/);
});

test('the page learns an id and a size; the file is posted once, form fields first, never by the page', async () => {
  const sent = [];
  const uploads = makeGuardedUploads({ settings, fetchImpl: async (url, init) => { sent.push({ url, form: init.body }); return { ok: true, status: 204 }; } });
  const archive = Buffer.from('PK zip bytes');
  const held = uploads.prepare({ bytes: archive, contentType: 'application/zip', name: 'diag.zip' });
  assert.deepEqual(Object.keys(held).sort(), ['id', 'size']);
  assert.equal(held.size, archive.length);
  const done = await uploads.send({ id: held.id, slot: good });
  assert.equal(done.size, archive.length);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, good.url);
  assert.deepEqual([...sent[0].form.keys()], ['key', 'policy', 'signature', 'file']);
  assert.equal(Buffer.from(await sent[0].form.get('file').arrayBuffer()).toString(), 'PK zip bytes');
  await assert.rejects(uploads.send({ id: held.id, slot: good }), error => error.status === 404);
});

test('a refused slot does not use the file up; a held file expires; a storage refusal says it may be tried again', async () => {
  let clock = 1_000_000;
  let answer = 403;
  const uploads = makeGuardedUploads({ settings, now: () => clock, fetchImpl: async () => new Response('', { status: answer }) });
  const held = uploads.prepare({ bytes: Buffer.from('x'), contentType: 'application/zip' });
  await assert.rejects(uploads.send({ id: held.id, slot: { ...good, url: 'https://evil.example.test/diagnostics-bucket' } }), error => error.status === 403);
  await assert.rejects(uploads.send({ id: held.id, slot: good }), error => { assert.equal(error.status, 502); assert.equal(error.retry, true); assert.doesNotMatch(error.message, /signature|policy/); return true; });
  const again = uploads.prepare({ bytes: Buffer.from('x'), contentType: 'application/zip' });
  clock += settings.hold_minutes * 60_000 + 1;
  await assert.rejects(uploads.send({ id: again.id, slot: good }), error => error.status === 404 && /15 minutes/.test(error.message));
  assert.throws(() => uploads.prepare({ bytes: Buffer.alloc(settings.max_hold_bytes + 1), contentType: 'application/zip' }), error => error.status === 413);
});

// A granted folder with one file in it, a folder beside it the tool was not granted, and a link out of the granted one.
function aGrantedFolder(t) {
  const place = mkdtempSync(join(tmpdir(), 'guarded-upload-'));
  t.after(() => rmSync(place, { recursive: true, force: true }));
  const folder = join(place, 'granted');
  mkdirSync(join(folder, 'inner'), { recursive: true });
  writeFileSync(join(folder, 'inner', 'diag.zip'), 'PK zip bytes');
  writeFileSync(join(place, 'secret.zip'), 'not granted');
  symlinkSync(join(place, 'secret.zip'), join(folder, 'link.zip'));
  return folder;
}

test('the Workshop entry reads the file from the granted folder and posts it once to the checked slot', async t => {
  const folder = aGrantedFolder(t);
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, form: init.body }); return { ok: true, status: 204 }; };
  const done = await uploadFromFolder({ input: { file: 'inner/diag.zip', content_type: 'application/zip', slot: good }, folder }, { settings, fetchImpl });
  assert.deepEqual(done, { sent: true, size: 12, said: 'Uploaded 12 bytes.' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, good.url);
  assert.deepEqual([...sent[0].form.keys()], ['key', 'policy', 'signature', 'file']);
  assert.equal(sent[0].form.get('file').name, 'diag.zip');
  assert.equal(Buffer.from(await sent[0].form.get('file').arrayBuffer()).toString(), 'PK zip bytes');
});

test('the Workshop entry reads nothing outside the granted folder and sends nothing to a slot no row allows', async t => {
  const folder = aGrantedFolder(t);
  const sent = [];
  const fetchImpl = async url => { sent.push(url); return { ok: true, status: 204 }; };
  const call = (input, given = folder) => uploadFromFolder({ input: { content_type: 'application/zip', slot: good, ...input }, folder: given }, { settings, fetchImpl });
  const refusedWith = (status, words) => error => { assert.equal(error.status, status); assert.match(error.message, words); assert.doesNotMatch(error.message, /signature|policy/); return true; };
  await assert.rejects(call({ file: '../secret.zip' }), refusedWith(400, /not a file inside the folder/));
  await assert.rejects(call({ file: join(folder, '..', 'secret.zip') }), refusedWith(400, /not a file inside the folder/));
  await assert.rejects(call({ file: 'link.zip' }), refusedWith(400, /not a file inside the folder/));
  await assert.rejects(call({ file: 'inner' }), refusedWith(404, /not a file in the folder/));
  await assert.rejects(call({ file: 'missing.zip' }), refusedWith(404, /not a file in the folder/));
  await assert.rejects(call({ file: 'inner/diag.zip' }, null), refusedWith(403, /No folder is granted/));
  await assert.rejects(call({ file: 'inner/diag.zip', slot: { ...good, url: 'https://evil.example.test/diagnostics-bucket' } }), refusedWith(403, /does not upload to evil/));
  await assert.rejects(call({ file: 'inner/diag.zip', content_type: 'text/html' }), refusedWith(403, /files of type text\/html/));
  await assert.rejects(uploadFromFolder({ input: { file: 'inner/diag.zip', content_type: 'application/zip', slot: good }, folder }, { settings: { ...settings, max_hold_bytes: 4 }, fetchImpl }), refusedWith(413, /12 bytes; at most 4/));
  await assert.rejects(uploadFromFolder({ input: { file: 'inner/diag.zip', content_type: 'application/zip', slot: good }, folder }, { fetchImpl }), refusedWith(403, /does not upload to storage.example.test/));
  assert.deepEqual(sent, []);
});
