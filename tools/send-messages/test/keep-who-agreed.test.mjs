// tools/send-messages/test/keep-who-agreed.test.mjs
//
// The consent logic (test/email-course.test.mjs, the package's own cases) run through its seam: over the rows a caller
// hands in, and against the sending seam with a stand-in adapter. The tools keep nothing and their rows hold no records
// door: each answer holds the rows to keep (`keep`), and the next call is handed them as the person's store would hold them.
// What these prove that the logic's own tests cannot: the consent and the queue come back in the answer, a lesson is
// sent once, an unsubscribed person gets nothing, the rows declare no records door, and the provider's key is read from
// the descriptors the row mounts and goes only to the adapter.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rowOf, answerOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import {
  KEY_FIRST_DESCRIPTOR, enrollInEmailCourse, heldKeysFrom, saveEmailInterest, sendDueEmailLessons, unsubscribeFromEmailCourse, whoAgreedToGetEmails,
} from '../do-work/keep-who-agreed.mjs';
import { providerOf } from '../do-work/send-a-message.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mountsFor, mountsOf } from './mounts-for.test.mjs';

const line = text => ({ text_lines: [`${text}: {{articleUrl}}`, 'Unsubscribe: {{unsubscribeUrl}}', '{{mailingAddress}}'], html_lines: [`<p>${text}: {{articleUrl}}</p>`, '<p>{{unsubscribeUrl}} {{mailingAddress}}</p>'] });
const course = {
  id: 'sample-course', public_origin: 'https://example.com/', checkout_url: 'https://example.com/#pricing',
  from: 'Teacher <teacher@example.com>', mailing_address: '1 Example Street, Example City', consent_text: 'Send me two lessons by email.', consent_version: '1',
  lessons: [
    { delay_hours: 0, subject: 'First lesson', article_url: 'https://example.com/lesson-1', ...line('First') },
    { delay_hours: 24, subject: 'Second lesson', article_url: 'https://example.com/lesson-2', ...line('Second') },
  ],
};
const interestCourse = { id: 'sample-course', public_origin: 'https://example.com/', consent_text: 'Email me one update.', consent_version: 'v1', capture_only: true };

// The person's rows after a run, as their store would hold them once the caller wrote its `keep`.
function held(records, keep) {
  const byId = new Map(records.map(row => [row.id, row]));
  for (const row of keep) { if (row.value === null) byId.delete(row.id); else byId.set(row.id, { id: row.id, type: row.type, value: row.value }); }
  return [...byId.values()];
}
const ofType = (records, type) => records.filter(record => record.type === type);

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
  it('keys are mounted from descriptor 4 up, in the order the provider lists them, and no row declares a records door', () => {
    for (const id of ['tool:sign-someone-up-for-an-email-course', 'tool:send-due-email-lessons']) {
      const row = rowOf(rows, id);
      assert.equal(row.invoke.records, undefined, `${id} keeps nothing and reads no store`);
      assert.deepEqual(mountsOf(row), mountsFor('email'), id);
      assert.equal(row.input_schema.properties.provider.enum, undefined, `${id} is named for its job, not a provider`);
    }
    for (const id of ['tool:save-interest-in-an-email-update', 'tool:stop-an-email-course', 'tool:who-agreed-to-get-which-emails']) {
      assert.equal(rowOf(rows, id).invoke.credential_mounts, undefined, `${id} sends nothing and holds no key`);
      assert.equal(rowOf(rows, id).invoke.internet, false);
      assert.equal(rowOf(rows, id).invoke.records, undefined, `${id} keeps nothing and reads no store`);
    }
    assert.equal(KEY_FIRST_DESCRIPTOR, 4);
  });

  it('every row that works over rows asks for them as records', () => {
    for (const id of ['tool:sign-someone-up-for-an-email-course', 'tool:send-due-email-lessons', 'tool:save-interest-in-an-email-update', 'tool:stop-an-email-course', 'tool:who-agreed-to-get-which-emails']) {
      assert.ok(rowOf(rows, id).input_schema.required.includes('records'), id);
    }
    for (const id of ['tool:sign-someone-up-for-an-email-course', 'tool:send-due-email-lessons', 'tool:save-interest-in-an-email-update', 'tool:stop-an-email-course']) {
      assert.ok(rowOf(rows, id).output_schema.properties.keep, `${id} answers the rows to keep`);
    }
  });

  it('heldKeysFrom reads each key from its descriptor', () => {
    const provider = providerOf('amazon-ses');
    assert.deepEqual(heldKeysFrom(provider, descriptor => `value-${descriptor}`), { AWS_ACCESS_KEY_ID: 'value-4', AWS_SECRET_ACCESS_KEY: 'value-5' });
  });
});

describe('signing up, the first lesson, the queue and the due runner', () => {
  it('answers the consent and the queued lesson as rows to keep, sends the first with unsubscribe headers and sends nothing twice', async () => {
    const sender = adapter();
    const result = await enrollInEmailCourse({ email: 'Reader@Example.com', basis: { kind: 'consent', text: course.consent_text }, course, source: '/sign-up', provider: 'resend', records: [] }, { ...keys, send: { run: sender.run }, ...at('2026-10-01T12:00:00.000Z') });
    assert.deepEqual({ status: result.status, already_enrolled: result.already_enrolled }, { status: 'enrolled', already_enrolled: false });
    assert.deepEqual(result.keep.map(record => record.type).sort(), ['contact-point', 'email-course-subscription', 'email-course-token', 'email-lesson-due']);
    assert.ok(result.keep.every(record => record.expected === null), 'every row is new, so each is to be written as absent');
    const kept = held([], result.keep);
    const subscription = ofType(kept, 'email-course-subscription')[0].value;
    assert.equal(subscription.consent_text, course.consent_text);
    assert.equal(subscription.source, '/sign-up');
    assert.ok(subscription.sent[0].provider_message_id.startsWith('receipt-'));
    const contact = ofType(kept, 'contact-point')[0].value;
    assert.equal(contact.email, 'reader@example.com');
    assert.ok(!JSON.stringify(subscription).includes('reader@example.com'), 'the subscription holds the contact\'s id, not the address');
    const due = ofType(kept, 'email-lesson-due')[0].value;
    assert.equal(due.lesson_index, 1);
    assert.equal(due.token, subscription.unsubscribe_token);
    assert.equal(sender.calls.length, 1);
    const [{ input, env }] = sender.calls;
    assert.deepEqual(input.recipients, ['reader@example.com']);
    assert.equal(input.subject, 'First lesson');
    assert.match(input.headers['List-Unsubscribe'], /^<https:\/\/example\.com\/email-course\/unsubscribe\?token=/);
    assert.ok(input.html.includes('1 Example Street, Example City'), 'the mailing address is in the lesson');
    assert.equal(env.RESEND_API_KEY, 'test-key-resend');
    assert.equal(env.EMAIL_FROM, 'Teacher <teacher@example.com>');
    assert.ok(!JSON.stringify(input).includes('test-key-resend'), 'the key is not in what the adapter is asked to send');
    const again = await enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend', records: kept }, { ...keys, send: { run: sender.run }, ...at('2026-10-01T12:00:00.000Z') });
    assert.deepEqual({ status: again.status, already_enrolled: again.already_enrolled }, { status: 'enrolled', already_enrolled: true });
    assert.equal(sender.calls.length, 1, 'signing up again sends nothing twice');
  });

  it('refuses without consent and answers no rows', async () => {
    const sender = adapter();
    await assert.rejects(enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: 'Some other words.' }, course, provider: 'resend', records: [] }, { ...keys, send: { run: sender.run } }), /agree/);
    assert.equal(sender.calls.length, 0);
  });

  it('asks for the rows it works over', async () => {
    await assert.rejects(enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend' }, { ...keys, send: { run: adapter().run } }), /records is a list of the rows/);
  });

  it('the due runner sends a lesson once it has fallen due, answers it marked sent and its queue row removed', async () => {
    const enrolled = await enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend', records: [] }, { ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
    const records = held([], enrolled.keep);
    const early = adapter();
    const before = await sendDueEmailLessons({ provider: 'resend', records }, { ...keys, send: { run: early.run }, ...at('2026-10-02T11:00:00.000Z') });
    assert.deepEqual(before.results, []);
    assert.deepEqual(before.keep, []);
    assert.equal(early.calls.length, 0, 'not due yet, nothing is sent');
    const sender = adapter();
    const after = await sendDueEmailLessons({ provider: 'resend', records }, { ...keys, send: { run: sender.run }, ...at('2026-10-02T12:00:00.000Z') });
    assert.deepEqual(after.results.map(item => [item.lesson_index, item.status]), [[1, 'sent']]);
    assert.equal(sender.calls[0].input.subject, 'Second lesson');
    const left = held(records, after.keep);
    assert.equal(ofType(left, 'email-lesson-due').length, 0, 'the queue row is answered removed');
    assert.ok(after.keep.some(row => row.type === 'email-lesson-due' && row.value === null && row.expected !== null));
    assert.deepEqual(Object.keys(ofType(left, 'email-course-subscription')[0].value.sent), ['0', '1']);
    assert.match(after.said, /1 lesson due; 1 sent, 0 failed/);
  });

  it('a failed send answers its own later retry and the row that failed removed', async () => {
    const enrolled = await enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend', records: [] }, { ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
    const records = held([], enrolled.keep);
    const answer = await sendDueEmailLessons({ provider: 'resend', records }, { ...keys, send: { run: adapter(true).run }, ...at('2026-10-02T12:00:00.000Z') });
    assert.equal(answer.results[0].status, 'failed');
    assert.match(answer.results[0].why, /Resend 500: down/);
    const left = ofType(held(records, answer.keep), 'email-lesson-due');
    assert.equal(left.length, 1);
    assert.equal(left[0].value.retry, 1);
    assert.equal(left[0].value.due_at, '2026-10-02T14:00:00.000Z', 'the retry is two hours after the first try was due');
  });

  it('an unsubscribed person gets nothing from the queue', async () => {
    const enrolled = await enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend', records: [] }, { ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
    const records = held([], enrolled.keep);
    const token = ofType(records, 'email-course-subscription')[0].value.unsubscribe_token;
    const stopped = await unsubscribeFromEmailCourse({ token, records }, at('2026-10-01T13:00:00.000Z'));
    assert.equal(stopped.status, 'unsubscribed');
    assert.deepEqual(stopped.keep.map(row => row.type), ['email-course-subscription', 'email-course-stop']);
    assert.deepEqual((await unsubscribeFromEmailCourse({ token: 'x'.repeat(43), records })).status, 'unsubscribed', 'an unknown token answers unsubscribed too');
    const sender = adapter();
    const answer = await sendDueEmailLessons({ provider: 'resend', records: held(records, stopped.keep) }, { ...keys, send: { run: sender.run }, ...at('2026-10-05T12:00:00.000Z') });
    assert.deepEqual(answer.results.map(item => item.status), ['unsubscribed']);
    assert.equal(sender.calls.length, 0);
  });
});

describe('interest in one update, and who agreed', () => {
  it('answers the agreement in its words as a row to keep and lists everyone with a consent, each address once', async () => {
    const first = await saveEmailInterest({ email: 'Asker@Example.com', consent: true, course: interestCourse, source: '/update', records: [] }, at('2026-10-01T09:00:00.000Z'));
    assert.deepEqual({ status: first.status, already_saved: first.already_saved }, { status: 'interest_saved', already_saved: false });
    assert.deepEqual(first.keep.map(row => row.type), ['email-course-interest']);
    const interest = held([], first.keep);
    const second = await saveEmailInterest({ email: 'asker@example.com', consent: true, course: interestCourse, records: interest });
    assert.deepEqual({ status: second.status, already_saved: second.already_saved }, { status: 'interest_saved', already_saved: true });
    assert.deepEqual(second.keep, []);
    const enrolled = await enrollInEmailCourse({ email: 'reader@example.com', basis: { kind: 'consent', text: course.consent_text }, course, provider: 'resend', records: [] }, { ...keys, send: { run: adapter().run }, ...at('2026-10-01T12:00:00.000Z') });
    const records = [...interest, ...held([], enrolled.keep)];
    const all = await whoAgreedToGetEmails({ records });
    assert.deepEqual(all.people.map(item => [item.email, item.kind, item.status]).sort(), [['asker@example.com', 'update', 'pending'], ['reader@example.com', 'course', 'active']]);
    assert.deepEqual([...all.agreed].sort(), ['asker@example.com', 'reader@example.com']);
    assert.equal(all.people.find(item => item.kind === 'update').consent_text, 'Email me one update.');
    assert.match(all.said, /2 people; 2 can be sent to now/);
    assert.equal(all.keep, undefined, 'who agreed keeps nothing');
    assert.equal((await whoAgreedToGetEmails({ list: 'another-list', records })).people.length, 0);
    assert.deepEqual((await whoAgreedToGetEmails({ status: 'active', records })).people.map(item => item.email), ['reader@example.com']);
  });
});

describe('the rows as the container runs them', () => {
  it('tool:save-interest-in-an-email-update answers the agreement as a row to keep, with no records door handed to the run', async () => {
    const row = rowOf(rows, 'tool:save-interest-in-an-email-update');
    const run = await answerOf(row, { email: 'asker@example.com', consent: true, course: interestCourse, source: '/update', records: [] });
    assert.equal(run.status, 0, run.error);
    assert.deepEqual({ status: run.result.status, already_saved: run.result.already_saved }, { status: 'interest_saved', already_saved: false });
    assert.deepEqual(run.result.keep.map(record => record.type), ['email-course-interest']);
    assert.deepEqual(run.kept, run.result.keep.map(({ id, type, value }) => ({ id, type, value })), 'only what the run answers to keep is kept, by the caller');
  });

  it('tool:who-agreed-to-get-which-emails reads them from the rows handed in through the real command', async () => {
    const saved = await answerOf(rowOf(rows, 'tool:save-interest-in-an-email-update'), { email: 'asker@example.com', consent: true, course: interestCourse, records: [] });
    const run = await answerOf(rowOf(rows, 'tool:who-agreed-to-get-which-emails'), { records: held([], saved.result.keep) });
    assert.equal(run.status, 0, run.error);
    assert.deepEqual(run.result.agreed, ['asker@example.com']);
  });

  it('a refusal says why and sends nothing', async () => {
    const run = await answerOf(rowOf(rows, 'tool:save-interest-in-an-email-update'), { email: 'asker@example.com', consent: false, course: interestCourse, records: [] });
    assert.equal(run.status, 1);
    assert.match(run.error, /agree/);
  });
});

describe('the keep rows run their export from this folder, directly', () => {
  const KEEP_ROWS = {
    'tool:sign-someone-up-for-an-email-course': 'enrollInEmailCourse',
    'tool:send-due-email-lessons': 'sendDueEmailLessons',
    'tool:save-interest-in-an-email-update': 'saveEmailInterest',
    'tool:stop-an-email-course': 'unsubscribeFromEmailCourse',
    'tool:who-agreed-to-get-which-emails': 'whoAgreedToGetEmails',
  };
  const script = fileURLToPath(new URL('../do-work/keep-who-agreed.mjs', import.meta.url));

  it('each row names keep-who-agreed.mjs and its export, with no records door between them', () => {
    for (const [id, name] of Object.entries(KEEP_ROWS)) {
      const row = rowOf(rows, id);
      assert.deepEqual(row.invoke.argv, ['node', '/opt/send-messages/do-work/keep-who-agreed.mjs', name], id);
      assert.ok(!row.invoke.files.package_files.some(files => files.package === 'records-door'), id);
    }
  });

  it('the command answers the export it names as { result } on standard output, and an unknown name as { error }', () => {
    const answer = spawnSync(process.execPath, [script, 'whoAgreedToGetEmails'], { input: JSON.stringify({ records: [] }), encoding: 'utf8' });
    assert.equal(answer.status, 0);
    assert.deepEqual(JSON.parse(answer.stdout).result.agreed, []);
    const unknown = spawnSync(process.execPath, [script, 'noSuchExport'], { input: '{}', encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.match(JSON.parse(unknown.stdout).error, /usage: keep-who-agreed/);
  });
});
