// sql/email-course-stop-from-a-link.sql on PGlite, as a site's own logins hold it: a reader that may only call
// email_course_stop_records and a writer that may only call keep_an_email_course_stop, neither with any right on
// email_course_records. The narrow read hands the stop tool the same answer and keep the whole table would, and no other
// person's rows; the keep goes in as keep-a-site-write's json value and stops only that person; a keep naming any other kind of
// row is refused whole. Every value is made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { enrollInEmailCourse, unsubscribeFromEmailCourse } from '../do-work/keep-who-agreed.mjs';
import { statementOf } from '../../serve-a-sites-pages-from-its-rows/do-work/keep-a-site-write.ts';

type Row = { id: string; type: string; value: Record<string, unknown> | null };
const rowsStack = readFileSync(new URL('../sql/email-course-rows.sql', import.meta.url), 'utf8');
const stopFunctions = readFileSync(new URL('../sql/email-course-stop-from-a-link.sql', import.meta.url), 'utf8');
const course = (id: string) => ({
  id, public_origin: 'https://example.com/', stop_path: 'stop?token={token}', from: 'Teacher <teacher@example.com>',
  mailing_address: '1 Example Street', waits: false, late_after_hours: 24, retry_failed: false,
  lessons: [{ delay_hours: 0, receipt: true, subject: 'Receipt', article_url: 'https://example.com/', text_lines: ['Thanks.'] },
    { delay_hours: 24, subject: 'Day one', article_url: 'https://example.com/', text_lines: ['Day one.', 'Stop: {{unsubscribeUrl}}', '{{mailingAddress}}'] }],
});
const START = Date.parse('2026-11-20T10:00:00.000Z');
const at = (hours: number) => ({ now: () => new Date(START + hours * 3_600_000) });
const options = { read: (fd: number) => (fd === 4 ? 'test-key' : ''), ...at(0),
  send: { run: async (_p: unknown, input: { recipients: string[] }) => ({ code: 0, stdout: JSON.stringify({ sent: input.recipients.map((r, i) => ({ recipient: r, messageId: `m-${r}-${i}` })) }) }) } };

async function store() {
  const db = new PGlite();
  await db.exec(rowsStack);
  await db.exec(`CREATE ROLE site_owner; CREATE ROLE site_reader; CREATE ROLE site_writer;
    GRANT CREATE, USAGE ON SCHEMA public TO site_owner; GRANT USAGE ON SCHEMA public TO site_reader, site_writer;
    GRANT ALL ON email_course_records, email_courses TO site_owner; GRANT EXECUTE ON FUNCTION keep_email_course_rows(jsonb) TO site_owner;
    SET ROLE site_owner; ${stopFunctions} RESET ROLE;
    GRANT EXECUTE ON FUNCTION email_course_stop_records(text) TO site_reader; GRANT EXECUTE ON FUNCTION keep_an_email_course_stop(jsonb) TO site_writer;`);
  const records = async (): Promise<Row[]> => (await db.query<Row>('SELECT id, type, value FROM email_course_records ORDER BY id')).rows;
  const keep = async (rows: unknown[]) => db.query('SELECT keep_email_course_rows($1::jsonb)', [JSON.stringify(rows)]);
  const as = async <T>(role: string, sql: string, params: unknown[]) => {
    await db.exec(`SET ROLE ${role}`);
    try { return (await db.query<T>(sql, params)).rows; } finally { await db.exec('RESET ROLE'); }
  };
  return { db, records, keep, as };
}

// Two people: the first in two courses, the second in one.
async function twoPeople() {
  const s = await store();
  for (const [email, courseId, key] of [['one@example.com', 'buyer-welcome', 'p-1'], ['one@example.com', 'words-ask', 'p-2'], ['two@example.com', 'buyer-welcome', 'p-3']]) {
    const enrolled = await enrollInEmailCourse({ provider: 'resend', records: await s.records(), email, basis: { kind: 'transaction', source_row: `payments/${key}`, at: new Date(START).toISOString() }, course: course(courseId), enrollment_key: key, waits_until: false }, options);
    await s.keep(enrolled.keep);
  }
  return s;
}
const tokens = async (s: Awaited<ReturnType<typeof store>>) => (await s.records()).filter(row => row.type === 'email-course-subscription').map(row => ({ token: String(row.value?.unsubscribe_token), account: String(row.value?.account_id), id: row.id }));

describe('a site answers a stop link with its own logins only', () => {
  it('the narrow read gives the stop tool the same answer and keep as the whole table, and holds no other person\'s rows', async () => {
    const s = await twoPeople();
    for (const { token, account } of await tokens(s)) {
      const [{ records }] = await s.as<{ records: Row[] }>('site_reader', 'SELECT public.email_course_stop_records($1::text) AS records', [token]);
      const narrow = await unsubscribeFromEmailCourse({ token, records }, at(1));
      const whole = await unsubscribeFromEmailCourse({ token, records: await s.records() }, at(1));
      assert.deepEqual(narrow, whole, 'the same answer and keep');
      assert.ok(records.every(row => row.type !== 'contact-point'), 'no address reaches the site');
      assert.ok(records.every(row => row.type !== 'email-course-subscription' || row.value?.unsubscribe_token === token), 'only this token\'s subscription');
      assert.ok(records.filter(row => row.type === 'email-course-stop').every(row => row.value?.account_id === account), 'only this person\'s stops');
    }
    for (const token of ['x'.repeat(43), 'short']) {
      assert.deepEqual((await s.as<{ records: Row[] }>('site_reader', 'SELECT public.email_course_stop_records($1::text) AS records', [token]))[0].records, [], 'an unknown or malformed token reads nothing');
    }
    await assert.rejects(s.as('site_reader', 'SELECT id FROM email_course_records', []), /permission denied/, 'the reader reads no row of the table itself');
  });

  it('the keep goes in as keep-a-site-write\'s json value and stops that person only; any other kind of row is refused whole', async () => {
    const s = await twoPeople();
    const [first, , other] = await tokens(s);
    const [{ records }] = await s.as<{ records: Row[] }>('site_reader', 'SELECT public.email_course_stop_records($1::text) AS records', [first.token]);
    const stopped = await unsubscribeFromEmailCourse({ token: first.token, records }, at(1));
    assert.equal(stopped.status, 'unsubscribed');
    const { sql, params } = statementOf({ write: 'email-course-stop', values: { keep: stopped.keep } });
    const [{ kept }] = await s.as<{ kept: number }>('site_writer', sql, params);
    assert.equal(kept, stopped.keep.length);
    const after = await s.records();
    assert.ok(after.some(row => row.type === 'email-course-stop' && row.value?.account_id === first.account), 'the first person is stopped');
    assert.ok(!after.some(row => row.type === 'email-course-stop' && row.value?.account_id === other.account), 'the other person is not');
    const lesson = after.find(row => row.type === 'contact-point')!;
    const sneaked = [...stopped.keep, { id: lesson.id, type: lesson.type, value: null, expected: { type: lesson.type, value: lesson.value } }];
    const asked = statementOf({ write: 'email-course-stop', values: { keep: sneaked } });
    await assert.rejects(s.as('site_writer', asked.sql, asked.params), /only subscription, token and stop rows/);
    assert.deepEqual(await s.records(), after, 'nothing of a refused keep is written');
    await assert.rejects(s.as('site_writer', 'SELECT keep_email_course_rows($1::jsonb)', ['[]']), /permission denied/, 'the writer cannot call the unfenced keep');
    await assert.rejects(s.as('site_writer', 'SELECT id FROM email_course_records', []), /permission denied/, 'nor read the table');
  });
});
