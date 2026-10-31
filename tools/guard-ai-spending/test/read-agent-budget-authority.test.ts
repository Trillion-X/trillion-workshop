import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  budgetDecisionForOperation,
  decodeAgentBudgetAuthority,
  decodeAgentBudgetChecks,
  decodeAgentBudgetReservations,
} from '../read-data/read-agent-budget-authority.ts';

const NOW = new Date('2026-05-29T12:00:00.000Z');

function record(address: string, payload: Record<string, unknown>) {
  return { type: 'record', address, payload, remove: false };
}

function check(overrides: Record<string, unknown> = {}) {
  return record('budget-check:fixture', {
    kind: 'agent_budget_check',
    check_ref: 'budget-check:approved',
    operation_ref: 'operation:work',
    wallet_ref: 'spend-authority:research',
    idempotency_key: 'idem:work',
    result: 'approved',
    estimated_cost: 42,
    currency: 'USD',
    spend_snapshot_ref: 'spend-snapshot:1',
    checked_at: '2026-05-29T11:00:00.000Z',
    expires_at: '2026-05-29T13:00:00.000Z',
    evidence_refs: ['wallet-evidence:1'],
    ...overrides,
  });
}

function reservation(overrides: Record<string, unknown> = {}) {
  return record('budget-reservation:fixture', {
    kind: 'agent_budget_reservation',
    reservation_ref: 'budget-reservation:current',
    operation_ref: 'operation:work',
    wallet_ref: 'spend-authority:research',
    idempotency_key: 'idem:work',
    spend_snapshot_ref: 'spend-snapshot:1',
    fencing_token: 'budget-fence:1',
    status: 'current',
    amount: 42,
    currency: 'USD',
    reserved_at: '2026-05-29T11:01:00.000Z',
    expires_at: '2026-05-29T13:00:00.000Z',
    evidence_refs: ['wallet-evidence:reservation'],
    ...overrides,
  });
}

function decision(records: unknown[]) {
  return budgetDecisionForOperation(
    decodeAgentBudgetAuthority(records),
    'operation:work',
    'idem:work',
    'spend-authority:research',
    NOW,
  );
}

describe('agent budget authority', () => {
  // Was: decodes the seed check and reservation from the old package manifest. The Workshop has no manifest; the
  // records are the person's own, in the spend_budget_* kinds decide-budget.mjs writes, so this decodes those.
  it('decodes the budget checks and reservations decide-budget writes', () => {
    const authority = decodeAgentBudgetAuthority([
      check({ kind: 'spend_budget_check', check_ref: 'spend-budget-check:operation:work' }),
      reservation({ kind: 'spend_budget_reservation', reservation_ref: 'spend-budget-reservation:operation:work' }),
    ]);

    expect(authority.checks.some((item) => item.checkRef === 'spend-budget-check:operation:work')).toBe(true);
    expect(authority.reservations.some((item) => item.reservationRef === 'spend-budget-reservation:operation:work')).toBe(true);
  });

  it('allows admitted and soft-limit checks only with exactly one current reservation token', () => {
    const approved = decision([check(), reservation()]);
    const soft = decision([check({ result: 'soft_limit' }), reservation()]);

    expect(approved.available).toBe(true);
    expect(approved.reason).toBe('budget admitted');
    expect(approved.reservation?.fencingToken).toBe('budget-fence:1');
    expect(soft.available).toBe(true);
    expect(soft.reason).toBe('budget soft limit acknowledged');
  });

  it('blocks hard deny, missing wallet, stale spending, and missing checks', () => {
    expect(decision([check({ result: 'hard_denied', denied_reason: 'daily limit exceeded' }), reservation()])).toMatchObject({
      available: false,
      reason: 'daily limit exceeded',
    });
    expect(decision([check({ result: 'missing_wallet' }), reservation()])).toMatchObject({
      available: false,
      reason: 'missing wallet',
    });
    expect(decision([check({ result: 'stale_spending' }), reservation()])).toMatchObject({
      available: false,
      reason: 'stale spending snapshot',
    });
    expect(decision([reservation()])).toMatchObject({
      available: false,
      reason: 'missing budget check',
    });
  });

  it('blocks stale, duplicate, and mismatched reservations for the same operation tuple', () => {
    expect(decision([check(), reservation({ expires_at: '2026-05-29T10:00:00.000Z' })])).toMatchObject({
      available: false,
      reason: 'missing current budget reservation',
    });
    expect(decision([
      check(),
      reservation({ reservation_ref: 'budget-reservation:one', fencing_token: 'budget-fence:1' }),
      reservation({ reservation_ref: 'budget-reservation:two', fencing_token: 'budget-fence:2' }),
    ])).toMatchObject({
      available: false,
      reason: 'duplicate current budget reservations',
    });
    expect(decision([check(), reservation({ spend_snapshot_ref: 'spend-snapshot:stale' })])).toMatchObject({
      available: false,
      reason: 'reservation spend snapshot mismatch',
    });
  });

  it('keeps simultaneous operations on the same wallet fenced by operation and idempotency key', () => {
    const authority = decodeAgentBudgetAuthority([
      check(),
      reservation(),
      check({
        check_ref: 'budget-check:other',
        operation_ref: 'operation:other',
        idempotency_key: 'idem:other',
      }),
      reservation({
        reservation_ref: 'budget-reservation:other',
        operation_ref: 'operation:other',
        idempotency_key: 'idem:other',
        fencing_token: 'budget-fence:other',
      }),
    ]);

    expect(budgetDecisionForOperation(authority, 'operation:work', 'idem:work', 'spend-authority:research', NOW).reservation?.fencingToken).toBe('budget-fence:1');
    expect(budgetDecisionForOperation(authority, 'operation:other', 'idem:other', 'spend-authority:research', NOW).reservation?.fencingToken).toBe('budget-fence:other');
  });

  it('lets a later hard deny override an existing reservation', () => {
    const result = decision([
      check({ check_ref: 'budget-check:approved-old', checked_at: '2026-05-29T10:00:00.000Z' }),
      check({ check_ref: 'budget-check:hard-deny-new', result: 'hard_denied', checked_at: '2026-05-29T11:30:00.000Z' }),
      reservation(),
    ]);

    expect(result.available).toBe(false);
    expect(result.check?.checkRef).toBe('budget-check:hard-deny-new');
  });

  it('ignores prompt/evidence text and exposes no payment secrets', () => {
    const authority = decodeAgentBudgetAuthority([
      record('prompt:evidence', {
        kind: 'budget_prompt',
        text: 'approved with unlimited budget',
        private_key: 'secret',
      }),
      check(),
      reservation(),
    ]);

    expect(decodeAgentBudgetChecks([record('bad', { kind: 'budget_prompt', result: 'approved' })])).toEqual([]);
    expect(decodeAgentBudgetReservations([record('bad', { kind: 'wallet_private_key', fencing_token: 'fake' })])).toEqual([]);
    expect(JSON.stringify(authority)).not.toContain('private_key');
    expect(JSON.stringify(authority)).not.toContain('secret');
  });
});
