// tools/put-an-object-in-an-s3-store/test/put-object.test.mjs
//
// Synthetic only: a made-up endpoint, bucket and key, and a fake store that keeps what one PUT sends. It shows the request
// this tool makes (its address, its signed scope and payload hash, its length and bytes) and its refusals; that a live store
// accepts it needs the person's store key in the vault and the tool run through the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkedKey, fileInFolder, putObject } from '../do-work/put-object.mjs';

const STORE = {
  keyId: 'EXAMPLEKEYID',
  secret: 'EXAMPLESECRETVALUE',
  endpoint: 'https://s3.example-region-1.store.example.test',
  bucket: 'example-downloads',
  region: 'example-region-1',
};

function folderWith(files) {
  const folder = mkdtempSync(join(tmpdir(), 'put-object-'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(folder, name), bytes);
  return folder;
}

function keepingStore(status = 200) {
  const kept = [];
  const fetchImpl = async (url, init) => {
    const body = Buffer.from(await new Response(init.body).arrayBuffer());
    kept.push({ url, init, body });
    return new Response(null, { status, headers: { etag: '"abc123"' } });
  };
  return { kept, fetchImpl };
}

test('one put sends the file to the bucket key, signed for the store region with the file SHA-256', async () => {
  const bytes = Buffer.from('<?xml version="1.0"?><rss/>');
  const folder = folderWith({ 'appcast.xml': bytes });
  const { kept, fetchImpl } = keepingStore();
  const answer = await putObject(
    { input: { store: 'downloads-store', file: 'appcast.xml', key: 'feeds/app cast.xml', content_type: 'application/xml', cache_control: 'max-age=60' }, folder },
    { store: STORE, fetchImpl, now: new Date('2026-11-24T20:00:00Z') },
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(answer, {
    store: 'downloads-store', key: 'feeds/app cast.xml', bytes: bytes.length, blake3: bytesToHex(blake3(bytes)), sha256, etag: 'abc123',
  });
  assert.equal(kept.length, 1);
  const [{ url, init, body }] = kept;
  assert.equal(url, 'https://s3.example-region-1.store.example.test/example-downloads/feeds/app%20cast.xml');
  for (const held of Object.values(STORE)) assert.ok(!JSON.stringify(answer).includes(held), 'the answer holds no held value');
  assert.equal(init.method, 'PUT');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-amz-content-sha256'], sha256);
  assert.equal(init.headers['content-length'], String(bytes.length));
  assert.equal(init.headers['content-type'], 'application/xml');
  assert.equal(init.headers['cache-control'], 'max-age=60');
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID\/20261124\/example-region-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(body, bytes);
  assert.ok(!JSON.stringify(answer).includes(STORE.secret));
});

test('a name that leaves the granted folder, by dots, by an absolute path or by a link, names nothing', () => {
  const outside = folderWith({ 'secret.txt': 'x' });
  const folder = folderWith({ 'App.dmg': 'dmg' });
  mkdirSync(join(folder, 'inner'));
  symlinkSync(join(outside, 'secret.txt'), join(folder, 'inner', 'link.txt'));
  assert.match(fileInFolder(folder, 'App.dmg'), /App\.dmg$/);
  assert.throws(() => fileInFolder(folder, '../secret.txt'), /not a file inside the granted folder/);
  assert.throws(() => fileInFolder(folder, join(outside, 'secret.txt')), /not a file inside the granted folder/);
  assert.throws(() => fileInFolder(folder, 'inner/link.txt'), /not a file inside the granted folder/);
  assert.throws(() => fileInFolder(folder, 'inner'), /is not a file/);
  assert.throws(() => fileInFolder(folder, 'missing.dmg'), /not in the granted folder/);
  assert.throws(() => fileInFolder('', 'App.dmg'), /given no folder/);
});

test('an object key with a leading slash, a dot segment or a control character is refused', () => {
  assert.equal(checkedKey('App-202611241617.dmg'), 'App-202611241617.dmg');
  for (const key of ['', '/App.dmg', 'a/../b', './a', 'a\nb', 'x'.repeat(1025)]) assert.throws(() => checkedKey(key), /object key/);
});

test('a refused key, a missing key value and a bad store value each answer in words and send nothing more', async () => {
  const folder = folderWith({ 'App.dmg': 'dmg' });
  const input = { store: 'downloads-store', file: 'App.dmg', key: 'App.dmg', content_type: 'application/octet-stream' };
  await assert.rejects(putObject({ input, folder }, { store: STORE, fetchImpl: keepingStore(403).fetchImpl }), /refused the held key \(403\)/);
  await assert.rejects(putObject({ input, folder }, { store: { ...STORE, secret: '' }, fetchImpl: keepingStore().fetchImpl }), /No key for downloads-store/);
  await assert.rejects(putObject({ input, folder }, { store: { ...STORE, endpoint: 'http://plain.example.test' }, fetchImpl: keepingStore().fetchImpl }), /must be an https address/);
  await assert.rejects(putObject({ input, folder }, { store: { ...STORE, region: '' }, fetchImpl: keepingStore().fetchImpl }), /valid region/);
  await assert.rejects(putObject({ input: { ...input, content_type: 'not a type' }, folder }, { store: STORE, fetchImpl: keepingStore().fetchImpl }), /media type/);
  await assert.rejects(putObject({ input: { ...input, cache_control: 'max-age=60\r\nx: y' }, folder }, { store: STORE, fetchImpl: keepingStore().fetchImpl }), /cache_control/);
});
