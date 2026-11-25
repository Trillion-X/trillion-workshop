import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';
import { readBookingPage } from '../reads/read-a-booking-page.ts';

const entry = new URL('../show/BookingPage.tsx', import.meta.url).pathname;
const props = JSON.parse(JSON.stringify({
  page: 'application', title: 'Program application', timezone: 'America/Chicago', duration_minutes: 30,
  questions: [{ position: 0, prompt: 'What is your goal?', required: true }, { position: 1, prompt: 'Anything else?', required: false }],
}));

test('the server draws the first step: the email, with the plain words and a continue button', async () => {
  const html = await renderAView(entry, props);
  assert.match(html, /Start with your email/);
  assert.match(html, /Your email/);
  assert.match(html, /name="email"/);
  assert.match(html, />Continue</);
  assert.doesNotMatch(html, /<script/);
});

test('words given by the page replace the defaults', async () => {
  const html = await renderAView(entry, { ...props, words: { email_title: 'Tell us where to write', continue: 'Go on' } });
  assert.match(html, /Tell us where to write/);
  assert.match(html, />Go on</);
  assert.doesNotMatch(html, /Start with your email/);
});

const pageRow = { slug: 'application', title: 'Program application', duration_minutes: 30, timezone: 'America/Chicago', windows: [{ days: [1] }], horizon_days: 14, min_notice_minutes: 60, form_id: 'f1' };
const rowsFor = (pages: Record<string, unknown>[], form: unknown) => async (sql: string) => (/from booking_pages/.test(sql) ? pages : form === undefined ? [] : [{ value: form }]);

test('a live page with windows and a form answers its questions in the form\'s order, required unless the form says not', async () => {
  const answer = await readBookingPage({ database: 'd', page: 'application' }, rowsFor([pageRow], { questions: [{ label: 'Goal' }, { label: 'More', required: false }] }));
  assert.deepEqual(answer.questions, [{ position: 0, prompt: 'Goal', required: true }, { position: 1, prompt: 'More', required: false }]);
  assert.equal(answer.duration_minutes, 30);
  assert.equal(answer.timezone, 'America/Chicago');
  assert.equal(answer.horizon_days, 14);
});

test('a page that is not live, has no windows, or has no questions is refused by name', async () => {
  await assert.rejects(readBookingPage({ database: 'd', page: 'a' }, rowsFor([], undefined)), /not open/);
  await assert.rejects(readBookingPage({ database: 'd', page: 'a' }, rowsFor([{ ...pageRow, windows: [] }], { questions: [{ label: 'x' }] })), /no times to offer/);
  await assert.rejects(readBookingPage({ database: 'd', page: 'a' }, rowsFor([pageRow], { questions: [] })), /no questions/);
  await assert.rejects(readBookingPage({ database: 'd', page: '' }, rowsFor([pageRow], undefined)), /Give page/);
});

test('the read asks the page by its slug and only live pages', async () => {
  const asked: { sql: string; params: unknown[] | undefined }[] = [];
  await readBookingPage({ database: 'd', page: 'application' }, async (sql, params) => { asked.push({ sql, params }); return /booking_pages/.test(sql) ? [pageRow] : [{ value: { questions: [{ label: 'x' }] } }]; });
  assert.match(asked[0].sql, /where slug = \$1 and live/);
  assert.deepEqual(asked[0].params, ['application']);
  assert.deepEqual(asked[1].params, ['question-sequence:f1']);
});
