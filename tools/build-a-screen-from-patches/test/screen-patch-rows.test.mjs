// The three rows run as the container runs them: a patch made between two answers rebuilds the next one exactly, a
// patch against another answer is stale, and lines of changes become a checked spec with the bad lines said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const items = count => Array.from({ length: count }, (_, at) => ({ id: `item-${at}`, title: `A sample item number ${at}`, done: false }));

test('make-a-view-patch sends only the change, and apply-a-view-patch rebuilds the next answer from it', async () => {
  const previous = JSON.stringify({ items: items(100) }, null, 2);
  const changed = items(100); changed[3].done = true;
  const next = JSON.stringify({ items: changed }, null, 2);
  const made = await answerOf(rowOf(rows, 'tool:make-a-view-patch'), { previous, next });
  assert.equal(made.status, 0);
  assert.equal(made.result.text, undefined);
  assert.deepEqual(made.result.patch.ops, [{ op: 'replace', path: '/items/3/done', value: true }]);
  const applied = await answerOf(rowOf(rows, 'tool:apply-a-view-patch'), { previous, answer: made.result });
  assert.deepEqual(JSON.parse(applied.result.text), { items: changed });
  assert.equal(applied.result.held.identity, made.result.identity);
  const stale = await answerOf(rowOf(rows, 'tool:apply-a-view-patch'), { previous: '{"other":true}', answer: made.result });
  assert.deepEqual(stale.result, { stale: true });
  const small = await answerOf(rowOf(rows, 'tool:make-a-view-patch'), { previous: '{"a":1}', next: '{"a":2}' });
  assert.equal(small.result.text, '{"a":2}', 'a short answer is sent whole');
  const refused = await answerOf(rowOf(rows, 'tool:make-a-view-patch'), { previous: 1, next: '{}' });
  assert.match(refused.error, /Give previous/);
});

test('build-a-screen-spec-from-a-patch-stream applies every complete line, says the bad ones, and checks the parts', async () => {
  const text = [
    { op: 'add', path: '/root', value: 'main' },
    { op: 'add', path: '/elements/main', value: { type: 'Card', props: {}, children: ['title', 'gone'] } },
    { op: 'add', path: '/secret', value: 1 },
    { op: 'add', path: '/elements/title', value: { type: 'Text', props: { text: 'Hello' } } },
  ].map(line => JSON.stringify(line)).join('\n');
  const { status, result } = await answerOf(rowOf(rows, 'tool:build-a-screen-spec-from-a-patch-stream'), { text: `${text}\nnot json` });
  assert.equal(status, 0);
  assert.equal(result.spec.root, 'main');
  assert.deepEqual(result.spec.elements.main.children, ['title'], 'a child never sent is left out');
  assert.equal(result.said.length, 2);
  assert.match(result.said[0], /changes \/secret/);
  assert.match(result.said[1], /Line 5 is not a change/);
  assert.equal(result.fixes.length, 1);
  assert.deepEqual(result.problems, []);
  const none = await answerOf(rowOf(rows, 'tool:build-a-screen-spec-from-a-patch-stream'), { text: '' });
  assert.match(none.result.problems[0], /names no root/);
});
