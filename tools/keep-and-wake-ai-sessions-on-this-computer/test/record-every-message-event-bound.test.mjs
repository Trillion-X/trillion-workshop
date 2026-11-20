// harness/record-every-message.mjs: a hook event over max_event_bytes is drained and ignored, so it keeps nothing, prints
// nothing and exits 0; the same transcript under a small event is kept. The turn is caught up from the cursor later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../harness/record-every-message.mjs', import.meta.url));
const { max_event_bytes: MAX } = JSON.parse(readFileSync(new URL('../harness/record-every-message.json', import.meta.url), 'utf8'));
const SESSION = '8c5a4d75-c324-4633-aa0a-986edabfc1d5';

const transcriptIn = dir => {
  const path = join(dir, `${SESSION}.jsonl`);
  const row = { isSidechain: false, userType: 'external', entrypoint: 'cli', sessionId: SESSION, origin: { kind: 'human' },
    type: 'user', timestamp: '2026-09-27T18:19:20.677Z', message: { role: 'user', content: [{ type: 'text', text: 'Keep this one message.' }] } };
  writeFileSync(path, `${JSON.stringify(row)}\n`);
  return path;
};

// Runs the entry point as the Stop hook does, with the event on stdin, against a loopback origin that counts requests.
async function runHook(event) {
  const home = mkdtempSync(join(tmpdir(), 'record-every-message-home-'));
  const keyFile = join(home, 'key');
  writeFileSync(keyFile, 'test-key\n');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ message_id: 'message-1', arrival_id: 'arrival-1' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const child = spawn(process.execPath, [SCRIPT, '--harness', 'claude-code'], {
      env: { ...process.env, HOME: home, RECORDER_TEST_ORIGIN: `http://127.0.0.1:${port}`, RECORDER_TEST_KEY_FILE: keyFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const code = new Promise(resolve => child.on('exit', resolve));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
    return { code: await code, stdout, requests };
  } finally {
    server.close();
  }
}

test('an event over max_event_bytes keeps nothing, prints nothing and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-every-message-big-'));
  const event = { session_id: SESSION, transcript_path: transcriptIn(dir), pad: 'x'.repeat(MAX) };
  const result = await runHook(event);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.requests, []);
});

test('the same transcript under an event within max_event_bytes is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-every-message-small-'));
  const result = await runHook({ session_id: SESSION, transcript_path: transcriptIn(dir) });
  assert.equal(result.code, 0);
  assert.ok(result.requests.some(url => url === '/mcp/api/inbound'), `expected the person's message to be sent, saw ${result.requests}`);
});
