// tools/send-messages/test/keep-who-agreed.test.mjs
//
// The consent logic (test/email-course.test.mjs, the package's own cases) run through its seam: against the fake
// records door holding exactly the rights each row declares, and against the sending seam with a stand-in adapter.
// What these prove that the logic's own tests cannot: the rows' rights are enough for what each tool does and no more,
// the consent and the queue land in the person's records, a lesson is sent once, an unsubscribed person gets nothing,
// and the provider's key is read from the descriptors the row mounts and goes only to the adapter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { rowOf, runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import {
  KEY_FIRST_DESCRIPTOR, enrollInEmailCourse, heldKeysFrom, saveEmailInterest, sendDueEmailLessons, unsubscribeFromEmailCourse, whoAgreedToGetEmails,
} from '../do-work/keep-who-agreed.mjs';
import { providerOf } from '../do-work/send-a-message.mjs';


const line = text => ({ text_lines: [`${text}: {{articleUrl}}`, 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: [`<p>${text}: {{articleUrl}}</p>`, '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] });
const course = {
  id: 'sample-course', public_origin: 'https://example.com/', checkout_url: 'https://example.com/#pricing',
  from: 'Teacher <teacher@example.com>', mailing_address: '123 Test Street, Example City', consent_text: 'Send me two lessons by email.', consent_version: '1',
  lessons: [
    { delay_hours: 0, subject: 'First lesson', article_url: 'https://example.com/lesson-1', ...line('First') },
    { delay_hours: 24, subject: 'Second lesson', article_url: 'https://example.com/lesson-2', ...line('Second') },
  ],
};
const interestCourse = { id: 'sample-course', public_origin: 'https://example.com/', consent_text: 'Email me one update.', consent_version: 'v1', capture_only: true };

// A door on the fake endpoint with the rights of the row, so a tool that reaches past its row is refused.
async function doorFor(id, records = []) {
  const row = rowOf(rows, id);
  const fake = await startFakeDoor({ rights: row.invoke.records.rights, records });
  return { fake, row, door: openRecordsDoor({ descriptor: fake.descriptor }) };
}

// A stand-in adapter run: records what it was given and answers a receipt (or an error) for each recipient.
function adapter(fail = false) {
  const calls = [];
  const run = async (provider, input, env) => {
    calls.push({ provider: provider.id, input, env });
    return { code: fail ? 1 : 0, stdout: JSON.stringify({ sent: input.recipients.map((recipient, index) => (fail ? { recipient, error: 'Resend 500: down' } : { recipient, messageId: `receipt-${calls.length}-${index}` })) }), stderr: '' };
  };
  return { calls, run };
}

const keys = { read: descriptor => (descriptor === 4 ? 'test-key-resend' : '') };
const at = iso => ({ now: () => new Date(iso) });

describe('the rows and the seam agree', () => {
  it('keys are mounted from descriptor 4 up, in the order the provider lists them, and the records door is 3', () => {
    for (const [id, provider] of [['tool:sign-someone-up-for-an-email-course-with-resend', 'resend'], ['tool:sign-someone-up-for-an-email-course-with-amazon-ses', 'amazon-ses'], ['tool:send-due-email-lessons-with-resend', 'resend'], ['tool:send-due-email-lessons-with-amazon-ses', 'amazon-ses']]) {
      const row = rowOf(rows, id);
      assert.equal(row.invoke.records.fd, 3);
      assert.deepEqual(row.invoke.credential_mounts, providerOf(provider).credentials.map(({ secret_name }, index) => ({ secret_name, fd: KEY_FIRST_DESCRIPTOR + index })), id);
      assert.deepEqual(row.input_schema.properties.provider.enum, [provider]);
    }
    for (const id of ['tool:save-interest-in-an-email-update', 'tool:stop-an-email-course', 'tool:who-agreed-to-get-which-emails']) {
      assert.equal(rowOf(rows, id).invoke.credential_mounts, undefined, `${id} sends nothing and holds no key`);
      assert.equal(rowOf(rows, id).invoke.internet, false);
    }
  });

  it('heldKeysFrom reads each key from its descriptor', () => {
    const provider = providerOf('amazon-ses');
    assert.deepEqual(heldKeysFrom(provider, descriptor => `value-${descriptor}`), { AWS_ACCESS_KEY_ID: 'value-4', AWS_SECRET_ACCESS_KEY: 'value-5' });
  });
});

describe('signing up, the first lesson, the queue and the due runner', () => {
  it('records the consent, queues the later lesson, sends the first with unsubscribe headers and sends nothing twice', async () => {
    const { fake, row, door } = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      const sender = adapter();
      const result = await enrollInEmailCourse({ email: 'Reader@Example.com', consent: true, course, source: '/sign-up', provider: 'resend' }, { door, ...keys, send: { run: sender.run }, ...at('2026-10-01T12:00:00.000Z') });
      assert.deepEqual(result, { status: 'enrolled', already_enrolled: false });
      const kinds = [...fake.kept.values()].map(record => record.type).sort();
      assert.deepEqual(kinds, ['contact-point', 'email-course-subscription', 'email-course-token', 'email-lesson-due']);
      const subscription = [...fake.kept.values()].find(record => record.type === 'email-course-subscription').value;
      assert.equal(subscription.consent_text, course.consent_text);
      assert.equal(subscription.source, '/sign-up');
      assert.ok(subscription.sent[0].provider_message_id.startsWith('receipt-'));
      const contact = [...fake.kept.values()].find(record => record.type === 'contact-point').value;
      assert.equal(contact.email, 'reader@example.com');
      assert.ok(!JSON.stringify(subscription).includes('reader@example.com'), 'the subscription holds the contact\'s id, not the address');
      const due = [...fake.kept.values()].find(record => record.type === 'email-lesson-due').value;
      assert.equal(due.lesson_index, 1);
      assert.equal(due.token, subscription.unsubscribe_token);
      assert.equal(sender.calls.length, 1);
      const [{ input, env }] = sender.calls;
      assert.deepEqual(input.recipients, ['reader@example.com']);
      assert.equal(input.subject, 'First lesson');
      assert.match(input.headers['List-Unsubscribe'], /^<https:\/\/example\.com\/email-course\/unsubscribe\?token=/);
      assert.ok(input.html.includes('123 Test Street, Example City'), 'the mailing address is in the lesson');
      assert.equal(env.RESEND_API_KEY, 'test-key-resend');
      assert.equal(env.EMAIL_FROM, 'Teacher <teacher@example.com>');
      assert.ok(!JSON.stringify(input).includes('test-key-resend'), 'the key is not in what the adapter is asked to send');
      assert.deepEqual(await enrollInEmailCourse({ email: 'reader@example.com', consent: true, course, provider: 'resend' }, { door, ...keys, send: { run: sender.run }, ...at('2026-10-01T12:00:00.000Z') }), { status: 'enrolled', already_enrolled: true });
      assert.equal(sender.calls.length, 1, 'signing up again sends nothing twice');
      assert.ok(row.invoke.records.rights.length > 0);
    } finally { await fake.close(); }
  });

  it('refuses without consent and writes nothing', async () => {
    const { fake, door } = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      const sender = adapter();
      await assert.rejects(enrollInEmailCourse({ email: 'reader@example.com', consent: false, course, provider: 'resend' }, { door, ...keys, send: { run: sender.run } }), /agree/);
      assert.equal(fake.kept.size, 0);
      assert.equal(sender.calls.length, 0);
    } finally { await fake.close(); }
  });

  it('the due runner sends a lesson once it has fallen due, marks it sent and clears the queue', async () => {
    const enrolled = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      await enrollInEmailCourse({ email: 'reader@example.com', consent: true, course, provider: 'resend' }, { door: enrolled.door, ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
      const held = [...enrolled.fake.kept.values()];
      const due = await doorFor('tool:send-due-email-lessons-with-resend', held);
      try {
        const early = adapter();
        const before = await sendDueEmailLessons({ provider: 'resend' }, { door: due.door, ...keys, send: { run: early.run }, ...at('2026-10-02T11:00:00.000Z') });
        assert.deepEqual(before.results, []);
        assert.equal(early.calls.length, 0, 'not due yet, nothing is sent');
        const sender = adapter();
        const after = await sendDueEmailLessons({ provider: 'resend' }, { door: due.door, ...keys, send: { run: sender.run }, ...at('2026-10-02T12:00:00.000Z') });
        assert.deepEqual(after.results.map(item => [item.lesson_index, item.status]), [[1, 'sent']]);
        assert.equal(sender.calls[0].input.subject, 'Second lesson');
        assert.equal([...due.fake.kept.values()].filter(record => record.type === 'email-lesson-due').length, 0, 'the queue entry is gone');
        const subscription = [...due.fake.kept.values()].find(record => record.type === 'email-course-subscription').value;
        assert.deepEqual(Object.keys(subscription.sent), ['0', '1']);
        assert.match(after.said, /1 lesson due; 1 sent, 0 failed/);
      } finally { await due.fake.close(); }
    } finally { await enrolled.fake.close(); }
  });

  it('a failed send queues its own later retry and clears the entry that failed', async () => {
    const enrolled = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      await enrollInEmailCourse({ email: 'reader@example.com', consent: true, course, provider: 'resend' }, { door: enrolled.door, ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
      const due = await doorFor('tool:send-due-email-lessons-with-resend', [...enrolled.fake.kept.values()]);
      try {
        const answer = await sendDueEmailLessons({ provider: 'resend' }, { door: due.door, ...keys, send: { run: adapter(true).run }, ...at('2026-10-02T12:00:00.000Z') });
        assert.equal(answer.results[0].status, 'failed');
        assert.match(answer.results[0].why, /Resend 500: down/);
        const left = [...due.fake.kept.values()].filter(record => record.type === 'email-lesson-due');
        assert.equal(left.length, 1);
        assert.equal(left[0].value.retry, 1);
        assert.equal(left[0].value.due_at, '2026-10-02T14:00:00.000Z', 'the retry is two hours after the first try was due');
      } finally { await due.fake.close(); }
    } finally { await enrolled.fake.close(); }
  });

  it('an unsubscribed person gets nothing from the queue', async () => {
    const enrolled = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      await enrollInEmailCourse({ email: 'reader@example.com', consent: true, course, provider: 'resend' }, { door: enrolled.door, ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
      const held = [...enrolled.fake.kept.values()];
      const token = held.find(record => record.type === 'email-course-subscription').value.unsubscribe_token;
      const stop = await doorFor('tool:stop-an-email-course', held);
      try {
        assert.deepEqual(await unsubscribeFromEmailCourse({ token }, { door: stop.door, ...at('2026-10-01T13:00:00.000Z') }), { status: 'unsubscribed' });
        assert.deepEqual(await unsubscribeFromEmailCourse({ token: 'x'.repeat(43) }, { door: stop.door }), { status: 'unsubscribed' }, 'an unknown token answers unsubscribed too');
        const due = await doorFor('tool:send-due-email-lessons-with-resend', [...stop.fake.kept.values()]);
        try {
          const sender = adapter();
          const answer = await sendDueEmailLessons({ provider: 'resend' }, { door: due.door, ...keys, send: { run: sender.run }, ...at('2026-10-05T12:00:00.000Z') });
          assert.deepEqual(answer.results.map(item => item.status), ['unsubscribed']);
          assert.equal(sender.calls.length, 0);
        } finally { await due.fake.close(); }
      } finally { await stop.fake.close(); }
    } finally { await enrolled.fake.close(); }
  });
});

describe('interest in one update, and who agreed', () => {
  it('keeps the agreement in its words and lists everyone with a consent, each address once', async () => {
    const interest = await doorFor('tool:save-interest-in-an-email-update');
    const enrolled = await doorFor('tool:sign-someone-up-for-an-email-course-with-resend');
    try {
      assert.deepEqual(await saveEmailInterest({ email: 'Asker@Example.com', consent: true, course: interestCourse, source: '/update' }, { door: interest.door, ...at('2026-10-01T09:00:00.000Z') }), { status: 'interest_saved', already_saved: false });
      assert.deepEqual(await saveEmailInterest({ email: 'asker@example.com', consent: true, course: interestCourse }, { door: interest.door }), { status: 'interest_saved', already_saved: true });
      await enrollInEmailCourse({ email: 'reader@example.com', consent: true, course, provider: 'resend' }, { door: enrolled.door, ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
      const who = await doorFor('tool:who-agreed-to-get-which-emails', [...interest.fake.kept.values(), ...enrolled.fake.kept.values()]);
      try {
        const all = await whoAgreedToGetEmails({}, { door: who.door });
        assert.deepEqual(all.people.map(item => [item.email, item.kind, item.status]).sort(), [['asker@example.com', 'update', 'pending'], ['reader@example.com', 'course', 'active']]);
        assert.deepEqual([...all.agreed].sort(), ['asker@example.com', 'reader@example.com']);
        assert.equal(all.people.find(item => item.kind === 'update').consent_text, 'Email me one update.');
        assert.match(all.said, /2 people; 2 can be sent to now/);
        assert.equal((await whoAgreedToGetEmails({ list: 'another-list' }, { door: who.door })).people.length, 0);
        assert.deepEqual((await whoAgreedToGetEmails({ status: 'active' }, { door: who.door })).people.map(item => item.email), ['reader@example.com']);
      } finally { await who.fake.close(); }
    } finally { await interest.fake.close(); await enrolled.fake.close(); }
  });

  it('the row for who agreed cannot write', () => {
    const operations = rowOf(rows, 'tool:who-agreed-to-get-which-emails').invoke.records.rights.flatMap(item => item.operations);
    assert.ok(!operations.includes('records:write'));
  });
});

describe('the rows as the container runs them', () => {
  it('tool:save-interest-in-an-email-update saves the agreement through the real command and door client', async () => {
    const row = rowOf(rows, 'tool:save-interest-in-an-email-update');
    const run = await runRow(row, { email: 'asker@example.com', consent: true, course: interestCourse, source: '/update' });
    assert.equal(run.status, 0, run.error);
    assert.deepEqual(run.result, { status: 'interest_saved', already_saved: false });
    assert.deepEqual(run.kept.map(record => record.type), ['email-course-interest']);
  });

  it('tool:who-agreed-to-get-which-emails reads them back through the real command', async () => {
    const saved = await runRow(rowOf(rows, 'tool:save-interest-in-an-email-update'), { email: 'asker@example.com', consent: true, course: interestCourse });
    const run = await runRow(rowOf(rows, 'tool:who-agreed-to-get-which-emails'), {}, { records: saved.kept });
    assert.equal(run.status, 0, run.error);
    assert.deepEqual(run.result.agreed, ['asker@example.com']);
  });

  it('a refusal says why and sends nothing', async () => {
    const run = await runRow(rowOf(rows, 'tool:save-interest-in-an-email-update'), { email: 'asker@example.com', consent: false, course: interestCourse });
    assert.equal(run.status, 1);
    assert.match(run.error, /agree/);
  });
});

