// tools/check-declared-places-keep-what-is-written-there: the row is the shape the engine runs on the person's computer,
// and the command, run the way the engine runs it (the granted folder in argv, the input on standard input, the answer
// on the last line), answers over a made-up folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records[0].payload;

function run(granted, input) {
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'check-my-places.mjs'), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

// A made-up home: /work/kept has its own history, /work/loose has none, /scratch/tmp is scratch, /elsewhere is declared and absent.
function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-my-places-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const place of ['projects/kept/.history', 'projects/kept/src', 'projects/loose/src', 'scratch/tmp']) mkdirSync(join(root, place), { recursive: true });
  writeFileSync(join(root, 'projects', 'kept', 'src', 'note.txt'), 'x');
  return root;
}

const DECLARATION = { rules: { deeper: { may_write_here: [{ path_contains: 'kept' }, { path_contains: 'loose' }, { path_contains: 'tmp' }, { path_contains: 'elsewhere' }] } } };
const BASE = { declaration: DECLARATION, places_key: 'may_write_here', id_key: 'path_contains', bases: ['projects', 'scratch'], retention_kinds: [{ kind: 'history', marker: '.history' }] };

test('the row runs on the person\'s computer with only the folder capability, and reaches no internet', () => {
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.notEqual(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.result_selector, '$.result');
  assert.deepEqual(row.invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
});

test('a place with no history is named with its folder inside the granted one, and a place that is absent is unresolved, not a finding', t => {
  const { status, answer } = run(home(t), BASE);
  assert.equal(status, 0);
  assert.equal(answer.result.passed, false);
  assert.equal(answer.result.places_declared, 4);
  assert.deepEqual(answer.result.keeps_nothing.map(item => [item.place, item.directory]), [['loose', 'projects/loose'], ['tmp', 'scratch/tmp']]);
  assert.deepEqual(answer.result.unresolved, ['elsewhere']);
  const kept = answer.result.examined.find(item => item.place === 'kept');
  assert.deepEqual(kept.kept, ['history']);
});

test('an exempt place is still examined and shows its reason; the rest passing makes the run pass', t => {
  const { answer } = run(home(t), { ...BASE, exemptions: [{ place: 'loose', why: 'declared scratch' }, { place: 'tmp', why: 'declared scratch' }] });
  assert.equal(answer.result.passed, true);
  assert.equal(answer.result.examined_count, 3);
  assert.equal(answer.result.examined.find(item => item.place === 'loose').exemptFor, 'declared scratch');
});

test('the history may sit at an ancestor, and the walk stops at the granted folder', t => {
  const root = home(t);
  writeFileSync(join(root, 'projects', '.history'), 'a history of every project, kept as a file');
  const { answer } = run(root, BASE);
  assert.deepEqual(answer.result.keeps_nothing.map(item => item.place), ['tmp'], 'both projects are now covered; scratch is not');
});

test('the declaration may be a file inside the folder', t => {
  const root = home(t);
  writeFileSync(join(root, 'declared.json'), JSON.stringify(DECLARATION));
  const { declaration, ...rest } = BASE;
  assert.equal(declaration, DECLARATION);
  assert.equal(run(root, { ...rest, declaration_file: 'declared.json' }).answer.result.places_declared, 4);
});

test('it refuses rather than pass when nothing was examined', t => {
  const root = home(t);
  assert.match(run(root, { ...BASE, places_key: 'no_such_key' }).answer.error, /read 0 places/);
  assert.match(run(root, { ...BASE, declaration: undefined, declaration_file: 'missing.json' }).answer.error, /nothing was examined/);
  assert.match(run(root, { ...BASE, declaration: undefined, declaration_file: '../outside.json' }).answer.error, /nothing was examined/);
  assert.match(run(root, { ...BASE, retention_kinds: undefined }).answer.error, /give retention_kinds/);
  assert.match(run(join(root, 'absent'), BASE).answer.error, /granted folder/);
});
