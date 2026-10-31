// The stock provider on a made-up library served from this computer: the library is a row of data, a key goes to the
// library it belongs to on the search request only, a source without a key is skipped, and the next source answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickUrl, searchUrl, valueAt } from '../read-data/stock-pick.mjs';

const provider = join(import.meta.dirname, '..', 'do-work', 'stock-provider.mjs');
const work = mkdtempSync(join(tmpdir(), 'stock-provider-'));
const seen = [];
let server;
let base;
let count = 0;

before(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url, auth: request.headers.authorization ?? null });
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/a/search') {
      response.end(JSON.stringify({ items: [{ files: [{ w: 100, link: `${base}/file/small` }, { w: 900, link: `${base}/file/large` }] }] }));
    } else if (path === '/b/search') {
      response.end(JSON.stringify({ hits: [{ media: { big: { url: '' }, small: { url: `${base}/file/b-small` } } }] }));
    } else if (path === '/empty/search') {
      response.end(JSON.stringify({ items: [] }));
    } else if (path.startsWith('/file/')) {
      response.end(`bytes of ${path.slice(6)}`);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function writeSources(sources) {
  const file = join(work, `sources-${count += 1}.json`);
  writeFileSync(file, JSON.stringify({ license: 'cc0', sources }));
  return file;
}

// The server is in this process, so the provider must run beside it, not block it.
function run(sources, env = {}, license = 'cc0') {
  const out = join(work, `out-${count += 1}.bin`);
  const args = [provider, '--describe', 'a quiet harbour', '--kind', 'clip', '--license', license, '--out', out, '--sources', writeSources(sources)];
  return new Promise(done => execFile('node', args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } },
    (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr, out })));
}

const sourceA = () => ({
  id: 'library-a', key_env: 'LIBRARY_A_KEY', key_header: 'Authorization',
  kinds: { clip: { search: `${base}/a/search?query={query}`, pick: { at: 'items.0.files', largest_by: 'w', url: ['link'] } } },
});
const sourceB = () => ({
  id: 'library-b', key_env: 'LIBRARY_B_KEY',
  kinds: { clip: { search: `${base}/b/search?key={key}&q={query}`, pick: { at: 'hits.0.media', url: ['big.url', 'small.url'] } } },
});

test('the readers: a dotted path into an answer, the largest file, the first address that is there, an encoded search', () => {
  assert.equal(valueAt({ a: [{ b: 7 }] }, 'a.0.b'), 7);
  assert.equal(valueAt({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(pickUrl({ f: [{ w: 1, u: 'x' }, { w: 5, u: 'y' }] }, { at: 'f', largest_by: 'w', url: ['u'] }), 'y');
  assert.equal(pickUrl({ f: [{ u: 'first' }, { u: 'second' }] }, { at: 'f', url: ['u'] }), 'first');
  assert.equal(pickUrl({ o: { a: '', b: 'there' } }, { at: 'o', url: ['a', 'b'] }), 'there');
  assert.equal(pickUrl({ o: {} }, { at: 'o', url: ['a'] }), null);
  assert.equal(searchUrl('https://x.test/s?q={query}&k={key}', 'a b&c', 'k 1'), 'https://x.test/s?q=a%20b%26c&k=k%201');
});

test('a source row finds the largest file and downloads it', async () => {
  const { status, stdout, out } = await run([sourceA()], { LIBRARY_A_KEY: 'secret-a' });
  assert.equal(status, 0);
  assert.match(stdout, /source library-a/);
  assert.equal(readFileSync(out, 'utf8'), 'bytes of large');
});

test('the key goes on the search request only, never to the file address', async () => {
  seen.length = 0;
  await run([sourceA()], { LIBRARY_A_KEY: 'secret-a' });
  assert.equal(seen.find(hit => hit.url.startsWith('/a/search')).auth, 'secret-a');
  assert.equal(seen.find(hit => hit.url.startsWith('/file/')).auth, null);
});

test('a source with no key is skipped and the next one answers, using the first address that is there', async () => {
  const { status, stderr, stdout, out } = await run([sourceA(), sourceB()], { LIBRARY_B_KEY: 'secret-b' });
  assert.equal(status, 0);
  assert.match(stderr, /library-a: no LIBRARY_A_KEY in env/);
  assert.match(stdout, /source library-b/);
  assert.equal(readFileSync(out, 'utf8'), 'bytes of b-small');
});

test('with no result anywhere the run fails and names which keys were there', async () => {
  const none = { ...sourceA(), kinds: { clip: { search: `${base}/empty/search?query={query}`, pick: { at: 'items.0.files', url: ['link'] } } } };
  const { status, stderr } = await run([none], { LIBRARY_A_KEY: 'secret-a' });
  assert.equal(status, 4);
  assert.match(stderr, /no stock source satisfied "a quiet harbour" \(keys present: library-a\)/);
});

test('only the free licence is served', async () => {
  const { status, stderr } = await run([sourceA()], { LIBRARY_A_KEY: 'x' }, 'editorial');
  assert.equal(status, 3);
  assert.match(stderr, /serves cc0 only/);
});
