// The email-course engine's widened rules, through the tool seam (do-work/keep-who-agreed.mjs) with rows held as a
// person's store would hold them: an enrollment's recorded basis (consent in the course's words, or a transaction's row),
// the caller's enrollment key, waits_until, late_after_hours, one lesson per enrollment per run, retry_failed false, the
// stop scope a link covers, 1 to 12 lessons and tokens of 32 to 100 characters.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { enrollInEmailCourse, sendDueEmailLessons, unsubscribeFromEmailCourse } from '../do-work/keep-who-agreed.mjs';
import { inProcess } from '../do-work/send-a-message.mjs';

const resendAdapter = createRequire(import.meta.url)('../do-work/send-via-resend.cjs');

type Row = { id: string; type: string; value: Record<string, unknown> | null };
type Course = Record<string, unknown> & { id: string; lessons: unknown[] };
type Sent = { to: string; subject: string };

const line = (text: string) => ({ text_lines: [`${text}: {{articleUrl}}`, 'Stop: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: [`<p>${text}</p>`, '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] });
const lesson = (delay: number, name: string) => ({ delay_hours: delay, subject: name, article_url: `https://example.com/${name.toLowerCase().replace(/ /g, '-')}`, ...line(name) });
const base = {
  public_origin: 'https://example.com/', from: 'Teacher <teacher@example.com>', mailing_address: '1 Example Street, Example City',
  stop_path: 'stop?token={token}',
};
const buyers: Course = { ...base, id: 'buyer-welcome', waits: true, late_after_hours: 24, retry_failed: false, stop_scope: 'all-site-emails',
  lessons: [lesson(0, 'Welcome'), lesson(24, 'Day one'), lesson(72, 'Day three')] };
const wordsAsk: Course = { ...base, id: 'words-ask', stop_scope: 'all-site-emails', lessons: [lesson(0, 'Your words')] };
const readers: Course = { ...base, id: 'reader-course', consent_text: 'Send me the lessons by email.', consent_version: '1', lessons: [lesson(0, 'First'), lesson(24, 'Second')] };

const START = Date.parse('2026-11-20T10:00:00.000Z');
const hours = (n: number) => ({ now: () => new Date(START + n * 3_600_000) });
const keys = { read: (descriptor: number) => (descriptor === 4 ? 'test-key-resend' : '') };

function store() {
  let rows: Row[] = [];
  const sent: Sent[] = [];
  const send = { run: async (_provider: unknown, input: { recipients: string[]; subject?: string; message?: { subject: string } }) => {
    for (const to of input.recipients) sent.push({ to, subject: String(input.subject ?? input.message?.subject ?? '') });
    return { code: 0, stdout: JSON.stringify({ sent: input.recipients.map((recipient, index) => ({ recipient, messageId: `receipt-${sent.length}-${index}` })) }) };
  } };
  const failing = { run: async (_provider: unknown, input: { recipients: string[] }) => ({ code: 1, stdout: JSON.stringify({ sent: input.recipients.map(recipient => ({ recipient, error: 'Resend 500: down' })) }) }) };
  const keep = (answer: { keep: Row[] }) => {
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const row of answer.keep) { if (row.value === null) byId.delete(row.id); else byId.set(row.id, { id: row.id, type: row.type, value: row.value }); }
    rows = [...byId.values()];
    return answer;
  };
  return {
    sent,
    rows: () => rows,
    ofType: (type: string) => rows.filter(row => row.type === type),
    enroll: async (input: Record<string, unknown>, at: number) => keep(await enrollInEmailCourse({ provider: 'resend', records: rows, ...input }, { ...keys, send, ...hours(at) })),
    due: async (input: Record<string, unknown>, at: number, fail = false) => keep(await sendDueEmailLessons({ provider: 'resend', records: rows, ...input }, { ...keys, send: fail ? failing : send, ...hours(at) })),
    stop: async (token: string, at: number) => keep(await unsubscribeFromEmailCourse({ token, records: rows }, hours(at))),
  };
}

const transaction = (row: string) => ({ kind: 'transaction', source_row: row });

describe('the basis of an enrollment is recorded, and one of the two is required', () => {
  it('a transaction basis needs no consent words and is kept as it was given', async () => {
    const s = store();
    await s.enroll({ email: 'buyer@example.com', basis: transaction('payment_events/pay-1'), course: { ...buyers, waits: false }, enrollment_key: 'pay-1' }, 0);
    const [subscription] = s.ofType('email-course-subscription');
    assert.deepEqual(subscription.value?.basis, { kind: 'transaction', source_row: 'payment_events/pay-1' });
    assert.equal(subscription.value?.consented_at, undefined);
    assert.equal(subscription.value?.consent_text, undefined);
    assert.deepEqual(s.sent.map(item => item.to), ['buyer@example.com']);
  });

  it('a consent basis must carry the course\'s own words; no basis, or another kind, is refused before anything is kept or sent', async () => {
    const s = store();
    for (const basis of [undefined, true, { kind: 'consent', text: 'Something else.' }, { kind: 'consent' }, { kind: 'purchase', source_row: 'x' }, { kind: 'transaction', source_row: '' }]) {
      await assert.rejects(s.enroll({ email: 'reader@example.com', basis, course: readers }, 0));
    }
    await assert.rejects(s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: 'Anything.' }, course: { ...readers, consent_text: undefined } }, 0), /consent or sender is incomplete/);
    assert.equal(s.rows().length, 0);
    assert.equal(s.sent.length, 0);
    await s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course: readers }, 0);
    const [subscription] = s.ofType('email-course-subscription');
    assert.deepEqual(subscription.value?.basis, { kind: 'consent', text: readers.consent_text });
    assert.equal(subscription.value?.consent_text, readers.consent_text);
  });
});

describe('the caller chooses the enrollment key', () => {
  it('the same email with two payments makes two enrollments, each sent its own first lesson; the same key again makes none', async () => {
    const s = store();
    const course = { ...buyers, waits: false };
    await s.enroll({ email: 'buyer@example.com', basis: transaction('payment_events/pay-1'), course, enrollment_key: 'pay-1' }, 0);
    await s.enroll({ email: 'Buyer@Example.com', basis: transaction('payment_events/pay-2'), course, enrollment_key: 'pay-2' }, 0);
    await s.enroll({ email: 'buyer@example.com', basis: transaction('payment_events/pay-2'), course, enrollment_key: 'pay-2' }, 1);
    const subscriptions = s.ofType('email-course-subscription');
    assert.equal(subscriptions.length, 2);
    assert.deepEqual(subscriptions.map(row => row.value?.enrollment_key).sort(), ['pay-1', 'pay-2']);
    assert.equal(new Set(subscriptions.map(row => row.value?.account_id)).size, 1, 'one contact behind both');
    assert.equal(s.ofType('contact-point').length, 1);
    assert.equal(s.sent.length, 2);
  });

  it('a course that waits needs an enrollment key, and an enrollment key is a short non-empty name', async () => {
    const s = store();
    await assert.rejects(s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, waits_until: true }, 0), /needs an enrollment_key/);
    await assert.rejects(s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: '', waits_until: true }, 0), /enrollment key/);
    await assert.rejects(s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'k'.repeat(301), waits_until: true }, 0), /enrollment key/);
    assert.equal(s.rows().length, 0);
  });
});

describe('waits_until is the caller\'s answer on every wake, never assumed', () => {
  it('no answer at sign-up is refused; false queues even the first lesson; each run sends only on a true answer for that key', async () => {
    const s = store();
    await assert.rejects(s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'pay-1' }, 0), /give waits_until/);
    await s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'pay-1', waits_until: false }, 0);
    assert.equal(s.sent.length, 0);
    assert.equal(s.ofType('email-lesson-due').length, 3, 'the first lesson is queued too');
    const unanswered = await s.due({}, 1);
    assert.deepEqual(unanswered.results.map((item: { status: string }) => item.status), ['no-waits-answer']);
    const wrongKey = await s.due({ waits_until: { 'pay-2': true } }, 2);
    assert.deepEqual(wrongKey.results.map((item: { status: string }) => item.status), ['no-waits-answer']);
    const no = await s.due({ waits_until: { 'pay-1': false } }, 3);
    assert.deepEqual(no.results.map((item: { status: string }) => item.status), ['waiting']);
    assert.equal(s.sent.length, 0);
    assert.equal(s.ofType('email-lesson-due').length, 3, 'a waiting lesson stays queued');
    const yes = await s.due({ waits_until: { 'pay-1': true } }, 4);
    assert.deepEqual(yes.results.map((item: { status: string }) => item.status), ['sent']);
    assert.deepEqual(s.sent.map(item => item.subject), ['Welcome']);
  });

  it('a true answer at sign-up sends the first lesson then', async () => {
    const s = store();
    await s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'pay-1', waits_until: true }, 0);
    assert.deepEqual(s.sent.map(item => item.subject), ['Welcome']);
    assert.equal(s.ofType('email-lesson-due').length, 2);
  });
});

describe('late_after_hours holds a late lesson as a row the person can read', () => {
  it('a lesson more than late_after_hours past its time is not sent and is kept once as a held row; one on time is sent', async () => {
    const s = store();
    await s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'pay-1', waits_until: false }, 0);
    const first = await s.due({ waits_until: { 'pay-1': true } }, 30);
    assert.deepEqual(first.results.map((item: { status: string }) => item.status), ['held-late', 'next-run'], 'the welcome is 30 hours past its time');
    assert.equal(s.sent.length, 0);
    const [held] = s.ofType('email-course-held');
    assert.deepEqual({ ...held.value, held_at: undefined }, { kind: 'email-course-held', why: 'late', course_id: 'buyer-welcome', subscription_address: held.value?.subscription_address,
      enrollment_key: 'pay-1', lesson_index: 0, due_at: '2026-11-20T10:00:00.000Z', late_after_hours: 24, held_at: undefined });
    const second = await s.due({ waits_until: { 'pay-1': true } }, 30);
    assert.deepEqual(second.results.map((item: { status: string }) => item.status), ['sent'], 'day one is 6 hours past its time, inside 24');
    const third = await s.due({ waits_until: { 'pay-1': true } }, 100);
    assert.deepEqual(third.results.map((item: { status: string }) => item.status), ['held-late'], 'day three is 28 hours past its time');
    assert.deepEqual(s.sent.map(item => item.subject), ['Day one']);
    assert.deepEqual(s.ofType('email-course-held').map(row => row.value?.lesson_index).sort(), [0, 2]);
    assert.equal(s.ofType('email-lesson-due').length, 0);
  });

  it('a course with no late_after_hours sends a lesson however late', async () => {
    const s = store();
    await s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course: readers }, 0);
    await s.due({}, 24 * 20);
    assert.deepEqual(s.sent.map(item => item.subject), ['First', 'Second']);
    assert.equal(s.ofType('email-course-held').length, 0);
  });
});

describe('one lesson per enrollment per run is its own rule', () => {
  it('with no lateness rule, three due lessons of one enrollment go one a run; another enrollment\'s lesson goes in the same run', async () => {
    const s = store();
    const course = { ...buyers, late_after_hours: undefined };
    await s.enroll({ email: 'one@example.com', basis: transaction('p/1'), course, enrollment_key: 'pay-1', waits_until: false }, 0);
    await s.enroll({ email: 'two@example.com', basis: transaction('p/2'), course, enrollment_key: 'pay-2', waits_until: false }, 0);
    const yes = { waits_until: { 'pay-1': true, 'pay-2': true } };
    const first = await s.due(yes, 100);
    assert.deepEqual(first.results.map((item: { status: string }) => item.status).sort(), ['next-run', 'next-run', 'next-run', 'next-run', 'sent', 'sent']);
    assert.deepEqual(s.sent.map(item => `${item.to} ${item.subject}`).sort(), ['one@example.com Welcome', 'two@example.com Welcome']);
    assert.equal(s.ofType('email-lesson-due').length, 4);
    await s.due(yes, 101);
    await s.due(yes, 102);
    assert.equal(s.sent.length, 6);
    assert.equal(s.ofType('email-lesson-due').length, 0);
    assert.match((await s.due(yes, 103)).said, /^0 lessons due/);
  });
});

describe('retry_failed false', () => {
  it('a failed send queues no retry when the course says so, and queues one when it does not', async () => {
    const noRetry = store();
    await noRetry.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course: buyers, enrollment_key: 'pay-1', waits_until: false }, 0);
    const failed = await noRetry.due({ waits_until: { 'pay-1': true } }, 1, true);
    assert.deepEqual(failed.results.map((item: { status: string }) => item.status), ['failed']);
    assert.deepEqual(noRetry.ofType('email-lesson-due').map(row => row.value?.lesson_index).sort(), [1, 2]);
    const retry = store();
    await retry.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course: readers }, 0);
    await retry.due({}, 25, true);
    assert.deepEqual(retry.ofType('email-lesson-due').map(row => row.value?.retry), [1]);
  });
});

describe('a stop link covers the course\'s stop scope', () => {
  it('an old link stops every enrollment of that contact in the scope, other courses of the scope too; another contact is untouched', async () => {
    const s = store();
    const course = { ...buyers, waits: false, late_after_hours: undefined };
    await s.enroll({ email: 'buyer@example.com', basis: transaction('p/1'), course, enrollment_key: 'pay-1' }, 0);
    await s.enroll({ email: 'buyer@example.com', basis: transaction('p/2'), course, enrollment_key: 'pay-2' }, 0);
    await s.enroll({ email: 'other@example.com', basis: transaction('p/3'), course, enrollment_key: 'pay-3' }, 0);
    const token = String(s.ofType('email-course-subscription').find(row => row.value?.enrollment_key === 'pay-1')?.value?.unsubscribe_token);
    await s.stop(token, 1);
    const [stop] = s.ofType('email-course-stop');
    assert.equal(stop.value?.scope, 'all-site-emails');
    const sentBefore = s.sent.length;
    const run = await s.due({}, 30);
    assert.deepEqual(run.results.map((item: { status: string }) => item.status).sort(), ['sent', 'unsubscribed', 'unsubscribed']);
    assert.deepEqual(s.sent.slice(sentBefore).map(item => item.to), ['other@example.com']);
    await s.enroll({ email: 'buyer@example.com', basis: transaction('words/1'), course: wordsAsk, enrollment_key: 'words-1' }, 31);
    assert.deepEqual(s.sent.slice(sentBefore).map(item => item.to), ['other@example.com'], 'a transaction never lifts a stop');
    await s.stop(token, 32);
    assert.equal(s.ofType('email-course-stop').length, 1, 'the same link again keeps one stop');
  });

  it('a fresh consent in the course\'s own words lifts an earlier stop of the same scope', async () => {
    const s = store();
    const course = { ...readers, stop_scope: 'all-site-emails' };
    await s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course }, 0);
    const token = String(s.ofType('email-course-subscription')[0].value?.unsubscribe_token);
    await s.stop(token, 1);
    await s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course, enrollment_key: 'second-time' }, 2);
    assert.equal(s.ofType('email-course-stop').length, 0);
    assert.deepEqual(s.sent.map(item => item.subject), ['First', 'First']);
  });
});

describe('lesson counts and token lengths', () => {
  it('a course of one lesson enrolls; none or thirteen are refused', async () => {
    const s = store();
    await s.enroll({ email: 'asker@example.com', basis: transaction('words/1'), course: wordsAsk, enrollment_key: 'w-1' }, 0);
    assert.deepEqual(s.sent.map(item => item.subject), ['Your words']);
    await assert.rejects(s.enroll({ email: 'asker@example.com', basis: transaction('words/2'), course: { ...wordsAsk, lessons: [] }, enrollment_key: 'w-2' }, 0), /no valid lessons/);
    const thirteen = Array.from({ length: 13 }, (_, index) => lesson(index * 24, `Lesson ${index}`));
    await assert.rejects(s.enroll({ email: 'asker@example.com', basis: transaction('words/3'), course: { ...wordsAsk, lessons: thirteen }, enrollment_key: 'w-3' }, 0), /no valid lessons/);
  });

  it('a stop link of 32 characters works, as one of 43 does; 31 is refused', async () => {
    for (const length of [32, 43, 100]) {
      const s = store();
      await s.enroll({ email: 'reader@example.com', basis: { kind: 'consent', text: readers.consent_text }, course: readers }, 0);
      const [subscription] = s.ofType('email-course-subscription');
      const [mapping] = s.ofType('email-course-token');
      const token = 'a'.repeat(length);
      const kept: Row[] = s.rows().map(row => row.type === 'email-course-subscription' ? { ...row, value: { ...row.value, unsubscribe_token: token } } : row)
        .filter(row => row.id !== mapping.id);
      const stopped = await unsubscribeFromEmailCourse({ token, records: [...kept, { id: await tokenRowId(token), type: 'email-course-token', value: { subscription_address: subscription.id } }] }, hours(1));
      assert.equal(stopped.status, 'unsubscribed');
      assert.ok(stopped.keep.some((row: Row) => row.type === 'email-course-stop'), `a ${length}-character link stops`);
    }
    await assert.rejects(unsubscribeFromEmailCourse({ token: 'a'.repeat(31), records: [] }, hours(1)), /Invalid unsubscribe link/);
  });
});

describe('the transaction\'s own time, a reply-to and text-only lessons', () => {
  it('a transaction basis at times the lessons from the payment, not from the sign-up; a time later than now is refused', async () => {
    const s = store();
    const course = { ...buyers, waits: false, late_after_hours: undefined };
    const paidAt = new Date(START - 30 * 3_600_000).toISOString();
    await s.enroll({ email: 'buyer@example.com', basis: { ...transaction('p/1'), at: paidAt }, course, enrollment_key: 'pay-1' }, 0);
    const [subscription] = s.ofType('email-course-subscription');
    assert.equal(subscription.value?.started_at, paidAt);
    assert.equal(subscription.value?.enrolled_at, new Date(START).toISOString());
    assert.deepEqual((subscription.value?.basis as Record<string, unknown>).at, paidAt);
    const run = await s.due({}, 0);
    assert.deepEqual(run.results.map((item: { status: string }) => item.status), ['sent'], 'day one, due 6 hours ago by the payment\'s time');
    assert.deepEqual(s.sent.map(item => item.subject), ['Welcome', 'Day one']);
    await assert.rejects(s.enroll({ email: 'later@example.com', basis: { ...transaction('p/2'), at: new Date(START + 60_000).toISOString() }, course, enrollment_key: 'pay-2' }, 0), /not later than now/);
    await assert.rejects(s.enroll({ email: 'later@example.com', basis: { ...transaction('p/2'), at: 'yesterday' }, course, enrollment_key: 'pay-2' }, 0), /not later than now/);
  });

  it('a lesson with no html lines goes out as text only, with the course\'s reply-to, its stop link and mailing address filled in', async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body?: string } = {}) => {
      calls.push({ body: JSON.parse(String(init.body ?? '{}')) });
      return new Response('{"id":"msg-1"}', { status: 200 });
    }) as typeof fetch;
    try {
      const textOnly = { ...wordsAsk, reply_to: 'teacher@example.com', lessons: [{ delay_hours: 0, subject: 'Your words', article_url: 'https://example.com/words', text_lines: ['Hello.', 'Stop: {{unsubscribeUrl}}', '{{mailingAddress}}'] }] };
      const answer = await enrollInEmailCourse({ provider: 'resend', records: [], email: 'asker@example.com', basis: transaction('words/1'), course: textOnly, enrollment_key: 'w-1' },
        { ...keys, send: { run: inProcess({ 'send-via-resend.cjs': resendAdapter }) }, ...hours(0) });
      assert.equal(answer.status, 'enrolled');
      assert.equal(calls.length, 1);
      const [{ body }] = calls;
      assert.equal(body.html, undefined, 'no html part');
      assert.equal(body.reply_to, 'teacher@example.com');
      assert.match(String(body.text), /^Hello\.\nStop: https:\/\/example\.com\/stop\?token=[A-Za-z0-9_-]{43}\n1 Example Street, Example City$/);
      await assert.rejects(enrollInEmailCourse({ provider: 'resend', records: [], email: 'asker@example.com', basis: transaction('words/2'), course: { ...textOnly, reply_to: 'Teacher <teacher@example.com>' }, enrollment_key: 'w-2' },
        { ...keys, send: { run: inProcess({ 'send-via-resend.cjs': resendAdapter }) }, ...hours(0) }), /reply_to is one plain email address/);
      await assert.rejects(enrollInEmailCourse({ provider: 'resend', records: [], email: 'asker@example.com', basis: transaction('words/3'), course: { ...textOnly, lessons: [{ ...textOnly.lessons[0], text_lines: ['Hello, no stop link.'] }] }, enrollment_key: 'w-3' },
        { ...keys, send: { run: inProcess({ 'send-via-resend.cjs': resendAdapter }) }, ...hours(0) }), /copy is incomplete/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The id a token's row has in the store: the engine's own address for it.
async function tokenRowId(token: string): Promise<string> {
  const { makeHashCodeHexFromBytes } = await import('../../content-identity/read-data/identity.mjs');
  return `email-course.token::${makeHashCodeHexFromBytes(new TextEncoder().encode(token)).slice('1f:'.length)}`;
}
