// tools/stream-an-answer-in-keyed-parts/test/stream-an-answer-in-keyed-parts.test.mjs: the tool's run over made-up input, and each row run the way the runner runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { answerOf, rowOf, select } from '../../../test-helpers/run-a-row.mjs';
import { mergeAStreamedAnswer } from '../do-work/stream-an-answer-in-keyed-parts.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

test('events merge into the entry, a later call continues it, and a replay adds nothing twice', () => {
  const first = mergeAStreamedAnswer({ events: [{ seq: 1, type: 'text', key: 'answer', text: 'Hello, ' }] });
  const second = mergeAStreamedAnswer({ entry: first.entry, events: [{ seq: 1, type: 'text', key: 'answer', text: 'Hello, ' }, { seq: 2, type: 'text', key: 'answer', text: 'world.' }] });
  assert.equal(second.entry.parts.answer.text, 'Hello, world.');
  assert.equal(second.resume.seq, 2);
  assert.notEqual(second.resume.identity, first.resume.identity);
  assert.throws(() => mergeAStreamedAnswer({ events: 'x' }), /events is a list/);
});

test('tool:merge-a-streamed-answer runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:merge-a-streamed-answer');
  const ran = await answerOf(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});
