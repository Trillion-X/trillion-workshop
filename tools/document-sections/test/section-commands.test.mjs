// tools/document-sections: the two stdin commands, run the way the tool container runs them, over synthetic text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { placeInText } from '../do-work/place-a-section.mjs';
import { buildFromInput } from '../do-work/build-a-section.mjs';

const run = (file, input) => {
  const done = spawnSync('node', [new URL(`../do-work/${file}`, import.meta.url).pathname], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: done.status, answer: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};

test('the place command appends a new section and replaces the same one in place, run over standard input', () => {
  const document_text = '# Notes\n\nIntro.\n\n## Second\n\nKeep this.\n';
  const first = run('place-a-section.mjs', { document_text, section_text: '## First\n\nOne.\n' });
  assert.equal(first.status, 0);
  assert.equal(first.answer.result.placement, 'appended');
  assert.equal(first.answer.result.heading, '## First');
  const again = run('place-a-section.mjs', { document_text: first.answer.result.text, section_text: '## First\n\nOne, said better.\n' });
  assert.equal(again.answer.result.placement, 'replaced');
  assert.ok(again.answer.result.text.includes('One, said better.'));
  assert.ok(!again.answer.result.text.includes('\nOne.\n'));
  assert.ok(again.answer.result.text.includes('## Second\n\nKeep this.'));
});

test('the place command refuses a section with no heading and input that is not text', () => {
  const noHeading = run('place-a-section.mjs', { document_text: '# Notes\n', section_text: 'no heading here' });
  assert.equal(noHeading.status, 1);
  assert.match(noHeading.answer.error, /no markdown heading/);
  assert.throws(() => placeInText({ document_text: 7, section_text: '## A' }), /document_text/);
  assert.throws(() => placeInText({ document_text: '', section_text: null }), /section_text/);
});

test('the build command quotes every line of every entry and counts them across sources', () => {
  const done = run('build-a-section.mjs', {
    heading: 'Said',
    sources: [
      { path: 'first', document: { session_id: 'one', messages: [{ ordinal: 1, content: 'Line a  \n\nLine c', timestamp: 't1' }] } },
      { document: { session_id: 'two', messages: [{ ordinal: 1, content: 'Another' }] } },
    ],
  });
  assert.equal(done.status, 0);
  assert.equal(done.answer.result.entries, 2);
  assert.equal(done.answer.result.sources, 2);
  assert.ok(done.answer.result.text.startsWith('## Said\n'));
  assert.ok(done.answer.result.text.includes('> Line a  \n>\n> Line c'));
  assert.ok(done.answer.result.text.includes('### one (1)') && done.answer.result.text.includes('### two (1)'));
});

test('the build command takes the field names from the input and refuses empty or malformed sources', () => {
  const named = buildFromInput({ heading: '# Top', entries_at: 'notes', text_field: 'body', label_field: 'n', stamp_field: 'when', group_field: 'thread',
    sources: [{ document: { thread: 'T', notes: [{ n: 4, body: 'a note' }] } }] });
  assert.match(named.text, /^# Top\n/);
  assert.match(named.text, /\*\*#4\*\*/);
  assert.throws(() => buildFromInput({ heading: 'H', sources: [{ document: { session_id: 's', messages: [] } }] }), /would look exactly/);
  assert.throws(() => buildFromInput({ heading: 'H', sources: [] }), /at least one/);
  assert.throws(() => buildFromInput({ heading: '', sources: [{ document: {} }] }), /heading/);
  assert.throws(() => buildFromInput({ heading: 'H', sources: [{ document: null }] }), /sources\[0\]/);
});
