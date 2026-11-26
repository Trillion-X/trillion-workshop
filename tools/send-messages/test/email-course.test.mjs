// tools/send-messages/test/email-course.test.mjs
//
// The consent package's own ten cases, as it had them. What changed: the logic is handed targets named for what they
// do (contact-points.import, contact-points.resolve, lesson.schedule, send-email) in place of the old runtime's
// workflow and sender calls; a queued lesson is checked by its due time and token instead of by the old scheduler's
// three records; the sample course has no brand or sport in it, and its lesson copy uses the renderer's {{double}}
// braces (the originals used single braces, which the renderer would not have filled).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { alreadySent, createPublicEmailCourse, dueStep, HOUR_MS, isActive, isDue } from '../read-data/email-course.mjs';

const course = {
  id: 'sample-course', public_origin: 'https://example.com/',
  checkout_url: 'https://example.com/#pricing', from: 'Coach <coach@example.com>',
  mailing_address: '1 Example Street, Example City, CA 90000',
  consent_text: 'Send me three lessons by email.', consent_version: '1',
  lessons: [
    { delay_hours: 0, subject: 'First lesson', article_url: 'https://example.com/lesson-1', text_lines: ['First: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>First: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
    { delay_hours: 24, subject: 'Second lesson', article_url: 'https://example.com/lesson-2', text_lines: ['Second: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>Second: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
    { delay_hours: 48, subject: 'Third lesson', article_url: 'https://example.com/lesson-3', text_lines: ['Third: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>Third: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
  ],
};
const agreed = { kind: 'consent', text: course.consent_text };
const interestCourse = {
  id: 'sample-course', public_origin: 'https://example.com/',
  consent_text: 'Email me one update if the free lesson series becomes available.',
  consent_version: '2026-09-23-interest-v1', capture_only: true,
};

function harness({ writeReply, onWrite } = {}) {
  const records = new Map();
  const asks = [];
  const readCurrent = async (address) => {
    const payload = records.get(address);
    return payload ? { found: true, payload, content_hash: makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(payload))) } : { found: false };
  };
  const writeBatch = async (writes) => {
    if (onWrite) return onWrite(writes, records);
    if (writeReply) return writeReply;
    for (const row of writes) records.set(row.address_label, row.payload);
    return { write_count: writes.length };
  };
  const invokeTarget = async (target, input) => {
    asks.push({ target, input });
    if (target === 'contact-points.import') return { rows: [{ account_id: 'account-1', status: 'imported' }] };
    if (target === 'contact-points.resolve') return { address: 'reader@example.com' };
    if (target === 'lesson.schedule') return { status: 'scheduled' };
    if (target === 'send-email') return { ok: true, provider_message_id: `provider-${asks.filter((ask) => ask.target === target).length}` };
    throw new Error(`Unexpected target ${target}`);
  };
  return { asks, records, service: createPublicEmailCourse({ readCurrent, writeBatch, invokeTarget,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    mintToken: () => Buffer.alloc(32, 7).toString('base64url'),
  }) };
}

test('consent is required before contact import or email delivery', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: 'Some other words.' }, course }), /agree/);
  assert.equal(h.asks.length, 0);
});

test('an unverified mailing address blocks enrollment before external effects', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({
    email: 'reader@example.com', basis: agreed,
    course: { ...course, mailing_address: '' },
  }), /consent or sender is incomplete/);
  assert.equal(h.asks.length, 0);
});

test('capture-only course configuration cannot enroll or send lessons', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', basis: agreed, course: { ...course, capture_only: true } }), /not ready to send/);
  assert.equal(h.asks.length, 0);
});

test('interest capture stores explicit consent and never schedules or sends email', async () => {
  const h = harness();
  assert.deepEqual(await h.service.captureInterest({
    email: 'Reader@Example.com', consent: true, course: interestCourse, source: '/#email-course',
  }), { status: 'interest_saved', already_saved: false });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-interest');
  assert.equal(state.status, 'pending');
  assert.equal(state.email, 'reader@example.com');
  assert.equal(state.course_id, interestCourse.id);
  assert.equal(state.purpose, 'one-update-if-available');
  assert.equal(state.consent_text, interestCourse.consent_text);
  assert.equal(state.consent_version, interestCourse.consent_version);
  assert.equal(state.source, '/#email-course');
  assert.equal(h.asks.length, 0);
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 0);
  assert.equal(h.asks.filter((ask) => ask.target === 'lesson.schedule').length, 0);
  assert.deepEqual(await h.service.captureInterest({ email: 'reader@example.com', consent: true, course: interestCourse }), { status: 'interest_saved', already_saved: true });
  assert.equal(h.records.size, 1);
});

test('interest capture requires valid consent before writing any lead data', async () => {
  const h = harness();
  await assert.rejects(h.service.captureInterest({ email: 'reader@example.com', consent: false, course: interestCourse }), /agree/);
  await assert.rejects(h.service.captureInterest({ email: 'not-an-email', consent: true, course: interestCourse }), /valid email/);
  assert.equal(h.asks.length, 0);
  assert.equal(h.records.size, 0);
});

test('concurrent capture returns success only after reading the winning consent', async () => {
  const matching = harness({ onWrite: (writes, records) => {
    records.set(writes[0].address_label, writes[0].payload);
    return { ok: false, error: 'ExpectedCurrentMismatch' };
  } });
  assert.deepEqual(await matching.service.captureInterest({ email: 'Reader@Example.com', consent: true, course: interestCourse }),
    { status: 'interest_saved', already_saved: true });
  const different = harness({ onWrite: (writes, records) => {
    records.set(writes[0].address_label, { ...writes[0].payload, consent_version: 'different' });
    return { ok: false, error: 'ExpectedCurrentMismatch' };
  } });
  await assert.rejects(different.service.captureInterest({ email: 'reader@example.com', consent: true, course: interestCourse }), /could not be saved/);
});

test('a rejected consent write cannot send a lesson or report enrollment', async () => {
  const h = harness({ writeReply: { ok: false, error: 'ExpectedCurrentMismatch' } });
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', basis: agreed, course }), /could not be saved/);
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 0);
});

test('enrollment stores consent, schedules later lessons, and sends once', async () => {
  const h = harness();
  assert.deepEqual(await h.service.enroll({ email: 'Reader@Example.com', basis: agreed, course, source: '/contact' }), { status: 'enrolled', already_enrolled: false, first_lesson: { status: 'sent' } });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-subscription');
  assert.equal(state.consent_text, course.consent_text);
  assert.equal(state.source, '/contact');
  assert.equal(state.sent[0].provider_message_id, 'provider-1');
  assert.equal(h.asks.filter((ask) => ask.target === 'lesson.schedule').length, 2);
  const firstScheduled = h.asks.find((ask) => ask.target === 'lesson.schedule');
  assert.equal(firstScheduled.input.due_at, '2026-09-24T12:00:00.000Z');
  assert.equal(firstScheduled.input.token, state.unsubscribe_token);
  assert.equal(firstScheduled.input.lesson_index, 1);
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('a lesson cannot be triggered before its scheduled time', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-subscription');
  assert.deepEqual(await h.service.deliver({ token: state.unsubscribe_token, lesson_index: 1 }), { status: 'not-due' });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('unsubscribe stops a scheduled lesson from sending', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-subscription');
  assert.deepEqual(await h.service.unsubscribe(state.unsubscribe_token), { status: 'unsubscribed' });
  assert.deepEqual(await h.service.deliver({ token: state.unsubscribe_token, lesson_index: 1 }), { status: 'unsubscribed' });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('a non-receipt lesson is sent with its unsubscribe headers and copy variables', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course });
  const [lessonSend] = h.asks.filter((ask) => ask.target === 'send-email');
  assert.match(lessonSend.input.headers['List-Unsubscribe'], /email-course\/unsubscribe\?token=/);
  assert.match(lessonSend.input.variables.unsubscribeUrl, /email-course\/unsubscribe\?token=/);
  assert.equal(lessonSend.input.variables.mailingAddress, course.mailing_address);
});

test('a course with its own stop page links every lesson there, and a stop page with no token or on another site is refused', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course: { ...course, stop_path: 'courses/stop/{token}?from=email' } });
  const [lessonSend] = h.asks.filter((ask) => ask.target === 'send-email');
  const token = [...h.records.values()].find((row) => row.kind === 'email-course-subscription').unsubscribe_token;
  assert.equal(lessonSend.input.variables.unsubscribeUrl, `https://example.com/courses/stop/${token}?from=email`);
  assert.equal(lessonSend.input.headers['List-Unsubscribe'], `<https://example.com/courses/stop/${token}?from=email>`);
  for (const stop_path of ['courses/stop', 'stop/{token}/{token}', 'https://elsewhere.example/stop/{token}', '//elsewhere.example/{token}', 42]) {
    await assert.rejects(harness().service.enroll({ email: 'reader@example.com', basis: agreed, course: { ...course, stop_path } }), /stop link is invalid/, String(stop_path));
  }
});

test('a course that names no stop page keeps the default one, as before', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', basis: agreed, course });
  const token = [...h.records.values()].find((row) => row.kind === 'email-course-subscription').unsubscribe_token;
  const [lessonSend] = h.asks.filter((ask) => ask.target === 'send-email');
  assert.equal(lessonSend.input.variables.unsubscribeUrl, `https://example.com/email-course/unsubscribe?token=${token}`);
});

const receiptCourse = {
  ...course,
  lessons: [
    { ...course.lessons[0], receipt: true, text_lines: ['Thanks for buying: {{articleUrl}}'], html_lines: ['<p>Thanks: {{articleUrl}}</p>'] },
    ...course.lessons.slice(1),
  ],
};

test('a receipt step is sent without unsubscribe headers, unsubscribe copy or mailing address', async () => {
  const h = harness();
  assert.deepEqual(await h.service.enroll({ email: 'reader@example.com', basis: agreed, course: receiptCourse }), { status: 'enrolled', already_enrolled: false, first_lesson: { status: 'sent' } });
  const [receiptSend] = h.asks.filter((ask) => ask.target === 'send-email');
  assert.deepEqual(receiptSend.input.headers, {});
  assert.equal(receiptSend.input.variables.articleUrl, 'https://example.com/lesson-1');
  assert.equal('unsubscribeUrl' in receiptSend.input.variables, false);
  assert.equal('mailingAddress' in receiptSend.input.variables, false);
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('the receipt flag must be a boolean, and only a non-receipt lesson must carry unsubscribe copy', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', basis: agreed,
    course: { ...course, lessons: [{ ...course.lessons[0], receipt: 'yes' }, ...course.lessons.slice(1)] } }), /receipt flag is invalid/);
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', basis: agreed,
    course: { ...course, lessons: [{ ...course.lessons[0], receipt: false, text_lines: ['No unsubscribe here'], html_lines: ['<p>None</p>'] }, ...course.lessons.slice(1)] } }),
  /copy is incomplete/);
  assert.equal(h.asks.length, 0);
});

test('isActive is true only for an active subscription', () => {
  assert.equal(isActive({ status: 'active' }), true);
  assert.equal(isActive({ status: 'unsubscribed' }), false);
  assert.equal(isActive({ status: 'stopped' }), false);
  assert.equal(isActive(undefined), false);
});

test('alreadySent reads the sent log by step key', () => {
  assert.equal(alreadySent({ 0: { at: 'x' } }, 0), true);
  assert.equal(alreadySent({ 0: { at: 'x' } }, 1), false);
  assert.equal(alreadySent(undefined, 0), false);
});

test('isDue is true from the moment a step is due, not a millisecond before', () => {
  const start = Date.parse('2026-09-23T12:00:00.000Z');
  const step = { delay_hours: 24 };
  assert.equal(isDue(start, step, new Date(start + 24 * HOUR_MS - 1)), false);
  assert.equal(isDue(start, step, new Date(start + 24 * HOUR_MS)), true);
});

test('dueStep takes the first unsent due step in order and holds back the rest', () => {
  const started_at = Date.parse('2026-09-23T12:00:00.000Z');
  const steps = [
    { key: 0, delay_hours: 0, receipt: true },
    { key: 1, delay_hours: 24, receipt: false },
    { key: 2, delay_hours: 96, receipt: false },
  ];
  const enrollment = { status: 'active', started_at, sent: {} };
  const at48h = new Date(started_at + 48 * HOUR_MS);
  assert.equal(dueStep(enrollment, steps, at48h).key, 0);
  assert.equal(dueStep({ ...enrollment, sent: { 0: true } }, steps, at48h).key, 1);
  assert.equal(dueStep({ ...enrollment, sent: { 0: true, 1: true } }, steps, at48h), null);
  assert.equal(dueStep({ ...enrollment, sent: { 0: true, 1: true } }, steps, new Date(started_at + 96 * HOUR_MS)).key, 2);
  assert.equal(dueStep({ ...enrollment, sent: { 0: true, 1: true, 2: true } }, steps, new Date(started_at + 96 * HOUR_MS)), null);
});

test('dueStep: an earlier step not yet due holds back a later step that is due', () => {
  const started_at = Date.parse('2026-09-23T12:00:00.000Z');
  const steps = [{ key: 'a', delay_hours: 48, receipt: false }, { key: 'b', delay_hours: 0, receipt: false }];
  assert.equal(dueStep({ status: 'active', started_at, sent: {} }, steps, new Date(started_at + HOUR_MS)), null);
});

test('dueStep holds a follow-up for an inactive subscription but never the receipt', () => {
  const started_at = Date.parse('2026-09-23T12:00:00.000Z');
  const steps = [{ key: 0, delay_hours: 0, receipt: true }, { key: 1, delay_hours: 0, receipt: false }];
  const stopped = { status: 'stopped', started_at, sent: {} };
  const now = new Date(started_at);
  assert.equal(dueStep(stopped, steps, now).key, 0);
  assert.equal(dueStep({ ...stopped, sent: { 0: true } }, steps, now), null);
});
