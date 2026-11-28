// A step leaves its refusal status for the site to answer: the real form-page tool (serve-form-page.ts keep, signed out) over a
// real PostgreSQL server in a temp folder leaves its 401 as one JSON line { error, status } on standard error, with the step's own
// words. A step that fails with no status of its own leaves plain words, no JSON line, which a site answers as a 502.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 56000 + (process.pid % 900);
const LOGIN = ['postgres', 'made-up-admin-pw'];
const CONNECTION = `postgres://${LOGIN.join(':')}@127.0.0.1:${PORT}/postgres`;
const STEPS = join(import.meta.dirname, '..', '..', 'ask-questions-sort-answers-follow-up', 'steps', 'serve-form-page.ts');
let server: EmbeddedPostgres;

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'refusal-status-')), user: LOGIN[0], password: LOGIN[1], port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
});
after(async () => { await server.stop(); });

// One run of a step as the engine starts it: the input on standard input, the connection on descriptor 3.
function runStep(step: string, input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STEPS, step], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    (child.stdio[3] as NodeJS.WritableStream).end(CONNECTION);
    child.stdin!.end(JSON.stringify(input));
  });
}

test('a signed-out keep leaves its 401 with its words as one JSON line', async () => {
  const ran = await runStep('keep', { attemptId: 'attempt-1', database: 'postgres' });
  assert.equal(ran.code, 1);
  assert.deepEqual(JSON.parse(ran.stderr.trim()), { error: 'Sign in to keep your answers.', status: 401 });
});

test('a step that fails with no status of its own leaves plain words, no JSON line', async () => {
  const ran = await runStep('no-such-step', {});
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /^No step named no-such-step/);
  assert.throws(() => JSON.parse(ran.stderr.trim()), 'no status line a site could read as anything but a 502');
});
