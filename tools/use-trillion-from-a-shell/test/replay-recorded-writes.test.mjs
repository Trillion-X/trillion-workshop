import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import cli from '../do-work/trillion.json' with { type: 'json' };
import { expand, main, parseArgs } from '../do-work/trillion.mjs';
import {
  batchesOf, credentialLike, dryRun, inventoryOf, shellCommands, shellWrites, writeInventory,
} from '../do-work/replay-recorded-writes.mjs';

const host = { parseArgs, expand, settings: cli, programs: new Set(['trillion', 'trillion.mjs']) };
const folder = () => mkdtempSync(join(tmpdir(), 'replay-writes-test-'));
const T = minutes => new Date(Date.UTC(2026, 0, 28, 12, minutes)).toISOString();
const since = Date.UTC(2026, 0, 25);

// Synthetic transcript rows in the two shapes the DATA names: message parts (call and result in separate rows) and
// completed items (call and result in one row).
const call = (id, name, input, minutes, cwd = '/work') => JSON.stringify({ type: 'assistant', timestamp: T(minutes), cwd, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, minutes, isError = false) => JSON.stringify({ type: 'user', timestamp: T(minutes), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const operation = records => ({ address: '@own-records', method: 'records:write', request_key: 'k', input: { records } });
const item = (minutes, value) => JSON.stringify({ timestamp: T(minutes), type: 'event_msg', payload: { type: 'item_completed', started_at_ms: Date.parse(T(minutes)) - 1000, item: value } });
const row = (id, value, type = 'note') => ({ id, type, value });

async function inventory(transcripts, extra = {}) {
  const files = Object.keys(transcripts).map(path => ({ path }));
  return inventoryOf({ host, files, since, open: path => transcripts[path], ...extra });
}
const keptIds = found => Object.fromEntries(found.kept.map(entry => [entry.record.id, entry.record.value]));

test('a succeeded records:write is kept, in each shape and road', async () => {
  const found = await inventory({
    '/t/a.jsonl': [
      call('c1', 'mcp__account__run_resource_operation', operation([row('note:1', { text: 'one' })]), 1),
      result('c1', [{ type: 'text', text: '{"changed":true,"write_count":1}' }], 2),
      call('c2', 'Bash', { command: `trillion op @own-records records:write '${JSON.stringify({ records: [row('note:2', { text: 'two' })] })}' --json` }, 3),
      result('c2', '{\n  "changed": true,\n  "write_count": 1\n}', 4),
    ],
    '/t/b.jsonl': [
      item(5, { type: 'McpToolCall', id: 'exec-1', server: 'account', tool: 'run_resource_operation', status: 'completed', arguments: operation([row('note:3', { text: 'three' })]), result: { structuredContent: { changed: true, write_count: 1 }, isError: false } }),
      item(6, { type: 'CommandExecution', id: 'exec-2', cwd: 'file:///work', exit_code: 0, command: ['/bin/zsh', '-lc', `trillion op @own-records records:write - <<'EOF'\n{"records":[{"id":"note:4","type":"note","value":{"text":"four"}}]}\nEOF`], aggregated_output: '{\n  "changed": true,\n  "write_count": 1\n}' }),
    ],
  });
  assert.deepEqual(keptIds(found), { 'note:1': { text: 'one' }, 'note:2': { text: 'two' }, 'note:3': { text: 'three' }, 'note:4': { text: 'four' } });
  assert.equal(found.counts.calls_kept, 4);
  assert.equal(found.types.note.records, 4);
});

test('a refused or unanswered call is skipped and listed, never kept', async () => {
  const found = await inventory({
    '/t/a.jsonl': [
      call('c1', 'mcp__account__run_resource_operation', operation([row('note:1', { text: 'refused' })]), 1),
      result('c1', 'The resource operation was refused.', 2, true),
      call('c2', 'Bash', { command: `trillion op @own-records records:write '{"records":[{"id":"note:2","type":"note","value":{}}]}' 2>&1 | head -3` }, 3),
      result('c2', 'The local door refused records:write.', 4),
      call('c3', 'Bash', { command: `trillion op @own-records records:write '{"records":[{"id":"note:3","type":"note","value":{}}]}' > /tmp/out.json` }, 5),
      result('c3', '', 6),
      call('c4', 'mcp__account__run_resource_operation', operation([row('note:4', {})]), 7),
    ],
    '/t/b.jsonl': [
      item(8, { type: 'McpToolCall', id: 'exec-1', tool: 'run_resource_operation', status: 'failed', arguments: operation([row('note:5', {})]), result: { content: [{ type: 'text', text: 'refused' }], isError: true } }),
      item(9, { type: 'CommandExecution', id: 'exec-2', exit_code: 3, command: ['/bin/zsh', '-lc', `trillion op @own-records records:write '{"records":[{"id":"note:6","type":"note","value":{}}]}'`], aggregated_output: 'refused' }),
    ],
  });
  assert.deepEqual(found.kept, []);
  assert.deepEqual(found.skipped.map(row => [row.skipped, row.ids ?? null]), [
    ['refused', ['note:1']], ['refused', null], ['result_unknown', null], ['no_result', ['note:4']], ['refused', ['note:5']], ['refused', null],
  ]);
});

test('the newest write of a record wins by the time of its call, whichever file holds it, and conflicts are listed', async () => {
  const write = (id, minutes, value) => [call(id, 'mcp__account__run_resource_operation', operation([row('note:1', value)]), minutes), result(id, '{"changed":true}', minutes + 1)];
  const found = await inventory({ '/t/a.jsonl': [...write('c1', 30, { text: 'newest' })], '/t/b.jsonl': [...write('c2', 10, { text: 'older' }), ...write('c3', 20, { text: 'middle' })] });
  assert.deepEqual(keptIds(found), { 'note:1': { text: 'newest' } });
  assert.equal(found.conflicts.length, 1);
  assert.equal(found.conflicts[0].versions, 3);
  assert.equal(found.conflicts[0].distinct_values, 3);
});

test('a null value is a removal, carried as the newest write', async () => {
  const found = await inventory({ '/t/a.jsonl': [
    call('c1', 'mcp__account__run_resource_operation', operation([row('note:1', { text: 'made' }), row('note:2', { text: 'kept' })]), 1), result('c1', '{"changed":true}', 2),
    call('c2', 'mcp__account__run_resource_operation', operation([{ id: 'note:1', type: 'note', value: null }]), 3), result('c2', '{"changed":true}', 4),
  ] });
  assert.deepEqual(keptIds(found), { 'note:1': null, 'note:2': { text: 'kept' } });
  assert.deepEqual(found.types.note, { records: 1, removals: 1, first: found.types.note.first, last: found.types.note.last });
});

test('malformed escapes are tolerated: a broken line is counted and passed over, shell escapes are read as the shell reads them', async () => {
  const broken = '{"type":"assistant","timestamp":"2026-01-28T12:00:00Z","message":{"content":[{"type":"tool_use","id":"cx","name":"Bash","input":{"command":"trillion op @own-records records:write \\q"}}]}';
  const found = await inventory({ '/t/a.jsonl': [
    broken,
    call('c1', 'Bash', { command: 'trillion op @own-records records:write "{\\"records\\":[{\\"id\\":\\"note:1\\",\\"type\\":\\"note\\",\\"value\\":{\\"text\\":\\"quoted \\\\\\" mark\\"}}]}"' }, 1),
    result('c1', '{ "changed": true }', 2),
    call('c2', 'Bash', { command: `trillion op @own-records records:write '{"records":[{"id":"note:2","type":"note","value":{"text":"it'\\''s"}}]}'` }, 3),
    result('c2', '{ "changed": true }', 4),
    call('c3', 'Bash', { command: `trillion op @own-records records:write '{"records":[{"id":"note:3","type":"note","value":{"text":"bad \\q escape"}}]}'` }, 5),
    result('c3', '{ "changed": true }', 6),
  ] });
  assert.equal(found.counts.unreadable_lines, 1);
  assert.deepEqual(keptIds(found), { 'note:1': { text: 'quoted " mark' }, 'note:2': { text: "it's" } });
  assert.deepEqual(found.skipped.map(row => row.skipped), ['input_not_json']);
});

test('a file input is read from what the transcript wrote, or from disk only when unchanged since the call answered', async () => {
  const dir = folder();
  const onDisk = join(dir, 'disk.json'), changed = join(dir, 'changed.json');
  writeFileSync(onDisk, JSON.stringify({ records: [row('note:2', { text: 'disk' })] }));
  writeFileSync(changed, JSON.stringify({ records: [row('note:3', { text: 'changed later' })] }));
  const answered = Date.parse(T(4));
  utimesSync(onDisk, new Date(answered - 60_000), new Date(answered - 60_000));
  utimesSync(changed, new Date(answered + 60_000), new Date(answered + 60_000));
  const found = await inventory({ '/t/a.jsonl': [
    call('w1', 'Write', { file_path: '/scratch/w.json', content: JSON.stringify({ records: [row('note:1', { text: 'written' })] }) }, 0),
    call('c1', 'Bash', { command: 'trillion op @own-records records:write "$(cat /scratch/w.json)"' }, 1),
    result('c1', '{"changed": true}', 2),
    call('c2', 'Bash', { command: `cd ${dir} && trillion op @own-records records:write - < disk.json | jq -c .changed` }, 3),
    result('c2', 'true', 4),
    call('c3', 'Bash', { command: `trillion op @own-records records:write - < ${changed}` }, 3),
    result('c3', '{"changed": true}', 4),
    call('c4', 'Bash', { command: `jq -c '{records:[.]}' x.json | trillion op @own-records records:write -` }, 5),
    result('c4', '{"changed": true}', 6),
  ] });
  assert.deepEqual(keptIds(found), { 'note:1': { text: 'written' }, 'note:2': { text: 'disk' } });
  assert.deepEqual(found.skipped.map(row => row.skipped), ['file_changed_after_call', 'built_at_run_time']);
});

test('shell lines are read as a shell reads them: pipes, heredocs into files, flags and redirects', () => {
  const commands = shellCommands(`cat > /s/a.json <<'EOF'\n{"records":[]}\nEOF\necho '{"a":1}' | trillion op --json @own-records records:write - 2>&1 | head`);
  assert.equal(commands.length, 4);
  assert.equal(commands[0].redirects.find(row => row.op === '<<').body, '{"records":[]}\n');
  const files = new Map();
  const found = shellWrites(`cat > /s/a.json <<'EOF'\n{"records":[1]}\nEOF\ntrillion op @own-records records:write - < /s/a.json\necho '{"b":2}' | trillion op --as ai:x @own-records records:write -`, { host, files });
  assert.deepEqual(found.map(row => row.input), [{ text: '{"records":[1]}\n', from: 'transcript' }, { text: '{"b":2}\n' }]);
  assert.deepEqual(shellWrites('trillion op @own-records records:read \'{"id":"x"}\'', { host }), []);
  assert.deepEqual(shellWrites('trillion op @own-records records:write "$V"', { host }).map(row => row.input), [{ problem: 'built_at_run_time' }]);
});

test('a record whose newest value looks like a credential is listed by id and kept out of the inventory', async () => {
  assert.equal(credentialLike({ token: 'abcdefghijklmnopqrstuvwxyz012345' }), false);
  assert.equal(credentialLike({ api_key: 'abcdefghijklmnopqrstuvwxyz012345' }), true);
  assert.equal(credentialLike({ about: `the key starts sk_live_${'A1'.repeat(12)}` }), true);
  assert.equal(credentialLike({ about: 'an api_key is a secret that is never written into notes' }), false);
  const found = await inventory({ '/t/a.jsonl': [
    call('c1', 'mcp__account__run_resource_operation', operation([row('connection:1', { client_secret: 'Z'.repeat(40) }, 'connection'), row('note:1', { text: 'plain' })]), 1),
    result('c1', '{"changed":true}', 2),
  ] });
  assert.deepEqual(keptIds(found), { 'note:1': { text: 'plain' } });
  assert.deepEqual(found.credential_like.map(row => row.id), ['connection:1']);
});

test('a call carried again by a resumed session is read once', async () => {
  const lines = [call('c1', 'mcp__account__run_resource_operation', operation([row('note:1', { text: 'one' })]), 1), result('c1', '{"changed":true}', 2)];
  const found = await inventory({ '/t/a.jsonl': lines, '/t/b.jsonl': lines });
  assert.equal(found.counts.calls_kept, 1);
  assert.equal(found.counts.repeated_calls, 1);
});

test('the dry run writes the inventory folder and nothing else; writing it back batches, keys, resumes and reads back', async () => {
  const home = folder(), out = join(home, 'inventory');
  // One app's folder is named by its home variable, the other is its folder under the home directory (its skills row).
  const [named, under] = ['claude-code', 'codex'].map(id => cli.skills.find(row => row.id === id));
  const env = { [named.home_variable]: join(home, 'elsewhere') };
  const transcripts = join(home, 'elsewhere', 'projects');
  const records = Array.from({ length: 300 }, (_, at) => row(`note:${String(at).padStart(3, '0')}`, { text: `row ${at}` }));
  const lines = [call('c1', 'mcp__account__run_resource_operation', operation(records.slice(0, 256)), 1), result('c1', '{"changed":true}', 2),
    call('c2', 'mcp__account__run_resource_operation', operation([...records.slice(256), { id: 'gone:1', type: 'gone', value: null }]), 3), result('c2', '{"changed":true}', 4)];
  mkdirSync(join(transcripts, 'project'), { recursive: true });
  writeFileSync(join(transcripts, 'project', 's.jsonl'), `${lines.join('\n')}\n`);
  const summary = await dryRun({ host, home, env, since: '2026-01-25T00:00:00Z', folder: out });
  assert.deepEqual(summary.roots, [{ app: named.id, folder: transcripts }, { app: under.id, folder: join(home, under.folder, 'sessions') }]);
  assert.equal(summary.transcripts, 1);
  assert.equal(summary.records.kept, 300);
  assert.equal(summary.records.removals, 1);
  assert.equal(readFileSync(join(out, 'records.jsonl'), 'utf8').trim().split('\n').length, 301);

  const sent = [], store = new Map();
  let refuseOnce = true;
  const client = { op: async (address, method, input, options = {}) => {
    sent.push({ method, size: input.records?.length ?? 0, key: options.requestKey ?? null });
    if (method === 'records:write') {
      if (input.records.some(record => record.id === 'note:299') && refuseOnce) { refuseOnce = false; throw Object.assign(new Error('busy'), { code: 'busy' }); }
      for (const record of input.records) record.value === null ? store.delete(record.id) : store.set(record.id, record.value);
      return { changed: true, write_count: input.records.length };
    }
    return { value: store.get(input.id) ?? null };
  } };
  const first = await writeInventory(client, out);
  assert.deepEqual(sent.filter(row => row.method === 'records:write').map(row => [row.size, row.key]), [[256, 'replay-from-transcripts-inventory-1'], [45, 'replay-from-transcripts-inventory-2']]);
  assert.equal(first.failed.length, 1);
  sent.length = 0;
  const again = await writeInventory(client, out);
  assert.deepEqual(sent.filter(row => row.method === 'records:write').map(row => row.key), ['replay-from-transcripts-inventory-2']);
  assert.equal(again.written, 301);
  assert.deepEqual(again.failed, []);
  assert.equal(again.readback.read, 4);
  assert.equal(again.readback.same, 4);
  assert.deepEqual(batchesOf(records, { max_records: 256, max_bytes: 200 }).map(batch => batch.length).slice(0, 2), [3, 3]);
});

test('the command asks for the earliest call time and for a dry run\'s folder before it reads or sends anything', async () => {
  const seams = { env: {}, localDoor: () => null, computerName: 'Mac', model: null, store: { read: () => null }, grants: { read: () => null } };
  await assert.rejects(main(['records', 'replay-from-transcripts'], seams), /--since TIME/);
  await assert.rejects(main(['records', 'replay-from-transcripts', '--since', 'soon'], seams), /--since TIME/);
  await assert.rejects(main(['records', 'replay-from-transcripts', '--write'], seams), /--inventory FOLDER/);
  await assert.rejects(main(['records', 'replay-from-transcripts', '--write', '--inventory', folder()], seams), /holds no records\.jsonl/);
  await assert.rejects(main(['records', 'list'], seams), /replay-from-transcripts/);
});
