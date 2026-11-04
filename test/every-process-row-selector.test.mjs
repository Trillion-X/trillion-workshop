// Every row that runs a program and declares a result_selector: the selector picks from the parsed last JSON line the
// program prints (the engine's rule under every kind that runs a process, as an http row's picks from its reply), so a
// row's own sample run (verify, kind sample-run) is run here the way the container runner runs it
// (test-helpers/run-a-row.mjs) and the selector must find a value in that line. "$" is the line itself; "$.result" is
// right only for a program that prints { result: ... }. A selector the line does not hold fails here, not as a failed
// run on someone's computer. A row with no sample that runs is named with why, and fails the test. A sample
// seeds the records a row reads (records), answers a row with internet: true from recorded replies (replies, read on
// shape_read_at) and gives made-up held values (held). A row no sample here can run because its run needs a real
// computer (a screen, a camera, an attached drive) has a needs-a-machine item naming exactly what (requires); every
// other row fails until its own sample proves it. Run by the push gate once for each tool folder, with that
// folder in WORKSHOP_UNIT_FOLDER, it proves that folder's rows; run with none, it proves every row. Nothing here names
// a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { rows as readRows } from '../test-helpers/tool-rows.mjs';
import { runRow, select } from '../test-helpers/run-a-row.mjs';
import { staleReplies } from '../test-helpers/stand-in-egress.mjs';

const unit = process.env.WORKSHOP_UNIT_FOLDER ? basename(process.env.WORKSHOP_UNIT_FOLDER) : null;
const processRows = readRows().filter(({ folder }) => unit === null || folder === unit).map(({ payload }) => payload)
  .filter(row => Array.isArray(row.invoke?.argv) && typeof row.result_selector === 'string');
const samplesOf = row => [row.verify ?? []].flat().filter(check => check?.kind === 'sample-run' && 'input' in check);
// A row whose run truly needs a real computer (a screen, a camera, an attached drive) says so in its verify list:
// { kind: "needs-a-machine", requires: "<OS, permission, device>", proved_on: null | "<date it was proved there>" }.
// Only an item with a non-empty `requires` accounts for a row; any other is named as wrong.
const machineItemsOf = row => [row.verify ?? []].flat().filter(check => check?.kind === 'needs-a-machine');
const machineItemWrong = item => (typeof item.requires !== 'string' || !item.requires.trim() ? 'its needs-a-machine item has no requires'
  : !('proved_on' in item) || (item.proved_on !== null && (typeof item.proved_on !== 'string' || !item.proved_on.trim())) ? 'its needs-a-machine item has no proved_on (null, or the date it was proved)'
  : null);

// How a row is accounted for: { proved } by a passing sample of its own, else { machine: <requires> } by well-formed
// needs-a-machine items, else { unproved: <why> }.
export function accountFor(row, proved, why = new Map()) {
  if (proved.has(row.id)) return { proved: true };
  const items = machineItemsOf(row);
  const bad = items.map(machineItemWrong).find(Boolean);
  if (items.length && !bad) return { machine: items.map(item => item.requires).join('; ') };
  return { unproved: bad ?? (samplesOf(row).length ? why.get(row.id) : 'it has no sample run; add one to its verify list') };
}

// Every sample of every row, run a few at a time: { row, sample, ran } per sample.
async function runAll(limit = 8) {
  const work = processRows.flatMap(row => samplesOf(row).map(sample => ({ row, sample })));
  const done = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < work.length) {
      const { row, sample } = work[next++];
      const stale = staleReplies(sample);
      done.push({ row, sample, ran: stale ? { cannot: stale } : await runRow(row, sample.input, sample) });
    }
  }));
  return done;
}

const shown = value => { const text = JSON.stringify(value) ?? String(value); return text.length > 160 ? `${text.slice(0, 160)}…` : text; };

test('every process row\'s result_selector finds a value in the last line its own sample prints', { timeout: 600_000 }, async t => {
  const runs = await runAll();
  const wrong = [];
  const proved = new Set();
  const why = new Map();
  for (const { row, ran } of runs) {
    if (ran.cannot) { why.set(row.id, `its sample cannot run here: ${ran.cannot}`); continue; }
    if (ran.unanswered.length) { why.set(row.id, `its sample asked for a reply it has not recorded: ${ran.unanswered.join(', ')}`); continue; }
    if (ran.code !== 0) {
      // A run that exits non-zero answers its error; the engine picks nothing from it, so it proves no selector.
      const said = ran.last?.error ?? ran.stderr.trim().split('\n').at(-1) ?? '';
      why.set(row.id, `its sample exits ${ran.code}: ${shown(said)}`);
      continue;
    }
    proved.add(row.id);
    if (select(ran.last, row.result_selector) === undefined) {
      const wrapped = ran.last !== null && typeof ran.last === 'object' && !Array.isArray(ran.last) && 'result' in ran.last;
      wrong.push(`${row.id}: result_selector ${row.result_selector} finds nothing in the last line ${shown(ran.last)}; `
        + (wrapped ? 'it prints { result }, so the selector is "$.result"' : 'it prints the value itself, so the selector is "$"'));
    }
  }
  const machine = [];
  const unproved = [];
  for (const row of processRows) {
    const accounted = accountFor(row, proved, why);
    if (accounted.machine) machine.push(`${row.id}: needs a machine: ${accounted.machine}`);
    else if (accounted.unproved) unproved.push(`${row.id}: ${accounted.unproved}`);
  }
  machine.sort(); unproved.sort();
  t.diagnostic(`${processRows.length} process rows${unit ? ` in tools/${unit}` : ''}: ${proved.size} proved by their own sample, `
    + `${machine.length} need a machine, ${unproved.length} neither`);
  for (const line of machine) t.diagnostic(`  ${line}`);
  for (const line of unproved) t.diagnostic(`  ${line}`);
  assert.deepEqual(wrong, [], `a selector its program's last line does not hold:\n${wrong.join('\n')}`);
  assert.deepEqual(unproved, [], `a process row with neither a passing sample run nor a needs-a-machine item with its requires:\n${unproved.join('\n')}`);
});

test('a process row with neither a passing sample nor a needs-a-machine item that names its requires is not accounted for', () => {
  const row = verify => ({ id: 'tool:made-up', invoke: { argv: ['node'] }, result_selector: '$', verify });
  const none = new Set();
  assert.deepEqual(accountFor(row([]), new Set(['tool:made-up'])), { proved: true });
  assert.match(accountFor(row([]), none).unproved, /no sample run/);
  assert.match(accountFor(row([{ kind: 'sample-run', input: {} }]), none, new Map([['tool:made-up', 'its sample exits 1']])).unproved, /exits 1/);
  assert.match(accountFor(row([{ kind: 'needs-a-machine', requires: '', proved_on: null }]), none).unproved, /no requires/);
  assert.match(accountFor(row([{ kind: 'needs-a-machine', requires: '   ', proved_on: null }]), none).unproved, /no requires/);
  assert.match(accountFor(row([{ kind: 'needs-a-machine', proved_on: null }]), none).unproved, /no requires/);
  assert.match(accountFor(row([{ kind: 'needs-a-machine', requires: 'macOS with a display' }]), none).unproved, /no proved_on/);
  assert.deepEqual(accountFor(row([{ kind: 'needs-a-machine', requires: 'macOS with a display', proved_on: null }]), none),
    { machine: 'macOS with a display' });
});
