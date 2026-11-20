// The old hook suite's outcomes that had no current test by name, ported onto the current scripts.
//   - a session whose transcript is recorded is told not to record its own turn again (old tests.rs 495);
//   - a session that starts is registered with its harness under its own agent id (old tests.rs 537);
//   - a new harness is a row, read without a code change (old tests.rs 576);
//   - the hook writes only under the folder its settings list (old tests.rs 609).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedLineFor, settings as notices } from '../harness/decisions-since.mjs';
import { settings as recording, harnessOf } from '../harness/record-every-message.mjs';
import { folderOf, registerSession, sessionCard, settings as sessionRules } from '../harness/wake-sessions.mjs';

const SCRIPT = fileURLToPath(new URL('../harness/record-every-message.mjs', import.meta.url));
const SESSION = '8c5a4d75-c324-4633-aa0a-986edabfc1d5';

// The home folder is read at call time, so each test points it at a fresh folder and restores it after.
async function withHome(run) {
  const saved = process.env.HOME;
  const home = tempFolder(join(tmpdir(), 'keep-and-wake-home-'));
  process.env.HOME = home;
  try { return await run(home); } finally { process.env.HOME = saved; }
}

test('a session whose transcript is recorded is told not to record its own turn again', () => {
  const recorded = join(homedir(), '.claude', 'projects', 'project-one', `${SESSION}.jsonl`);
  const event = { session_id: SESSION, transcript_path: recorded, hook_event_name: 'UserPromptSubmit' };
  assert.equal(recordedLineFor(event, { rules: notices, recorded: recording, env: process.env }), notices.recorded_line);
  const elsewhere = { session_id: SESSION, transcript_path: join(homedir(), 'notes', `${SESSION}.jsonl`) };
  assert.equal(recordedLineFor(elsewhere, { rules: notices, recorded: recording, env: process.env }), '');
});

test('a session that starts is registered with its harness under its own agent id, published as an agent', () => withHome(home => {
  const [harness] = Object.keys(sessionRules.harnesses);
  const hosted = registerSession({ harness, session_id: 'session-0001-abcd', cwd: '/work/project-one' });
  assert.equal(hosted.harness, harness);
  assert.equal(hosted.session_id, 'session-0001-abcd');
  assert.equal(hosted.source_id, `${harness}:session-0001-abcd`);
  const card = sessionCard(hosted);
  assert.equal(card.agent_id, hosted.agent_id);
  assert.equal(card.source_id, `${harness}:session-0001-abcd`);
  assert.deepEqual(card.delivery, { stream: true });
  const written = JSON.parse(readFileSync(join(folderOf(sessionRules), sessionRules.hosted_file), 'utf8'));
  assert.equal(written.sessions[0].agent_id, hosted.agent_id);
}));

test('a new harness is a row: it is recognized from its row alone, with no code change', () => {
  const newRow = { id: 'new-tool', app: 'New Tool', recognized_by: [{ path: ['newToolMarker'], present: true }] };
  const rules = { ...recording, harnesses: [...recording.harnesses, newRow] };
  assert.equal(harnessOf([{ newToolMarker: 'yes' }], rules)?.id, 'new-tool');
  assert.equal(harnessOf([{ sessionId: SESSION }], rules)?.id, 'claude-code');
  assert.equal(harnessOf([{ unrelated: true }], rules), null);
});

function runHook(home, event) {
  const keyFile = join(tempFolder(join(tmpdir(), 'keep-and-wake-key-')), 'key');
  writeFileSync(keyFile, 'test-key\n');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ message_id: 'message-1', arrival_id: 'arrival-1' })); });
  });
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const child = spawn(process.execPath, [SCRIPT, '--harness', 'claude-code'], {
      env: { ...process.env, HOME: home, RECORDER_TEST_ORIGIN: `http://127.0.0.1:${port}`, RECORDER_TEST_KEY_FILE: keyFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify(event));
    child.on('error', reject);
    child.on('exit', code => { server.close(); resolve({ code, requests }); });
  }));
}

function filesUnder(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('the hook writes only under the folder its settings list', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-and-wake-transcript-'));
  const transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ isSidechain: false, userType: 'external', entrypoint: 'cli', sessionId: SESSION,
    origin: { kind: 'human' }, type: 'user', timestamp: '2026-09-27T18:19:20.677Z', message: { role: 'user', content: [{ type: 'text', text: 'Keep this one message.' }] } })}\n`);
  await withHome(async home => {
    const result = await runHook(home, { session_id: SESSION, transcript_path: transcript });
    assert.equal(result.code, 0);
    assert.ok(result.requests.length >= 1, 'the message was sent, so the write path was exercised');
    const listed = recording.cursor_folder.replace(/^~(?=\/|$)/, home);
    const written = filesUnder(home).filter(path => statSync(path).isFile());
    assert.ok(written.length > 0);
    for (const path of written) assert.ok(path.startsWith(listed + '/'), `${path} is outside the listed folder`);
  });
});
