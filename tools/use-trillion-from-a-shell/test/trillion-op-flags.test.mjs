// tools/use-trillion-from-a-shell/test/trillion-op-flags.test.mjs
//
// `trillion op` and `trillion call` refuse a flag they do not know (trillion.json direct_calls.flags), so a flag that means
// nothing to them (the `--dry-run` that removed a record on 2026-11-13) is never silently dropped. `op --dry-run` sends nothing:
// it prints the request it would have sent, and refuses a method in direct_calls.dry_run_refuses (records:write).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, stateOf, TrillionError } from '../do-work/trillion.mjs';

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const WRITE = ['op', '@own-records', 'records:write', '{"records":[{"id":"note:one","type":"note","value":null}]}'];
const READ = ['op', '@own-records', 'records:read', '{"id":"note:one"}'];

const run = argv => {
  const asked = [];
  const result = main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'trillion-op-flags-')) }),
    fetchImpl: async (url, init) => { asked.push(init.body); return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { ok: true }, content: [] } }); },
    wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  return { asked, result };
};

test('op and call refuse a flag they do not know, before sending anything', async () => {
  for (const argv of [[...WRITE, '--force'], [...READ, '--nope'], ['call', 'tool:x', '{}', '--all']]) {
    const { asked, result } = run(argv);
    await assert.rejects(result, error => error instanceof TrillionError && error.status === 2 && /--(force|nope|all)/.test(error.message), argv.join(' '));
    assert.equal(asked.length, 0);
  }
});

test('call has no --dry-run: only op does', async () => {
  const { asked, result } = run(['call', 'tool:x', '{}', '--dry-run']);
  await assert.rejects(result, error => error instanceof TrillionError && /--dry-run/.test(error.message));
  assert.equal(asked.length, 0);
});

test('op --dry-run refuses records:write, shows the request, and sends nothing', async () => {
  const { asked, result } = run([...WRITE, '--dry-run', '--request-key', 'k-1']);
  await assert.rejects(result, error => error instanceof TrillionError && error.status === 2 && error.message.includes('records:write') && error.message.includes('"request_key": "k-1"') && error.message.includes('note:one'));
  assert.equal(asked.length, 0);
});

test('op --dry-run on a read prints the request and sends nothing', async () => {
  const { asked, result } = run([...READ, '--dry-run', '--request-key', 'k-2']);
  const shown = JSON.parse(await result);
  assert.deepEqual(shown, { address: '@own-records', method: 'records:read', request_key: 'k-2', input: { id: 'note:one' } });
  assert.equal(asked.length, 0);
});

test('the flags op and call know still work', async () => {
  const { asked, result } = run([...READ, '--request-key', 'k-3', '--timeout', '5', '--json']);
  assert.match(await result, /ok/);
  assert.ok(asked.length > 0);
});
