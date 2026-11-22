// tools/use-your-tools-from-a-shell/test/command-op-flags.test.mjs
//
// `example op` and `example call` refuse a flag they do not know (command.json direct_calls.flags), so a flag that means
// nothing to them (the `--dry-run` that removed a row on 2026-11-13) is never silently dropped. `op --dry-run` sends nothing:
// it prints the request it would have sent, for a write as for a read.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, CommandError, speakFor } from '../do-work/command.mjs';

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };
const WRITE = ['op', 'wake:switch', '{"tool":"tool:x","id":"daily","on":false}'];
const READ = ['op', 'wake:list', '{"kind":"due-time"}'];

/** A fake door that answers every call with what it was asked; every request body is kept. */
const run = argv => {
  const asked = [];
  const result = main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: tempFolder(join(tmpdir(), 'example-op-flags-')) }),
    fetchImpl: async (url, init) => {
      asked.push(init.body);
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { [settings.engine.account_meta]: { account_id: 'acct' } }, serverInfo: {}, capabilities: { tools: {} } } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { asked: body.params?.arguments }, content: [] } });
    },
    wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  return { asked, result };
};

test('op and call refuse a flag they do not know, before sending anything', async () => {
  for (const argv of [[...WRITE, '--force'], [...READ, '--nope'], ['call', 'tool:x', '{}', '--all']]) {
    const { asked, result } = run(argv);
    await assert.rejects(result, error => error instanceof CommandError && error.status === 2 && /--(force|nope|all)/.test(error.message), argv.join(' '));
    assert.equal(asked.length, 0);
  }
});

test('call has no --dry-run: only op does', async () => {
  const { asked, result } = run(['call', 'tool:x', '{}', '--dry-run']);
  await assert.rejects(result, error => error instanceof CommandError && /--dry-run/.test(error.message));
  assert.equal(asked.length, 0);
});

test('op --dry-run on a write prints the request and sends nothing', async () => {
  const { asked, result } = run([...WRITE, '--dry-run', '--request-key', 'k-1']);
  assert.deepEqual(JSON.parse(await result), { method: 'wake:switch', request_key: 'k-1', input: { tool: 'tool:x', id: 'daily', on: false } });
  assert.equal(asked.length, 0);
});

test('op --dry-run on a read prints the request and sends nothing', async () => {
  const { asked, result } = run([...READ, '--dry-run', '--request-key', 'k-2']);
  assert.deepEqual(JSON.parse(await result), { method: 'wake:list', request_key: 'k-2', input: { kind: 'due-time' } });
  assert.equal(asked.length, 0);
});

test('the flags op and call know still work', async () => {
  const { asked, result } = run([...READ, '--request-key', 'k-3', '--timeout', '5', '--json']);
  assert.match(await result, /due-time/);
  assert.ok(asked.length > 0);
});

test('op takes its input from standard input (-) or a file (@FILE) as from the command line, and refuses a file over the bound', async () => {
  const { writeFileSync } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const dir = tempFolder(join(tmpdir(), 'example-op-input-'));
  const input = { name: 'A Booker', email: 'booker@example.com' };
  const shown = async argv => JSON.parse(await run(argv).result).input;
  assert.deepEqual(await shown(['op', 'records:write', JSON.stringify(input), '--dry-run']), input, 'the command line, as before');
  const file = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(input));
  assert.deepEqual(await shown(['op', 'records:write', `@${file}`, '--dry-run']), input, 'a file');
  const before = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(JSON.stringify(input))]), configurable: true });
  try { assert.deepEqual(await shown(['op', 'records:write', '-', '--dry-run']), input, 'standard input'); }
  finally { Object.defineProperty(process, 'stdin', before); }
  const large = join(dir, 'large.json');
  writeFileSync(large, JSON.stringify({ text: 'x'.repeat(settings.direct_calls.input_file_most_bytes) }));
  await assert.rejects(run(['op', 'records:write', `@${large}`, '--dry-run']).result, error => error instanceof CommandError && /is at most/.test(error.message));
  await assert.rejects(run(['op', 'records:write', `@${join(dir, 'none.json')}`, '--dry-run']).result, error => error instanceof CommandError && /Could not read the input file/.test(error.message));
});
