// tools/start-a-site-in-a-container/test/start-with-engine-keys.test.mjs
// Starts the starter for real against stand-ins: an engine vault socket, a site program on its socket and a receiver on a
// loopback port. Proves held values reach the site's credentials folder, byte joining, redirect_hosts and routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTER = new URL('../start-with-engine-keys.mjs', import.meta.url).pathname;

// A site program that answers every request with what it saw, and the held value it was given.
const SITE = `const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
fs.rmSync(process.env.SOCKET, { force: true });
http.createServer((q, a) => {
  let held = null;
  try { held = fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY, 'API_KEY'), 'utf8'); } catch {}
  a.writeHead(404, { 'x-from': 'site', 'content-type': 'application/json' });
  a.end(JSON.stringify({ url: q.url, host: q.headers.host, held, mode: process.env.MODE ?? null }));
}).listen(process.env.SOCKET);`;

const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const free = async () => { const server = createServer(); const port = await listen(server); await new Promise(done => server.close(done)); return port; };

// One request to the starter: { status, headers, body }.
const ask = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((done, fail) => {
  const asked = request({ host: '127.0.0.1', port, path, method, headers }, answer => {
    const parts = [];
    answer.on('data', part => parts.push(part));
    answer.on('end', () => done({ status: answer.statusCode, headers: answer.headers, body: Buffer.concat(parts).toString() }));
  });
  asked.on('error', fail);
  asked.end(body);
});

// Lays a site folder with keys.json, starts the starter on a free port and waits until it joins: { port, stop, log }.
async function start(keys, { engine, lay = () => {} } = {}) {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), 'starter-site-'));
  mkdirSync(join(folder, 'site-data'));
  lay(folder);
  writeFileSync(join(folder, 'site-data/keys.json'), JSON.stringify({ program: 'site.cjs', environment: { MODE: 'from-keys-json' }, ...keys }));
  writeFileSync(join(folder, 'site.cjs'), SITE);
  const port = await free();
  const child = spawn(process.execPath, [STARTER, 'site-data/keys.json'], {
    cwd: folder,
    env: { ...process.env, PORT: String(port), SITE_SOCKET: join(folder, 'site.sock'), CREDENTIALS_FOLDER: join(folder, 'held'), ENGINE_PERSON: 'person-1', ...(engine ? { ENGINE_SOCKET: engine } : {}) },
  });
  let log = '';
  child.stdout.on('data', part => { log += part; });
  child.stderr.on('data', part => { log += part; });
  for (let tries = 0; !/joining port/.test(log); tries += 1) {
    if (tries > 100 || child.exitCode !== null) throw new Error(`the starter did not join: ${log}`);
    await new Promise(done => setTimeout(done, 50));
  }
  return { port, log: () => log, stop: () => new Promise(done => { child.once('exit', done); child.kill('SIGTERM'); }) };
}

test('held values come from the engine socket into the site, and the port is joined byte for byte', async () => {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), 'starter-engine-'));
  const engine = join(folder, 'vault.sock');
  const asked = [];
  const vault = createServer((q, a) => {
    const parts = [];
    q.on('data', part => parts.push(part));
    q.on('end', () => { asked.push(JSON.parse(Buffer.concat(parts))); a.writeHead(200); a.end('made-up-held-value'); });
  });
  await new Promise(done => vault.listen(engine, done));
  const site = await start({ keys: { API_KEY: 'site-api-key' } }, { engine });
  try {
    const answer = await ask(site.port, '/page?x=1');
    assert.equal(answer.status, 404);
    assert.deepEqual(JSON.parse(answer.body), { url: '/page?x=1', host: `127.0.0.1:${site.port}`, held: 'made-up-held-value', mode: 'from-keys-json' });
    assert.deepEqual(asked, [{ person: 'person-1', name: 'site-api-key' }]);
    assert.match(site.log(), /held 1 values from the engine/);
    assert.doesNotMatch(site.log(), /made-up-held-value/);
    assert.doesNotMatch(site.log(), /request by request/);
  } finally { await site.stop(); vault.close(); }
});

test('a redirect host is answered 308 to its origin with the same path; other hosts reach the site', async () => {
  const site = await start({ redirect_hosts: { 'bare.example': 'https://www.bare.example' } });
  try {
    const moved = await ask(site.port, '/a/b?c=1', { headers: { host: 'bare.example' } });
    assert.equal(moved.status, 308);
    assert.equal(moved.headers.location, 'https://www.bare.example/a/b?c=1');
    const kept = await ask(site.port, '/a', { headers: { host: 'www.bare.example' } });
    assert.equal(JSON.parse(kept.body).url, '/a');
  } finally { await site.stop(); }
});

test('a route passes its path and everything under it to its origin unchanged; a near miss stays on the site', async () => {
  const seen = [];
  const receiver = createServer((q, a) => {
    const parts = [];
    q.on('data', part => parts.push(part));
    q.on('end', () => {
      const body = Buffer.concat(parts);
      seen.push({ url: q.url, method: q.method, sha: createHash('sha256').update(body).digest('hex'), signature: q.headers['svix-signature'] ?? null });
      a.writeHead(202, { 'x-from': 'receiver', 'set-cookie': ['a=1', 'b=2'] });
      a.end('taken');
    });
  });
  const port = await listen(receiver);
  const site = await start({ routes: { '/webhooks/receiver': `http://127.0.0.1:${port}` } });
  try {
    const body = randomBytes(300_000);
    const sent = await ask(site.port, '/webhooks/receiver?x=1', { method: 'POST', body, headers: { 'content-length': body.length, 'svix-signature': 'v1,made-up=' } });
    assert.equal(sent.status, 202);
    assert.equal(sent.body, 'taken');
    assert.deepEqual(sent.headers['set-cookie'], ['a=1', 'b=2']);
    assert.deepEqual(seen[0], { url: '/webhooks/receiver?x=1', method: 'POST', sha: createHash('sha256').update(body).digest('hex'), signature: 'v1,made-up=' });
    const chunked = await ask(site.port, '/webhooks/receiver/health', { method: 'POST', body, headers: { 'transfer-encoding': 'chunked' } });
    assert.equal(chunked.status, 202);
    assert.equal(seen[1].sha, seen[0].sha);
    for (const path of ['/webhooks/receiverx', '/webhooks', '/']) assert.equal(JSON.parse((await ask(site.port, path)).body).url, path);
    assert.match(site.log(), /request by request; \/webhooks\/receiver routed/);
  } finally { await site.stop(); receiver.close(); }
});

test('a route whose origin does not answer is 502, and the site still answers', async () => {
  const site = await start({ routes: { '/webhooks/receiver': `http://127.0.0.1:${await free()}` } });
  try {
    assert.equal((await ask(site.port, '/webhooks/receiver')).status, 502);
    assert.equal((await ask(site.port, '/')).status, 404);
  } finally { await site.stop(); }
});

// A pages folder: an index, a page reached without its .html, a nested page, a stylesheet and a font.
const layPages = folder => {
  mkdirSync(join(folder, 'public/work'), { recursive: true });
  mkdirSync(join(folder, 'public/fonts'), { recursive: true });
  writeFileSync(join(folder, 'public/index.html'), '<h1>home</h1>');
  writeFileSync(join(folder, 'public/provenance.html'), '<h1>provenance</h1>');
  writeFileSync(join(folder, 'public/work/first-client.html'), '<h1>first client</h1>');
  writeFileSync(join(folder, 'public/site.css'), 'body{}');
  writeFileSync(join(folder, 'public/fonts/a.woff2'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(folder, 'secret.txt'), 'outside the folder');
};
const pagesSite = () => start({ files: { folder: 'public', cache_control: 'public, max-age=300' }, program_paths: ['/go/*', '/observe/visit', '/before-booking/*'] }, { lay: layPages });

test('files: pages are served from the folder the way the front door served them, with clean paths', async () => {
  const site = await pagesSite();
  try {
    const home = await ask(site.port, '/');
    assert.equal(home.status, 200);
    assert.equal(home.body, '<h1>home</h1>');
    assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(home.headers['cache-control'], 'public, max-age=300');
    assert.ok(home.headers.etag && home.headers['last-modified']);
    assert.equal((await ask(site.port, '/index.html')).body, '<h1>home</h1>');
    assert.equal((await ask(site.port, '/provenance')).body, '<h1>provenance</h1>');
    assert.equal((await ask(site.port, '/work/first-client?x=1')).body, '<h1>first client</h1>');
    assert.equal((await ask(site.port, '/site.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await ask(site.port, '/fonts/a.woff2')).headers['content-type'], 'font/woff2');
    const cached = await ask(site.port, '/', { headers: { 'if-none-match': home.headers.etag } });
    assert.equal(cached.status, 304);
    const head = await ask(site.port, '/provenance', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String('<h1>provenance</h1>'.length));
  } finally { await site.stop(); }
});

test('files: a missing page, a folder with no index, a POST and a path out of the folder are 404 Not found', async () => {
  const site = await pagesSite();
  try {
    for (const [path, method] of [['/nope', 'GET'], ['/work/', 'GET'], ['/', 'POST'], ['/../secret.txt', 'GET'], ['/%2e%2e/secret.txt', 'GET'], ['/%E0%A4%A', 'GET']]) {
      const answer = await ask(site.port, path, { method });
      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.equal(answer.body, 'Not found');
      assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8');
    }
  } finally { await site.stop(); }
});

test('files: only program_paths reach the program, with Cache-Control no-store', async () => {
  const site = await pagesSite();
  try {
    for (const path of ['/go/check', '/go/a/b', '/observe/visit', '/before-booking/offer-1']) {
      const answer = await ask(site.port, path, { method: path === '/go/check' ? 'GET' : 'POST' });
      assert.equal(answer.headers['x-from'], 'site', path);
      assert.equal(JSON.parse(answer.body).url, path);
      assert.equal(answer.headers['cache-control'], 'no-store', path);
    }
    for (const path of ['/go', '/observe/visit/x', '/observe']) assert.equal((await ask(site.port, path)).body, 'Not found', path);
    assert.match(site.log(), /files from public, \/go\/\* \/observe\/visit \/before-booking\/\* to the program/);
  } finally { await site.stop(); }
});
