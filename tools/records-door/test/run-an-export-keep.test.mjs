// The export runner's keep path: a row with no `database` answers its keep list as every row does, and a `database` given
// to a row that declares its keep table is written there (the mount is missing here, so it is refused and nothing is written).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNNER = new URL('../do-work/run-an-export.mjs', import.meta.url).pathname;
const dir = tempFolder(join(tmpdir(), 'keep-runner-'));
const moduleFile = join(dir, 'tool.mjs');
writeFileSync(moduleFile, `export function decide(input) {
  return { case_id: 'source:x', keep: [{ id: 'source:x', type: 'decision', value: { status: 'needs_outcome' }, expected: null }] };
}`);

// `mounted` is a file given to the child on descriptor 4, as the engine mounts a connection; without it, nothing is on 4.
function run(input, options = [], { mounted = null } = {}) {
  // Descriptors 3 and 4 are given a file each (/dev/null unless a mount is given): a child would otherwise inherit the test runner's pipes.
  const stdio = ['pipe', 'pipe', 'pipe', openSync('/dev/null', 'r'), openSync(mounted ?? '/dev/null', 'r')];
  const child = spawnSync(process.execPath, [RUNNER, moduleFile, 'decide', ...options], { input: JSON.stringify(input), encoding: 'utf8', stdio });
  return { code: child.status, answer: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
}

test('a row with no database answers its keep list as before, and never loads pg', () => {
  const { code, answer } = run({ source_id: 'x' }, ['--keep-into', 'decision_records', '--keep-fd', '4']);
  assert.equal(code, 0, 'pg is not installed here, so a load would fail the run');
  assert.equal(answer.result.case_id, 'source:x');
  assert.equal(answer.result.keep.length, 1, 'the keep list is returned');
  assert.equal(answer.result.kept_in, undefined);
});

test('a row with no keep table answers its keep list whatever its input says', () => {
  const { code, answer } = run({ source_id: 'x' });
  assert.equal(code, 0);
  assert.equal(answer.result.keep.length, 1);
});

test('a database given to a row with a keep table, with nothing mounted on the descriptor, is refused and writes nothing', () => {
  const { code, answer } = run({ source_id: 'x', database: 'proofs_for_who_runs_it' }, ['--keep-into', 'decision_records', '--keep-fd', '4']);
  assert.equal(code, 1);
  assert.ok(answer.error, 'refused');
  assert.equal(answer.result, undefined, 'nothing is answered as written');
});

test('a database given, with a descriptor that holds no connection, is refused before pg loads', () => {
  const notAConnection = join(dir, 'not-a-connection.txt');
  writeFileSync(notAConnection, 'this is not a connection string\n');
  const { code, answer } = run({ source_id: 'x', database: 'proofs_for_who_runs_it' }, ['--keep-into', 'decision_records', '--keep-fd', '4'], { mounted: notAConnection });
  assert.equal(code, 1);
  assert.match(answer.error, /No database connection is mounted on descriptor 4/);
});

test('a keep descriptor below 4 is refused before anything runs', () => {
  const { code, answer } = run({ source_id: 'x', database: 'proofs_for_who_runs_it' }, ['--keep-into', 'decision_records', '--keep-fd', '3']);
  assert.equal(code, 1);
  assert.match(answer.error, /--keep-fd/);
});
