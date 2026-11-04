import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendToTrillion, settings, sweepTranscriptQueue, transcriptSweepKey, transcriptsBehind } from '../harness/record-every-message.mjs';

test('sweep queue uses stable opaque transcript keys', async t => {
  const root = mkdtempSync(join(tmpdir(), 'recorder-sweep-fairness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'projects', 'p');
  mkdirSync(project, { recursive: true });
  const sessions = ['session-a0000001', 'session-b0000002', 'session-c0000003'];
  const paths = sessions.map(session => {
    const path = join(project, `${session}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'custom-title', sessionId: session })}\n`);
    return path;
  });
  const rules = { ...settings, cursor_folder: join(root, 'cursors'), harnesses: settings.harnesses.map(harness => harness.id === 'claude-code'
    ? { ...harness, transcript_roots: [{ folder: join(root, 'projects'), depth: 1 }] }
    : { ...harness, transcript_roots: [] }) };

  const firstOrder = transcriptsBehind(rules);
  assert.equal(firstOrder.length, 3);
  assert.deepEqual(firstOrder.map(transcriptSweepKey), [...firstOrder].map(transcriptSweepKey));
  assert.ok(firstOrder.every(row => /^[0-9a-f]{64}$/.test(transcriptSweepKey(row))));
  assert.deepEqual(new Set(firstOrder.map(row => row.path)), new Set(paths));
  const visited = [];
  const result = await sweepTranscriptQueue({ ...rules, time_box_ms: 10 }, {
    now: () => 0,
    runTranscript: async item => { visited.push(item.path); return { pending: 1 }; },
  });
  assert.equal(result.processed, 3, 'an immediately blocked chat is attempted only once per sweep');
  assert.equal(new Set(visited).size, 3, 'a blocked chat cannot spin while the clock has not advanced');
});

test('timeboxed sweeps serve an owed small chat and revisit a large backlog while new chats keep arriving', async t => {
  const root = mkdtempSync(join(tmpdir(), 'recorder-sweep-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'projects', 'p'), cursors = join(root, 'cursors');
  mkdirSync(project, { recursive: true });
  mkdirSync(cursors, { recursive: true });
  const rules = { ...settings, executions_path: null, cursor_folder: cursors, time_box_ms: 10,
    harnesses: settings.harnesses.map(harness => harness.id === 'claude-code'
      ? { ...harness, transcript_roots: [{ folder: join(root, 'projects'), depth: 1 }] }
      : { ...harness, transcript_roots: [] }) };
  const makeChat = (session, rowCount = 1) => {
    const path = join(project, `${session}.jsonl`);
    const rows = Array.from({ length: rowCount }, (_, index) => ({ type: index ? 'progress' : 'custom-title', sessionId: session }));
    writeFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
    return path;
  };
  makeChat('session-a0000001', 2);
  makeChat('session-b0000002');
  const initialOrder = transcriptsBehind(rules);
  assert.equal(initialOrder.length, 2);
  const largePath = initialOrder[0].path;
  const smallPath = initialOrder[1].path;
  writeFileSync(largePath, [
    { type: 'custom-title', sessionId: initialOrder[0].session_id },
    { type: 'progress', sessionId: initialOrder[0].session_id },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const firstRowBytes = Buffer.byteLength(`${JSON.stringify({ type: 'custom-title', sessionId: initialOrder[0].session_id })}\n`);
  const visits = [];
  let clock = Date.now();

  const sweep = () => sweepTranscriptQueue(rules, { now: () => clock, runTranscript: async item => {
    visits.push(item.path);
    const offset = item.path === largePath ? firstRowBytes : statSync(item.path).size;
    writeFileSync(join(cursors, `${item.session_id}.json`), JSON.stringify({ transcript: item.path, offset, harness: item.harness, context: {} }));
    clock += rules.time_box_ms;
    return { pending: item.path === largePath ? 1 : 0 };
  } });

  await sweep();
  assert.equal(visits[0], largePath, 'the first chat has a bounded turn and remains pending');
  await sweep();
  assert.equal(visits[1], smallPath, 'the small chat gets its turn behind the still-owed large chat');
  for (let index = 0; index < 5; index += 1) {
    makeChat(`session-new${String(index).padStart(4, '0')}`);
    await sweep();
  }
  assert.ok(visits.filter(path => path === largePath).length >= 2, 'new chats do not starve the older large backlog');
  assert.equal(visits.filter(path => path === smallPath).length, 1, 'completed chats leave the queue');
  const saved = JSON.parse(readFileSync(join(cursors, rules.sweep.cursor_file), 'utf8'));
  assert.ok(saved.pending_keys.every(key => /^[0-9a-f]{64}$/.test(key)), 'persistent queue contains digests only');
});

test('an unknown inbound outcome retries the same message and arrival identity', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const bodies = [];
  let stored = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${settings.origin}${settings.inbound_path}`);
    bodies.push(JSON.parse(options.body));
    if (!stored) {
      stored = true; // the server accepted the message and arrival, but its reply was lost
      throw new Error('connection closed after acceptance');
    }
    return { ok: true, json: async () => ({ message_id: 'message:stable', arrival_id: 'arrival:stable' }) };
  };
  const message = { conversation_id: 'claude-code:session-a', app: 'Claude Code', speaker: 'person', text: 'A kept message',
    at: '2026-10-22T12:00:00.000Z', source_ref: 'transcript-row:91' };
  await assert.rejects(sendToTrillion([message], { rules: settings, deadline: Date.now() + 1000, key: 'test' }));
  assert.equal(await sendToTrillion([message], { rules: settings, deadline: Date.now() + 1000, key: 'test' }), true);
  assert.deepEqual(bodies[0], bodies[1], 'retry carries the exact same source identity into both books');
  assert.equal(bodies[1].source_ref, message.source_ref);
});
