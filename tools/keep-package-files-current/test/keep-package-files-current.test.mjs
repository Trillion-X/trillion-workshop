// tools/keep-package-files-current/test/keep-package-files-current.test.mjs
//
// The pass with fake seams: origin's file, the generated file, the landing. The job only adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, keepPackageFilesCurrent } from '../do-work/keep-package-files-current.mjs';

const TIP = 'tip0000000000000000000000000000000000000';
const itemOf = (pkg, paths) => ({ package: pkg, paths, at: `/opt/${pkg}` });
const origin = {
  'tool:alpha': [itemOf('alpha', ['do-work'])],
  'tool:beta': [itemOf('beta', ['do-work']), itemOf('gamma', ['read-data'])],
};

// Fake seams: the generated text is what the test names; the landing and the findings record what they were handed.
function fakes({ generated, movedAfterGenerate = false }) {
  const calls = { landed: [] };
  let fetches = 0;
  const seams = {
    async fetchOriginMain() { fetches += 1; return fetches > 1 && movedAfterGenerate ? 'moved000000000000000000000000000000000' : TIP; },
    async fileAt() { return JSON.stringify(origin); },
    async generate() { return JSON.stringify(generated); },
    async land(_root, { text }) { calls.landed.push(JSON.parse(text)); return { ok: true, commit: 'commit0000000000000000000000000000000000' }; },
  };
  return { seams, calls };
}

test('only adds: the added row and item land on top of origin, and origin items are kept', async () => {
  const generated = { ...origin, 'tool:alpha': [...origin['tool:alpha'], itemOf('alpha2', ['src'])], 'tool:new': [itemOf('new', ['do-work'])] };
  const { seams, calls } = fakes({ generated });
  const result = await keepPackageFilesCurrent({ root: '/x', seams });
  assert.equal(result.outcome, 'landed');
  assert.equal(result.added, 2, "one item and one row");
  assert.equal(calls.landed.length, 1);
  assert.deepEqual(calls.landed[0]['tool:alpha'], [itemOf('alpha', ['do-work']), itemOf('alpha2', ['src'])]);
  assert.deepEqual(calls.landed[0]['tool:beta'], origin['tool:beta']);
  assert.deepEqual(calls.landed[0]['tool:new'], [itemOf('new', ['do-work'])]);
  assert.deepEqual(result.findings, []);
});

test('an origin item the generator does not find is kept, is a finding, and does not stop the adds', async () => {
  const generated = { 'tool:alpha': origin['tool:alpha'], 'tool:beta': [itemOf('beta', ['do-work'])], 'tool:new': [itemOf('new', ['do-work'])] };
  const { seams, calls } = fakes({ generated });
  const result = await keepPackageFilesCurrent({ root: '/x', seams });
  assert.equal(result.outcome, 'landed');
  assert.deepEqual(calls.landed[0]['tool:beta'], origin['tool:beta'], 'the item the generator missed stays in the file');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].row, 'tool:beta');
  assert.deepEqual(result.findings[0].item, itemOf('gamma', ['read-data']));
});

test('nothing to add: nothing lands, and the findings are still recorded', async () => {
  const generated = { 'tool:alpha': origin['tool:alpha'] };
  const { seams, calls } = fakes({ generated });
  const result = await keepPackageFilesCurrent({ root: '/x', seams });
  assert.equal(result.outcome, 'nothing-to-do');
  assert.equal(calls.landed.length, 0);
  assert.equal(result.findings.length, 1, 'tool:beta is missing from the generated file as a whole');
});

test('origin moves while the generator runs: nothing lands, the next pass starts again', async () => {
  const generated = { ...origin, 'tool:new': [itemOf('new', ['do-work'])] };
  const { seams, calls } = fakes({ generated, movedAfterGenerate: true });
  const result = await keepPackageFilesCurrent({ root: '/x', seams });
  assert.equal(result.outcome, 'origin-moved');
  assert.equal(calls.landed.length, 0);
});

test('a row origin has but the generator does not find is a finding, never a removal', () => {
  const verdict = classify({ oldRows: { 'tool:gone': [itemOf('gone', ['do-work'])] }, newRows: {} });
  assert.equal(verdict.land, false);
  assert.deepEqual(verdict.merged, { 'tool:gone': [itemOf('gone', ['do-work'])] });
  assert.equal(verdict.findings.length, 1);
});

test('a landing that is not wired reports an error and lands nothing', async () => {
  const { seams: fake } = fakes({ generated: { ...origin, 'tool:new': [itemOf('new', ['do-work'])] } });
  const seams = { ...fake, land: async () => ({ ok: false, why: 'landing is not wired' }) };
  const result = await keepPackageFilesCurrent({ root: '/x', seams });
  assert.equal(result.outcome, 'error');
});
