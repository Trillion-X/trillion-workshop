// The site as its own OS user on the engine's vault socket (door.peer): no pass is held or sent, and every tool run that names a
// database opens it under the pages' declared use.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from '../do-work/door.ts';
import { settingsOf, withPagesUse } from '../do-work/serve.ts';

const USE = { purpose: 'serve the site', surface: 'site pages' };
const good = {
  listen: '127.0.0.1:0', origin: 'https://site.example.test', lang: 'en',
  door: { address: 'unix:/run/engine-vault/vault.sock', peer: true },
  pages: { database: 'a_site_for_who_uses_it', use: USE, refresh_seconds: 60, answer_seconds: 60 },
  sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://sign-in.example.test', audience: 'https://site.example.test', team_claim: 'team_ids', members_team: 'team-members' },
};

test('a peer door is the vault socket alone: no pass, no pins, no command fields', () => {
  assert.equal(settingsOf(good).door.peer, true);
  for (const door of [
    { ...good.door, pass_credential: 'site-door-pass' },
    { ...good.door, pins: ['a-computer'] },
    { address: 'http://127.0.0.1:7199', peer: true },
    { ...good.door, peer: 'yes' },
  ]) assert.throws(() => settingsOf({ ...good, door }), /peer: true/, JSON.stringify(door));
  assert.throws(() => settingsOf({ ...good, door: { address: 'unix:/run/engine-vault/vault.sock' } }), /door is/, 'no pass and no peer is still refused');
});

test('the pages\' use is given to a call that names a database and no use, and to no other', () => {
  const run = (input: unknown) => withPagesUse(USE, { tool: 'tool:read-the-courses', input }).input;
  assert.deepEqual(run({ database: 'a_site_for_who_uses_it', slug: 'one' }), { database: 'a_site_for_who_uses_it', slug: 'one', use: USE });
  const own = { purpose: 'its own', surface: 'its own' };
  assert.deepEqual(run({ database: 'a_site_for_who_uses_it', use: own }), { database: 'a_site_for_who_uses_it', use: own }, 'a use the row gives is kept');
  assert.deepEqual(run({ when: 'today' }), { when: 'today' }, 'a call that opens no database is as it was');
  assert.deepEqual(run([1, 2]), [1, 2]);
  assert.deepEqual(withPagesUse(undefined, { tool: 't', input: { database: 'd' } }).input, { database: 'd' }, 'no declared use adds none');
});

test('a run with no pass sends no authorization header to the door', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'peer-door-')), 'vault.sock');
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: 'tool:read-the-courses', exit_code: 0, result: { courses: [] } } } }));
    });
  });
  await new Promise<void>(done => server.listen(socket, done));
  try {
    assert.deepEqual(await runTool({ address: `unix:${socket}` }, '', { tool: 'tool:read-the-courses', input: {} }), { courses: [] });
    await runTool({ address: `unix:${socket}` }, 'a-pass', { tool: 'tool:read-the-courses', input: {} });
    assert.deepEqual(seen, [undefined, 'Bearer a-pass']);
  } finally {
    server.close();
  }
});
