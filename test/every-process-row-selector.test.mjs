// Every row that runs a program and declares a result_selector: the selector picks from the parsed last JSON line the
// program prints (the engine's rule under every kind that runs a process, as an http row's picks from its reply), so a
// row's own sample run (verify, kind sample-run) is run here the way the container runner runs it
// (test-helpers/run-a-row.mjs) and the selector must find a value in that line. "$" is the line itself; "$.result" is
// right only for a program that prints { result: ... }. A selector the line does not hold fails here, not as a refused
// run on someone's computer. A row with no sample, or whose sample cannot run here, is listed by name and why, never
// left out silently. Nothing here names a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rows as readRows } from '../test-helpers/tool-rows.mjs';
import { runRow, select } from '../test-helpers/run-a-row.mjs';

const processRows = readRows().map(({ payload }) => payload)
  .filter(row => Array.isArray(row.invoke?.argv) && typeof row.result_selector === 'string');
const samplesOf = row => [row.verify ?? []].flat().filter(check => check?.kind === 'sample-run' && 'input' in check);

// Every sample of every row, run a few at a time: { row, ran } per sample.
async function runAll(limit = 8) {
  const work = processRows.flatMap(row => samplesOf(row).map(sample => ({ row, sample })));
  const done = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < work.length) {
      const { row, sample } = work[next++];
      done.push({ row, ran: await runRow(row, sample.input) });
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
  // Every row not proved by a sample of its own is listed by name and why, so a missing proof is seen.
  const unproved = processRows.filter(row => !proved.has(row.id))
    .map(row => `${row.id}: ${samplesOf(row).length ? why.get(row.id) : 'it has no sample run'}`).sort();
  t.diagnostic(`${processRows.length} process rows: ${proved.size} proved by their own sample, ${unproved.length} not proved here`);
  for (const line of unproved) t.diagnostic(`  ${line}`);
  assert.deepEqual(wrong, [], `a selector its program's last line does not hold:\n${wrong.join('\n')}`);
});
