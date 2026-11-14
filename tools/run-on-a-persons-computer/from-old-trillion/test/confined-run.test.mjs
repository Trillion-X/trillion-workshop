// test/confined-run.test.mjs
// A program runs under a generated Seatbelt profile (F-0310, F-0237): it writes only in its tier's roots, cannot read the
// credential folders, has no network unless the tier allows it, and a pinned program that does not match is not started.
// These tests run sandbox-exec on this Mac.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPin, profileFor, runConfined, confinementSettings } from '../computer/confined-run.mjs';

const mac = { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') };
const sh = script => ['/bin/sh', ['-c', script]];

async function places() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'confined-')));
  const workspace = join(base, 'work'), outside = join(base, 'outside'), home = join(base, 'home');
  await mkdir(workspace); await mkdir(outside); await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id'), 'secret key bytes');
  return { workspace, outside, home };
}

test('the profile subtracts: writes outside the roots, the credential folders, and the network unless the tier allows it', () => {
  const settings = confinementSettings();
  const text = profileFor(settings.tiers.find(row => row.id === 'workspace'), { workspace: '/tmp/w', tmp: '/tmp/t', home: '/Users/example' });
  assert.match(text, /\(deny file-write\*\)/);
  assert.match(text, /\(deny file-read\* file-write\* .*"\/Users\/example\/\.ssh"/);
  assert.match(text, /\(deny network\*\)/);
  assert.doesNotMatch(profileFor(settings.tiers.find(row => row.id === 'workspace-online'), { workspace: '/tmp/w', tmp: '/tmp/t', home: '/Users/example' }), /deny network/);
});

test('a confined program writes in the workspace, not outside it, and cannot read the credential folder', mac, async () => {
  const { workspace, outside, home } = await places();
  const ok = await runConfined(...sh(`echo inside > "${workspace}/a.txt" && echo wrote`), { tier: 'workspace', workspace, home });
  assert.equal(ok.stdout.trim(), 'wrote');
  assert.equal((await readFile(join(workspace, 'a.txt'), 'utf8')).trim(), 'inside');
  await assert.rejects(runConfined(...sh(`echo nope > "${outside}/b.txt"`), { tier: 'workspace', workspace, home }), error => /Operation not permitted/.test(error.stderr));
  assert.equal(existsSync(join(outside, 'b.txt')), false);
  await assert.rejects(runConfined(...sh(`cat "${home}/.ssh/id"`), { tier: 'workspace', workspace, home }), error => /Operation not permitted/.test(error.stderr));
  console.log('readback: wrote in workspace; outside write and ~/.ssh read refused by the sandbox');
});

test('the network is closed unless the tier opens it; scoped values arrive by name only', mac, async () => {
  const server = http.createServer((_, response) => response.end('up')).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const { workspace, home } = await places();
    const fetchIt = `/usr/bin/curl -s --max-time 5 ${url}`;
    await assert.rejects(runConfined(...sh(fetchIt), { tier: 'workspace', workspace, home }));
    const online = await runConfined(...sh(`${fetchIt}; echo " $TOKEN_NAME"`), { tier: 'workspace-online', workspace, home, scoped_env: { TOKEN_NAME: 'tok' } });
    assert.equal(online.stdout.trim(), 'up tok');
    assert.doesNotMatch(online.profile, /tok/);
    const env = await runConfined(...sh('env'), { tier: 'read-only', home, workspace });
    assert.doesNotMatch(env.stdout, /^(npm_|ANTHROPIC|OPENAI)/m);
    console.log('readback: closed tier refused 127.0.0.1; online tier answered "up tok"');
  } finally { server.close(); }
});

test('an unknown tier and a pin that does not match are refused before anything starts', mac, async () => {
  const { workspace, home } = await places();
  await assert.rejects(runConfined('/bin/echo', [], { tier: 'nope', workspace, home }), /no confinement named nope/);
  await assert.rejects(runConfined('/bin/echo', ['x'], { tier: 'read-only', workspace, home, pin: { blake3: '0'.repeat(64) } }), /not the program pinned/);
  await assert.rejects(checkPin('/bin/echo', { team: 'ZZZZZZZZZZ' }), /not signed by the pinned developer/);
  const run = await runConfined('/bin/echo', ['hello'], { tier: 'read-only', workspace, home });
  assert.equal(run.stdout.trim(), 'hello');
});

test('the link reader runs confined when the DATA switch is on, and as before when it is off', mac, async () => {
  const { runFetcher } = await import('../../../audio-transcription/read-data/hear-here.mjs');
  const { workspace, outside } = await places();
  const row = part => ({ check: ['x'], info: ['/bin/sh', '-c', part] });
  const on = { enabled: true, tier: 'workspace-online' };
  assert.equal((await runFetcher(row(`echo fetched > {folder}/page.vtt; echo ok`), 'info', { folder: workspace }, 20, on)).trim(), 'ok');
  assert.equal((await readFile(join(workspace, 'page.vtt'), 'utf8')).trim(), 'fetched');
  await assert.rejects(runFetcher(row(`echo bad > ${outside}/x && echo ok`), 'info', { folder: workspace }, 20, on), error => /Operation not permitted/.test(error.message));
  assert.equal((await runFetcher(row(`echo bad > ${outside}/x && echo ok`), 'info', { folder: workspace }, 20, { enabled: false })).trim(), 'ok');
  assert.equal(await readFile(join(outside, 'x'), 'utf8'), 'bad\n');
});
