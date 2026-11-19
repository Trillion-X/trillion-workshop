// tools/generate-speech/test/speak-aloud.test.mjs
//
// The Mac app's speaking road (do-work/speak-aloud.mjs) reads and writes no store and holds no key: the person's voices
// and places come in with the request, and a notice that could never be said is handed back as the tool and input to
// report it with, for the caller to run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const road = path.join(import.meta.dirname, '..', 'do-work', 'speak-aloud.mjs');
const run = (args, stdin) => spawnSync('node', [road, ...args], { input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH } });
const lastLine = output => JSON.parse(output.trim().split('\n').pop());

test('--unsaid hands back the tool and input that report a notice that was never said, with no key or store', () => {
  const made = run(['--unsaid'], JSON.stringify({ notice: 'n1', title: 'Hello', why: 'no voice', hours: 3 }));
  assert.equal(made.status, 0);
  const told = lastLine(made.stdout);
  assert.equal(told.tool, 'tool:report-progress');
  assert.equal(told.input.key, 'unsaid-out-loud:n1');
  assert.equal(told.input.kind, 'stopped');
  assert.equal(told.input.state, 'failed');
  assert.equal(told.input.title, 'Not said out loud: Hello');
  assert.match(told.input.body, /waited 3 hours/);
  assert.match(told.input.body, /Why: no voice$/);
});

test('a request with no words is refused with an error answer and exit 1, and writes no sound file', () => {
  const sound = path.join(os.tmpdir(), `speak-aloud-test-${process.pid}.wav`);
  const refused = run(['--out', sound], JSON.stringify({ text: '' }));
  assert.equal(refused.status, 1);
  assert.deepEqual(lastLine(refused.stdout), { error: 'Give the words to say.' });
});

test('the road imports no records door and reads no account key or origin', () => {
  assert.doesNotMatch(readFileSync(road, 'utf8'), /records-door|openRecordsDoorAt|TRILLION_ORIGIN/);
});
