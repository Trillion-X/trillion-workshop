// tools/judge-words: plain work titles. The tests and their assertions are carried unchanged from the engine's
// src/work_title.rs (`mod tests`) and tests/tool_label_text.rs, where this logic lived before it moved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { FALLBACK, titleOf, workTitle } from '../do-work/plain-work-title.mjs';

const folder = resolve(import.meta.dirname, '..');

test('mirrors canonical plain sentence and fallback rules', () => {
  assert.equal(workTitle('Handoff: fix h_4677423f69aed1fb495164bc so the [login](https://x.com/a) page works.'), 'Fix so the login page works');
  assert.equal(workTitle('Use list_pursuits first. Draft the launch post for Friday.'), 'Draft the launch post for Friday');
  assert.equal(workTitle('https://example.com/only'), FALLBACK);
});

test('matches original sentence boundaries and UTF-16 truncation', () => {
  assert.equal(workTitle('One! Two? Third.'), 'One!');
  assert.equal(workTitle(`${'A'.repeat(77)}😀 tail`), `${'A'.repeat(77)}😀…`);
  assert.equal(workTitle(`${'A'.repeat(76)} 😀 tail`), `${'A'.repeat(76)}…`);
});

test('matches JavaScript whitespace, paths and lone surrogate length', () => {
  assert.equal(workTitle('Read /a/ and tidy it.'), 'Read and tidy it');
  assert.equal(workTitle('Read\u0085this report'), 'Read\u0085this report');
  assert.equal(workTitle('Read\u0085/a/b and tidy it.'), 'Read\u0085/a/b and tidy it');
  assert.equal(workTitle('Task:\u0085write a useful report'), 'Task:\u0085write a useful report');

  const input = 'a' + 'b'.repeat(77) + '\ud800' + 'c';
  const result = workTitle(input);
  assert.equal(result.length, 80);
  assert.equal(result.charCodeAt(0), 'A'.charCodeAt(0));
  assert.equal(result.charCodeAt(78), 0xd800);
  assert.equal(result.charCodeAt(79), 'c'.charCodeAt(0));
});

test('uses UTF-16 length and preserves unpaired surrogates', () => {
  assert.equal(workTitle('\ud800 A').charCodeAt(0), 0xd800);
  assert.equal(workTitle('𐐨 task'), '𐐨 task');
});

test('title_of keeps a trimmed said', () => {
  assert.equal(titleOf('  Keep these words  ', 'ignored'), 'Keep these words');
});

test('the uppercase of the first letter keeps a multi-unit expansion before the unchanged tail', () => {
  // `sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1)`: sharp s becomes SS.
  assert.equal(workTitle('ßeta task'), 'SSeta task');
});

test('a caller names its own fallback words', () => {
  assert.equal(workTitle('https://example.com/only', 'Handed on'), 'Handed on');
});

const run = input => {
  const ran = spawnSync(process.execPath, ['do-work/make-a-plain-work-title.mjs'], { cwd: folder, input, encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
};

test('the command says where the title came from', () => {
  assert.deepEqual(run(JSON.stringify({ job: 'Draft the launch post.' })), { status: 0, answer: { result: { title: 'Draft the launch post', from: 'job' } } });
  assert.deepEqual(run(JSON.stringify({ job: 'x', said: ' Mine ' })), { status: 0, answer: { result: { title: 'Mine', from: 'said' } } });
  assert.deepEqual(run(JSON.stringify({ job: 'https://example.com/only' })), { status: 0, answer: { result: { title: FALLBACK, from: 'fallback' } } });
});

test('the command refuses a request without job text, with why', () => {
  for (const input of ['{"job": 3}', '{"job": "a", "said": 1}', '{"job":']) {
    const { status, answer } = run(input);
    assert.equal(status, 1);
    assert.deepEqual([typeof answer.error, 'result' in answer], ['string', false]);
  }
});
