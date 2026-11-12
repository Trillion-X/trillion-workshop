import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecordsDoor, recordsDoorFromCall, RecordsDoorError } from '../read-data/records-door.mjs';
import { requestKeyForEngine } from '../../content-identity/read-data/identity.mjs';
import { wholeAnswer } from '../read-data/byte-pages.mjs';
import { startFakeDoor } from './fake-door.mjs';
import { writeBatches } from '../read-data/write-batches.mjs';

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

test('workspace reads send only exact labels through the run bearer and preserve raw arrays, objects and missing labels', async () => {
  const values = {
    'screen-look': [{ id: 'warm', name: 'Warm' }],
    'workspace-preference:where-looks-apply': { everywhere_else: 'warm', rules: [{ host: 'docs.test' }] },
  };
  const labels = Object.keys(values).concat('workspace-preference:missing');
  const rights = labels.map(id => ({ kind: '@own-records', id, operations: ['workspace:read'] }));
  const door = await startFakeDoor({ rights, workspaceRecords: values, eventStream: true });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    assert.deepEqual(await client.readWorkspace(labels), { records: values });
    assert.deepEqual(door.calls.map(call => call.method), ['workspace:read']);
    assert.deepEqual(door.calls[0].input, { selection: { labels, prefixes: [] } });
    assert.equal(door.calls[0].authorization, `Bearer ${door.capability}`);
    assert.equal(door.calls[0].protocol, '2025-06-18');
  } finally { await door.close(); }
});

test('workspace reads reject ungranted sibling labels, invalid selections and unverified result envelopes', async () => {
  const door = await startFakeDoor({
    rights: [{ kind: '@own-records', id: 'screen-look', operations: ['workspace:read'] }],
    workspaceRecords: { 'screen-look': [] },
  });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    await assert.rejects(client.readWorkspace(['screen-look', 'screen-look-own-themes']), { code: 'current_workspace_rights_refused' });
    for (const labels of [[], ['screen-look', 'screen-look'], [''], [3], Array.from({ length: 65 }, (_, i) => `look-${i}`)]) {
      await assert.rejects(client.readWorkspace(labels), { code: 'original_input_refused' });
    }
    assert.equal(door.calls.length, 1, 'invalid requests are refused before network access');
  } finally { await door.close(); }

  for (const workspaceEnvelope of [
    { status: 403 },
    { content_type: 'text/html' },
    { text: '{broken' },
    { text: JSON.stringify({ records: { other: { leaked: true } } }) },
  ]) {
    const bad = await startFakeDoor({
      rights: [{ kind: '@own-records', id: 'screen-look', operations: ['workspace:read'] }],
      workspaceRecords: { 'screen-look': [] }, workspaceEnvelope,
    });
    try {
      await assert.rejects(openRecordsDoor({ descriptor: bad.descriptor, wait: noWait }).readWorkspace(['screen-look']),
        { code: 'original_workspace_read_unavailable', outcome: 'unknown' });
    } finally { await bad.close(); }
  }
});

test('workspace read byte pages are joined and authenticated by the shared byte-pages owner', async () => {
  const values = { 'screen-look': { theme: 'w'.repeat(1600), nested: { exact: [1, true, null] } } };
  const door = await startFakeDoor({
    rights: [{ kind: '@own-records', id: 'screen-look', operations: ['workspace:read'] }],
    workspaceRecords: values, bytePage: 128,
  });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    assert.deepEqual(await client.readWorkspace(['screen-look']), { records: values });
    const pages = door.calls.filter(call => call.method === 'workspace:read');
    assert.ok(pages.length > 3);
    assert.ok(pages.slice(1).every((call, at) => call.input.after_byte === (at + 1) * 128));
    assert.ok(pages.every(call => call.input.selection.labels[0] === 'screen-look' && call.input.selection.prefixes.length === 0));
  } finally { await door.close(); }
});

test('safe reads retry partial response bodies with the same request key and input', async () => {
  const cases = [
    { method: 'records:read', rights: [{ kind: 'note', operations: ['records:read'] }], input: ['note', 'note:1'], expected: { type: 'note', value: { words: 'one' } }, records: [{ id: 'note:1', type: 'note', value: { words: 'one' } }] },
    { method: 'records:list', rights: [{ kind: 'note', operations: ['records:list'] }], expected: { id: 'note:1', type: 'note', value: { words: 'one' } }, records: [{ id: 'note:1', type: 'note', value: { words: 'one' } }] },
    { method: 'workspace:read', rights: [{ kind: '@own-records', id: 'screen-look', operations: ['workspace:read'] }], expected: { records: { 'screen-look': { theme: 'warm' } } }, workspaceRecords: { 'screen-look': { theme: 'warm' } } },
  ];
  for (const item of cases) {
    const door = await startFakeDoor({ rights: item.rights, records: item.records, workspaceRecords: item.workspaceRecords, partialBodyFirst: 1 });
    try {
      const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
      let result;
      if (item.method === 'records:read') result = await client.readRecord(...item.input);
      if (item.method === 'records:list') result = (await client.list({ type: 'note' }).next()).value;
      if (item.method === 'workspace:read') result = await client.readWorkspace(['screen-look']);
      assert.deepEqual(result, item.expected);
      const calls = door.calls.filter(call => call.method === item.method);
      assert.equal(calls.length, 2, `${item.method} retries once after a body transport failure`);
      assert.equal(calls[0].key, calls[1].key, `${item.method} retries with the same request key`);
      assert.deepEqual(calls[0].input, calls[1].input, `${item.method} retries with identical input`);
    } finally { await door.close(); }
  }
});

test('safe read transport retries stop after five retries and report a stable error code', async () => {
  const door = await startFakeDoor({
    rights: [{ kind: 'note', operations: ['records:read'] }],
    partialBodyAlways: true,
  });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    await assert.rejects(client.readRecord('note', 'note:1'), { code: 'transport_unavailable' });
    assert.equal(door.calls.length, 6, 'one initial attempt and five retries');
    assert.ok(door.calls.every(call => call.key === door.calls[0].key));
    assert.ok(door.calls.every(call => JSON.stringify(call.input) === JSON.stringify(door.calls[0].input)));
  } finally { await door.close(); }
});

test('a retried transport failure stops immediately on HTTP 401', async () => {
  const door = await startFakeDoor({
    rights: [{ kind: 'note', operations: ['records:read'] }],
    partialBodyFirst: 1,
  });
  try {
    let attempts = 0;
    const client = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async (url, options) => {
        attempts += 1;
        if (attempts === 1) return fetch(url, options);
        return new Response(null, { status: 401 });
      },
    });
    await assert.rejects(client.readRecord('note', 'note:1'), { code: 'capability_gone' });
    assert.equal(attempts, 2, 'the 401 response is terminal');
  } finally { await door.close(); }
});

test('a refused run is told which check the door refused it with', async () => {
  const cause = 'trillion_local::mcp::http@src/mcp.rs:933:24:AuthenticationFailure::Unauthorized#abc';
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ['records:read'] }] });
  try {
    const client = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Bearer authentication is required', cause }), { status: 401 }),
    });
    await assert.rejects(client.readRecord('note', 'note:1'), error => error.code === 'capability_gone' && error.message.endsWith(`Refused by: ${cause}`));
  } finally { await door.close(); }
});

test('fetch transport failures retry safe reads, while malformed JSON fails immediately', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ['records:read'] }] });
  try {
    let fetchAttempts = 0;
    const client = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async (url, options) => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new TypeError('socket closed');
        return fetch(url, options);
      },
    });
    assert.equal(await client.readRecord('note', 'note:missing'), null);
    assert.equal(fetchAttempts, 2);
    assert.equal(door.calls.length, 1);

    let malformedAttempts = 0;
    const malformed = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async () => {
        malformedAttempts += 1;
        return new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(malformed.readRecord('note', 'note:missing'), SyntaxError);
    assert.equal(malformedAttempts, 1, 'JSON parse failures do not retry');

    let programmerAttempts = 0;
    const programmerError = new ReferenceError('fetch implementation bug');
    const broken = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async () => {
        programmerAttempts += 1;
        throw programmerError;
      },
    });
    await assert.rejects(broken.readRecord('note', 'note:missing'), error => error === programmerError);
    assert.equal(programmerAttempts, 1, 'programmer errors are not treated as transport failures');

    let writeAttempts = 0;
    const writeClient = openRecordsDoor({
      descriptor: door.descriptor,
      wait: noWait,
      fetchImpl: async () => {
        writeAttempts += 1;
        throw new TypeError('socket closed');
      },
    });
    await assert.rejects(writeClient.write([{ id: 'note:1', type: 'note', value: {} }]), TypeError);
    assert.equal(writeAttempts, 1, 'writes do not gain transport retries');
  } finally { await door.close(); }
});

test('a whole-record expected snapshot makes conditional writes atomic and leaves ordinary writes unconditional', async () => {
  const original = { words: 'before', nested: { count: 1 } };
  const second = { words: 'second before' };
  const door = await startFakeDoor({
    rights: [{ kind: 'note', operations: ALL }],
    records: [
      { id: 'note:1', type: 'note', value: original },
      { id: 'note:2', type: 'note', value: second },
    ],
  });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    const firstSnapshot = await client.readRecord('note', 'note:1');
    assert.deepEqual(firstSnapshot, { type: 'note', value: original });
    assert.deepEqual(await client.read('note', 'note:1'), original, 'read keeps its value-only result');

    await assert.rejects(client.write([
      { id: 'note:1', type: 'note', value: { words: 'must not land' }, expected: firstSnapshot },
      { id: 'note:2', type: 'note', value: { words: 'also must not land' }, expected: { type: 'note', value: { words: 'stale second snapshot' } } },
    ], { key: 'atomic-conditional-write' }), { code: 'original_command_conflict' });
    assert.deepEqual(await client.readRecord('note', 'note:1'), firstSnapshot, 'the matching first item was not partially applied');
    assert.deepEqual(await client.readRecord('note', 'note:2'), { type: 'note', value: second });

    await assert.rejects(client.write([
      { id: 'note:1', type: 'note', value: { words: 'must still not land' }, expected: null },
    ], { key: 'expected-absence-conflict' }), { code: 'original_command_conflict' });
    assert.deepEqual(await client.readRecord('note', 'note:1'), firstSnapshot);

    await client.write([{ id: 'note:1', type: 'note', value: { words: 'ordinary write' } }], { key: 'ordinary-write' });
    assert.deepEqual(await client.readRecord('note', 'note:1'), { type: 'note', value: { words: 'ordinary write' } });
    assert.equal(door.kept.get('note:1').expected, undefined, 'the condition is not stored as part of the record');
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

test('a list sends fields and where to the door, and keeps paging past pages where nothing matched', async () => {
  const records = Array.from({ length: 7 }, (_, at) => ({ id: `note:${at}`, type: 'note', value: { at, shelf: at === 1 || at === 5 ? 'top' : 'low', words: 'w'.repeat(50) } }));
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], records, pageCut: 2 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    const listed = [];
    for await (const record of client.list({ type: 'note', where: { shelf: 'top' }, fields: ['at'] })) listed.push(record);
    assert.deepEqual(listed, [{ id: 'note:5', type: 'note', value: { at: 5 } }, { id: 'note:1', type: 'note', value: { at: 1 } }]);
    assert.deepEqual(door.calls[0].input.where, { shelf: 'top' });
    assert.equal(door.calls.length, 4, 'a cut page with no match still names the next one');
  } finally { await door.close(); }
});

test('a throttled door (429) is asked again with the same key after a jittered wait that honours Retry-After', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], throttleFirst: 3, retryAfter: 2, eventStream: true });
  const waits = [];
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: ms => { waits.push(ms); return Promise.resolve(); } });
    const answer = await client.write([{ id: 'note:a', type: 'note', value: { n: 1 } }], { key: 'write-note-a' });
    assert.ok(answer, 'the write is answered once the door stops throttling');
    assert.equal(door.calls.filter(call => call.key === 'write-note-a').length, 4, 'three throttled answers, then the write');
    assert.equal(waits.length, 3);
    for (const ms of waits) assert.ok(ms >= 1000 && ms <= 2000, `a wait of ${ms} ms is half to all of the 2 s Retry-After`);
    assert.ok(new Set(waits).size > 1, 'the waits are jittered, not the same each time');
  } finally { await door.close(); }
});

test('a door at its dispatch limit (503) is asked again after a jittered wait, not on a fixed schedule', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], busyFirst: 3, eventStream: true });
  const waits = [];
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: ms => { waits.push(ms); return Promise.resolve(); } });
    await client.write([{ id: 'note:a', type: 'note', value: { n: 1 } }], { key: 'write-note-busy-jitter' });
    assert.equal(waits.length, 3, 'three busy answers, three waits');
    assert.notDeepEqual(waits, [200, 400, 800], 'the waits are jittered, not the fixed 200, 400, 800 schedule');
    for (const ms of waits) assert.ok(ms > 0 && ms <= 30000, `each wait is bounded: ${ms}`);
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

test('a busy write the engine answers as its source unavailable, before anything began, is sent again with the same key', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], busySourceFirst: 2 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    assert.deepEqual(await client.write([{ id: 'note:b', type: 'note', value: { n: 1 } }], { key: 'write-note-b' }), { changed: 1, write_count: 1 });
    assert.deepEqual(door.calls.map(call => call.key), ['write-note-b', 'write-note-b', 'write-note-b']);
  } finally { await door.close(); }
});

test('a write whose outcome is unknown is sent again with the same key and answers the receipt it made', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], unknownFirst: 1 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    assert.deepEqual(await client.write([{ id: 'note:u', type: 'note', value: { n: 1 } }], { key: 'write-note-u' }), { changed: 1, write_count: 1 });
    assert.deepEqual(door.calls.map(call => call.key), ['write-note-u', 'write-note-u']);
  } finally { await door.close(); }
});

test('a record too big for one message is read as pages of its own bytes, joined and checked against its BLAKE3', async () => {
  const long = { id: 'note:long', type: 'note', value: { words: 'flour, water, salt and time; '.repeat(40) } };
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }], records: [long, { id: 'note:a', type: 'note', value: { words: 'a' } }], bytePage: 300 });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor });
    assert.deepEqual(await client.read('note', 'note:long'), long.value);
    const listed = [];
    for await (const record of client.list({ type: 'note' })) listed.push(record.id);
    assert.deepEqual(listed, ['note:long', 'note:a']);
    const paged = door.calls.filter(call => call.method === 'records:read');
    assert.ok(paged.length > 3 && paged.slice(1).every((call, at) => call.input.after_byte === (at + 1) * 300), 'each page reads on from the last');
  } finally { await door.close(); }
});

test('byte pages that do not follow on, or whose joined bytes are not what the door hashed, are refused', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: 'kneaded' }));
  const page = (offset, length, next, blake3 = 'a'.repeat(64)) => ({ byte_page: { total: bytes.length, blake3, offset, length,
    base64: btoa(String.fromCharCode(...bytes.subarray(offset, offset + length))), next_after_byte: next } });
  await assert.rejects(wholeAnswer(page(0, 5, 5), async () => page(6, 5, null)), /do not follow on/);
  await assert.rejects(wholeAnswer(page(0, 5, 5), async () => page(5, bytes.length - 5, null)), /not the answer the door hashed/);
  assert.deepEqual(await wholeAnswer({ records: [] }, async () => { throw new Error('never asked'); }), { records: [] });
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

test('run-an-export prints a woken function\'s wake_effects beside its result, where the engine reads them', () => {
  assert.deepEqual(runExport('later', { at_ms: 1000 }), { status: 0, answer: { result: { said: 'later' }, wake_effects: [{ wake: { at_ms: 1000 } }] } });
});

test('a run with no door is told so', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'no-door-')), 'descriptor.json');
  writeFileSync(empty, '{}');
  assert.throws(() => openRecordsDoor({ descriptor: empty }), error => error instanceof RecordsDoorError && error.code === 'no_door');
});

test('files operations go to the files resource the run was handed, and a run with none is refused before sending', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'records-door-files-'));
  const sent = [];
  const fetchImpl = async (_url, { body }) => {
    sent.push(JSON.parse(body).params.arguments);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { names: [], next_after: null } } }), { headers: { 'content-type': 'application/json' } });
  };
  const handed = join(folder, 'with-files.json');
  writeFileSync(handed, JSON.stringify({ url: 'http://127.0.0.1:9/mcp', resource: '@made-up-records', capability: 'run_made_up', files_resource: '@made-up-files' }));
  assert.deepEqual(await openRecordsDoor({ descriptor: handed, fetchImpl }).files('list_files', { folder: '/notes/' }), { names: [], next_after: null });
  assert.deepEqual([sent[0].address, sent[0].method, sent[0].input], ['@made-up-files', 'list_files', { folder: '/notes/' }]);
  const none = join(folder, 'without-files.json');
  writeFileSync(none, JSON.stringify({ url: 'http://127.0.0.1:9/mcp', resource: '@made-up-records', capability: 'run_made_up' }));
  await assert.rejects(openRecordsDoor({ descriptor: none, fetchImpl }).files('list_files', {}), { code: 'no_files' });
  assert.equal(sent.length, 1);
});

test('writes are cut to fit one message: at most rows records and bytes of JSON each, a larger record alone', () => {
  const record = (n, size) => ({ id: `note:${n}`, type: 'note', value: { words: 'w'.repeat(size) } });
  const sizes = batches => batches.map(batch => batch.map(item => item.id));
  assert.deepEqual(sizes(writeBatches([1, 2, 3, 4, 5].map(n => record(n, 10)), { rows: 2, bytes: 10_000 })), [['note:1', 'note:2'], ['note:3', 'note:4'], ['note:5']]);
  assert.deepEqual(sizes(writeBatches([record(1, 400), record(2, 400), record(3, 5000), record(4, 10)], { rows: 256, bytes: 1000 })), [['note:1', 'note:2'], ['note:3'], ['note:4']]);
  assert.deepEqual(writeBatches([], { rows: 1, bytes: 1 }), []);
  for (const bounds of [{ rows: 0, bytes: 10 }, { rows: 1 }, { rows: 1.5, bytes: 10 }]) assert.throws(() => writeBatches([record(1, 1)], bounds), TypeError);
});

// A write the door keeps (`pending`) is read to its outcome by its request key, for every write of the shared client.

// A door that keeps its first write pending, then answers `then` for the same request key.
function doorThen(then) {
  const keys = [];
  const call = async (method, input, key) => {
    keys.push(key);
    if (keys.length === 1) return { accepted: true, pending: true, request_key: key };
    return then(key);
  };
  return { keys, door: recordsDoorFromCall(call, { resource: '@own-records', wait: noWait }) };
}

test('a pending write is asked again under its own key and returns the writer\'s commit', async () => {
  const { door, keys } = doorThen(() => ({ changed: 1, write_count: 1 }));
  const answer = await door.write([{ id: 'note:1', type: 'note', value: { words: 'one' } }]);
  assert.deepEqual(answer, { changed: 1, write_count: 1 });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the same key answers the outcome');
  assert.match(keys[0], /^records:write:/, 'a write with no key still gets one key for all its asks');
});

test('a writer refusal after a pending write is thrown to the caller, never reported as kept', async () => {
  const { door, keys } = doorThen(() => { throw new RecordsDoorError('command_settle_mismatch', 'refused', 'not_started'); });
  await assert.rejects(door.write([{ id: 'note:1', type: 'note', value: {} }], { key: 'k' }), { code: 'command_settle_mismatch' });
  assert.equal(keys.length, 2);
});

test('a write still pending when the settle window has passed is thrown as write_pending', async () => {
  const keys = [];
  const door = recordsDoorFromCall(async (method, input, key) => {
    keys.push(key);
    return { accepted: true, pending: true, request_key: key };
  }, { resource: '@own-records', wait: noWait });
  await assert.rejects(door.write([], { key: 'k' }), { code: 'write_pending', outcome: 'unknown' });
  assert.ok(keys.length > 1, 'it is asked again before it gives up');
  assert.ok(keys.every(key => key === 'k'));
});

test('a request key over the engine\'s 255-byte bound is sent as its BLAKE3 identity, the same every time; a key within it is sent unchanged', async () => {
  const door = await startFakeDoor({ rights: [{ kind: 'note', operations: ALL }] });
  try {
    const client = openRecordsDoor({ descriptor: door.descriptor, wait: noWait });
    const long = 'pairing-waiting:events:sample:'.padEnd(300, 'x');
    await client.write([{ id: 'note:1', type: 'note', value: {} }], { key: long });
    await client.write([{ id: 'note:1', type: 'note', value: {} }], { key: long });
    await client.write([{ id: 'note:1', type: 'note', value: {} }], { key: 'a'.repeat(255) });
    const [first, again, within] = door.calls.filter(call => call.method === 'records:write').map(call => call.key);
    assert.match(first, /^key:[0-9a-f]{2}:[0-9a-f]{64}$/, 'a 300-byte key is sent as its identity');
    assert.equal(first, again, 'the same long key is the same name on a retry');
    assert.equal(within, 'a'.repeat(255), 'a 255-byte key is sent unchanged');
    assert.notEqual(requestKeyForEngine(long), requestKeyForEngine(long.slice(0, -1)), 'two long keys never share a name');
  } finally { await door.close(); }
});

// A busy records account, asked again the door's own number of times, is a retryable refusal; any other refusal is final.
const busyDescriptorFor = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'records-door-busy-')), 'descriptor.json');
  writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', resource: '@own-records', capability: 'capability-x' }));
  return file;
};
const refusing = structuredContent => async () => Response.json({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent } });
const door = fetchImpl => openRecordsDoor({ descriptor: busyDescriptorFor(), fetchImpl, wait: async () => {} });

test('a busy account, asked again the door\'s own number of times, is a retryable refusal', async () => {
  const busy = door(refusing({ code: 'selected_owner_unavailable', outcome: 'not_started' }));
  await assert.rejects(busy.read('note', 'n1'), error => {
    assert.equal(error.code, 'selected_owner_unavailable');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('a source that began nothing while its workspace was busy is retryable too', async () => {
  const busy = door(refusing({ code: 'original_workspace_source_unavailable', outcome: 'not_started' }));
  await assert.rejects(busy.read('note', 'n1'), error => error.retryable === true);
});

test('a refusal that is not busy is final: it is not marked retryable', async () => {
  const refused = door(refusing({ code: 'original_input_refused', outcome: 'not_started' }));
  await assert.rejects(refused.read('note', 'n1'), error => {
    assert.equal(error.code, 'original_input_refused');
    assert.notEqual(error.retryable, true);
    return true;
  });
});
