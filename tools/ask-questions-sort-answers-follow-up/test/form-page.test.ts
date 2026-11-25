import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('../show/FormPage.tsx', import.meta.url).pathname;
const words = {
  intro_title: 'Find your level', intro_lead: '{count} short questions.', start: 'Begin', resume: 'Go on', start_over: 'Start again',
  question_of: 'Question {number} of {count}', answer_label: 'Your answer', next: 'Next', skip: 'Skip', optional: 'You may skip this.',
  pick_one: 'Pick one.', pick_many: 'Pick all that fit.', next_steps: 'What to do next', keep_title: 'Keep your answers', keep_lead: 'Give your email.',
  email_label: 'Email', keep_button: 'Keep', kept_lead: 'Your answers are kept.', open_kept: 'Open them', result_title: 'Your result',
};
const info = { title: 'Assessment', words, questions: 3, keep_on: 'https://members.example', signed_in: false };
const question = (extra: Record<string, unknown> = {}) => ({ kind: 'question', next: { key: 'q1', kind: 'question', position: 1, prompt: 'How long have you played?', required: true, question: { questionId: 'q1', questionTypeId: 'text' }, ...extra } });

test('the intro fills the count into its lead and offers a start; a resumable sitting offers go on and start again', async () => {
  const fresh = await renderAView(entry, { screen: { kind: 'intro', resumable: false }, info });
  assert.match(fresh, /Find your level/);
  assert.match(fresh, /3 short questions\./);
  assert.match(fresh, />Begin</);
  assert.doesNotMatch(fresh, /Go on/);
  const again = await renderAView(entry, { screen: { kind: 'intro', resumable: true }, info });
  assert.match(again, /Go on/);
  assert.match(again, /Start again/);
});

test('a question shows its place, its prompt, and Next waits for a required answer', async () => {
  const empty = await renderAView(entry, { screen: question(), info });
  assert.match(empty, /Question 2 of 3/);
  assert.match(empty, /How long have you played\?/);
  assert.match(empty, /<button[^>]*disabled=""[^>]*>Next</);
  const typed = await renderAView(entry, { screen: question(), info, answer: 'Ten years' });
  assert.doesNotMatch(typed, /<button[^>]*disabled=""[^>]*>Next</);
  assert.match(typed, /value="Ten years"/);
});

test('an optional question offers Skip and its optional help', async () => {
  const html = await renderAView(entry, { screen: question({ required: false }), info });
  assert.match(html, /Skip/);
  assert.match(html, /You may skip this\./);
});

test('a picks question draws its options with the one-or-many help', async () => {
  const html = await renderAView(entry, { screen: question({ question: { questionId: 'q1', questionTypeId: 'picks', multiple: true, options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] } }), info });
  assert.match(html, /Alpha/);
  assert.match(html, /Beta/);
  assert.match(html, /Pick all that fit\./);
});

test('a visitor\'s result asks for an email to keep the answers; a kept result links to where they are kept', async () => {
  const result = { segment: { id: 's', title: 'Intermediate', meaning: 'You play well.', next_step: 'Take a lesson' }, follow_up: [{ id: 'f', label: 'Read the guide' }], kept: false, keep_at: null };
  const visitor = await renderAView(entry, { screen: { kind: 'result', result }, info, email: 'a@example.com' });
  assert.match(visitor, /Intermediate/);
  assert.match(visitor, /Take a lesson/);
  assert.match(visitor, /Read the guide/);
  assert.match(visitor, /name="email"/);
  const kept = await renderAView(entry, { screen: { kind: 'result', result: { ...result, kept: true, keep_at: '/members' } }, info });
  assert.match(kept, /href="\/members"/);
  assert.doesNotMatch(kept, /name="email"/);
});

test('a closed form says why; loading draws nothing; an error shows as an alert', async () => {
  assert.match(await renderAView(entry, { screen: { kind: 'closed', message: 'This form is closed.' }, info: null }), /This form is closed\./);
  assert.doesNotMatch(await renderAView(entry, { screen: { kind: 'loading' }, info: null }), /data-form-step/);
  assert.match(await renderAView(entry, { screen: { kind: 'intro', resumable: false }, info, error: 'Try again.' }), /role="alert"[^>]*>Try again\./);
});

test('the screen is pure: it draws no script', async () => {
  const html = await renderAView(entry, { screen: question(), info });
  assert.doesNotMatch(html, /<script/);
});

test('the self-driving screen draws the intro of the page it is given from plain JSON props, and fetches nothing while it renders', async () => {
  const screen = new URL('../show/FormPageScreen.tsx', import.meta.url).pathname;
  const props = JSON.parse(JSON.stringify({ page: 'assessment', title: 'Assessment', words, questions: 3, keep_on: 'https://members.example' }));
  const html = await renderAView(screen, props);
  assert.match(html, /Find your level/);
  assert.match(html, /3 short questions\./);
  assert.match(html, />Begin</);
  assert.doesNotMatch(html, /Go on/);
});
