// The install line a site gives, run for real with sh against a stand-in site serving write-site-pages.mjs's pages:
// the command lands on PATH, the site file names that site, and `trillion login` then needs no address.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { sitePages, writeSitePages } from '../do-work/write-site-pages.mjs';

const serve = folder => new Promise(resolve => {
  const server = createServer((request, response) => {
    try { response.writeHead(200).end(readFileSync(join(folder, decodeURIComponent(new URL(request.url, 'http://x').pathname)))); }
    catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

// Run without blocking: the stand-in site answers in this same process.
const run = (command, args, env) => new Promise(resolve => {
  const child = spawn(command, args, { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});
const install = (origin, home, path) => run('sh', ['-c', `curl -fsSL ${origin}/cli/install | sh`], { HOME: home, PATH: path, SHELL: '/bin/zsh' });

test('the site pages name only their own site, and carry every file the program needs', () => {
  const pages = sitePages('https://site.example');
  const named = Object.fromEntries(pages.map(row => [row.page, row.bytes.toString('utf8')]));
  assert.equal(JSON.parse(named['cli/client.json']).client_id, 'https://site.example/cli/client.json');
  assert.match(named['cli/install'], /^origin='https:\/\/site\.example'$/m);
  assert.ok(!named['cli/install'].includes('{origin}'));
  assert.deepEqual(named['cli/program/files.txt'].trim().split('\n'), settings.install.files);
  for (const name of settings.install.files) assert.ok(pages.some(row => row.page === `cli/program/${name}`), name);
  for (const bad of ['http://site.example', 'https://site.example/path', 'site.example']) assert.throws(() => sitePages(bad), /not an origin/, bad);
});

test('the install line puts trillion on PATH and names its site; run again it changes nothing it should not', async () => {
  const pages = mkdtempSync(join(tmpdir(), 'trillion-site-'));
  const server = await serve(pages);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    writeSitePages(origin, pages);
    const home = mkdtempSync(join(tmpdir(), 'trillion-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const path = `${bin}:/usr/bin:/bin:${join(process.execPath, '..')}`;
    const first = await install(origin, home, path);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), 'Trillion is installed. Now type: trillion login', 'a folder on PATH under home is used, so no new terminal');
    assert.equal(readlinkSync(join(bin, 'trillion')), join(home, '.trillion/cli/program/trillion.mjs'));
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.trillion/cli', settings.site_file), 'utf8')), { origin });
    const help = spawnSync(join(bin, 'trillion'), ['help'], { env: { HOME: home, PATH: path }, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /trillion login/);
    assert.equal((await install(origin, home, path)).status, 0, 'a second install replaces the first');
  } finally { server.close(); }
});

test('with no folder of its own on PATH it adds ~/.local/bin to the shell\'s start file once and says to open a new terminal; a file it did not make is left alone', async () => {
  const pages = mkdtempSync(join(tmpdir(), 'trillion-site-'));
  const server = await serve(pages);
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    writeSitePages(origin, pages);
    const home = mkdtempSync(join(tmpdir(), 'trillion-home-'));
    const path = `/usr/bin:/bin:${join(process.execPath, '..')}`;
    const said = await install(origin, home, path);
    assert.equal(said.status, 0, said.stderr);
    assert.equal(said.stdout.trim(), 'Trillion is installed. Open a new terminal, then type: trillion login');
    assert.ok(existsSync(join(home, '.local/bin/trillion')));
    await install(origin, home, path);
    assert.equal(readFileSync(join(home, '.zshrc'), 'utf8').match(/\.local\/bin/g).length, 1, 'the start file gains the line once');
    const other = mkdtempSync(join(tmpdir(), 'trillion-home-'));
    mkdirSync(join(other, '.local/bin'), { recursive: true });
    writeFileSync(join(other, '.local/bin/trillion'), 'someone else\'s');
    const refused = await install(origin, other, path);
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(join(other, '.local/bin/trillion'), 'utf8'), 'someone else\'s');
  } finally { server.close(); }
});

test('with no Node.js 22 the install line says where to get it and changes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-home-'));
  const fakeBin = mkdtempSync(join(tmpdir(), 'old-node-'));
  writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\necho 18\n', { mode: 0o755 });
  const script = sitePages('https://site.example').find(row => row.page === 'cli/install').bytes.toString('utf8');
  const said = spawnSync('sh', ['-c', script], { env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(said.status, 1);
  assert.match(said.stdout, /Node\.js 22 or newer.*nodejs\.org/);
  assert.ok(!existsSync(join(home, '.trillion')));
});
