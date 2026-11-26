// tools/remove-objects-from-an-s3-store/test/remove-objects.test.ts
//
// Synthetic only: a made-up endpoint, bucket and key, and a fake store that holds objects in memory and answers signed HEAD,
// DELETE and ListObjectsV2 requests path-style, as an S3 store does. It shows the requests this tool makes (their address,
// method and signed region), what each key answers, that nothing is removed when the list is refused, and that no answer holds a
// held value. That a live store accepts it needs the person's store key in the vault and the tool run through the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOST_KEYS, exactKeys, removeObjects, type HeldStore } from '../do-work/remove-objects.ts';

const STORE: HeldStore = {
  keyId: 'EXAMPLEKEYID',
  secret: 'EXAMPLESECRETVALUE',
  endpoint: 'https://s3.example-region-1.store.example.test',
  bucket: 'example-files',
  region: 'example-region-1',
};
const ORIGIN = `${STORE.endpoint}/${STORE.bucket}/`;

// A store of key -> bytes that answers what an S3 store answers, and keeps every request it was sent.
function fakeStore(objects: Record<string, string>, { refuse = 0, failDeleteOf = '' } = {}) {
  const held = new Map(Object.entries(objects));
  const sent: { method: string; url: string; authorization: string }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ method: String(init.method), url, authorization: headers.authorization });
    assert.equal(init.redirect, 'error');
    if (refuse) return new Response(null, { status: refuse });
    const target = new URL(url);
    if (init.method === 'GET') {
      const prefix = target.searchParams.get('prefix') ?? '';
      const most = Number(target.searchParams.get('max-keys'));
      const keys = [...held.keys()].filter(key => key.startsWith(prefix)).sort();
      const page = keys.slice(0, most);
      const contents = page.map(key => `<Contents><Key>${key}</Key><LastModified>2026-11-25T09:46:00.000Z</LastModified><Size>${held.get(key)!.length}</Size></Contents>`).join('');
      return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${keys.length > most}</IsTruncated>${contents}</ListBucketResult>`, { status: 200 });
    }
    const key = decodeURIComponent(target.pathname.slice(`/${STORE.bucket}/`.length));
    if (init.method === 'HEAD') return held.has(key) ? new Response(null, { status: 200, headers: { 'content-length': String(held.get(key)!.length) } }) : new Response(null, { status: 404 });
    if (init.method === 'DELETE') {
      if (key === failDeleteOf) return new Response(null, { status: 500 });
      held.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return { held, sent, fetchImpl };
}

test('each named key is read, then removed, and answers what was there; an absent key answers absent', async () => {
  const store = fakeStore({ 'site/public/a b.html': 'aaaa', 'site/public/c.png': 'cc', 'site/kept/d.html': 'dddd' });
  const answer = await removeObjects(
    { store: 'files-store', keys: ['site/public/a b.html', 'site/public/c.png', 'site/public/gone.txt'] },
    { store: STORE, fetchImpl: store.fetchImpl, now: new Date('2026-11-26T08:00:00Z') },
  );
  assert.deepEqual(answer, {
    store: 'files-store',
    results: [
      { key: 'site/public/a b.html', result: 'removed', bytes: 4 },
      { key: 'site/public/c.png', result: 'removed', bytes: 2 },
      { key: 'site/public/gone.txt', result: 'absent' },
    ],
    removed: 2, absent: 1, failed: 0,
  });
  assert.deepEqual([...store.held.keys()], ['site/kept/d.html'], 'only the named keys are gone');
  assert.deepEqual(store.sent.map(item => `${item.method} ${item.url}`), [
    `HEAD ${ORIGIN}site/public/a%20b.html`, `DELETE ${ORIGIN}site/public/a%20b.html`,
    `HEAD ${ORIGIN}site/public/c.png`, `DELETE ${ORIGIN}site/public/c.png`,
    `HEAD ${ORIGIN}site/public/gone.txt`,
  ]);
  for (const { authorization } of store.sent) {
    assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID\/20261126\/example-region-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  }
  for (const value of Object.values(STORE)) assert.ok(!JSON.stringify(answer).includes(value), 'the answer holds no held value');
});

test('a prefix, a wildcard, a key named twice, a bad key or a list too long removes nothing', async () => {
  for (const keys of [['site/public/'], ['site/public/*'], ['site/public/a?.html'], ['site/a.html', 'site/a.html'], ['/site/a.html'], ['site/../a.html'], [], 'site/a.html', [7]]) {
    const store = fakeStore({ 'site/a.html': 'a' });
    await assert.rejects(removeObjects({ store: 'files-store', keys }, { store: STORE, fetchImpl: store.fetchImpl }));
    assert.equal(store.sent.length, 0, `${JSON.stringify(keys)} sends nothing`);
    assert.equal(store.held.size, 1);
  }
  assert.throws(() => exactKeys(Array.from({ length: MOST_KEYS + 1 }, (_, n) => `k/${n}`)), /1 to 1000/);
  assert.equal(exactKeys(Array.from({ length: MOST_KEYS }, (_, n) => `k/${n}`)).length, MOST_KEYS);
});

test('one key the store will not remove is answered failed and the others still go', async () => {
  const store = fakeStore({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, { failDeleteOf: 'b.txt' });
  const answer = await removeObjects({ store: 'files-store', keys: ['a.txt', 'b.txt', 'c.txt'] }, { store: STORE, fetchImpl: store.fetchImpl });
  assert.deepEqual(answer.results, [
    { key: 'a.txt', result: 'removed', bytes: 1 },
    { key: 'b.txt', result: 'failed', why: 'the store answered 500 to the removal' },
    { key: 'c.txt', result: 'removed', bytes: 1 },
  ]);
  assert.deepEqual([answer.removed, answer.failed], [2, 1]);
  assert.deepEqual([...store.held.keys()], ['b.txt']);
});

test('a refused key stops the run with words that name the store and hold no held value', async () => {
  for (const status of [401, 403]) {
    const store = fakeStore({ 'a.txt': 'a' }, { refuse: status });
    await assert.rejects(removeObjects({ store: 'files-store', keys: ['a.txt'] }, { store: STORE, fetchImpl: store.fetchImpl }), (error: Error) => {
      assert.match(error.message, new RegExp(`refused the held key \\(${status}\\)`));
      for (const value of Object.values(STORE)) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('list reads one page under a prefix and removes nothing', async () => {
  const store = fakeStore({ 'site/public/a.html': 'aaa', 'site/public/b.html': 'b', 'site/kept/c.html': 'cc' });
  const page = await removeObjects({ store: 'files-store', action: 'list', prefix: 'site/public/' }, { store: STORE, fetchImpl: store.fetchImpl });
  assert.deepEqual(page, {
    store: 'files-store', prefix: 'site/public/', truncated: false, next_token: null,
    objects: [
      { key: 'site/public/a.html', size: 3, last_modified: '2026-11-25T09:46:00.000Z' },
      { key: 'site/public/b.html', size: 1, last_modified: '2026-11-25T09:46:00.000Z' },
    ],
  });
  assert.equal(store.held.size, 3);
  assert.deepEqual(store.sent.map(item => item.method), ['GET']);
  assert.match(store.sent[0].url, /^https:\/\/s3\.example-region-1\.store\.example\.test\/example-files\?list-type=2&max-keys=1000&prefix=site%2Fpublic%2F$/);
  await assert.rejects(removeObjects({ store: 'files-store', action: 'list' }, { store: STORE, fetchImpl: store.fetchImpl }), /Name the prefix/);
});

test('a store with no key, no bucket, no region or an endpoint that is not an https root sends nothing', async () => {
  for (const store of [{ ...STORE, keyId: '' }, { ...STORE, bucket: 'Not A Bucket' }, { ...STORE, region: '' }, { ...STORE, endpoint: 'http://s3.example.test' }, { ...STORE, endpoint: 'https://s3.example.test/path' }]) {
    const fake = fakeStore({ 'a.txt': 'a' });
    await assert.rejects(removeObjects({ store: 'files-store', keys: ['a.txt'] }, { store, fetchImpl: fake.fetchImpl }));
    assert.equal(fake.sent.length, 0);
  }
});
