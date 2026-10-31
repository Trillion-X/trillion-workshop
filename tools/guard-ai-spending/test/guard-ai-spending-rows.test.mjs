// The rows run as the container runs them, against the fake records door with exactly each row's rights. Every
// record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const reserve = rowOf(rows, 'tool:reserve-a-spend-within-budget');
const goAhead = rowOf(rows, 'tool:may-this-spend-go-ahead');
const record = rowOf(rows, 'tool:record-a-spend');
const reset = rowOf(rows, 'tool:reset-daily-spend');
const railsRow = rowOf(rows, 'tool:read-spend-rails');

const AUTHORITY = 'spend-authority:research';
const authority = (value = {}) => ({
  id: AUTHORITY,
  type: 'spend-authority',
  value: { status: 'active', enabled: true, daily_limit: 1000, per_transaction_limit: 300, total_spent_today: 0, total_spent_all_time: 0, ...value },
});
const kept = (answer, id) => answer.kept.find(item => item.id === id);

test('no spend authority refuses every positive spend, and the refusal is kept', async () => {
  const answer = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', estimated_cost: 1 });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual([answer.result.approved, answer.result.reason], [false, 'wallet_disabled']);
  assert.equal(kept(answer, 'spend-budget-reservation:operation:buy-a-report').value.status, 'denied');
  assert.equal(kept(answer, 'spend-budget-check:operation:buy-a-report').value.result, 'denied');
});

test('a spend inside the limits is reserved, may go ahead, and a caller cannot choose the time', async () => {
  const reserved = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', estimated_cost: 250, idempotency_key: 'idem:one' }, { records: [authority()] });
  assert.equal(reserved.status, 0, reserved.error);
  assert.deepEqual([reserved.result.approved, reserved.result.reason, reserved.result.budget_reservation.amount], [true, 'ok', 250]);
  const sneaky = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', estimated_cost: 250, now_iso: '2001-01-01T00:00:00.000Z' }, { records: [authority()] });
  assert.equal(sneaky.status, 0, sneaky.error);
  assert.notEqual(sneaky.result.budget_check.checked_at.slice(0, 4), '2001');
  const ahead = await runRow(goAhead, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', idempotency_key: 'idem:one' }, { records: reserved.kept });
  assert.deepEqual([ahead.result.available, ahead.result.amount], [true, 250]);
  assert.match(ahead.result.fencing_token, /idem:one/);
  const other = await runRow(goAhead, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', idempotency_key: 'idem:other' }, { records: reserved.kept });
  assert.equal(other.result.available, false);
});

test('over the per-spend limit or the day\'s limit is refused', async () => {
  const big = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:big', estimated_cost: 301 }, { records: [authority()] });
  assert.equal(big.status, 0, big.error);
  assert.equal(big.result.reason, 'over_per_transaction_limit');
  const late = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:late', estimated_cost: 200 }, { records: [authority({ total_spent_today: 900 })] });
  assert.equal(late.status, 0, late.error);
  assert.equal(late.result.reason, 'over_daily_limit');
  const off = await runRow(reserve, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:off', estimated_cost: 5 }, { records: [authority({ status: 'paused' })] });
  assert.equal(off.status, 0, off.error);
  assert.equal(off.result.reason, 'wallet_not_active');
});

test('a paid spend is added to the totals once, however often it is sent', async () => {
  const first = await runRow(record, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', amount: 250, payment_ref: 'payment:test-1' }, { records: [authority({ total_spent_today: 100, total_spent_all_time: 4000 })] });
  assert.equal(first.status, 0, first.error);
  assert.deepEqual([first.result.already_recorded, first.result.total_spent_today, first.result.total_spent_all_time], [false, 350, 4250]);
  assert.equal(kept(first, AUTHORITY).value.total_spent_today, 350);
  assert.equal(kept(first, 'payment:test-1').value.kind, 'spend_payment_processed');
  const again = await runRow(record, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', amount: 250, payment_ref: 'payment:test-1' }, { records: first.kept });
  assert.deepEqual([again.result.already_recorded, again.result.total_spent_today], [true, 350]);
  assert.equal(kept(again, AUTHORITY).value.total_spent_today, 350);
  const none = await runRow(record, { spend_authority_ref: AUTHORITY, operation_ref: 'operation:buy-a-report', amount: 1 });
  assert.equal(none.status, 1);
  assert.match(none.error, /not one of the person's spend authorities/);
});

test('today\'s total resets once on a new UTC day and not again that day', async () => {
  const first = await runRow(reset, { spend_authority_ref: AUTHORITY }, { records: [authority({ total_spent_today: 700, last_reset_day: '2001-01-01' })] });
  assert.equal(first.status, 0, first.error);
  assert.deepEqual([first.result.reset, first.result.total_spent_today], [true, 0]);
  assert.equal(kept(first, AUTHORITY).value.last_reset_day, first.result.day);
  const spent = { ...kept(first, AUTHORITY), value: { ...kept(first, AUTHORITY).value, total_spent_today: 40 } };
  const second = await runRow(reset, { spend_authority_ref: AUTHORITY }, { records: [spent] });
  assert.deepEqual([second.result.reset, second.result.total_spent_today], [false, 40]);
});

test('the shipped x402 rail is listed disabled; a person\'s rail that pays around the guard is refused', async () => {
  const shipped = await runRow(railsRow, {});
  assert.equal(shipped.status, 0, shipped.error);
  assert.deepEqual(shipped.result.rails.map(rail => [rail.id, rail.enabled]), [['payment-rail:x402', false]]);
  const around = {
    id: 'payment-rail:test-bank', type: 'payment-rail',
    value: { kind: 'payment-rail-descriptor', id: 'payment-rail:test-bank', label: 'Test bank', enabled: true, spend_authority_ref: AUTHORITY, credential_ref: 'credential:test-bank', guard_invoke: { tool: 'tool:pay-directly' }, ledger_invoke: { tool: 'tool:record-a-spend' }, settlement_invoke: { tool: 'tool:settle-a-test-bank-payment' }, evidence_contract: { session_intent_kind: 'operation-session-intent-record', evidence_ref: 'operation-evidence:test', projection_ref: 'operation-projection:test' } },
  };
  const answer = await runRow(railsRow, {}, { records: [around] });
  assert.deepEqual(answer.result.refused.map(row => row.id), ['payment-rail:test-bank']);
});

test('no row may set a limit or turn a budget on, and none reaches the internet', () => {
  for (const row of rows.records.map(item => item.payload)) {
    assert.equal(row.invoke.internet, false, row.id);
    for (const right of row.invoke.records.rights) {
      if (right.kind === 'spend-authority' && right.operations.includes('records:write')) assert.ok(['tool:record-a-spend', 'tool:reset-daily-spend'].includes(row.id), row.id);
    }
  }
});
