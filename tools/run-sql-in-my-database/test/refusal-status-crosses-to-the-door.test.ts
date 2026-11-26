// A step's refusal status crosses to the site unchanged: the real form-page tool (serve-form-page.ts keep, signed out) over a
// real PostgreSQL server in a temp folder leaves its 401 as one JSON line on standard error, and the pages front's door
// (door.ts toolAnswerOf) reads it as the engine hands it on ({ tool, exit_code, error }): a DoorError of status 401 with the
// step's own words. A step that fails with no status of its own leaves plain words, which the door reads as a 502.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { toolAnswerOf } from '../../serve-a-sites-pages-from-its-rows/do-work/door.ts';

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

const doorStatusOf = (ran: { code: number | null; stderr: string }) => {
  try { toolAnswerOf({ tool: 'tool:keep-a-form-sitting', exit_code: ran.code, error: ran.stderr.trim(), result: null }); } catch (error) { return error as { status: number; refusal: { words: string } | null }; }
  throw new Error('the run did not fail');
};

test('a signed-out keep leaves its 401 with its words, and the door answers 401', async () => {
  const ran = await runStep('keep', { attemptId: 'attempt-1', database: 'postgres' });
  assert.equal(ran.code, 1);
  assert.deepEqual(JSON.parse(ran.stderr.trim()), { error: 'Sign in to keep your answers.', status: 401 });
  const thrown = doorStatusOf(ran);
  assert.equal(thrown.status, 401);
  assert.equal(thrown.refusal?.words, 'Sign in to keep your answers.');
});

test('a step that fails with no status of its own leaves plain words, and the door answers 502', async () => {
  const ran = await runStep('no-such-step', {});
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /^No step named no-such-step/);
  assert.equal(doorStatusOf(ran).status, 502);
});
