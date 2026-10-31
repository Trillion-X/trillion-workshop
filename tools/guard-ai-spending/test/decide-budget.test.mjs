import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { describe, it } from 'node:test';
const script = fileURLToPath(new URL('../do-work/decide-budget.mjs', import.meta.url));

function decide(request, state = { status: 'pending_setup', enabled: false, daily_limit: 0, threshold: 0, spent_today: 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'agent-wallet-budget-'));
  const output = join(root, 'decision.json');
  try {
    execFileSync(process.execPath, [
      script,
      output,
      JSON.stringify(state.status),
      JSON.stringify(state.enabled),
      JSON.stringify(state.daily_limit),
      JSON.stringify(state.threshold),
      JSON.stringify(state.spent_today),
      JSON.stringify(request),
      '2026-08-18T00:00:00.000Z',
      '{}',
    ]);
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('agent-wallet budget reducer', () => {
  it('records and fences zero-cost work without consuming payment-wallet authority', () => {
    const result = decide({ operation_ref: 'operation:local-proof', estimated_cost: 0, idempotency_key: 'idem:local-proof' });

    deepStrictEqual({
      approved: true,
      reason: 'zero_cost',
      budget_check: { result: 'approved', estimated_cost: 0 },
      budget_reservation: { status: 'current', amount: 0 },
    }, {
      approved: result.approved,
      reason: result.reason,
      budget_check: { result: result.budget_check.result, estimated_cost: result.budget_check.estimated_cost },
      budget_reservation: { status: result.budget_reservation.status, amount: result.budget_reservation.amount },
    });
  });

  it('still fails closed for paid work and malformed amounts when the wallet is disabled', () => {
    strictEqual(decide({ operation_ref: 'operation:paid', estimated_cost: 1 }).reason, 'wallet_disabled');
    strictEqual(decide({ operation_ref: 'operation:missing-cost' }).reason, 'invalid_amount');
  });

  it('treats a never-named quintillion rail as DATA while emitting the required reservation', () => {
    const result = decide(
      {
        operation_ref: 'operation:quintillion-proof',
        estimated_cost: 7,
        spend_authority_ref: 'service_connection:quintillion-bank',
        rail_ref: 'payment-rail:quintillion',
        spender_id: 'autonomous-worker:17',
        idempotency_key: 'idem:quintillion-proof',
      },
      { status: 'active', enabled: true, daily_limit: 100, threshold: 10, spent_today: 0 },
    );

    deepStrictEqual({
      approved: true,
      reason: 'ok',
      budget_check: {
        kind: 'spend_budget_check',
        spend_authority_ref: 'service_connection:quintillion-bank',
        rail_ref: 'payment-rail:quintillion',
        spender_id: 'autonomous-worker:17',
      },
      budget_reservation: { kind: 'spend_budget_reservation', status: 'current', amount: 7 },
    }, {
      approved: result.approved,
      reason: result.reason,
      budget_check: {
        kind: result.budget_check.kind,
        spend_authority_ref: result.budget_check.spend_authority_ref,
        rail_ref: result.budget_check.rail_ref,
        spender_id: result.budget_check.spender_id,
      },
      budget_reservation: {
        kind: result.budget_reservation.kind,
        status: result.budget_reservation.status,
        amount: result.budget_reservation.amount,
      },
    });
  });

  it('denies spending above the per-transaction limit without creating an approval wait', () => {
    const result = decide(
      { operation_ref: 'operation:over-limit', estimated_cost: 11 },
      { status: 'active', enabled: true, daily_limit: 100, threshold: 10, spent_today: 0 },
    );
    strictEqual(result.approved, false);
    strictEqual(result.reason, 'over_per_transaction_limit');
    strictEqual(result.budget_reservation.status, 'denied');
  });
});
