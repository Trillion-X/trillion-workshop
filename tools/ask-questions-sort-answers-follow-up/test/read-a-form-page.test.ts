import test from 'node:test';
import assert from 'node:assert/strict';
import { readFormPage } from '../reads/read-a-form-page.ts';

const rowsFor = (page: unknown, form: unknown) => async (_sql: string, params: unknown[] = []) => {
  const id = String(params[0]);
  if (id.startsWith('form-page:')) return page === undefined ? [] : [{ value: page }];
  return form === undefined ? [] : [{ value: form }];
};
const live = { live: true, formId: 'f1', words: { intro_title: 'Find your level', refusals: { closed: 'Closed for now.' }, start: 'Begin' }, keep_on: 'https://members.example' };
const form = { title: 'Assessment', questions: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }] };

test('a live page with a form answers its words, its question count, its title and the keeping site', async () => {
  const answer = await readFormPage({ database: 'd', page: 'assessment' }, rowsFor(live, form));
  assert.equal(answer.questions, 3);
  assert.equal(answer.title, 'Assessment');
  assert.equal(answer.keep_on, 'https://members.example');
  assert.equal(answer.words.start, 'Begin');
  assert.equal(typeof answer.words.refusals, 'undefined', 'only plain words are answered');
});

test('a page that is not live, unknown, or whose form has no questions is refused in the row\'s own words, else the default', async () => {
  await assert.rejects(readFormPage({ database: 'd', page: 'a' }, rowsFor({ ...live, live: false }, form)), /Closed for now\./);
  await assert.rejects(readFormPage({ database: 'd', page: 'a' }, rowsFor(undefined, form)), /This page is not open\./);
  await assert.rejects(readFormPage({ database: 'd', page: 'a' }, rowsFor(live, { questions: [] })), /Closed for now\./);
  await assert.rejects(readFormPage({ database: 'd', page: '' }, rowsFor(live, form)), /Give page/);
});

test('the read asks only the one table, by the page id and then the form id', async () => {
  const asked: unknown[][] = [];
  await readFormPage({ database: 'd', page: 'assessment' }, async (sql, params = []) => { asked.push(params); return /form-page/.test(String(params[0])) ? [{ value: live }] : [{ value: form }]; });
  assert.deepEqual(asked.map(item => item[0]), ['form-page:assessment', 'question-sequence:f1']);
});
