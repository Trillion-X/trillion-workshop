import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessQuestions } from '../src/questions.mjs';
import { settings } from './made-up-settings.mjs';
import { openStore } from './sql-store.mjs';

const questionsFor = (query, now = () => '2026-11-01T09:00:00Z') => awarenessQuestions({ query, settings, now });

test('a question is kept once under its words, with its about label, guess and why', async () => {
  const { query } = openStore();
  const questions = questionsFor(query);
  const found = [{ question: 'Is the bakery still open?', about: 'pursuits', guess: 'yes', why: 'It was open in October.' }];
  assert.deepEqual(await questions.keep(found), { kept: 1 });
  assert.deepEqual(await questions.keep(found), { kept: 0 }, 'the same question is never written twice');
  const waiting = await questions.waiting();
  assert.equal(waiting.count, 1);
  assert.deepEqual(waiting.questions, ['Is the bakery still open?']);
  assert.equal(waiting.label, 'Questions');
  assert.deepEqual(query('SELECT id, about, guess, why FROM awareness_questions'), [
    { id: 'is-the-bakery-still-open', about: 'Pursuits', guess: 'yes', why: 'It was open in October.' },
  ]);
});

test('no more than open_cap questions wait at once, and a reading adds no more than it is given', async () => {
  const { query } = openStore();
  const questions = questionsFor(query);
  const found = ['One?', 'Two?', 'Three?', 'Four?', 'Five?', 'Six?'].map(question => ({ question, about: 'pursuits' }));
  assert.deepEqual(await questions.keep(found), { kept: 4 }, 'open_cap is 4 in the fixture');
  assert.deepEqual(await questions.keep([{ question: 'Seven?', about: 'pursuits' }]), { kept: 0 }, 'a full room keeps nothing new');
});

test('answered questions come first for the next reading, and an answer leaves the waiting list', async () => {
  const { query } = openStore();
  const questions = questionsFor(query);
  await questions.keep([{ question: 'Do you still play?', about: 'pursuits' }, { question: 'Where do you live now?', about: 'pursuits' }]);
  query('UPDATE awareness_questions SET answer = $1 WHERE id = $2', ['Yes, on Tuesdays.', 'do-you-still-play']);
  const asked = await questions.asked();
  assert.deepEqual(asked, [
    { question: 'Do you still play?', answer: 'Yes, on Tuesdays.' },
    { question: 'Where do you live now?', answer: '' },
  ]);
  assert.deepEqual((await questions.waiting()).questions, ['Where do you live now?']);
});

test('a question the person answers with spaces only still waits', async () => {
  const { query } = openStore();
  const questions = questionsFor(query);
  await questions.keep([{ question: 'Anything else?', about: 'pursuits' }]);
  query("UPDATE awareness_questions SET answer = ' ' WHERE id = $1", ['anything-else']);
  assert.equal((await questions.waiting()).count, 1);
});
