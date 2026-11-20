// tools/run-rules-and-schedules-by-themselves/test/say-what-got-worse.test.mjs
// tool:say-what-got-worse keeps every capability the old module had (inventory in workflow port-without-losing-anything,
// run 1795154225): the direction of worse, sums and parts that moved, unknown or zero when missing, at_least, scale and
// unit, the answer in words, and the refusals. Every name and number below is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CompareReadingsError, sayWhatGotWorse } from '../do-work/compare-readings.mjs';
import { sayFrom } from '../do-work/say-what-got-worse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'do-work', 'say-what-got-worse.mjs');

test('a higher-is-worse measure that rose is worse, and a lower one that fell is worse', () => {
  const up = sayWhatGotWorse({ measures: [{ label: 'Restarts', now: 7, before: 3, worse_when: 'higher' }] });
  assert.equal(up.worse, true);
  assert.equal(up.measures[0].change, 4);
  const down = sayWhatGotWorse({ measures: [{ label: 'Saves', now: 2, before: 9, worse_when: 'lower' }] });
  assert.equal(down.worse, true);
  const fine = sayWhatGotWorse({ measures: [{ label: 'Saves', now: 9, before: 2, worse_when: 'lower' }] });
  assert.equal(fine.worse, false);
  assert.equal(fine.said, 'Nothing got worse. Saves: 9 (2 before).');
});

test('a list of numbers is added up, and a list of items is added up by the path to each number', () => {
  const r = sayWhatGotWorse({ measures: [{ label: 'Restarts', now: [5, 1], before: [2], worse_when: 'higher' }] });
  assert.equal(r.measures[0].now, 6);
  assert.equal(r.measures[0].before, 2);
  const items = sayWhatGotWorse({ measures: [{ label: 'Restarts', now: [{ n: 5, id: 'a' }, { n: 1, id: 'b' }], before: [{ n: 2, id: 'a' }], value: ['n'], worse_when: 'higher' }] });
  assert.equal(items.measures[0].now, 6);
  assert.equal(items.measures[0].before, 2);
});

test('the parts that moved are named, largest change first, at most three in the line', () => {
  const r = sayWhatGotWorse({ measures: [{ label: 'Restarts', now: [{ n: 5, id: 'store-a' }, { n: 1, id: 'store-b' }], before: [{ n: 2, id: 'store-a' }], value: ['n'], key: ['id'], worse_when: 'higher' }] });
  const parts = r.measures[0].parts;
  assert.deepEqual(parts.map(part => part.key), ['store-a', 'store-b']);
  assert.match(r.lines[0], /store-a 5 \(2\), store-b 1 \(0\)/);
  const long = sayWhatGotWorse({ measures: [{ label: 'X', now: [{ n: 1, id: 'a-very-long-name-here' }], before: [], value: ['n'], key: ['id'], missing: 'zero', worse_when: 'higher' }] });
  assert.match(long.lines[0], /a-very-long-…/);
});

test('a side not read is unknown and never worse, unless missing is zero', () => {
  const unknown = sayWhatGotWorse({ measures: [{ label: 'Pages', now: 4, worse_when: 'higher' }] });
  assert.equal(unknown.worse, false);
  assert.equal(unknown.measures[0].change, null);
  assert.equal(unknown.lines[0], 'Pages: not compared, nothing was read before.');
  const zero = sayWhatGotWorse({ measures: [{ label: 'Errors', now: [{ n: 3 }], value: ['n'], missing: 'zero', worse_when: 'higher' }] });
  assert.equal(zero.worse, true, 'nothing found before counts as zero, so 3 is worse');
});

test('at_least: a change smaller than it is not worse', () => {
  const small = sayWhatGotWorse({ measures: [{ label: 'Cost', now: 5, before: 4, at_least: 2, worse_when: 'higher' }] });
  assert.equal(small.worse, false);
  const big = sayWhatGotWorse({ measures: [{ label: 'Cost', now: 6, before: 4, at_least: 2, worse_when: 'higher' }] });
  assert.equal(big.worse, true);
});

test('scale divides both numbers before they are shown, and unit follows each number', () => {
  const r = sayWhatGotWorse({ measures: [{ label: 'Wait', now: 3000000, before: 1000000, scale: 1000000, unit: 's', worse_when: 'higher' }] });
  assert.equal(r.measures[0].now, 3);
  assert.equal(r.measures[0].before, 1);
  assert.equal(r.lines[0], 'Wait: 3 s (1 s before).');
});

test('the answer says which measures got worse, in words, and the reading in lines', () => {
  const r = sayWhatGotWorse({ measures: [
    { label: 'Restarts', now: 7, before: 3, worse_when: 'higher' },
    { label: 'Saves', now: 9, before: 2, worse_when: 'lower' },
  ] });
  assert.equal(r.worse, true);
  assert.deepEqual(Object.keys(r).sort(), ['lines', 'measures', 'said', 'worse']);
  assert.match(r.said, /^Worse than before: Restarts\. /);
});

test('the refusals name the problem in words', () => {
  assert.throws(() => sayWhatGotWorse({}), CompareReadingsError);
  assert.throws(() => sayWhatGotWorse({ measures: [{ now: 1, before: 2, worse_when: 'higher' }] }), /Each measure needs a label/);
  assert.throws(() => sayWhatGotWorse({ measures: [{ label: 'A', now: 1, before: 2, worse_when: 'more' }] }), /worse_when is "higher" or "lower"/);
  assert.throws(() => sayWhatGotWorse({ measures: [{ label: 'A', now: 'many', before: 2, worse_when: 'higher' }] }), /now and before are a number or a list/);
});

test('the tool runs as a command: a reading in on standard input, its answer out as one JSON line', () => {
  const input = JSON.stringify({ measures: [{ label: 'Restarts', now: 7, before: 3, worse_when: 'higher' }] });
  const out = JSON.parse(execFileSync(process.execPath, [cli], { input, encoding: 'utf8' }));
  assert.equal(out.worse, true);
  assert.deepEqual(out, sayFrom(input));
});

test('the command refuses a bad reading with a non-zero exit and writes nothing to standard output', () => {
  let failed = null;
  try {
    execFileSync(process.execPath, [cli], { input: '{"measures":[]}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'exits non-zero');
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Give measures/);
});
