
// tools/guard-ai-spending/read-data/read-agent-budget-authority.ts
//
// May this operation spend now: the latest budget check for (operation, idempotency key, spend authority) and
// exactly one current reservation that matches it. Ported from bitfield-packages
// packages/agent-wallet/read-data/read-agent-budget-authority.ts; changed only so decodeAgentBudgetAuthority reads
// the records it is given (the person's own check and reservation records) instead of a package manifest.

export interface BudgetAuthorityRecordThing {
  type?: string;
  address?: string;
  payload?: unknown;
  remove?: boolean;
}

export interface AgentBudgetCheck {
  checkRef: string;
  operationRef: string;
  walletRef: string;
  idempotencyKey: string;
  result: string;
  estimatedCost?: number;
  currency?: string;
  spendSnapshotRef?: string;
  checkedAt?: string;
  expiresAt: string | null;
  evidenceRefs: string[];
  pauseTransitionRef?: string;
  deniedReason?: string;
}

export interface AgentBudgetReservation {
  reservationRef: string;
  operationRef: string;
  walletRef: string;
  idempotencyKey: string;
  spendSnapshotRef: string;
  fencingToken: string;
  status: string;
  amount?: number;
  currency?: string;
  reservedAt?: string;
  expiresAt: string | null;
  evidenceRefs: string[];
}

export interface AgentBudgetAuthority {
  checks: AgentBudgetCheck[];
  reservations: AgentBudgetReservation[];
}

export interface AgentBudgetDecision {
  available: boolean;
  reason: string;
  check: AgentBudgetCheck | null;
  reservation: AgentBudgetReservation | null;
  duplicateReservations: AgentBudgetReservation[];
}

function thingsFrom(records: unknown): BudgetAuthorityRecordThing[] {
  if (Array.isArray(records)) return records.filter(isThing);
  if (records && typeof records === 'object' && Array.isArray((records as { things?: unknown }).things)) {
    return (records as { things: unknown[] }).things.filter(isThing);
  }
  return [];
}

function isThing(value: unknown): value is BudgetAuthorityRecordThing {
  return Boolean(value && typeof value === 'object');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function asNullableTime(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timeRank(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function isExpired(expiresAt: string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now.getTime();
}

function currentReservation(reservation: AgentBudgetReservation, now: Date): boolean {
  return reservation.status === 'current' && !isExpired(reservation.expiresAt, now);
}

export function decodeAgentBudgetChecks(records: unknown): AgentBudgetCheck[] {
  return thingsFrom(records).flatMap((thing) => {
    if (thing.remove) return [];
    const payload = asObject(thing.payload);
    if (!payload || !['agent_budget_check', 'spend_budget_check'].includes(String(payload.kind))) return [];
    const checkRef = asString(payload.check_ref) ?? asString(payload.checkRef) ?? thing.address;
    const operationRef = asString(payload.operation_ref) ?? asString(payload.operationRef);
    const walletRef = asString(payload.wallet_ref) ?? asString(payload.walletRef);
    const idempotencyKey = asString(payload.idempotency_key) ?? asString(payload.idempotencyKey);
    const result = asString(payload.result);
    if (!checkRef || !operationRef || !walletRef || !idempotencyKey || !result) return [];
    return [{
      checkRef,
      operationRef,
      walletRef,
      idempotencyKey,
      result,
      estimatedCost: asNumber(payload.estimated_cost ?? payload.estimatedCost),
      currency: asString(payload.currency),
      spendSnapshotRef: asString(payload.spend_snapshot_ref) ?? asString(payload.spendSnapshotRef),
      checkedAt: asString(payload.checked_at) ?? asString(payload.checkedAt),
      expiresAt: asNullableTime(payload.expires_at ?? payload.expiresAt),
      evidenceRefs: asStringArray(payload.evidence_refs ?? payload.evidenceRefs),
      pauseTransitionRef: asString(payload.pause_transition_ref) ?? asString(payload.pauseTransitionRef),
      deniedReason: asString(payload.denied_reason) ?? asString(payload.deniedReason),
    }];
  }).sort((left, right) => timeRank(right.checkedAt) - timeRank(left.checkedAt));
}

export function decodeAgentBudgetReservations(records: unknown): AgentBudgetReservation[] {
  return thingsFrom(records).flatMap((thing) => {
    if (thing.remove) return [];
    const payload = asObject(thing.payload);
    if (!payload || !['agent_budget_reservation', 'spend_budget_reservation'].includes(String(payload.kind))) return [];
    const reservationRef = asString(payload.reservation_ref) ?? asString(payload.reservationRef) ?? thing.address;
    const operationRef = asString(payload.operation_ref) ?? asString(payload.operationRef);
    const walletRef = asString(payload.wallet_ref) ?? asString(payload.walletRef);
    const idempotencyKey = asString(payload.idempotency_key) ?? asString(payload.idempotencyKey);
    const spendSnapshotRef = asString(payload.spend_snapshot_ref) ?? asString(payload.spendSnapshotRef);
    const fencingToken = asString(payload.fencing_token) ?? asString(payload.fencingToken);
    if (!reservationRef || !operationRef || !walletRef || !idempotencyKey || !spendSnapshotRef || !fencingToken) return [];
    return [{
      reservationRef,
      operationRef,
      walletRef,
      idempotencyKey,
      spendSnapshotRef,
      fencingToken,
      status: asString(payload.status) ?? 'current',
      amount: asNumber(payload.amount),
      currency: asString(payload.currency),
      reservedAt: asString(payload.reserved_at) ?? asString(payload.reservedAt),
      expiresAt: asNullableTime(payload.expires_at ?? payload.expiresAt),
      evidenceRefs: asStringArray(payload.evidence_refs ?? payload.evidenceRefs),
    }];
  }).sort((left, right) => timeRank(right.reservedAt) - timeRank(left.reservedAt));
}

export function decodeAgentBudgetAuthority(records: unknown): AgentBudgetAuthority {
  const things = thingsFrom(records);
  return {
    checks: decodeAgentBudgetChecks(things),
    reservations: decodeAgentBudgetReservations(things),
  };
}

export function budgetDecisionForOperation(
  authority: AgentBudgetAuthority,
  operationRef: string,
  idempotencyKey: string,
  walletRef: string,
  now: Date = new Date(),
): AgentBudgetDecision {
  const check = authority.checks.find((candidate) => (
    candidate.operationRef === operationRef
    && candidate.idempotencyKey === idempotencyKey
    && candidate.walletRef === walletRef
  )) ?? null;

  if (!check) {
    return { available: false, reason: 'missing budget check', check, reservation: null, duplicateReservations: [] };
  }
  if (isExpired(check.expiresAt, now)) {
    return { available: false, reason: 'budget check expired', check, reservation: null, duplicateReservations: [] };
  }
  if (check.result === 'hard_denied') {
    return { available: false, reason: check.deniedReason ?? 'budget hard denied', check, reservation: null, duplicateReservations: [] };
  }
  if (check.result === 'missing_wallet') {
    return { available: false, reason: 'missing wallet', check, reservation: null, duplicateReservations: [] };
  }
  if (check.result === 'stale_spending') {
    return { available: false, reason: 'stale spending snapshot', check, reservation: null, duplicateReservations: [] };
  }

  const matchingReservations = authority.reservations.filter((reservation) => (
    reservation.operationRef === operationRef
    && reservation.idempotencyKey === idempotencyKey
    && reservation.walletRef === walletRef
    && currentReservation(reservation, now)
  ));

  if (matchingReservations.length === 0) {
    return { available: false, reason: 'missing current budget reservation', check, reservation: null, duplicateReservations: [] };
  }
  if (matchingReservations.length > 1) {
    return { available: false, reason: 'duplicate current budget reservations', check, reservation: null, duplicateReservations: matchingReservations };
  }

  const [reservation] = matchingReservations;
  if (check.spendSnapshotRef && reservation.spendSnapshotRef !== check.spendSnapshotRef) {
    return { available: false, reason: 'reservation spend snapshot mismatch', check, reservation, duplicateReservations: [] };
  }
  if (check.result === 'approved' || check.result === 'soft_limit') {
    return {
      available: true,
      reason: check.result === 'soft_limit' ? 'budget soft limit acknowledged' : 'budget admitted',
      check,
      reservation,
      duplicateReservations: [],
    };
  }
  return { available: false, reason: `budget ${check.result}`, check, reservation, duplicateReservations: [] };
}
