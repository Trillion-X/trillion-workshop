// The referral tools run as their rows run them, against the stand-in records door with exactly each row's rights. The
// rules are rows in a made-up bakery's own list; every name, amount and person here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf as run, rowOf, runRow } from '../../../test-helpers/run-a-row.mjs';
import records from '../records.json' with { type: 'json' };
import { readCheckoutCodeAdjustments, findCheckoutCodeAdjustment } from '../../take-payments/read-data/read-code-adjustments.ts';
import { heldAccess } from '../../paid-access/read-data/who-holds-access.mjs';
import { readRewardRules, rewardsForSale } from '../read-data/referral-reward-rules.mjs';
import list from '../read-data/referral-reward-list.json' with { type: 'json' };

const rows = { records: records.things };
const make = rowOf(rows, 'tool:make-a-referral-code');
const workOut = rowOf(rows, 'tool:work-out-referral-codes');
const give = rowOf(rows, 'tool:give-referral-rewards');
const withdraw = rowOf(rows, 'tool:withdraw-a-referral-code');

// A run's answer with its fields at the top: the function's result, any error, the records kept afterwards, the door's calls.
const answerOf = async (row, input, sample) => {
  const { result, ...ran } = await run(row, input, sample);
  return { ...result, ...ran };
};

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
const rule = (id, value) => ({ id: `referral-reward-rule:${id}`, type: 'record:referral-reward-rule', value: { state: 'active', code_points_at: 'product_id', ...value } });
const share = bp => rule('share', { label: 'A share of a loaf sale', earner: 'referrer', reward: 'share', amount_field: 'amount_cents', basis_points: bp });
const friendOff = rule('friend-off', { label: 'Five off for the friend', earner: 'friend', reward: 'discount', amount_cents: 500, currency: 'USD', duration: 'once', offer_ids: ['offer:loaf'] });
const referrerOff = rule('referrer-off', { label: 'Ten off the referrer next time', earner: 'referrer', reward: 'discount', percent: 10, max_redemptions: 1, offer_ids: ['offer:loaf'] });
const referrerAccess = rule('referrer-club', { label: 'A week in the club', earner: 'referrer', reward: 'access', access_ref: 'access:club', access_days: 7 });
const friendAccess = rule('friend-club', { label: 'The club for the friend', earner: 'friend', reward: 'access', access_ref: 'access:club', friend_field: 'buyer' });

const created = { kind: 'referral_code_created', subject: 'ada@example.com', material: { event_type: 'referral_code_created', referral_code: 'LOAF-1234', target: { on: 'product_id', value: 'loaf' }, occurred_at: '2026-01-01T00:00:00Z' } };
const sale = { id: 'sale-1', product_id: 'loaf', offer_id: 'offer:loaf', amount_cents: 2000, buyer: 'bo@example.com', occurred_at_ms: NOW };
const ofType = (kept, type) => kept.filter(item => item.type === type);

test('what a sale earns is read from the business\'s rows: change a row and the answer changes', async () => {
  const input = { events: [created], codes: ['loaf-1234'], sales: [sale] };
  const ten = await answerOf(workOut, input, { records: [share(1000)] });
  assert.equal(ten.status, 0, ten.error);
  assert.deepEqual(ten.checked[0].rewards.map(item => [item.reward, item.earner, item.subject, item.cents]), [['share', 'referrer', 'ada@example.com', 200]]);
  const twenty = await answerOf(workOut, input, { records: [share(2500)] });
  assert.equal(twenty.checked[0].rewards[0].cents, 500);
  const none = await answerOf(workOut, input, { records: [] });
  assert.deepEqual([none.checked[0].earns, none.checked[0].rewards, none.rules_used], [true, [], []]);
  assert.deepEqual(ten.kept.filter(item => item.type !== 'record:referral-reward-rule'), [], 'working out writes nothing');
});

test('a code points only at what an active rule names, and with no active rule it says to add one', async () => {
  const input = { referrer: 'ada@example.com', target: { on: 'product_id', value: 'loaf' }, prefix: 'loaf' };
  const made = await answerOf(make, input, { records: [share(1000)] });
  assert.equal(made.status, 0, made.error);
  assert.match(made.code, /^LOAF-[0-9A-HJKMNP-TV-Z]{6}$/);
  const elsewhere = await answerOf(make, { ...input, target: { on: 'email', value: 'x' } }, { records: [share(1000)] });
  assert.match(elsewhere.error, /product_id, not email/);
  const off = await answerOf(make, input, { records: [rule('old', { ...share(1000).value, state: 'inactive' })] });
  assert.match(off.error, /no active referral reward rule/);
  assert.match((await answerOf(make, input, { records: [] })).error, /no active referral reward rule/);
});

test('a friend\'s discount is the referral code itself as a checkout code take-payments reads, written once', async () => {
  const input = { events: [created], codes: ['LOAF-1234'] };
  const first = await answerOf(give, input, { records: [friendOff] });
  assert.equal(first.status, 0, first.error);
  assert.deepEqual(first.given.adjustments, { written: 1, already: 0, refused: [] });
  const adjustments = readCheckoutCodeAdjustments(ofType(first.kept, 'checkout-code-adjustment').map(item => item.value));
  const found = findCheckoutCodeAdjustment(adjustments, 'loaf-1234');
  assert.deepEqual([found.adjustment, found.duration, found.scope.offer_ids, found.state], [{ kind: 'amount_cents', amount_cents: 500, currency: 'usd' }, 'once', ['offer:loaf'], 'active']);
  const second = await answerOf(give, input, { records: first.kept });
  assert.deepEqual(second.given.adjustments, { written: 0, already: 1, refused: [] });
  assert.ok(!second.calls.some(call => call.method === 'records:write'), 'the second run writes nothing');
});

test('a referrer\'s discount is a checkout code of its own for that sale, the same on every run, and a rule changed later does not rewrite it', async () => {
  const input = { events: [created], codes: ['LOAF-1234'], sales: [sale] };
  const first = await answerOf(give, input, { records: [referrerOff] });
  assert.equal(first.status, 0, first.error);
  const reward = first.checked[0].rewards[0];
  assert.match(reward.adjustment.value.code, /^RWD-[0-9A-F]{8}$/);
  const [read] = readCheckoutCodeAdjustments(ofType(first.kept, 'checkout-code-adjustment').map(item => item.value));
  assert.deepEqual([read.code, read.adjustment, read.max_redemptions], [reward.adjustment.value.code, { kind: 'percent', percent: 10 }, 1]);
  const again = await answerOf(give, input, { records: first.kept });
  assert.deepEqual(again.given.adjustments, { written: 0, already: 1, refused: [] });
  assert.equal(again.checked[0].rewards[0].adjustment.value.code, reward.adjustment.value.code);
  const changed = await answerOf(give, input, { records: [...first.kept.filter(item => item.type !== 'record:referral-reward-rule'), { ...referrerOff, value: { ...referrerOff.value, percent: 50 } }] });
  assert.equal(changed.given.adjustments.written, 0);
  assert.match(changed.given.adjustments.refused[0].reason, /different terms/);
});

test('access goes to the referrer or the friend the sale names, with the window the rule says, and the access rules hold it', async () => {
  const input = { events: [created], codes: ['LOAF-1234'], sales: [sale] };
  const done = await answerOf(give, input, { records: [referrerAccess, friendAccess] });
  assert.equal(done.status, 0, done.error);
  assert.deepEqual(done.given.access, { written: 2, already: 0, refused: [] });
  const grants = ofType(done.kept, 'access-grant').map(item => item.value);
  const heldAt = (subject, at) => heldAccess({ subject, nowMs: at, grants }).held_access_refs;
  assert.deepEqual([heldAt('ada@example.com', NOW + DAY), heldAt('ada@example.com', NOW + 8 * DAY), heldAt('bo@example.com', NOW + 400 * DAY)], [['access:club'], [], ['access:club']]);
  const again = await answerOf(give, input, { records: done.kept });
  assert.deepEqual(again.given.access, { written: 0, already: 2, refused: [] });
});

test('a reward that cannot be given safely is refused in the answer with why, and the others still go', async () => {
  const bare = { ...sale, id: undefined, buyer: undefined, occurred_at_ms: undefined };
  const answer = await answerOf(give, { events: [created], codes: ['LOAF-1234'], sales: [bare] }, { records: [share(1000), referrerOff, referrerAccess, friendAccess] });
  assert.equal(answer.status, 0, answer.error);
  const byRule = Object.fromEntries(answer.checked[0].rewards.map(item => [item.rule.replace('referral-reward-rule:', ''), item]));
  assert.equal(byRule.share.cents, 200);
  assert.match(byRule['referrer-off'].refused, /needs an id/);
  assert.match(byRule['referrer-club'].refused, /needs an id/);
  assert.deepEqual(answer.given.adjustments.written + answer.given.access.written, 0);
  const noDay = await answerOf(give, { events: [created], codes: ['LOAF-1234'], sales: [{ ...sale, occurred_at_ms: undefined }] }, { records: [referrerAccess] });
  assert.match(noDay.checked[0].rewards[0].refused, /occurred_at_ms/);
});

test('a malformed active rule is skipped and reported with every problem; the good rules still work', async () => {
  const bad = rule('bad', { label: 'x', earner: 'friend', reward: 'share', basis_points: 20000, weight: 0 });
  const answer = await answerOf(workOut, { events: [created], codes: ['LOAF-1234'], sales: [sale] }, { records: [share(1000), bad] });
  assert.equal(answer.checked[0].rewards.length, 1);
  assert.deepEqual(answer.rules_used, ['referral-reward-rule:share']);
  const [refused] = answer.rules_refused;
  assert.equal(refused.id, 'referral-reward-rule:bad');
  for (const part of ['a share goes to the referrer', 'amount_field', 'basis_points', 'weight']) assert.match(refused.problems.join('; '), new RegExp(part));
});

test('inputs that are wrong are refused with every problem listed', async () => {
  const refused = await answerOf(workOut, { events: [], codes: 'x', sales: [1], account: 5 }, { records: [] });
  for (const part of ['codes must be', 'sales must be', 'account must be']) assert.match(refused.error, new RegExp(part));
  assert.match((await answerOf(workOut, { codes: [] }, { records: [] })).error, /events must be a list/);
  const stopped = await runRow(withdraw, { referrer: 'ada@example.com', code: 'x' });
  assert.match(stopped.stderr, /4 to 32/);
});

test('rules in one test group are arms: each referrer lands on one arm, always the same, and the weights decide how many', () => {
  const arm = (id, cents, weight) => ({ id, value: { state: 'active', label: id, earner: 'referrer', reward: 'discount', code_points_at: 'product_id', amount_cents: cents, currency: 'usd', arm_group: 'credit-test', weight } });
  const { rules, refused } = readRewardRules([arm('low', 1000, 1), arm('high', 3000, 3)]);
  assert.deepEqual(refused, []);
  const landed = referrer => rewardsForSale({ code: 'CODE-0001', referrer, target: { on: 'product_id', value: 'loaf' } }, { id: 's' }, rules).map(item => item.rule);
  const counts = { low: 0, high: 0 };
  for (let person = 0; person < 400; person += 1) {
    const arms = landed(`person-${person}@example.com`);
    assert.equal(arms.length, 1);
    assert.deepEqual(landed(`person-${person}@example.com`), arms);
    counts[arms[0]] += 1;
  }
  assert.ok(counts.low > 60 && counts.low < 140 && counts.high > 260, `about one in four land on the lighter arm: ${JSON.stringify(counts)}`);
});

test('the rows can only read the rule rows and write the records the existing tools read, and move no money', () => {
  for (const row of [make, workOut, give]) {
    assert.equal(row.invoke.internet, false, `${row.id} reaches no network`);
    assert.equal(row.invoke.credential_mounts, undefined, `${row.id} holds no key`);
  }
  const rightsOf = row => Object.fromEntries(row.invoke.records.rights.map(item => [item.kind, item.operations]));
  assert.deepEqual(rightsOf(make), { 'record:referral-reward-rule': ['records:list'] });
  assert.deepEqual(rightsOf(workOut), { 'record:referral-reward-rule': ['records:list'] });
  assert.deepEqual(rightsOf(give), { 'record:referral-reward-rule': ['records:list'], 'checkout-code-adjustment': ['records:read', 'records:write'], 'access-grant': ['records:read', 'records:write'] });
});

test('the list definition gives every column a rule row can hold, with its row type the tools read', () => {
  assert.equal(list.list.value.row_type, 'referral-reward-rule');
  const ids = list.list.value.fields.map(field => field.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['state', 'earner', 'reward', 'code_points_at', 'offer_ids', 'basis_points', 'amount_cents', 'percent', 'access_ref', 'access_days']) assert.ok(ids.includes(id), id);
});
