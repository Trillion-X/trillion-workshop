export interface AccountSessionProjection {
  accountIdHash: string | null;
  email: string | null;
  signedAccountSessionProofId: string | null;
  status: 'anonymous' | 'pending_email' | 'signed_in';
  emailConfirmed: boolean;
  /** Canonical session-authority lease boundary. Presentation owners may use
   * this for one exact expiry wake; it is not an independently owned timer. */
  sessionExpiresAtMilliseconds?: number;
  /** Local replay/provenance projection only. This marker never grants account
   * authority, sync, entitlement, or permanence. */
  localFirstRunAdoptionId?: string | null;
  localFirstRunJourneyId?: string | null;
}

export function readAccountSession(
  projection: Partial<AccountSessionProjection> | null | undefined,
): AccountSessionProjection {
  return {
    accountIdHash: projection?.accountIdHash ?? null,
    email: projection?.email ?? null,
    signedAccountSessionProofId: projection?.signedAccountSessionProofId ?? null,
    status: projection?.status ?? 'anonymous',
    emailConfirmed: projection?.emailConfirmed ?? false,
    ...(typeof projection?.sessionExpiresAtMilliseconds === 'number' && Number.isFinite(projection.sessionExpiresAtMilliseconds)
      ? { sessionExpiresAtMilliseconds: projection.sessionExpiresAtMilliseconds }
      : {}),
    localFirstRunAdoptionId: projection?.localFirstRunAdoptionId ?? null,
    localFirstRunJourneyId: projection?.localFirstRunJourneyId ?? null,
  };
}
