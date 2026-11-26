// sql/email-course-rows.sql on PGlite: the course tools' rows kept in a pursuit's own Postgres. A sign-up's keep, a due run's
// keep and a stop's keep are written by keep_email_course_rows and read back as the next run's records; a keep whose rows
// moved since they were read writes nothing at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { enrollInEmailCourse, sendDueEmailLessons, unsubscribeFromEmailCourse } from '../do-work/keep-who-agreed.mjs';

type Row = { id: string; type: string; value: Record<string, unknown> | null; expected?: unknown };
const stack = readFileSync(new URL('../sql/email-course-rows.sql', import.meta.url), 'utf8');
const line = (text: string) => ({ text_lines: [`${text}.`, 'Stop: {{unsubscribeUrl}}', '{{mailingAddress}}'] });
const course = {
  id: 'buyer-welcome', public_origin: 'https://example.com/', stop_path: 'stop?token={token}', from: 'Teacher <teacher@example.com>',
  mailing_address: '1 Example Street', waits: true, late_after_hours: 24, retry_failed: false,
  lessons: [{ delay_hours: 0, receipt: true, subject: 'Receipt', article_url: 'https://example.com/', text_lines: ['Thanks.'] }, { delay_hours: 24, subject: 'Day one', article_url: 'https://example.com/', ...line('Day one') }],
};
const START = Date.parse('2026-11-20T10:00:00.000Z');
const at = (hours: number) => ({ now: () => new Date(START + hours * 3_600_000) });
const sends: string[] = [];
const options = (hours: number) => ({ read: (fd: number) => (fd === 4 ? 'test-key' : ''), ...at(hours),
  send: { run: async (_p: unknown, input: { recipients: string[] }) => { sends.push(...input.recipients); return { code: 0, stdout: JSON.stringify({ sent: input.recipients.map((r, i) => ({ recipient: r, messageId: `m-${sends.length}-${i}` })) }) }; } } });

async function store() {
  const db = new PGlite();
  await db.exec(stack);
  const records = async (): Promise<Row[]> => (await db.query<Row>('SELECT id, type, value FROM email_course_records ORDER BY id')).rows;
  const keep = async (rows: Row[]) => (await db.query<{ kept: number }>('SELECT keep_email_course_rows($1::jsonb) AS kept', [JSON.stringify(rows)])).rows[0].kept;
  return { db, records, keep };
}

describe('a pursuit keeps the course rows in its own Postgres', () => {
  it('sign-up, a due run and a stop each read the rows, and their keep is written back whole', async () => {
    const s = await store();
    const enrolled = await enrollInEmailCourse({ provider: 'resend', records: await s.records(), email: 'buyer@example.com', basis: { kind: 'transaction', source_row: 'payments/p-1', at: new Date(START).toISOString() }, course, enrollment_key: 'p-1', waits_until: true }, options(0));
    assert.equal(await s.keep(enrolled.keep), enrolled.keep.length);
    assert.deepEqual((await s.records()).map(row => row.type).sort(), ['contact-point', 'email-course-subscription', 'email-course-token', 'email-lesson-due']);
    const due = await sendDueEmailLessons({ provider: 'resend', records: await s.records(), waits_until: { 'p-1': true } }, options(25));
    assert.deepEqual(due.results.map((item: { status: string }) => item.status), ['sent']);
    await s.keep(due.keep);
    const records = await s.records();
    assert.equal(records.filter(row => row.type === 'email-lesson-due').length, 0);
    const subscription = records.find(row => row.type === 'email-course-subscription')!;
    assert.deepEqual(Object.keys(subscription.value?.sent as object).sort(), ['0', '1']);
    const stopped = await unsubscribeFromEmailCourse({ token: String(subscription.value?.unsubscribe_token), records }, at(26));
    await s.keep(stopped.keep);
    assert.equal((await s.records()).filter(row => row.type === 'email-course-stop').length, 1);
    assert.deepEqual(sends, ['buyer@example.com', 'buyer@example.com']);
  });

  it('a keep whose rows moved since they were read writes nothing at all', async () => {
    const s = await store();
    const enrolled = await enrollInEmailCourse({ provider: 'resend', records: [], email: 'buyer@example.com', basis: { kind: 'transaction', source_row: 'payments/p-1' }, course, enrollment_key: 'p-1', waits_until: false }, options(0));
    await s.keep(enrolled.keep);
    const read = await s.records();
    const first = await sendDueEmailLessons({ provider: 'resend', records: read, waits_until: { 'p-1': true } }, options(1));
    const second = await sendDueEmailLessons({ provider: 'resend', records: read, waits_until: { 'p-1': true } }, options(1));
    await s.keep(first.keep);
    const before = await s.records();
    await assert.rejects(s.keep(second.keep), /changed since it was read, so nothing of this keep is written/);
    assert.deepEqual(await s.records(), before);
  });

  it('a row added twice, a removal of a row that is there, and a malformed keep are refused whole', async () => {
    const s = await store();
    await s.keep([{ id: 'a', type: 'contact-point', value: { email: 'a@example.com' }, expected: null }]);
    await assert.rejects(s.keep([{ id: 'b', type: 'contact-point', value: { email: 'b@example.com' }, expected: null }, { id: 'a', type: 'contact-point', value: { email: 'x@example.com' }, expected: null }]), /changed since it was read/);
    await assert.rejects(s.keep([{ id: 'a', type: 'contact-point', value: null, expected: null }]), /changed since it was read/);
    assert.deepEqual((await s.records()).map(row => row.id), ['a']);
    assert.equal(await s.keep([{ id: 'gone', type: 'email-lesson-due', value: null, expected: null }]), 1, 'removing a row that is already absent is a no-op that holds');
    await assert.rejects(s.keep([{ id: 'c', type: 'contact-point', value: {} }]), /each row is/);
    await assert.rejects(s.db.query('SELECT keep_email_course_rows($1::jsonb)', [JSON.stringify({ id: 'a' })]), /a list of rows/);
    assert.equal(await s.keep([{ id: 'a', type: 'contact-point', value: null, expected: { type: 'contact-point', value: { email: 'a@example.com' } } }]), 1);
    assert.deepEqual(await s.records(), []);
  });
});
