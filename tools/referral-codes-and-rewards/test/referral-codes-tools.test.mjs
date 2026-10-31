// tools/referral-codes-and-rewards/test/referral-codes-tools.test.mjs
// Each tool runs the way its row runs it: its argv, in the folder its workdir stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'records.json'), 'utf8')).things.map(thing => thing.payload);

function runByRow(toolId, input) {
  const row = rows.find(item => item.id === toolId);
  assert.ok(row, `${toolId} is a row in records.json`);
  assert.equal(row.invoke.workdir, row.invoke.files.package_files.at);
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: folder, encoding: 'utf8' });
  if (ran.status !== 0) return { refused: ran.stderr.trim() };
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

const pick = (answer, selector) => selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);

test('every row\'s sample run gives what its verify says', () => {
  for (const row of rows) {
    for (const check of row.verify.filter(item => item.kind === 'sample-run')) {
      assert.ok(JSON.stringify(pick(runByRow(row.id, check.input), check.output_selector)).includes(check.contains), `${row.id}: ${check.output_selector} contains ${check.contains}`);
    }
  }
});

test('make a code, save its event, then work out what it earns; withdraw it and it earns nothing', () => {
  const made = runByRow('tool:make-a-referral-code', { referrer: 'account:ada', target: { on: 'product_id', value: 'loaf' }, allowed_on: ['product_id'], prefix: 'loaf', occurred_at: '2026-01-01T00:00:00Z' });
  assert.match(made.code, /^LOAF-[0-9A-HJKMNP-TV-Z]{6}$/);
  const sales = [{ product_id: 'loaf', amount_cents: 1500 }, { product_id: 'bun', amount_cents: 300 }];
  const share = { amount_field: 'amount_cents', basis_points: 2000 };
  const live = runByRow('tool:work-out-referral-codes', { events: [made.event], codes: [made.code.toLowerCase()], sales, share });
  assert.deepEqual(live.checked.map(item => [item.earns, item.earned]), [[true, 300], [false, undefined]]);
  const withdrawn = runByRow('tool:withdraw-a-referral-code', { referrer: 'account:ada', code: made.code, occurred_at: '2026-01-02T00:00:00Z' });
  const stopped = runByRow('tool:work-out-referral-codes', { events: [made.event, withdrawn.event], codes: [made.code], sales, share });
  assert.deepEqual(stopped.checked.map(item => item.earns), [false, false]);
  assert.equal(stopped.codes[0].live, false);
});

test('a code that points at something not allowed, and bad inputs, are refused with every problem listed', () => {
  assert.match(runByRow('tool:make-a-referral-code', { referrer: 'account:ada', target: { on: 'email', value: 'x' }, allowed_on: ['product_id'] }).refused, /product_id, not email/);
  assert.match(runByRow('tool:withdraw-a-referral-code', { referrer: 'account:ada', code: 'x' }).refused, /4 to 32/);
  const refused = runByRow('tool:work-out-referral-codes', { events: [], codes: 'x', sales: [1], share: { amount_field: 'a', basis_points: 20000 }, account: 5 });
  for (const part of ['codes must be', 'sales must be', 'share must be', 'account must be']) assert.match(refused.refused, new RegExp(part));
  assert.match(runByRow('tool:work-out-referral-codes', { codes: [] }).refused, /events must be a list/);
});

test('an account\'s state is counted when asked for', () => {
  const answer = runByRow('tool:work-out-referral-codes', {
    account: 'account:ada',
    events: [{ material: { event_type: 'referral_signup', occurred_at: '2026-02-01T00:00:00Z', referrer_account_id: 'account:ada' } }],
  });
  assert.deepEqual(answer.state, { referral_code: null, accepted_referral_count: 1 });
});

test('a code typed with no sales list is checked against nothing and says so', () => {
  const made = runByRow('tool:make-a-referral-code', { referrer: 'account:ada', target: { on: 'product_id', value: 'loaf' }, allowed_on: ['product_id'], code: 'LOAF-1234' });
  const answer = runByRow('tool:work-out-referral-codes', { events: [made.event], codes: ['LOAF-1234', 'NOPE-9999'] });
  assert.deepEqual(answer.checked.map(item => [item.typed, item.sale_index, item.code?.referrer ?? null, item.earns]), [['LOAF-1234', null, 'account:ada', false], ['NOPE-9999', null, null, false]]);
});
