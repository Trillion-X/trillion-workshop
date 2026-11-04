// tools/credit-kept-lines-to-their-writer/test/credit-kept-lines-to-their-writer.test.mjs: the tool's run over made-up input, and each row run the way the runner runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { answerOf, rowOf, select } from '../../../test-helpers/run-a-row.mjs';
import { creditKeptLines } from '../do-work/credit-kept-lines-to-their-writer.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

test('kept lines are credited to their first writer and versions that are not a list are refused', () => {
  assert.deepEqual(creditKeptLines({ versions: [{ by: 'ai', text: 'Intro\nBody' }, { by: 'person', text: 'Intro\nBody rewritten' }] }), { by: { ai: 1, person: 1 }, kept: 2, versions: 2 });
  assert.throws(() => creditKeptLines({}), /versions is a list/);
});

test('tool:credit-kept-lines-to-their-writer runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:credit-kept-lines-to-their-writer');
  const ran = await answerOf(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});
