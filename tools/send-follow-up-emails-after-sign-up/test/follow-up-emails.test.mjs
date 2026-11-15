import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/follow-up-emails.json' with { type: 'json' };
import { makeFollowUps, followUpFacts, offerWords } from '../do-work/follow-up-emails.mjs';
const DAY = 86400000, T0 = Date.parse('2026-10-01T12:00:00Z');
function harness({ email = 'ruth@example.test', access = { active_offers: [] } } = {}) {
  let held = null, clock = T0;
  const sent = [], offers = { records: [{ id: 'offer:paid', label: 'Full', price_options: [{ amount_cents: 15000, currency: 'usd', interval: 'month', trial_days: 7 }] }] };
  const door = {
    async read() { return structuredClone(held); },
    async write([row]) {
      assert.equal(row.id, 'follow-up:own');
      if (JSON.stringify(row.expected?.value ?? null) !== JSON.stringify(held)) throw Object.assign(new Error('conflict'), { code: 'original_command_conflict' });
      held = structuredClone(row.value);
    },
  };
  const options = { facts: followUpFacts(door, { type: 'follow-up', id: 'follow-up:own' }), settings,
    person: { email: async () => email, name: async () => 'Ruth', access: async () => access, origin: 'https://app.example.test' },
    readOfferRecords: async () => offers, upgradeOfferId: async () => 'offer:paid', paidWorth: async () => 'Remember your work.', postalAddress: async () => '1 Example Street',
    now: () => clock, random: bytes => bytes.fill(7), send: async message => { assert.ok(held.sent.length, 'durable claim precedes delivery'); sent.push(message); return { sent: true }; } };
  return { follow: makeFollowUps(options), another: () => makeFollowUps(options), make: extra => makeFollowUps({ ...options, ...extra }), sent, offers, at: day => { clock = T0 + day * DAY; }, held: () => held };
}
test('days 1, 3, 7 and 14 are sent once and finish; start is idempotent', async () => {
  const h = harness(); await h.follow.start('user');
  assert.equal((await h.follow.start('other')).user_id, 'user');
  assert.equal(await h.follow.nextDue(), T0 + DAY); assert.deepEqual(await h.follow.sendDue(), []);
  for (const day of [1, 3, 7, 14]) {
    h.at(day); assert.equal((await h.follow.sendDue())[0].step, `day-${day}`); assert.deepEqual(await h.follow.sendDue(), []);
  }
  assert.equal(h.sent.length, 4); assert.equal(h.held().ended_by, 'finished'); assert.equal(await h.follow.nextDue(), null);
});
test('current offer terms and required unsubscribe footer enter each message', async () => {
  const h = harness(); await h.follow.start('user'); h.at(1); h.offers.records[0].price_options[0].amount_cents = 22000;
  await h.follow.sendDue(); const [mail] = h.sent;
  assert.match(mail.markdown, /\$220\/month/); assert.match(mail.markdown, /^Hi Ruth,/);
  assert.equal(mail.action.href, 'https://app.example.test/buy/offer%3Apaid'); assert.ok(mail.footer_lines.includes('1 Example Street'));
  assert.match(mail.headers['List-Unsubscribe'], new RegExp('07'.repeat(16)));
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click'); assert.equal(/\{\w+\}/.test(JSON.stringify(mail)), false);
  assert.throws(() => offerWords('absent', { settings, offerRecords: h.offers }), /has no price/);
});
test('purchase, late wake and authenticated stop preserve stopping rules', async () => {
  const bought = harness({ access: { active_offers: ['offer:paid'] } }); await bought.follow.start('user'); bought.at(1);
  assert.deepEqual(await bought.follow.sendDue(), []); assert.equal(bought.held().ended_by, 'bought');
  const h = harness(); await h.follow.start('user'); h.at(8); assert.equal((await h.follow.sendDue())[0].step, 'day-7'); assert.equal(h.sent.length, 1);
  assert.deepEqual(await h.follow.stop('wrong'), { stopped: false }); assert.deepEqual(await h.follow.stop('07'.repeat(16)), { stopped: true });
  h.at(14); assert.deepEqual(await h.follow.sendDue(), []); assert.equal(h.held().ended_by, 'stop-link');
});
test('missing email skips the step forever', async () => {
  const h = harness({ email: null }); await h.follow.start('user'); h.at(1);
  assert.deepEqual(await h.follow.sendDue(), [{ step: 'day-1', sent: false, error: 'no email on the account' }]);
  assert.deepEqual(await h.follow.sendDue(), []); assert.equal(h.sent.length, 0);
});
test('competing door claims send at most once', async () => {
  const h = harness(); await h.follow.start('user'); h.at(1);
  const results = await Promise.allSettled([h.follow.sendDue(), h.another().sendDue()]);
  assert.equal(h.sent.length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('a send with an unknown outcome is never repeated', async () => {
  const h = harness(); await h.follow.start('user'); h.at(1);
  const interrupted = h.make({ send: async () => { throw new Error('provider disconnected'); } });
  await assert.rejects(interrupted.sendDue(), /provider disconnected/);
  assert.deepEqual(await h.another().sendDue(), []);
  assert.deepEqual(h.held().sent, ['day-1']); assert.equal(h.sent.length, 0);
});
