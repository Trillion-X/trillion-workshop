export interface AccountStateProjection {
  accountId: string;
  accountKey: string;
  activeActivationCount: string | null;
  contractId: string | null;
  currentPeriodEndsAt: string | null;
  lifecycleState: string;
  planLabel: string;
  policyHash: string | null;
  quoteReservationId: string | null;
}

export function readAccountState(
  projection: Partial<AccountStateProjection> | null | undefined,
): AccountStateProjection | null {
  if (!projection) return null;

  const accountId = projection.accountId ?? projection.accountKey;
  if (!accountId) return null;

  return {
    accountId,
    accountKey: projection.accountKey ?? accountId,
    activeActivationCount: projection.activeActivationCount ?? null,
    contractId: projection.contractId ?? null,
    currentPeriodEndsAt: projection.currentPeriodEndsAt ?? null,
    lifecycleState: projection.lifecycleState ?? 'unknown',
    planLabel: projection.planLabel ?? 'Unknown plan',
    policyHash: projection.policyHash ?? null,
    quoteReservationId: projection.quoteReservationId ?? null,
  };
}
