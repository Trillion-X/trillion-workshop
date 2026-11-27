// The rows, read the way the engine reads them, and run through the same command the container runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import * as pulls from '../do-work/pull.mjs';
import { loadSource, sourceIds } from '../read-data/sources.mjs';

// The source a pull row runs: its function is named pull<Source>, the source id without its dashes.
const sourceOfRow = row => sourceIds().find(id => id.replaceAll('-', '') === row.invoke.run.at(-1).replace(/^pull/, '').toLowerCase());
const all = rows.records.map(record => record.payload);
const pullRows = all.filter(row => row.id.startsWith('tool:pull-my-'));
const handedRows = pullRows.filter(row => loadSource(sourceOfRow(row)).handed_in);
const askingRows = pullRows.filter(row => !handedRows.includes(row));

test('there is one pull row for each source, and each runs a function this folder exports', () => {
  assert.equal(pullRows.length, sourceIds().length);
  assert.equal(new Set(all.map(row => row.id)).size, all.length);
  for (const row of pullRows) {
    const name = row.invoke.run.at(-1);
    assert.equal(typeof pulls[name], 'function', row.id);
    assert.equal(row.invoke.run.at(-2), '/opt/pull-from-connected-accounts/do-work/pull.mjs');
  }
});

test('a pull row that asks a service gets the public internet, its own held token on descriptor 4, and no records door', () => {
  const secrets = new Set();
  for (const row of askingRows) {
    assert.ok(Array.isArray(row.invoke.may_reach), row.id);
    assert.equal(row.invoke.records, undefined, row.id);
    assert.equal(row.invoke.key.length, 1, row.id);
    assert.equal(row.invoke.key[0].fd, 4);
    assert.match(row.invoke.key[0].secret_name, /^[a-z]+(-[a-z]+)*-(token)$/);
    secrets.add(row.invoke.key[0].secret_name);
    assert.equal(row.maker, 'maker:pull-from-connected-accounts');
    assert.equal(row.invoke.stdin.fill.from, 'input');
    assert.ok(!('account' in row.invoke) && !JSON.stringify(row.input_schema).includes('token'), row.id);
  }
  // One held token serves every source that extends another on the same service (Instagram comments read with the messaging token);
  // any other two sources hold separate tokens.
  const sharing = new Map();
  for (const row of askingRows) {
    const name = row.invoke.key[0].secret_name;
    sharing.set(name, [...(sharing.get(name) ?? []), sourceOfRow(row)]);
  }
  assert.equal(secrets.size, sharing.size);
  for (const [name, sources] of sharing) {
    const [first, ...rest] = sources;
    const parent = id => JSON.parse(readFileSync(new URL(`../read-data/sources/${id}.json`, import.meta.url), 'utf8')).extends;
    for (const other of rest) assert.ok(parent(other) === first || parent(first) === other, `${name} is held for ${sources.join(' and ')}, which are not one service`);
  }
});

test('a pull row for a source handed its document gets no records door, no internet and no secret, and takes the document as input', () => {
  assert.deepEqual(handedRows.map(row => row.id), ['tool:pull-my-signal-messages']);
  for (const row of handedRows) {
    assert.equal(row.invoke.may_reach, undefined, row.id);
    assert.equal(row.needs.network_egress, false, row.id);
    assert.equal(row.invoke.records, undefined, row.id);
    assert.equal(row.invoke.key, undefined, row.id);
    const document = loadSource(sourceOfRow(row)).handed_in.document;
    assert.deepEqual(row.input_schema.required, ['self_id', document], row.id);
    assert.equal(row.input_schema.properties[document].type, 'array', row.id);
    assert.equal(row.maker, 'maker:pull-from-connected-accounts');
  }
});

test('every pull row hands back the conversations and items in its answer and takes what it holds as input', () => {
  for (const row of pullRows) {
    assert.equal(row.output_schema.properties.threads.type, 'array', row.id);
    assert.equal(row.output_schema.properties.collections.type, 'object', row.id);
    assert.equal(row.input_schema.properties.held.type, 'object', row.id);
    assert.doesNotMatch(row.description, /your records|keeps them|kept once/, row.id);
  }
});

test('every pull row says in its output what was left out, as { conversation, reason }', () => {
  for (const row of pullRows) assert.deepEqual(row.output_schema.properties.skipped.items.required, ['conversation', 'reason'], row.id);
});

test('no row carries a path on a computer or a maker that is not the folder (provenance names where the job came from)', () => {
  const text = JSON.stringify(all.map(({ provenance, ...row }) => row));
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /bitfield|trillion/i);
  assert.ok(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8').length > 0);
});

test('run as the container runs it with no token handed over, a pull says it needs a login and asks no one', async () => {
  for (const row of askingRows) {
    // The held token's descriptor is handed, empty: the run was given no token.
    const held = Object.fromEntries(row.invoke.key.map(mount => [mount.secret_name, '']));
    const ran = await answerOf(row, {}, { held });
    assert.equal(ran.status, 0, ran.error);
    assert.equal(ran.result.status, 'needs_login', row.id);
    assert.equal(ran.calls.length, 0, row.id);
  }
});

test('run as the container runs it, a pull refuses input that is out of range with what to give', async () => {
  const ran = await answerOf(pullRows[0], { limit: 9000 });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /limit is a whole number from 1 to 500/);
});

test('run as the container runs it, a handed-in pull answers the conversations and keeps nothing, and refuses a document that is not a list or a missing self_id', async () => {
  const [row] = handedRows;
  const ran = await answerOf(row, { self_id: 'acct-a', conversations: [{ id: 'thread-1', name: 'Bakers', messages: [{ id: 'm1', timestamp: 1700000000000, from: 'acct-b', body: 'Rye is ready' }] }] });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.status, 'pulled');
  assert.equal(ran.result.new_messages, 1);
  assert.equal(ran.result.cursor, 1700000000000);
  assert.deepEqual(ran.result.threads.map(thread => [thread.id, thread.messages.length]), [['thread-1', 1]]);
  assert.deepEqual(ran.kept, [], 'nothing is written to the records');
  const notAList = await answerOf(row, { self_id: 'acct-a', conversations: 'not a list' });
  assert.equal(notAList.status, 1);
  assert.match(notAList.error, /conversations is the whole list of conversations that Signal printed/);
  const noSelf = await answerOf(row, { conversations: [] });
  assert.equal(noSelf.status, 1);
  assert.match(noSelf.error, /self_id is the identity of the account/);
});

