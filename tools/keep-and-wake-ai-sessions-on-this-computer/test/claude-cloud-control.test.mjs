import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dispatchCloudSessions, signIn } from '../harness/read-cloud-sessions.mjs';
import { manageClaudeCloudSessions, validateClaudeCloudRequest } from '../harness/claude-cloud-control.mjs';

test('Linux reads the existing Claude subscription sign-in without invoking Keychain or logging its token', () => {
  const home = '/tmp/claude-fixture';
  const folder = '.claude-account1';
  const files = new Map([
    [join(home, folder, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-fixture' } })],
    [join(home, folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'private-token', expiresAt: 2_000_000 } })],
  ]);
  const account = signIn(folder, { home, system: 'linux', read: name => {
    if (!files.has(name)) throw new Error('unexpected file: ' + name);
    return files.get(name);
  }, keychain: () => { throw new Error('Keychain should not run on Linux'); }, now: 1_000_000 });
  assert.deepEqual(account, { org: 'org-fixture', token: 'private-token' });
  assert.throws(() => signIn('../not-owned', { home, system: 'linux' }), /directly beneath/);
  assert.throws(() => signIn(folder, { home, system: 'linux', read: name => files.get(name), now: 3_000_000 }), error => !error.message.includes('private-token') && /expired/.test(error.message));
});

test('macOS continues to read the sign-in from its original Keychain item', () => {
  let called = false;
  const account = signIn('.claude-account1', {
    home: '/tmp/example', system: 'darwin', now: 100,
    read: name => {
      assert.equal(name, '/tmp/example/.claude-account1/.claude.json');
      return JSON.stringify({ oauthAccount: { organizationUuid: 'org-mac' } });
    },
    keychain: (program, args) => {
      called = true;
      assert.equal(program, 'security');
      assert.equal(args[0], 'find-generic-password');
      return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-only', expiresAt: 200 } });
    },
  });
  assert.equal(called, true);
  assert.equal(account.org, 'org-mac');
});

test('list-json returns bounded sessions through the authenticated provider with no token in its output', async () => {
  const lines = [];
  const request = async (url, options) => {
    assert.ok(url.includes('/v1/sessions?limit=2'));
    assert.equal(options.headers.authorization, 'Bearer never-print-this');
    return Response.json({ data: [
      { id: 'session_a', title: 'Fix release', session_status: 'completed', session_context: { sources: [{ url: 'https://github.com/Trillion-X/trillion-workshop' }] } },
      { id: 'session_b', title: 'Fix hook', session_status: 'running' },
    ], has_more: false });
  };
  const result = await dispatchCloudSessions(['list-json', '.claude-account1', '2'], {
    authenticate: () => ({ org: 'org', token: 'never-print-this' }), request, print: line => lines.push(line),
  });
  assert.equal(result.count, 2);
  assert.equal(result.sessions[0].sources[0].url, 'https://github.com/Trillion-X/trillion-workshop');
  assert.ok(!lines.join('').includes('never-print-this'));
});

test('read-one summarizes only the specified cloud session and keeps provider credentials private', async () => {
  const urls = [];
  const result = await dispatchCloudSessions(['read-one', '.claude-account2', 'session_123'], {
    authenticate: () => ({ org: 'org', token: 'secret' }),
    request: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.authorization, 'Bearer secret');
      if (url.endsWith('/v1/sessions/session_123')) return Response.json({ id: 'session_123', title: 'Continue verification', session_status: 'completed' });
      return Response.json({ has_more: false, data: [
        { type: 'user', created_at: '2026-11-20T00:00:00Z', message: { role: 'user', content: 'Fix the test failure.' } },
        { type: 'assistant', created_at: '2026-11-20T00:10:00Z', message: { role: 'assistant', content: 'One failing check remains.' } },
      ] });
    },
    print: () => {},
  });
  assert.equal(result.id, 'session_123');
  assert.equal(result.first_task, 'Fix the test failure.');
  assert.match(result.final_messages[0].text, /failing check/);
  assert.equal(urls.length, 2);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('resume targets exactly one existing session, sends the brief in memory, and never silently starts a new one', async () => {
  const calls = [];
  const result = await manageClaudeCloudSessions({
    action: 'resume', config_folder: '.claude-account3', session_id: 'session_existing', message: 'Continue the existing work from the last verified checkpoint.',
  }, { dispatch: async (args, deps) => {
    calls.push(args);
    assert.equal(await deps.resolveBrief('-'), 'Continue the existing work from the last verified checkpoint.');
    deps.print(JSON.stringify({ session: 'session_existing', sent: 'event_one', answer: null }));
  } });
  assert.deepEqual(calls, [['send', '.claude-account3', 'session_existing', '-']]);
  assert.equal(result.sent, 'event_one');
  assert.ok(!JSON.stringify(calls).includes('Continue the existing'));
});

test('dry runs and invalid requests cannot send work or access another home directory', async () => {
  assert.throws(() => validateClaudeCloudRequest({ action: 'resume', config_folder: '../victim', session_id: 'session_a', message: 'test' }), /directly below/);
  assert.throws(() => validateClaudeCloudRequest({ action: 'start', config_folder: '.claude', repositories: '../private', title: 'Bad', message: 'test' }), /owner\/repo/);
  let called = false;
  const result = await manageClaudeCloudSessions({ action: 'resume', config_folder: '.claude-account1',
    session_id: 'session_one', message: 'Continue.', dry_run: true }, { dispatch: async () => { called = true; } });
  assert.equal(result.dry_run, true);
  assert.equal(called, false);
});
