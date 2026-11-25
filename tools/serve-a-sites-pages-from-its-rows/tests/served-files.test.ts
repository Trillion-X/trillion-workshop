// Files a site answers itself from its store (a web app's shell, module scripts, engines, fonts), with 200 at its own origin:
// the rule's hosts, paths and named paths pick the key; the type comes from the name; one range is 206; an object is kept and
// asked again only after cache_seconds, with its ETag; a missing key is 404 and a failing store 502. A made-up store only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closedOnHost, ListedPaths, listedPathsOf, servedFilesOf, servedKeyOf, StoreFiles } from '../do-work/served-files.ts';
import { handlerOf, settingsOf } from '../do-work/serve.ts';
import type { Site } from '../do-work/serve.ts';

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

test('only_listed_by names a tool, an input object and seconds from 1 to 3600, and caps a browser\'s max-age at its seconds', async () => {
  const by = { tool: 'tool:read-the-listed-files', input: { database: 'a_site', limit: 100 }, seconds: 60 };
  assert.deepEqual(servedFilesOf([{ ...RULE, only_listed_by: by }])[0].only_listed_by, by);
  for (const bad of [{ ...by, tool: 'read-the-listed-files' }, { ...by, tool: 'tool:Read' }, { ...by, input: [] }, { ...by, input: null }, { ...by, seconds: 0 },
    { ...by, seconds: 3601 }, { ...by, seconds: 1.5 }, { ...by, extra: 1 }, 'tool:read-the-listed-files', null]) {
    assert.throws(() => servedFilesOf([{ ...RULE, only_listed_by: bad }]), /only_listed_by/, JSON.stringify(bad));
  }
  const files = new StoreFiles(STORE, KEY, { fetchImpl: (async () => new Response('clip', { status: 200 })) as typeof fetch });
  assert.equal((await files.answer({ ...RULE, cache_seconds: 86400, only_listed_by: by }, 'site-app-files/a.mp4', undefined)).headers['cache-control'], 'public, max-age=60');
  assert.equal((await files.answer({ ...RULE, cache_seconds: 30, only_listed_by: by }, 'site-app-files/b.mp4', undefined)).headers['cache-control'], 'public, max-age=30');
});

test('a listing\'s paths are every site path anywhere in its answer, without query or fragment; links to other places are not paths', () => {
  const answer = { clips: [{ cut_url: '/published-clips/a.mp4', picture_url: '/published-clips/a.jpg?v=2', pair: { left: { picture_url: '/published-clips/b-left.jpg#x' } } }],
    note: 'not a path', other: '//elsewhere.example/x.mp4', link: 'https://elsewhere.example/y.mp4', count: 3, none: null };
  assert.deepEqual([...listedPathsOf(answer)].sort(), ['/published-clips/a.jpg', '/published-clips/a.mp4', '/published-clips/b-left.jpg']);
});

test('ListedPaths asks the listing once per seconds, one ask at a time, drops a withdrawn path on the next ask, and never stands in an old list for a failed one', async () => {
  let now = 1_000_000;
  let listed = ['/published-clips/a.mp4', '/published-clips/b.mp4'];
  let fail = false;
  const calls: unknown[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const listing = new ListedPaths(async call => {
    calls.push(call);
    await gate;
    if (fail) throw new Error('the door is down');
    return { clips: listed.map(cut_url => ({ cut_url })) };
  }, { now: () => now });
  const by = { tool: 'tool:read-the-listed-files', input: { database: 'a_site' }, seconds: 60 };
  gate = new Promise(resolve => { release = resolve; });
  const asked = [listing.names(by, '/published-clips/a.mp4'), listing.names(by, '/published-clips/c.mp4'), listing.names(by, '/published-clips/b.mp4')];
  release();
  assert.deepEqual(await Promise.all(asked), [true, false, true]);
  assert.deepEqual(calls, [{ tool: 'tool:read-the-listed-files', input: { database: 'a_site' } }], 'three paths at once ask the listing once, with its input as written');
  now += 59_000;
  listed = ['/published-clips/a.mp4'];
  assert.equal(await listing.names(by, '/published-clips/b.mp4'), true, 'within seconds the kept list answers');
  assert.equal(calls.length, 1);
  now += 2_000;
  assert.equal(await listing.names(by, '/published-clips/b.mp4'), false, 'after seconds a withdrawn path is no longer listed');
  assert.equal(calls.length, 2);
  now += 61_000;
  fail = true;
  await assert.rejects(listing.names(by, '/published-clips/a.mp4'), /the door is down/, 'a failed listing is never answered from the old list');
  await assert.rejects(listing.names(by, '/published-clips/a.mp4'), /the door is down/, 'and is asked again on the next request');
  fail = false;
  assert.equal(await listing.names(by, '/published-clips/a.mp4'), true, 'once the tool answers again its paths answer');
  assert.equal(await listing.names({ ...by, input: { database: 'another_site' } }, '/published-clips/a.mp4'), true);
  assert.equal(calls.length, 6, 'another input is its own listing');
});

test('a host a rule closes (rest not_found) answers only what the rule names: every other path is 404, before pass_on and rows', async () => {
  const rules = servedFilesOf([RULE, { hosts: ['old.example.com'], paths: [], named: { '/': 'index.html' }, key_prefix: 'site-old-files/', cache_seconds: 300, rest: 'not_found' }]);
  assert.equal(closedOnHost(rules, 'old.example.com', '/'), false, 'its named page answers');
  assert.equal(closedOnHost(rules, 'old.example.com', '/courses'), true);
  assert.equal(closedOnHost(rules, 'example.com', '/courses'), false, 'other hosts are not closed');
  assert.equal(closedOnHost(rules, 'app.example.com', '/nothing'), false, 'a rule without rest leaves its host open');
  assert.throws(() => servedFilesOf([{ ...RULE, hosts: undefined, rest: 'not_found' }]), /served_files/, 'rest needs hosts');
  assert.throws(() => servedFilesOf([{ ...RULE, rest: 'gone' }]), /served_files/);
  const passedOn: string[] = [];
  const other = http.createServer((request, response) => { passedOn.push(String(request.url)); response.end('other'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const site = {
    hostOf: (forwarded: string | undefined) => forwarded ?? 'example.com', closed: (host: string, path: string) => closedOnHost(rules, host, path),
    acts: () => false, pageFor: () => null, siteHead: null,
    answer: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'the site' }),
  } as unknown as Site;
  const server = http.createServer(handlerOf(site, [{ name: 'sign-in', address: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, paths: ['/sign-in'] }]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = (host: string, path: string) => fetch(`${at}${path}`, { headers: { 'x-forwarded-host': host } });
    assert.equal(await (await ask('old.example.com', '/')).text(), 'the site', 'the named page is the site\'s answer');
    for (const path of ['/courses', '/sign-in', '/members/x']) assert.equal((await ask('old.example.com', path)).status, 404, path);
    assert.deepEqual(passedOn, [], 'nothing on a closed host is passed on');
    assert.equal(await (await ask('example.com', '/sign-in')).text(), 'other', 'other hosts pass on as before');
  } finally { server.close(); other.close(); }
});
