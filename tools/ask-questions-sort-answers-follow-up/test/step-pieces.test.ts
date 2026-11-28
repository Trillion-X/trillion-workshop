// The progress of a page asked one step at a time is one piece per step, never one continuous bar (show/step-pieces.ts and
// FormSteps StepPieces), on the form page and on the booking page; and a new step opens at the top of the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';
import { opensAtTop, piecesOf } from '../show/step-pieces.ts';

const piecesIn = (html: string) => [...html.matchAll(/data-step-piece="(\w+)"/g)].map(match => match[1][0]).join('');

test('one piece per step: the steps before are done, the step in view is current, the rest are ahead', () => {
  assert.deepEqual(piecesOf(0, 4), ['current', 'ahead', 'ahead', 'ahead']);
  assert.deepEqual(piecesOf(2, 4), ['done', 'done', 'current', 'ahead']);
  assert.deepEqual(piecesOf(3, 4), ['done', 'done', 'done', 'current']);
  assert.deepEqual(piecesOf(4, 4), ['done', 'done', 'done', 'done'], 'at the end every piece is done');
  assert.deepEqual(piecesOf(9, 4), ['done', 'done', 'done', 'done']);
  assert.deepEqual(piecesOf(-1, 3), ['current', 'ahead', 'ahead']);
  assert.deepEqual(piecesOf(0, 0), [], 'a page with no steps draws no pieces');
});

test('a new step opens at the top of the page; the first step and the same step again do not move it', () => {
  assert.equal(opensAtTop(null, 'email'), false);
  assert.equal(opensAtTop('email', 'question:0'), true);
  assert.equal(opensAtTop('question:0', 'question:1'), true);
  assert.equal(opensAtTop('question:1', 'question:1'), false);
  assert.equal(opensAtTop('question:21', 'time'), true);
});

const words = { intro_title: 'Find your level', intro_lead: '{count} short questions.', start: 'Begin', question_of: 'Question {number} of {count}', answer_label: 'Your answer', next: 'Next', result_title: 'Your result' };
const info = { title: 'Assessment', words, questions: 3, keep_on: null, signed_in: false };

test('the form page draws its progress as pieces: the intro, each question, the result', async () => {
  const entry = new URL('../show/FormPage.tsx', import.meta.url).pathname;
  const intro = await renderAView(entry, { screen: { kind: 'intro', resumable: false }, info });
  assert.equal(piecesIn(intro), 'caaaa');
  const second = await renderAView(entry, { screen: { kind: 'question', next: { key: 'q1', kind: 'question', position: 1, prompt: 'How long?', required: true, question: { questionId: 'q1', questionTypeId: 'text' } } }, info });
  assert.equal(piecesIn(second), 'ddcaa');
  assert.match(second, /role="progressbar"/);
  assert.doesNotMatch(second, /width:\s*\d+%;\s*height:\s*100%/, 'no continuous bar filled to a width');
});

test('the booking page draws its progress as pieces: the email, each question, the time, the confirmation', async () => {
  const entry = new URL('../../take-a-booking-one-step-at-a-time/show/BookingPage.tsx', import.meta.url).pathname;
  const html = await renderAView(entry, { page: 'p', title: 'A call', timezone: 'America/Chicago', duration_minutes: 15, questions: [{ position: 0, prompt: 'Why?', required: true }, { position: 1, prompt: 'When?', required: false }] });
  assert.equal(piecesIn(html), 'caaaa');
  assert.doesNotMatch(html, /width:\s*\d+%;\s*height:\s*100%/, 'no continuous bar filled to a width');
});
