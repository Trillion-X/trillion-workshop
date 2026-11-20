// test/codex-runs.test.mjs
//
// harness/codex-runs.mjs starts a fresh Codex run, reads its output window and state, and cancels it. Every test puts a
// fake `codex` first on PATH (a mkdtemp folder, removed after) and keeps runs in its own mkdtemp root, so no test
// contacts a real account and nothing is written under the person's home folder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelCodexRun, readCodexRun, startCodexRun } from '../harness/codex-runs.mjs';

// A stand-in for the codex CLI: it says its arguments, echoes the prompt it reads on standard input, and ends with a
// multi-byte line. FAKE_CODEX_HANG keeps it running (a child that a cancel must also end); FAKE_CODEX_EXIT sets its code.
const FAKE_CODEX = `#!/bin/sh
printf 'argv:%s\\n' "$*"
cat
printf '\\n'
printf 'done \\342\\234\\223 \\360\\237\\230\\200\\n'
if [ -n "$FAKE_CODEX_HANG" ]; then sleep 60; fi
exit "\${FAKE_CODEX_EXIT:-0}"
`;

let sandbox;
let savedPath;
let root;
let folder;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'codex-runs-test-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  root = join(sandbox, 'runs');
  folder = join(sandbox, 'workspace');
  mkdirSync(folder);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});

after(() => {
  process.env.PATH = savedPath;
  rmSync(sandbox, { recursive: true, force: true });
});

// Polls a read until the run's state is no longer running, or fails after a few seconds.
async function untilEnded(run) {
  for (let i = 0; i < 250; i += 1) {
    const read = readCodexRun({ run, root, most: 1 << 20 });
    if (read.state !== 'running') return read;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.fail(`run ${run} did not end`);
}

test('a fresh Codex run starts in the folder with the exec, json, folder and reply flags, and gets its prompt on standard input', async () => {
  const started = startCodexRun({ folder, message: 'Write the plan. Ünïcode ok.', root });
  assert.match(started.run, /^codex-[0-9a-f-]{36}$/);
  assert.equal(started.folder, realpathSync(folder));
  const read = await untilEnded(started.run);
  assert.equal(read.state, 'exited');
  assert.equal(read.exit_code, 0);
  const [argvLine, promptLine] = read.output.split('\n');
  assert.equal(argvLine, `argv:exec --json --skip-git-repo-check -C ${realpathSync(folder)} -o ${join(root, started.run, 'reply.txt')} -`);
  assert.equal(promptLine, 'Write the plan. Ünïcode ok.');
});

test('a read answers the bytes after the cursor in windows of whole characters that add up to the whole output', async () => {
  const { run } = startCodexRun({ folder, message: 'windowed', root });
  const ended = await untilEnded(run);
  const whole = readCodexRun({ run, root, most: 1 << 20 });
  assert.equal(whole.output, ended.output);
  assert.equal(whole.next, whole.written);
  let cursor = 0;
  const pieces = [];
  while (cursor < whole.written) {
    const window = readCodexRun({ run, root, after: cursor, most: 7 });
    assert.equal(window.from, cursor);
    assert.ok(!window.output.includes('�'), 'a window never splits a character');
    if (window.next === cursor) continue;
    pieces.push(window.output);
    cursor = window.next;
  }
  assert.equal(pieces.join(''), whole.output);
  const past = readCodexRun({ run, root, after: whole.written + 500 });
  assert.equal(past.from, whole.written);
  assert.equal(past.output, '');
});

test('a run that ends with a failure code reports that code and keeps what it said', async () => {
  process.env.FAKE_CODEX_EXIT = '3';
  try {
    const { run } = startCodexRun({ folder, message: 'fail', root });
    const read = await untilEnded(run);
    assert.equal(read.state, 'exited');
    assert.equal(read.exit_code, 3);
    assert.match(read.output, /argv:exec/);
  } finally { delete process.env.FAKE_CODEX_EXIT; }
});

test('cancel ends a running run and its child process, and reads back as cancelled', async () => {
  process.env.FAKE_CODEX_HANG = '1';
  try {
    const { run } = startCodexRun({ folder, message: 'hang', root });
    for (let i = 0; i < 250 && !readCodexRun({ run, root }).output.includes('argv:'); i += 1) await new Promise(done => setTimeout(done, 20));
    assert.equal(readCodexRun({ run, root }).state, 'running');
    const cancelled = await cancelCodexRun({ run, root });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(readCodexRun({ run, root }).state, 'cancelled');
    const again = await cancelCodexRun({ run, root });
    assert.deepEqual([again.cancelled, again.state], [false, 'cancelled']);
  } finally { delete process.env.FAKE_CODEX_HANG; }
});

test('cancel does nothing to a run that already ended', async () => {
  const { run } = startCodexRun({ folder, message: 'short', root });
  await untilEnded(run);
  const answer = await cancelCodexRun({ run, root });
  assert.deepEqual([answer.cancelled, answer.state, answer.exit_code], [false, 'exited', 0]);
});

test('a start is refused for a missing folder, an empty message, and a run read with a bad id or an unknown run', () => {
  assert.throws(() => startCodexRun({ folder: join(sandbox, 'missing'), message: 'x', root }), /does not exist/);
  assert.throws(() => startCodexRun({ folder, message: '   ', root }), /message is needed/);
  assert.throws(() => readCodexRun({ run: '../../etc', root }), /run id is codex-/);
  assert.throws(() => readCodexRun({ run: 'codex-00000000-0000-0000-0000-000000000000', root }), /No such run/);
});
