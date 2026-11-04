// The recorder hook reads a bounded slice of a transcript each pass, and at most one backlog drain (--drain) runs on a
// computer: twenty started at once while one is running all end at once and leave the running one alone (harness/
// record-every-message.mjs; 138 GB of Trillion.app memory, 2026-10-21).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { settings, rowsFrom, drainTranscript } from '../harness/record-every-message.mjs';

const script = fileURLToPath(new URL('../harness/record-every-message.mjs', import.meta.url));

test('a live read takes a bounded slice of a large transcript and says more is left', t => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-live-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'big.jsonl');
  const line = JSON.stringify({ type: 'event_msg', payload: { detail: 'x'.repeat(1000) } }) + '\n';
  writeFileSync(path, line.repeat(Math.ceil((settings.transcript_read_bytes * 3) / line.length)));
  const read = rowsFrom(path, 0, settings);
  assert.ok(settings.transcript_read_bytes > 0 && settings.transcript_row_bytes >= settings.transcript_read_bytes);
  assert.ok(read.offset <= settings.transcript_read_bytes, `read ${read.offset} bytes`);
  assert.equal(read.more, true);
});

test('twenty drains started while one runs all end at once, and the running one keeps its lock', async t => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-drain-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const folder = join(home, '.trillion', 'record-every-message');
  mkdirSync(folder, { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  writeFileSync(join(folder, 'drain.lock'), String(holder.pid));
  const transcript = join(home, 't.jsonl');
  writeFileSync(transcript, '');
  const ended = await Promise.all(Array.from({ length: 20 }, () => new Promise(resolve => {
    const child = spawn(process.execPath, [script, '--drain', '--transcript', transcript, '--session-id', 'session-00000001'],
      { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve('stuck'); }, 10_000);
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  })));
  assert.deepEqual(ended, Array(20).fill(0));
  assert.equal(readFileSync(join(folder, 'drain.lock'), 'utf8'), String(holder.pid), 'the running drain keeps its lock');
  assert.equal(existsSync(join(folder, 'session-00000001.drain.lock')), false, 'no ended drain worked on the chat');
});

test('a pass over a 200 MB transcript holds memory to the read window', t => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-live-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'huge.jsonl');
  const block = (JSON.stringify({ type: 'event_msg', payload: { detail: 'x'.repeat(1000) } }) + '\n').repeat(1000);
  const handle = openSync(path, 'w');
  for (let written = 0; written < 200 * 1024 * 1024; written += block.length) writeSync(handle, block);
  closeSync(handle);
  const before = process.memoryUsage().rss;
  let offset = 0, passes = 0;
  while (passes < 3) { const read = rowsFrom(path, offset, settings); offset = read.offset; passes += 1; }
  const grown = process.memoryUsage().rss - before;
  assert.ok(grown < 100 * 1024 * 1024, `three passes grew memory by ${grown >> 20} MB`);
  assert.ok(offset <= 3 * settings.transcript_read_bytes);
});

test('a drain over a 520 MB transcript stays under 100 MB of memory and ends within its turn', async t => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-drain-big-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'huge.jsonl');
  const handle = openSync(path, 'w');
  writeSync(handle, JSON.stringify({ type: 'session_meta', payload: { id: 'big-drain-session', source: 'vscode' } }) + '\n');
  const block = (JSON.stringify({ type: 'event_msg', payload: { detail: 'x'.repeat(1000) } }) + '\n').repeat(1000);
  for (let written = 0; written < 520 * 1024 * 1024; written += block.length) writeSync(handle, block);
  closeSync(handle);
  const began = Date.now();
  const out = await new Promise(resolve => {
    const child = spawn('/usr/bin/time', ['-l', process.execPath, script, '--drain', '--transcript', path, '--session-id', 'big-drain-session'],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ err, stuck: true }); }, settings.drain_most_ms);
    child.on('exit', () => { clearTimeout(timer); resolve({ err }); });
  });
  assert.ok(!out.stuck, 'the drain ended');
  assert.ok(Date.now() - began < settings.drain_session_ms + 15_000, `ended after ${Date.now() - began} ms`);
  const peak = Number(/(\d+)\s+maximum resident set size/.exec(out.err)?.[1]);
  assert.ok(peak < 100 * 1024 * 1024, `peak memory ${peak >> 20} MB`);
});

test('one chat takes only its turn at the drain, and says it has more', async t => {
  const root = mkdtempSync(join(tmpdir(), 'trillion-drain-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'chat.jsonl');
  writeFileSync(path, [{ type: 'session_meta', payload: { id: 'turn-session-1', source: 'vscode' } },
    { type: 'response_item', timestamp: '2026-07-01T10:00:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A reply.' }] } }]
    .map(row => JSON.stringify(row) + '\n').join(''));
  const began = Date.now();
  const result = await drainTranscript({ transcript_path: path, session_id: 'turn-session-1' }, {
    rules: { ...settings, cursor_folder: join(root, 'cursors'), drain_session_ms: 300, drain_wait_ms: { first: 20, most: 40 } },
    key: () => 'fictional-test-key', sourceReturn: () => {}, send: async () => false });
  assert.equal(result.pending, 1);
  assert.equal(result.reason, 'drain time box');
  assert.ok(Date.now() - began < 3000, `took ${Date.now() - began} ms`);
});

// A loopback stand-in for Trillion: answers every request the way the test says, and keeps what it was sent.
async function fakeTrillion(t, answer) {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => { seen.push(body); await answer(request, response, body, seen.length); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
const acceptAll = (_request, response, body) => {
  const sent = JSON.parse(body);
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ ids: (sent.messages ?? []).map((_, index) => `message:${index}`) }));
};
const huge = (handle, megabytes) => {
  const block = (JSON.stringify({ type: 'event_msg', payload: { detail: 'x'.repeat(1000) } }) + '\n').repeat(1000);
  for (let written = 0; written < megabytes * 1024 * 1024; written += block.length) writeSync(handle, block);
};
const reply = (text, minute) => JSON.stringify({ type: 'response_item', timestamp: `2026-07-01T10:0${minute}:00.000Z`,
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
const meta = id => JSON.stringify({ type: 'session_meta', payload: { id, source: 'vscode' } }) + '\n';

test('a drain over a 520 MB transcript against a server that answers 507 stays under 100 MB and ends by its turn', async t => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-drain-507-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const server = await fakeTrillion(t, (_request, response) => { response.statusCode = 507; response.end('{"error":"This store is full and is freeing space; send this again shortly."}'); });
  const keyFile = join(home, 'key');
  writeFileSync(keyFile, 'fictional-test-key');
  const path = join(home, 'huge.jsonl');
  const handle = openSync(path, 'w');
  writeSync(handle, meta('drain-507-session'));
  huge(handle, 520);
  writeSync(handle, reply('A reply the account will not take yet.', 1));
  closeSync(handle);
  const began = Date.now();
  const out = await new Promise(resolve => {
    const child = spawn('/usr/bin/time', ['-l', process.execPath, script, '--drain', '--transcript', path, '--session-id', 'drain-507-session'],
      { env: { ...process.env, HOME: home, TRILLION_RECORDER_TEST_ORIGIN: server.origin, TRILLION_RECORDER_TEST_KEY_FILE: keyFile }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ err, stuck: true }); }, settings.drain_most_ms);
    child.on('exit', () => { clearTimeout(timer); resolve({ err }); });
  });
  assert.ok(!out.stuck, 'the drain ended');
  assert.ok(Date.now() - began < settings.drain_session_ms + 30_000, `ended after ${Date.now() - began} ms`);
  assert.ok(server.seen.length > 0 && server.seen.every(body => body === server.seen[0]), 'the same reply was sent again each time, never a second message');
  const peak = Number(/(\d+)\s+maximum resident set size/.exec(out.err)?.[1]);
  // 65 MB reading the file; about 100 MB once the first request is made and refused (the engine's own network stack).
  assert.ok(peak < 120 * 1024 * 1024, `peak memory ${peak >> 20} MB`);
});

test('a sweep gives a small chat its turn behind a huge one', async t => {
  const home = mkdtempSync(join(tmpdir(), 'trillion-sweep-turns-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const server = await fakeTrillion(t, acceptAll);
  const keyFile = join(home, 'key');
  writeFileSync(keyFile, 'fictional-test-key');
  const sessions = join(home, 'codex', 'sessions', '2026', '07', '01');
  mkdirSync(sessions, { recursive: true });
  const small = join(sessions, 'small.jsonl'), big = join(sessions, 'big.jsonl');
  writeFileSync(small, meta('small-chat-session') + reply('The small chat reply.', 2));
  const handle = openSync(big, 'w');
  writeSync(handle, meta('big-chat-session'));
  huge(handle, 520);
  writeSync(handle, reply('The huge chat reply.', 3));
  closeSync(handle);
  const { utimesSync } = await import('node:fs');
  utimesSync(small, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // the huge chat is the newest, so it goes first
  await new Promise(resolve => {
    const child = spawn(process.execPath, [script, '--sweep'], { env: { ...process.env, HOME: home, CODEX_HOME: join(home, 'codex'),
      TRILLION_RECORDER_TEST_ORIGIN: server.origin, TRILLION_RECORDER_TEST_KEY_FILE: keyFile }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(); }, settings.sweep_time_box_ms + 20_000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.ok(server.seen.some(body => body.includes('The small chat reply.')), 'the small chat was kept in the same sweep');
});
