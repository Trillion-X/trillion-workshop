// Every row that runs a program and declares a result_selector: the selector picks from the parsed last JSON line the
// program prints (the engine's rule under every kind that runs a process, as an http row's picks from its reply), so a
// row's own sample run (verify, kind sample-run) is run here the way the container runner runs it
// (test-helpers/run-a-row.mjs) and the selector must find a value in that line. "$" is the line itself; "$.result" is
// right only for a program that prints { result: ... }. A selector the line does not hold fails here, not as a failed
// run on someone's computer. A row with no sample that runs is listed by name and why, never left out silently. A sample
// seeds the records a row reads (records), answers a row with internet: true from recorded replies (replies, read on
// shape_read_at) and gives made-up held values (held). Run by the push gate once for each tool folder, with that
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
  const unproved = processRows.filter(row => !proved.has(row.id))
    .map(row => `${row.id}: ${samplesOf(row).length ? why.get(row.id) : 'it has no sample run; add one to its verify list'}`).sort();
  t.diagnostic(`${processRows.length} process rows${unit ? ` in tools/${unit}` : ''}: ${proved.size} proved by their own sample, ${unproved.length} not proved`);
  for (const line of unproved) t.diagnostic(`  ${line}`);
  assert.deepEqual(wrong, [], `a selector its program's last line does not hold:\n${wrong.join('\n')}`);
});
