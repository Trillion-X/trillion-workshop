import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecordsDoor, RecordsDoorError } from '../read-data/records-door.mjs';
import { startFakeDoor } from './fake-door.mjs';

const ALL = ['records:read', 'records:list', 'records:write'];
const noWait = async () => {};

test('read, list and write go through the door with the bearer capability and the protocol version', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], records: [{ id: 'note:1', type: 'note', value: { words: 'one' } }] });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    assert.deepEqual(await client.read('note', 'note:1'), { words: 'one' });
    assert.equal(await client.read('note', 'note:missing'), null);
    assert.deepEqual(await client.write([{ id: 'note:2', type: 'note', value: { words: 'two' } }]), { changed: 1, write_count: 1 });
    const listed = [];
    for await (const record of client.list({ type: 'note' })) listed.push(record.id);
    assert.deepEqual(listed, ['note:2', 'note:1'], 'greatest id first');
    assert.ok(door.calls.every(call => call.authorization === `Bearer ${door.capability}` && call.protocol === '2025-06-18'));
    assert.ok(door.calls.every(call => typeof call.key === 'string' && call.key.length <= 512));
  } finally { await door.close(); }
});

test('a list keeps paging while the door names a next page, short pages included', async () => {
  const records = Array.from({ length: 7 }, (_, at) => ({ id: `note:${at}`, type: 'note', value: { at } }));
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], records, pageCut: 2 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    const listed = [];
    for await (const record of client.list({ type: 'note', limit: 3 })) listed.push(record.value.at);
    assert.deepEqual(listed, [6, 5, 4, 3, 2, 1, 0]);
    assert.equal(door.calls.length, 4, 'four cut pages of two');
  } finally { await door.close(); }
});

test('a busy account is asked again, and the same write key answers the saved receipt', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], busyFirst: 2, eventStream: true });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    const first = await client.write([{ id: 'note:a', type: 'note', value: { n: 1 } }], { key: 'write-note-a' });
    const again = await client.write([{ id: 'note:a', type: 'note', value: { n: 1 } }], { key: 'write-note-a' });
    assert.deepEqual(again, first);
    assert.equal(door.calls.filter(call => call.key === 'write-note-a').length, 4, 'two busy answers, then the write, then the repeat');
  } finally { await door.close(); }
});

test('a call outside the run\'s rights is refused with the door\'s code, and the capability is never in the error', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ['records:read'] }] });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    await assert.rejects(client.write([{ id: 'note:x', type: 'note', value: {} }]), error => {
      assert.ok(error instanceof RecordsDoorError);
      assert.equal(error.code, 'current_workspace_rights_refused');
      assert.ok(!error.message.includes(door.capability));
      return true;
    });
    await assert.rejects(client.read('secret', 'secret:1'), { code: 'current_workspace_rights_refused' });
  } finally { await door.close(); }
});

test('a right narrowed to one id or a prefix reaches only those records', async () => {
  const records = [{ id: 'setting:keep_for', type: 'setting', value: { value: 1 } }, { id: 'setting:other', type: 'setting', value: { value: 2 } }];
  const door = await startFakeDoor({ rights: [{ kind: 'setting', id: 'setting:keep_for', operations: ['records:read', 'records:list'] }, { kind: 'note', prefix: 'note:a', operations: ['records:list'] }], records });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    assert.deepEqual(await client.read('setting', 'setting:keep_for'), { value: 1 });
    await assert.rejects(client.read('setting', 'setting:other'), { code: 'current_workspace_rights_refused' });
    await assert.rejects(client.list({ type: 'setting' }).next(), { code: 'current_workspace_rights_refused' }, 'an id right lists nothing');
    assert.deepEqual(await client.list({ type: 'note', prefix: 'note:a1' }).next(), { done: true, value: undefined });
    await assert.rejects(client.list({ type: 'note' }).next(), { code: 'current_workspace_rights_refused' }, 'a prefix right lists only inside its prefix');
    await assert.rejects(client.list({ type: 'note', prefix: 'note:a1', order: 'by-time' }).next(), { code: 'current_workspace_rights_refused' }, 'a prefix right lists with no order');
  } finally { await door.close(); }
});

test('one write carries at most the row\'s most_writes, and never more than the engine cap', async () => {
  const many = count => Array.from({ length: count }, (_, at) => ({ id: `note:${at}`, type: 'note', value: { at } }));
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], mostWrites: 3 });
  const capped = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }] });
  try {
    assert.equal((await openRecordsDoor({ descriptor: door.descriptor }).write(many(3))).changed, 3);
    await assert.rejects(openRecordsDoor({ descriptor: door.descriptor }).write(many(4)), { code: 'original_input_refused' });
    assert.equal((await openRecordsDoor({ descriptor: capped.descriptor }).write(many(256))).changed, 256);
    await assert.rejects(openRecordsDoor({ descriptor: capped.descriptor }).write(many(257)), { code: 'original_input_refused' });
  } finally { await door.close(); await capped.close(); }
});

test('a write whose outcome is unknown is sent again with the same key and answers the receipt it made', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], unknownFirst: 1 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    assert.deepEqual(await client.write([{ id: 'note:u', type: 'note', value: { n: 1 } }], { key: 'write-note-u' }), { changed: 1, write_count: 1 });
    assert.deepEqual(door.calls.map(call => call.key), ['write-note-u', 'write-note-u']);
  } finally { await door.close(); }
});

test('a refusal carries the door\'s code and outcome with words of its own, and an ended run says its door closed', async () => {
  const door = await startFakeDoor({ rights: [] });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    await assert.rejects(client.read('note', 'note:1'), error => error.code === 'current_workspace_rights_refused' && error.outcome === 'not_started' && /may not reach/.test(error.message));
    const ended = openRecordsDoor({ descriptor: door.descriptor, fetchImpl: async () => new Response(null, { status: 401 }) });
    await assert.rejects(ended.read('note', 'note:1'), { code: 'capability_gone' });
  } finally { await door.close(); }
});

// The driver as the container runs it: the input on standard input, the door's descriptor on descriptor 3.
const driver = fileURLToPath(new URL('../do-work/run-an-export.mjs', import.meta.url));
const sample = fileURLToPath(new URL('./sample-tool.mjs', import.meta.url));
function runExport(name, input, descriptor) {
  const stdio = ['pipe', 'pipe', 'pipe', descriptor === undefined ? 'ignore' : openSync(descriptor, 'r')];
  const run = spawnSync(process.execPath, [driver, sample, name], { input: JSON.stringify(input), encoding: 'utf8', stdio });
  return { status: run.status, answer: JSON.parse(run.stdout.trim().split('\n').at(-1)) };
}

test('run-an-export calls the named function with the input and the door, and prints its result', async () => {
  const records = [{ id: 'note:a1', type: 'note', value: { n: 1 } }, { id: 'note:a2', type: 'note', value: { n: 2 } }, { id: 'note:b1', type: 'note', value: { n: 3 } }];
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ['records:list'] }], records });
  try {
    const answer = await new Promise((done, fail) => {
      const stdio = ['pipe', 'pipe', 'pipe', openSync(door.descriptor, 'r')];
      const child = spawn(process.execPath, [driver, sample, 'countNotes'], { stdio });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', fail);
      child.on('close', status => done({ status, answer: JSON.parse(out.trim().split('\n').at(-1)) }));
      child.stdin.end(JSON.stringify({ prefix: 'note:a' }));
    });
    assert.deepEqual(answer, { status: 0, answer: { result: { count: 2 } } });
  } finally { await door.close(); }
});

test('run-an-export opens no door for a function that never asks, and refuses an unknown export', () => {
  assert.deepEqual(runExport('echo', { a: 1 }), { status: 0, answer: { result: { echoed: { a: 1 } } } });
  const missing = runExport('nothing', {});
  assert.equal(missing.status, 1);
  assert.match(missing.answer.error, /has no function nothing/);
});

test('a run with no door is told so', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'no-door-')), 'descriptor.json');
  writeFileSync(empty, '{}');
  assert.throws(() => openRecordsDoor({ descriptor: empty }), error => error instanceof RecordsDoorError && error.code === 'no_door');
});
