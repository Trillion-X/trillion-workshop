import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listSentEmails } from '../do-work/list-sent-emails.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:list-sent-emails');
const canary = 'held-key-canary-0123456789';
const now = Date.parse('2026-11-25T15:00:00Z');
const email = (id, created_at, last_event = 'delivered') => ({ id, message_id: `<${id}@mail.example>`, to: ['a@example.org'], from: 'S <s@example.com>', created_at, subject: `About ${id}`, html: 'body-canary', last_event });
const pages = list => {
  const asked = [];
  const fetchImpl = async (address, request) => {
    assert.equal(request.headers.Authorization, `Bearer ${canary}`);
    asked.push(address);
    const page = list.shift();
    return typeof page === 'number' ? { status: page, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => page };
  };
  return { asked, fetchImpl };
};

test('the row hands the held key on a private pipe, the input on stdin, reads only, and runs on the person\'s computer', () => {
  assert.ok(row, 'tools/email-sending-domains/tool-rows.json has tool:list-sent-emails');
  assert.deepEqual(row.invoke.credential_mounts, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.deepEqual(row.input_schema.required, ['key_name', 'days']);
  assert.deepEqual(row.verify[0].replies.map(reply => reply.request), [{ method: 'GET', url: 'https://api.resend.com/emails?limit=100' }]);
});

test('reads page after page and stops at the first email older than the window, answering no key, body or raw reply', async () => {
  const { asked, fetchImpl } = pages([
    { object: 'list', has_more: true, data: [email('e-1', '2026-11-25 14:45:46.162+00'), email('e-2', '2026-11-22 10:00:00.5+00', 'bounced')] },
    { object: 'list', has_more: true, data: [email('e-3', '2026-11-21 09:00:00+00'), email('e-4', '2026-11-19 09:00:00+00')] },
  ]);
  const answer = await listSentEmails({ key: `${canary}\n`, days: 5, now, fetchImpl });
  assert.deepEqual(asked, ['https://api.resend.com/emails?limit=100', 'https://api.resend.com/emails?limit=100&after=e-2']);
  assert.deepEqual(answer.emails.map(e => [e.id, e.last_event]), [['e-1', 'delivered'], ['e-2', 'bounced'], ['e-3', 'delivered']]);
  assert.deepEqual(answer.emails[0], { id: 'e-1', to: ['a@example.org'], subject: 'About e-1', created_at: '2026-11-25 14:45:46.162+00', last_event: 'delivered' });
  assert.equal(answer.count, 3);
  assert.equal(answer.complete, true);
  const said = JSON.stringify(answer);
  assert.ok(!said.includes(canary) && !said.includes('body-canary'), 'neither the key nor a body is answered');
});

test('the last page ends the read; days outside 1 to 30 is refused before anything is asked', async () => {
  const { fetchImpl } = pages([{ object: 'list', has_more: false, data: [email('e-1', '2026-11-25 14:00:00+00')] }]);
  assert.deepEqual((await listSentEmails({ key: canary, days: 1, now, fetchImpl })).count, 1);
  await assert.rejects(listSentEmails({ key: canary, days: 31, now, fetchImpl: () => assert.fail('nothing is asked') }), /from 1 to 30/);
});

test('a refused or missing key says what to do, without the key', async () => {
  await assert.rejects(listSentEmails({ key: canary, days: 5, now, fetchImpl: pages([401]).fetchImpl }), error => /Connect the account again/.test(error.message) && !error.message.includes(canary));
  await assert.rejects(listSentEmails({ key: canary, days: 5, now, fetchImpl: pages([500]).fetchImpl }), /answered 500\. Try again later/);
  await assert.rejects(listSentEmails({ key: '', days: 5, now, fetchImpl: pages([]).fetchImpl }), /Connect the email-sending account first/);
});
