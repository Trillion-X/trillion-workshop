// The rows, read the way the engine reads them, and run through the same command the container runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import * as pulls from '../do-work/pull.mjs';
import * as reads from '../do-work/read.mjs';
import { loadSource, sourceIds } from '../read-data/sources.mjs';
import { PART_KIND, stateId, threadId } from '../read-data/snapshot.mjs';

// The source a pull row runs: its function is named pull<Source>, the source id without its dashes.
const sourceOfRow = row => sourceIds().find(id => id.replaceAll('-', '') === row.invoke.argv.at(-1).replace(/^pull/, '').toLowerCase());
const all = rows.records.map(record => record.payload);
const pullRows = all.filter(row => row.id.startsWith('tool:pull-my-'));
const handedRows = pullRows.filter(row => loadSource(sourceOfRow(row)).handed_in);
const askingRows = pullRows.filter(row => !handedRows.includes(row));
const readRow = rowOf(rows, 'tool:read-what-i-pulled-from-an-account');

test('there is one pull row for each source, and each runs a function this folder exports', () => {
  assert.equal(pullRows.length, sourceIds().length);
  assert.equal(new Set(all.map(row => row.id)).size, all.length);
  for (const row of pullRows) {
    const name = row.invoke.argv.at(-1);
    assert.equal(typeof pulls[name], 'function', row.id);
    assert.equal(row.invoke.argv.at(-2), '/opt/pull-from-connected-accounts/do-work/pull.mjs');
  }
  assert.equal(readRow.invoke.argv.at(-1), 'readPulledSnapshot');
  assert.equal(typeof reads.readPulledSnapshot, 'function');
});

test('a pull row that asks a service gets the public internet, its own held token on descriptor 4 and the records door on 3, and nothing more', () => {
  const secrets = new Set();
  for (const row of askingRows) {
    assert.equal(row.invoke.internet, true, row.id);
    assert.deepEqual(row.invoke.records, { fd: 3, rights: [{ kind: PART_KIND, prefix: 'account-snapshot:', operations: ['records:list', 'records:write'] }] }, row.id);
    assert.equal(row.invoke.credential_mounts.length, 1, row.id);
    assert.equal(row.invoke.credential_mounts[0].fd, 4);
    assert.match(row.invoke.credential_mounts[0].secret_name, /^[a-z]+(-[a-z]+)*-(token)$/);
    secrets.add(row.invoke.credential_mounts[0].secret_name);
    assert.equal(row.maker, 'maker:pull-from-connected-accounts');
    assert.equal(row.invoke.stdin.fill.from, 'input');
    assert.ok(!('account' in row.invoke) && !JSON.stringify(row.input_schema).includes('token'), row.id);
  }
  assert.equal(secrets.size, askingRows.length);
});

test('a pull row for a source handed its document gets the records door on 3, no internet and no secret, and takes the document as input', () => {
  assert.deepEqual(handedRows.map(row => row.id), ['tool:pull-my-signal-messages']);
  for (const row of handedRows) {
    assert.equal(row.invoke.internet, false, row.id);
    assert.equal(row.needs.network_egress, false, row.id);
    assert.deepEqual(row.invoke.records, { fd: 3, rights: [{ kind: PART_KIND, prefix: 'account-snapshot:', operations: ['records:list', 'records:write'] }] }, row.id);
    assert.equal(row.invoke.credential_mounts, undefined, row.id);
    const document = loadSource(sourceOfRow(row)).handed_in.document;
    assert.deepEqual(row.input_schema.required, ['self_id', document], row.id);
    assert.equal(row.input_schema.properties[document].type, 'array', row.id);
    assert.equal(row.maker, 'maker:pull-from-connected-accounts');
  }
});

test('every pull row says in its output what was left out, as { conversation, reason }', () => {
  for (const row of pullRows) assert.deepEqual(row.output_schema.properties.skipped.items.required, ['conversation', 'reason'], row.id);
});

test('the read row can only list the records, and reaches no network and no secret', () => {
  assert.equal(readRow.invoke.internet, false);
  assert.deepEqual(readRow.invoke.records.rights, [{ kind: PART_KIND, prefix: 'account-snapshot:', operations: ['records:list'] }]);
  assert.equal(readRow.invoke.credential_mounts, undefined);
  assert.deepEqual(readRow.input_schema.properties.source.enum, sourceIds());
});

test('no row carries a path on a computer or a maker that is not the folder (provenance names where the job came from)', () => {
  const text = JSON.stringify(all.map(({ provenance, ...row }) => row));
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /bitfield|trillion/i);
  assert.ok(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8').length > 0);
});

test('run as the container runs it with no token handed over, a pull says it needs a login and touches no record', async () => {
  for (const row of askingRows) {
    const ran = await runRow(row, {});
    assert.equal(ran.status, 0, ran.error);
    assert.equal(ran.result.status, 'needs_login', row.id);
    assert.equal(ran.calls.length, 0, row.id);
  }
});

test('run as the container runs it, a pull refuses input that is out of range with what to give', async () => {
  const ran = await runRow(pullRows[0], { limit: 9000 });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /limit is a whole number from 1 to 500/);
});

test('run as the container runs it, a handed-in pull keeps the conversations in the records, and refuses a document that is not a list or a missing self_id', async () => {
  const [row] = handedRows;
  const ran = await runRow(row, { self_id: 'acct-a', conversations: [{ id: 'thread-1', name: 'Bakers', messages: [{ id: 'm1', timestamp: 1700000000000, from: 'acct-b', body: 'Rye is ready' }] }] });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.status, 'pulled');
  assert.equal(ran.result.new_messages, 1);
  assert.equal(ran.result.cursor, 1700000000000);
  assert.ok(ran.kept.some(record => record.id === threadId('signal', 'default', 'thread-1')));
  const notAList = await runRow(row, { self_id: 'acct-a', conversations: 'not a list' });
  assert.equal(notAList.status, 1);
  assert.match(notAList.error, /conversations is the whole list of conversations that Signal printed/);
  const noSelf = await runRow(row, { conversations: [] });
  assert.equal(noSelf.status, 1);
  assert.match(noSelf.error, /self_id is the identity of the account/);
});

test('run as the container runs it, the read row answers from the records and a thread read gives its messages', async () => {
  const records = [
    { id: stateId('slack', 'default'), type: PART_KIND, value: { kind: 'state', source: 'slack', account: 'default', self_id: 'U0BOT', cursor: '1700000200.000300', pulled_at: '2026-10-30T12:00:00Z' } },
    { id: threadId('slack', 'default', 'C1'), type: PART_KIND, value: { kind: 'thread', seq: 1, thread: { id: 'C1', title: 'orders', messages: [{ ts: '1', text: 'a' }, { ts: '2', text: 'b' }, { ts: '3', text: 'c' }] } } },
  ];
  const summary = await runRow(readRow, { source: 'slack' }, { records });
  assert.equal(summary.status, 0, summary.error);
  assert.deepEqual(summary.result.threads, [{ id: 'C1', title: 'orders', messages: 3 }]);
  assert.equal(summary.result.self_id, 'U0BOT');
  assert.equal(summary.result.pulled_at, '2026-10-30T12:00:00Z');
  const one = await runRow(readRow, { source: 'slack', thread: 'C1', limit: 2 }, { records });
  assert.deepEqual(one.result.thread.messages.map(message => message.text), ['b', 'c']);
  assert.equal(one.result.thread.total, 3);
  const nothing = await runRow(readRow, { source: 'discord', account: 'other' }, { records });
  assert.match(nothing.result.said, /Nothing has been pulled from discord for the account other yet/);
  const missing = await runRow(readRow, { source: 'slack', thread: 'C9' }, { records });
  assert.equal(missing.status, 1);
  assert.match(missing.error, /There is no conversation C9/);
});
