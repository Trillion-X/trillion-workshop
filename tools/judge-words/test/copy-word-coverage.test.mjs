import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCopy, stringsIn, wordsIn } from '../parts/judge-words/do-work/judge-words.mjs';

const rule = { id: 'fixture-word', words: ['zorblax'], says: 'Use a concrete word.' };

test('the actual copy tool refuses absent input and an uncovered field, then resumes for covered clean words', () => {
  assert.equal(checkCopy({}, [rule]).status, 'no-input');
  assert.equal(checkCopy({ text: 'Start', rules: [] }, [rule]).passed, false);
  const onlyTitles = { ...rule, fields: ['title'] };
  const uncovered = checkCopy({ text: 'Start' }, [onlyTitles]);
  assert.equal(uncovered.status, 'no-applicable-rule');
  assert.equal(uncovered.passed, false);
  const covered = checkCopy({ value: { title: 'Start' }, fields: ['title'] }, [onlyTitles]);
  assert.equal(covered.passed, true);
  assert.equal(covered.coverage.evaluated_units, 1);
  assert.equal(checkCopy({ text: 'A zorblax promise.' }, [rule]).passed, false);
  assert.equal(checkCopy({ text: 'Try again' }, [rule]).passed, true);
});

test('positive owner paths select authored UI without selecting source quotations sharing the same key', () => {
  const data = { id: 'zorblax', captures: [{ label: 'Start', prompt: { headline: 'Try again' } }],
    source: { label: 'Original zorblax quotation.' }, schema: { properties: { nested: { properties: { text: { description: 'Explain the attempt.' } } } } } };
  const owner = { fields: 'strings', paths: ['captures.*.label', 'captures.*.prompt.headline', 'schema.properties.**.description'] };
  assert.deepEqual(wordsIn(data, owner).map(item => item.text), ['Start', 'Try again', 'Explain the attempt.']);
  const checked = checkCopy({ value: data, ...owner }, [rule]);
  assert.equal(checked.passed, true);
  assert.equal(checked.coverage.extracted_units, 3);
  assert.equal(checkCopy({ value: data, fields: ['label'] }, [rule]).passed, false);
  assert.deepEqual(wordsIn(data, { ...owner, skip_paths: ['captures.*.label'] }).map(item => item.text), ['Try again', 'Explain the attempt.']);
  assert.throws(() => wordsIn(data, { paths: 'captures.*.label' }), /paths/);
  assert.deepEqual(wordsIn(data, { paths: [] }), []);
});

test('raw owner strings reuse path selection and include blank leaves while wordsIn stays nonempty-only', () => {
  const data = { title: '', rows: [{ id: 'row-id', label: ' ', answer: 'Try again' }], source: { note: 'Quoted text.' } };
  assert.deepEqual(stringsIn(data).map(item => [item.text, item.path]), [
    ['', ['title']], ['row-id', ['rows', 0, 'id']], [' ', ['rows', 0, 'label']],
    ['Try again', ['rows', 0, 'answer']], ['Quoted text.', ['source', 'note']]
  ]);
  assert.deepEqual(stringsIn(data, { fields: 'strings', paths: ['rows.*.label'] }).map(item => item.path),
    [['rows', 0, 'label']]);
  assert.deepEqual(wordsIn(data).map(item => item.text), ['row-id', 'Try again', 'Quoted text.']);
});
