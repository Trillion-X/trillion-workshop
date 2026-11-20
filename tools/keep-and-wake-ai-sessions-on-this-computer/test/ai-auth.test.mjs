// The logins one AI run uses (harness/ai-auth.mjs) and the vault command they read and write (harness/vault-value.mjs),
// against a fake vault command: a script that keeps each value as a file in a folder the test makes. No secret is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireAiAuth } from '../harness/ai-auth.mjs';
import { readVaultValue, writeVaultValue } from '../harness/vault-value.mjs';
import { mergeSettings } from '../harness/take-open-work.mjs';

const FAKE_VAULT = `
const fs = require('node:fs');
const path = require('node:path');
const [store, verb, name, file] = process.argv.slice(2);
const kept = path.join(store, name);
if (verb === 'read') {
  if (!fs.existsSync(kept)) { process.stderr.write('no such value\\n'); process.exit(3); }
  fs.writeSync(3, fs.readFileSync(kept));
} else if (verb === 'put') {
  if (process.env.FAKE_PUT_FAILS) { process.stderr.write('put refused\\n'); process.exit(4); }
  fs.copyFileSync(file, kept);
}
`;

function fixture({ values = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-auth-test-'));
  const store = join(root, 'store');
  const state = join(root, 'state');
  mkdirSync(store);
  mkdirSync(state);
  for (const [name, text] of Object.entries(values)) writeFileSync(join(store, name), text);
  const script = join(root, 'fake-vault.cjs');
  writeFileSync(script, FAKE_VAULT);
  const vault = { command: [process.execPath, script, store], env: {} };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, store, state, vault, cleanup };
}

// The fake command takes [store, verb, name, file]; readVaultValue and writeVaultValue pass the verb and name after the
// command's own leading words, so the store is one of those leading words.
const vaultOf = ({ vault, store }) => ({ command: [...vault.command.slice(0, 2), store] });

test('an AI with no login row runs on its own sign-in: no folder is made and no environment is added', () => {
  const f = fixture();
  try {
    const auth = acquireAiAuth(undefined, { folder: f.state, runId: 'r1', vault: vaultOf(f), staleMs: 1000 });
    assert.deepEqual(auth.env, {});
    auth.done();
    assert.equal(existsSync(join(f.state, 'auth-locks')), false);
  } finally { f.cleanup(); }
});

test('a Claude run takes the first free token into its environment, and the next run takes the next', () => {
  const f = fixture({ values: { 'claude-subscription-token-1': 'tok-one\n', 'claude-subscription-token-2': 'tok-two' } });
  try {
    const vault = vaultOf(f);
    const auth = { claude_token_names: ['claude-subscription-token-1', 'claude-subscription-token-2'] };
    const first = acquireAiAuth(auth, { folder: f.state, runId: 'a', vault, staleMs: 60000 });
    assert.deepEqual(first.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-one' });
    const second = acquireAiAuth(auth, { folder: f.state, runId: 'b', vault, staleMs: 60000 });
    assert.deepEqual(second.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-two' });
    assert.equal(acquireAiAuth(auth, { folder: f.state, runId: 'c', vault, staleMs: 60000 }), null, 'every token in use: no run starts');
    first.done();
    const again = acquireAiAuth(auth, { folder: f.state, runId: 'd', vault, staleMs: 60000 });
    assert.deepEqual(again.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-one' }, 'a finished run frees its token');
    second.done();
    again.done();
  } finally { f.cleanup(); }
});

test('a Codex run gets a private CODEX_HOME with the login, and an unchanged login is not written back', () => {
  const login = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'r1' } });
  const f = fixture({ values: { 'codex-subscription-auth-1': login } });
  try {
    const vault = vaultOf(f);
    const auth = acquireAiAuth({ codex_login: 'codex-subscription-auth-1' }, { folder: f.state, runId: 'run-x', vault, staleMs: 60000 });
    const home = auth.env.CODEX_HOME;
    assert.equal(home, join(f.state, 'codex-homes', 'run-x'));
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), login);
    assert.equal((statSync(join(home, 'auth.json')).mode & 0o777), 0o600);
    assert.equal((statSync(home).mode & 0o777), 0o700);
    auth.done();
    assert.equal(existsSync(home), false, 'the run folder is removed');
    assert.equal(readFileSync(join(f.store, 'codex-subscription-auth-1'), 'utf8'), login);
  } finally { f.cleanup(); }
});

test('a refreshed Codex login is written back to the vault before its lock is released', () => {
  const f = fixture({ values: { 'codex-subscription-auth-1': '{"tokens":{"refresh_token":"old"}}' } });
  try {
    const vault = vaultOf(f);
    const login = { codex_login: 'codex-subscription-auth-1' };
    const auth = acquireAiAuth(login, { folder: f.state, runId: 'refresh', vault, staleMs: 60000 });
    writeFileSync(join(auth.env.CODEX_HOME, 'auth.json'), '{"tokens":{"refresh_token":"new"}}');
    auth.done();
    assert.equal(readFileSync(join(f.store, 'codex-subscription-auth-1'), 'utf8'), '{"tokens":{"refresh_token":"new"}}');
    assert.equal(existsSync(join(f.state, 'auth-locks', 'codex-subscription-auth-1')), false, 'lock released after the write');
  } finally { f.cleanup(); }
});

test('one Codex login is used by one run at a time, and a failed write-back keeps the lock and the new token', () => {
  const f = fixture({ values: { 'codex-subscription-auth-1': '{"n":1}' } });
  try {
    const vault = vaultOf(f);
    const login = { codex_login: 'codex-subscription-auth-1' };
    const auth = acquireAiAuth(login, { folder: f.state, runId: 'one', vault, staleMs: 60000 });
    assert.equal(acquireAiAuth(login, { folder: f.state, runId: 'two', vault, staleMs: 60000 }), null);
    writeFileSync(join(auth.env.CODEX_HOME, 'auth.json'), '{"n":2}');
    process.env.FAKE_PUT_FAILS = '1';
    try { assert.throws(() => auth.done(), /did not keep codex-subscription-auth-1 \(exit 4: put refused\)/); }
    finally { delete process.env.FAKE_PUT_FAILS; }
    assert.equal(existsSync(join(f.state, 'auth-locks', 'codex-subscription-auth-1')), true, 'the lock stays');
    assert.equal(readFileSync(join(auth.env.CODEX_HOME, 'auth.json'), 'utf8'), '{"n":2}', 'the refreshed login stays for recovery');
  } finally { f.cleanup(); }
});

test('a lock left by a run that never ended is taken back once it is stale', () => {
  const f = fixture({ values: { 'codex-subscription-auth-1': '{"n":1}' } });
  try {
    const vault = vaultOf(f);
    const lock = join(f.state, 'auth-locks', 'codex-subscription-auth-1');
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lock, old, old);
    const auth = acquireAiAuth({ codex_login: 'codex-subscription-auth-1' }, { folder: f.state, runId: 'after', vault, staleMs: 60000 });
    assert.ok(auth, 'the stale lock is taken back');
    auth.done();
  } finally { f.cleanup(); }
});

test('a vault that does not answer names its status and its first line, and takes nothing', () => {
  const f = fixture();
  try {
    const vault = vaultOf(f);
    assert.throws(() => readVaultValue(vault, 'missing'), /did not give missing \(exit 3: no such value\)/);
    assert.throws(() => acquireAiAuth({ claude_token_names: ['missing'] }, { folder: f.state, runId: 'x', vault, staleMs: 60000 }), /did not give missing/);
    assert.equal(existsSync(join(f.state, 'auth-locks', 'missing')), false, 'a lock is not left behind when the read fails');
    assert.throws(() => writeVaultValue(vault, 'made', join(f.root, 'no-such-file')), /did not keep made/);
  } finally { f.cleanup(); }
});

test('a computer config overlays the shared settings: objects merge, arrays and values are replaced', () => {
  const shared = { use_ai: 'claude', account: { pins: ['f596fa0076f6c620'], timeout_seconds: 120 }, ais: [{ id: 'claude' }] };
  const own = { account: { pins: ['computer-two'] }, vault: { command: ['x'] }, ais: [{ id: 'codex' }] };
  const merged = mergeSettings(shared, own);
  assert.deepEqual(merged.account, { pins: ['computer-two'], timeout_seconds: 120 });
  assert.deepEqual(merged.vault, { command: ['x'] });
  assert.deepEqual(merged.ais, [{ id: 'codex' }]);
  assert.equal(merged.use_ai, 'claude');
  assert.deepEqual(mergeSettings(shared, {}), shared, 'no own config leaves the shared settings as they are');
});
