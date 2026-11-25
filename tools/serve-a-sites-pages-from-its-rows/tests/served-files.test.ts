// Files a site answers itself from its store (a web app's shell, module scripts, engines, fonts), with 200 at its own origin:
// the rule's hosts, paths and named paths pick the key; the type comes from the name; one range is 206; an object is kept and
// asked again only after cache_seconds, with its ETag; a missing key is 404 and a failing store 502. A made-up store only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { servedFilesOf, servedKeyOf, StoreFiles } from '../do-work/served-files.ts';
import { settingsOf } from '../do-work/serve.ts';

const RULE = { hosts: ['app.example.com'], paths: ['/workspace/', '/app.js', '/engine.wasm'], named: { '/': 'index.html' }, key_prefix: 'site-app-files/', cache_seconds: 60 };
const STORE = { endpoint: 'https://store.example.test', region: 'r1', bucket: 'site-files', style: 'path' as const };
const KEY = { id: 'key-id', secret: 'key-secret' };

test('a rule names its keys by host, folder, whole path and named path', () => {
  const rules = servedFilesOf([RULE]);
  assert.deepEqual(servedKeyOf(rules, 'app.example.com', '/'), { rule: RULE, key: 'site-app-files/index.html' });
  assert.equal(servedKeyOf(rules, 'app.example.com', '/workspace/pdf/x.mjs')?.key, 'site-app-files/workspace/pdf/x.mjs');
  assert.equal(servedKeyOf(rules, 'app.example.com', '/engine.wasm')?.key, 'site-app-files/engine.wasm');
  assert.equal(servedKeyOf(rules, 'example.com', '/'), null, 'another host is not this rule\'s');
  for (const path of ['/workspace/', '/workspace/../secret', '/workspace/a/%2e%2e/b', '/other.js', '/app.js/x']) assert.equal(servedKeyOf(rules, 'app.example.com', path), null, path);
  for (const bad of [{}, [{ ...RULE, paths: ['/'] }], [{ ...RULE, named: { '/': '../x' } }], [{ ...RULE, key_prefix: 'a' }], [{ ...RULE, cache_seconds: 0 }], [{ ...RULE, hosts: ['App.example.com'] }]]) {
    assert.throws(() => servedFilesOf(bad), /served_files/, JSON.stringify(bad));
  }
});

test('a served file is 200 with the type its name gives, kept, asked again after cache_seconds with its ETag, and 206 for one range', async () => {
  let now = 1_000_000;
  const asked: { url: string; etag: string | null }[] = [];
  let body = 'console.log(1)';
  let etag = '"v1"';
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const given = new Headers(init?.headers).get('if-none-match');
    asked.push({ url: String(url), etag: given });
    if (String(url).includes('/missing.js')) return new Response('no', { status: 404 });
    if (String(url).includes('/broken.js')) return new Response('down', { status: 500 });
    if (given === etag) return new Response(null, { status: 304 });
    return new Response(body, { status: 200, headers: { etag, 'content-type': 'binary/octet-stream' } });
  }) as typeof fetch;
  const files = new StoreFiles(STORE, KEY, { fetchImpl, now: () => now });
  const rule = servedFilesOf([{ ...RULE, paths: ['/workspace/'] }])[0];
  const first = await files.answer(rule, 'site-app-files/workspace/app.js', undefined);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/javascript; charset=utf-8', 'the type comes from the name, not the store');
  assert.equal(first.headers['cache-control'], 'public, max-age=60');
  assert.equal(String(first.body), 'console.log(1)');
  assert.match(asked[0].url, /^https:\/\/store\.example\.test\/site-files\/site-app-files\/workspace\/app\.js\?.*X-Amz-Signature=/);
  assert.equal(asked[0].url.includes('key-secret'), false, 'the read key only signs');
  await files.answer(rule, 'site-app-files/workspace/app.js', undefined);
  assert.equal(asked.length, 1, 'kept: not asked again within cache_seconds');
  now += 61_000;
  await files.answer(rule, 'site-app-files/workspace/app.js', undefined);
  assert.deepEqual(asked.slice(1).map(a => a.etag), ['"v1"'], 'after cache_seconds it is asked again with its ETag, and 304 keeps it');
  now += 61_000;
  body = 'console.log(2)';
  etag = '"v2"';
  assert.equal(String((await files.answer(rule, 'site-app-files/workspace/app.js', undefined)).body), 'console.log(2)', 'a replaced object is served once asked again');
  const part = await files.answer(rule, 'site-app-files/workspace/app.js', 'bytes=0-6');
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 0-6/14');
  assert.equal(String(part.body), 'console');
  assert.equal(String((await files.answer(rule, 'site-app-files/workspace/app.js', 'bytes=-2')).body), '2)');
  assert.equal((await files.answer(rule, 'site-app-files/workspace/app.js', 'bytes=99-')).status, 416);
  assert.equal((await files.answer(rule, 'site-app-files/workspace/app.js', 'bytes=0-1,4-5')).status, 200, 'more than one range is the whole file');
  assert.equal((await files.answer(rule, 'site-app-files/workspace/missing.js', undefined)).status, 404);
  assert.equal((await files.answer(rule, 'site-app-files/workspace/broken.js', undefined)).status, 502);
  assert.equal((await files.answer(rule, 'site-app-files/workspace/x.wasm', undefined)).headers['content-type'], 'application/wasm');
});

test('served_files are checked with the settings and need a files store', () => {
  const base = {
    listen: '127.0.0.1:0', origin: 'https://example.com', lang: 'en', door: { address: 'http://127.0.0.1:1', pass_credential: 'p' },
    pages: { database: 'a_site', refresh_seconds: 60, answer_seconds: 0 },
    sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://example.com', audience: 'https://example.com', team_claim: 't', members_team: 'm' },
  };
  assert.throws(() => settingsOf({ ...base, served_files: [RULE] }), /need files_store/);
  assert.deepEqual(settingsOf({ ...base, files_store: { ...STORE, credential: 'store-read' }, served_files: [RULE] }).served_files, [RULE]);
  assert.deepEqual(settingsOf(base).served_files, []);
});
