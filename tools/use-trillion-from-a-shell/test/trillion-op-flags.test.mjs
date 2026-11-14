// tools/use-trillion-from-a-shell/test/trillion-op-flags.test.mjs
//
// `trillion op` and `trillion call` refuse a flag they do not know (trillion.json direct_calls.flags), so a flag that means
// nothing to them (the `--dry-run` that removed a record on 2026-11-13) is never silently dropped. `op --dry-run` sends nothing:
// it prints the request it would have sent; for records:write it reads each row first and prints the current value, the new value,
// the field diff and the removal, and writes nothing (proved by the door's store being the same before and after).
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

/** A fake door holding `rows` (id -> value): records:read answers from it, records:write changes it, every call is kept. */
const run = (argv, rows = {}) => {
  const asked = [];
  const result = main([...argv, '--origin', 'http://127.0.0.1:8788'], {
    env: { TRILLION_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants, state: stateOf({ home: mkdtempSync(join(tmpdir(), 'trillion-op-flags-')) }),
    fetchImpl: async (url, init) => {
      asked.push(init.body);
      const body = JSON.parse(init.body);
      const call = body.params?.arguments;
      let answer = { ok: true };
      if (call?.method === 'records:read') answer = { id: call.input.id, type: 'note', value: rows[call.input.id] ?? null };
      if (call?.method === 'records:write') for (const item of call.input.records) { if (item.value === null) delete rows[item.id]; else rows[item.id] = item.value; }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: answer, content: [] } });
    },
    wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
  });
  return { asked, result, rows };
};
const wrote = asked => asked.some(body => JSON.parse(body).params?.arguments?.method === 'records:write');

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

test('op --dry-run on a null write prints the removal, drops and the current value, and changes nothing', async () => {
  const rows = { 'note:one': { words: 'kept', price: 9900, nested: { a: 1 } } };
  const before = JSON.stringify(rows);
  const { asked, result } = run([...WRITE, '--dry-run', '--request-key', 'k-1'], rows);
  const shown = JSON.parse(await result);
  assert.equal(shown.sent, false);
  assert.equal(shown.request.request_key, 'k-1');
  assert.equal(shown.rows[0].action, 'REMOVES THIS ROW');
  assert.deepEqual(shown.rows[0].current, { words: 'kept', price: 9900, nested: { a: 1 } });
  assert.equal(shown.rows[0].new, null);
  assert.deepEqual(shown.rows[0].dropped_fields, ['nested.a', 'price', 'words']);
  assert.equal(wrote(asked), false);
  assert.equal(JSON.stringify(rows), before, 'the row is the same after the dry run');
});

test('op --dry-run on a replacing write prints the field diff and what it drops, and changes nothing', async () => {
  const rows = { 'note:one': { words: 'kept', price: 9900 } };
  const input = '{"records":[{"id":"note:one","type":"note","value":{"words":"new","extra":true}}]}';
  const { asked, result } = run(['op', '@own-records', 'records:write', input, '--dry-run'], rows);
  const row = JSON.parse(await result).rows[0];
  assert.equal(row.action, 'replaces this row');
  assert.deepEqual(row.diff.map(entry => [entry.field, entry.change]), [['extra', 'added'], ['price', 'dropped'], ['words', 'changed']]);
  assert.deepEqual(row.dropped_fields, ['price']);
  assert.equal(wrote(asked), false);
  assert.deepEqual(rows, { 'note:one': { words: 'kept', price: 9900 } });
});

test('op --dry-run on a write to an absent row says it creates it, and writes nothing', async () => {
  const input = '{"records":[{"id":"note:new","type":"note","value":{"a":1}}]}';
  const { asked, result, rows } = run(['op', '@own-records', 'records:write', input, '--dry-run']);
  assert.equal(JSON.parse(await result).rows[0].action, 'creates this row');
  assert.equal(wrote(asked), false);
  assert.deepEqual(rows, {});
});

test('op --dry-run on a read prints the request and sends nothing', async () => {
  const { asked, result } = run([...READ, '--dry-run', '--request-key', 'k-2']);
  const shown = JSON.parse(await result);
  assert.deepEqual(shown, { address: '@own-records', method: 'records:read', request_key: 'k-2', input: { id: 'note:one' } });
  assert.equal(asked.length, 0);
});

test('the flags op and call know still work', async () => {
  const { asked, result } = run([...READ, '--request-key', 'k-3', '--timeout', '5', '--json']);
  assert.match(await result, /note:one/);
  assert.ok(asked.length > 0);
});
