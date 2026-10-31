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
import { createPublicEmailCourse } from '../read-data/email-course.mjs';

const course = {
  id: 'sample-course', public_origin: 'https://example.com/',
  checkout_url: 'https://example.com/#pricing', from: 'Coach <coach@example.com>',
  mailing_address: '123 Test Street, Example City, CA 90000',
  consent_text: 'Send me three lessons by email.', consent_version: '1',
  lessons: [
    { delay_hours: 0, subject: 'First lesson', article_url: 'https://example.com/lesson-1', text_lines: ['First: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>First: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
    { delay_hours: 24, subject: 'Second lesson', article_url: 'https://example.com/lesson-2', text_lines: ['Second: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>Second: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
    { delay_hours: 48, subject: 'Third lesson', article_url: 'https://example.com/lesson-3', text_lines: ['Third: {{articleUrl}}', 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: ['<p>Third: {{articleUrl}}</p>', '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] },
  ],
};
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
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', consent: false, course }), /agree/);
  assert.equal(h.asks.length, 0);
});

test('an unverified mailing address blocks enrollment before external effects', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({
    email: 'reader@example.com', consent: true,
    course: { ...course, mailing_address: '' },
  }), /consent or sender is incomplete/);
  assert.equal(h.asks.length, 0);
});

test('capture-only course configuration cannot enroll or send lessons', async () => {
  const h = harness();
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', consent: true, course: { ...course, capture_only: true } }), /not ready to send/);
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
  await assert.rejects(h.service.enroll({ email: 'reader@example.com', consent: true, course }), /could not be saved/);
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 0);
});

test('enrollment stores consent, schedules later lessons, and sends once', async () => {
  const h = harness();
  assert.deepEqual(await h.service.enroll({ email: 'Reader@Example.com', consent: true, course, source: '/contact' }), { status: 'enrolled', already_enrolled: false });
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
  await h.service.enroll({ email: 'reader@example.com', consent: true, course });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('a lesson cannot be triggered before its scheduled time', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', consent: true, course });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-subscription');
  assert.deepEqual(await h.service.deliver({ token: state.unsubscribe_token, lesson_index: 1 }), { status: 'not-due' });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});

test('unsubscribe stops a scheduled lesson from sending', async () => {
  const h = harness();
  await h.service.enroll({ email: 'reader@example.com', consent: true, course });
  const state = [...h.records.values()].find((row) => row.kind === 'email-course-subscription');
  assert.deepEqual(await h.service.unsubscribe(state.unsubscribe_token), { status: 'unsubscribed' });
  assert.deepEqual(await h.service.deliver({ token: state.unsubscribe_token, lesson_index: 1 }), { status: 'unsubscribed' });
  assert.equal(h.asks.filter((ask) => ask.target === 'send-email').length, 1);
});
