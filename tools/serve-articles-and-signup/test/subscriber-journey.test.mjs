import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSite } from '../do-work/pursuit-site.mjs';

const secret = 'x'.repeat(40);
const at = '2026-11-24T06:00:00.000Z';
const digest = (purpose, value) => createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');
const pending = () => ({ id: 'sub-1', email: 'reader@example.test', status: 'pending', tags: '["kept"]', confirm_sent_at: at, confirm_digest: digest('confirm', 'sub-1:token') });

function fixture(initial = null, options = {}) {
  let row = initial ? structuredClone(initial) : null;
  const sent = [], writes = [];
  const db = async (sql, params = []) => {
    if (sql.includes('count(*)')) return [{ n: options.rate ?? 0 }];
    if (sql.startsWith('SELECT')) {
      const found = row && (sql.includes('WHERE email') ? row.email === params[0] : row.id === params[0]);
      const answer = found ? [structuredClone(row)] : [];
      options.afterRead?.(row, sql);
      return answer;
    }
    writes.push({ sql, params });
    if (sql.startsWith('INSERT INTO subscribers')) {
      if (options.insertConflict) return [];
      row = { id: params[0], email: params[1], status: 'pending', confirm_digest: params[2], confirm_sent_at: params[3], source_path: params[4], network_digest: params[5], tags: params[6], consent_text: params[7], consent_at: params[8], consent_page: params[9], consent_ip_digest: params[10] };
      return [{ id: row.id }];
    }
    if (sql.startsWith("UPDATE subscribers SET status = 'pending'")) {
      assert.match(sql, /status IN \('pending', 'unsubscribed'\)/);
      if (!row || !['pending', 'unsubscribed'].includes(row.status)) return [];
      Object.assign(row, { status: 'pending', confirm_digest: params[0], confirm_sent_at: params[1], source_path: params[2], network_digest: params[3], consent_text: params[4], consent_at: params[5], consent_page: params[6], consent_ip_digest: params[7], tags: params[8], confirmed_at: null, ended_at: null, ended_reason: null });
      return [{ id: row.id }];
    }
    if (sql.startsWith("UPDATE subscribers SET status = 'confirmed'")) {
      assert.match(sql, /status = 'pending' AND confirm_digest = \$3/);
      if (!row || row.status !== 'pending' || row.confirm_digest !== params[2]) return [];
      Object.assign(row, { status: 'confirmed', confirmed_at: params[0], confirm_digest: null });
      return [{ id: row.id }];
    }
    if (sql.startsWith("UPDATE subscribers SET status = 'unsubscribed'")) {
      assert.match(sql, /status IN \('confirmed', 'pending'\)/);
      if (row && ['confirmed', 'pending'].includes(row.status)) Object.assign(row, { status: 'unsubscribed', ended_at: params[0], ended_reason: params[1] });
      return [];
    }
    if (sql.startsWith('UPDATE subscribers SET tags')) {
      assert.match(sql, /AND status = 'confirmed'/);
      if (row?.status === 'confirmed') row.tags = params[0];
      return [];
    }
    if (sql.startsWith('UPDATE subscribers SET confirm_sent_at')) {
      assert.match(sql, /AND status = 'pending' AND confirm_digest = \$2/);
      if (row?.status === 'pending' && row.confirm_digest === params[1]) row.confirm_sent_at = null;
      return [];
    }
    throw new Error(`Unexpected query ${sql}`);
  };
  const handler = createSite({
    db, mail: async (message) => { if (options.mailFailure) throw Object.assign(new Error('not sent'), { code: 503 }); sent.push(message); },
    origin: 'https://example.test', brand: 'Example', secret, now: () => at,
    signupTags: ['updates'], sourceTags: { '/guide': ['guide', 'updates'], '/other': ['other'] },
    signupText: { label: 'Email', consent: 'Send me new articles.', button: 'Sign up', confirm: { subject: 'Confirm', body: 'Confirm your address.', button: 'Confirm' } },
  });
  return { handler, sent, writes, row: () => row };
}
const subscribe = (f, source = '/guide', more = {}) => f.handler.handle(new Request('https://example.test/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.test', source, ...more }) }));
const confirm = (f, token = 'token') => f.handler.handle(new Request(`https://example.test/subscribe/confirm?s=sub-1&t=${token}`));
const unsubscribe = (f, method = 'GET', token = digest('unsubscribe', 'sub-1')) => f.handler.handle(new Request(`https://example.test/unsubscribe?s=sub-1&t=${token}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' } : {}) }));

test('signup stores only server-declared tags and the consent provenance, then sends a confirmation', async () => {
  const f = fixture();
  assert.equal((await subscribe(f, '/guide?utm_source=post', { tags: ['paid', 'not-owner-data'] })).status, 200);
  assert.deepEqual(JSON.parse(f.row().tags), ['guide', 'updates']);
  assert.equal(f.row().status, 'pending');
  assert.equal(f.row().consent_text, 'Send me new articles.');
  assert.equal(f.row().consent_at, at);
  assert.equal(f.row().consent_page, '/guide?utm_source=post');
  assert.equal(f.sent.length, 1);
  assert.ok(f.row().confirm_digest);
  assert.equal(JSON.stringify(f.row()).includes(f.sent[0].text.match(/t=([^\s]+)/)[1]), false, 'the random confirmation token is not stored');
});

test('a confirmed signup gains the new declared tags without another confirmation send', async () => {
  const f = fixture({ ...pending(), status: 'confirmed' });
  assert.equal((await subscribe(f)).status, 200);
  assert.deepEqual(JSON.parse(f.row().tags), ['guide', 'kept', 'updates']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.row().status, 'confirmed');
});

test('a deliberate re-opt-in remains pending until it is confirmed, keeping previous tags', async () => {
  const f = fixture({ ...pending(), status: 'unsubscribed', ended_at: at, ended_reason: 'link' });
  await subscribe(f, '/other');
  assert.equal(f.row().status, 'pending');
  assert.equal(f.row().ended_at, null);
  assert.deepEqual(JSON.parse(f.row().tags), ['kept', 'other', 'updates']);
  assert.equal(f.sent.length, 1);
});

test('suppressed, bounced, complained, dormant and unknown states cannot be reactivated by a signup', async () => {
  for (const status of ['suppressed', 'bounced', 'complained', 'dormant', 'unseen']) {
    const f = fixture({ ...pending(), status });
    assert.equal((await subscribe(f)).status, 200);
    assert.equal(f.row().status, status);
    assert.equal(f.sent.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('a concurrent insertion does not send to the losing signup', async () => {
  const f = fixture(null, { insertConflict: true });
  assert.equal((await subscribe(f)).status, 200);
  assert.equal(f.sent.length, 0);
  assert.match(f.writes[0].sql, /ON CONFLICT \(email\) DO NOTHING RETURNING id/);
});

test('a suppression between reading and renewing a pending signup wins', async () => {
  const f = fixture(pending(), { afterRead: (row) => { if (row) row.status = 'suppressed'; } });
  await subscribe(f);
  assert.equal(f.row().status, 'suppressed');
  assert.equal(f.sent.length, 0);
});

test('confirmation succeeds with the current token and never overwrites a concurrent suppression', async () => {
  const f = fixture(pending());
  assert.equal((await confirm(f)).status, 200);
  assert.equal(f.row().status, 'confirmed');
  assert.equal(f.row().confirm_digest, null);
  const race = fixture(pending(), { afterRead: (row) => { row.status = 'suppressed'; } });
  assert.equal((await confirm(race)).status, 400);
  assert.equal(race.row().status, 'suppressed');
});

test('bad, expired and future-dated confirmation tokens cannot confirm a subscriber', async () => {
  assert.equal((await confirm(fixture(pending()), 'wrong')).status, 400);
  for (const sentAt of ['2026-11-01T00:00:00.000Z', '2026-11-25T00:00:00.000Z', 'not-a-time']) {
    const f = fixture({ ...pending(), confirm_sent_at: sentAt });
    assert.equal((await confirm(f)).status, 400);
    assert.equal(f.row().status, 'pending');
  }
});

test('plain-link unsubscribe, replay and bad token have distinct safe effects', async () => {
  const f = fixture({ ...pending(), status: 'confirmed' });
  assert.equal((await unsubscribe(f)).status, 200);
  assert.equal(f.row().status, 'unsubscribed');
  assert.equal(f.row().ended_reason, 'link');
  const writes = f.writes.length;
  assert.equal((await unsubscribe(f)).status, 200);
  assert.equal(f.writes.length, writes);
  assert.equal((await unsubscribe(f, 'GET', 'bad')).status, 400);
  assert.equal(f.writes.length, writes);
});

test('one-click unsubscribe answers 200 without a body; replay does not change its first end time', async () => {
  const f = fixture({ ...pending(), status: 'confirmed' });
  const answer = await unsubscribe(f, 'POST');
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), '');
  assert.equal(f.row().ended_reason, 'one-click');
  const writes = f.writes.length, ended = f.row().ended_at;
  assert.equal((await unsubscribe(f, 'POST')).status, 200);
  assert.equal(f.writes.length, writes);
  assert.equal(f.row().ended_at, ended);
});

test('an unsubscribe cannot lower a suppression read or written during the request', async () => {
  for (const race of [false, true]) {
    const f = fixture({ ...pending(), status: race ? 'confirmed' : 'suppressed' }, { afterRead: (row) => { if (row) row.status = 'suppressed'; } });
    assert.equal((await unsubscribe(f, 'POST')).status, 200);
    assert.equal(f.row().status, 'suppressed');
  }
});

test('a protocol-relative or backslash source cannot create a return link outside the site', async () => {
  for (const source of ['//other.test', '/\\other.test']) {
    const f = fixture();
    await subscribe(f, source);
    assert.equal(f.row().source_path, '/');
    assert.deepEqual(JSON.parse(f.row().tags), ['updates']);
  }
});
