// Runs the tool's Python tests (each test_*.py file is its own unittest program) and then the four commands end to end
// on a small written example: make a template from a word-timed transcript, fill its one slot, check the fill for drift,
// and re-time an event tied to a phrase after the words move. Needs python3 (standard library only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const command = name => join(folder, 'do-work', name);
const python = (...argv) => spawnSync('python3', ['-I', ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const available = python('--version').status === 0;
const skip = available ? false : 'needs python3';

for (const file of readdirSync(here).filter(name => /^test_.*\.py$/.test(name))) {
  test(`${file} passes`, { skip }, () => {
    const run = python(join(here, file));
    assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  });
}

test('make, fill, drift and re-time work together on a written example', { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'fill-a-template-'));
  const words = 'we shipped three features on launch day and everyone cheered'.split(' ');
  const timed = (list, step = 0.3) => ({
    language: 'en',
    words: list.map((text, i) => ({ id: `w${i}`, text, start: +(i * step).toFixed(3), end: +(i * step + 0.2).toFixed(3), type: 'word', speaker: 'S0' })),
  });
  const write = (name, data) => { const path = join(work, name); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); return path; };
  const transcript = write('transcript.json', timed(words));
  const spec = write('spec.json', {
    schema: 'word-template-spec@1',
    piece: { id: 'example', medium: 'podcast' },
    sources: { transcript_words: transcript },
    slots: [{ id: 'count', type: 'NUMBER', note: 'how many things shipped', rule: 'R1-number', tokens: ['w2'] }],
  });
  const template = join(work, 'TEMPLATE.json');
  const made = python(command('make_template.py'), spec, template);
  assert.equal(made.status, 0, made.stderr || made.stdout);
  const piece = JSON.parse(readFileSync(template, 'utf8'));
  assert.ok(piece.tokens.some(token => token.slot === 'count' && token.mark === 'SLOT'), 'the number is the one slot');

  const source = write('notes.txt', 'We shipped seven features this quarter.\n');
  const fills = write('fills.json', { title: 'Example', root: work, fills: { count: { value: 'seven', sources: [`${source}:1`] } } });
  const filled = join(work, 'filled.md');
  const fillRun = python(command('fill.py'), template, fills, filled, '--piece', join(work, 'filled.piece.json'));
  assert.equal(fillRun.status, 0, fillRun.stderr || fillRun.stdout);
  assert.match(readFileSync(filled, 'utf8'), /seven/);

  const drift = python(command('drift.py'), template, filled, '--check');
  assert.equal(drift.status, 0, drift.stdout + drift.stderr);

  // A script that changes a KEEP word fails the check and says so.
  const rewritten = write('rewritten.md', readFileSync(filled, 'utf8').replace('cheered', 'complained'));
  const failing = python(command('drift.py'), template, rewritten, '--check');
  assert.notEqual(failing.status, 0, 'a changed KEEP word fails the drift check');
});

test('a person\'s own dimensions come in with --registry and nothing of the kind ships in the repository', { skip }, () => {
  const shipped = JSON.parse(readFileSync(join(folder, 'read-data', 'dimensions.json'), 'utf8'));
  assert.ok(!shipped.dimensions.some(row => row.id === 'sample.roast'), 'the shipped registry has no tasting dimension');
  const work = mkdtempSync(join(tmpdir(), 'fill-a-template-registry-'));
  const registry = join(work, 'registry.json');
  writeFileSync(registry, JSON.stringify({
    ...shipped,
    dimensions: [...shipped.dimensions, {
      id: 'sample.roast', name: 'roast of a sample', media: ['podcast'], region: 'speech', value_kind: 'category',
      measure: [{ reader: 'tsv_rows', field: 'roast', token: 'record' }], drift: { threshold: 1.0 },
    }],
  }));
  const table = join(work, 'samples.tsv');
  writeFileSync(table, 't0\tt1\troast\n0\t2\tdark\n2\t4\tlight\n');
  const spec = join(work, 'spec.json');
  writeFileSync(spec, JSON.stringify({ schema: 'word-template-spec@1', piece: { id: 'table', medium: 'podcast' }, sources: { tsv_rows: table } }));
  const out = join(work, 'TEMPLATE.json');
  const made = python(command('make_template.py'), spec, out, '--registry', registry);
  assert.equal(made.status, 0, made.stderr || made.stdout);
  const piece = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(piece.tokens.filter(token => token.dims['sample.roast']).map(token => [token.id, token.dims['sample.roast']]),
    [['row-01', 'dark'], ['row-02', 'light']], 'rows without an id column are named row-NN');
});
