// The one private link a deal makes for one person: whose address opens it, when it stops, and what a free deal may do
// with it, plus what happens to the link when its payment offer cannot be made. Port of the link steps in
// sendSalesContract (src/native-commercial-domain.mjs at 3b7063d6f3). Storage-free: the caller makes the link from the
// request this returns, and revokes it from the action this returns.
import data from './private-link-for-one-person.json' with { type: 'json' };

/**
 * contractId: the deal's id; to: the email the link is for, or null to use scope; scope: who may open it when there is
 * no email; expiresAt: when it stops, or null for no end; origin: the address the deal was opened from; free: whether the
 * deal asks for no money (then the person may view and sign).
 */
export function privateLinkRequest({ contractId, to = null, scope = null, expiresAt = null, origin, free }) {
  return {
    record: contractId,
    options: {
      scope: to === null ? scope : { kind: data.email_kind, value: String(to) },
      expires_at: expiresAt,
      origin,
      ...(free ? { can: data.free_can } : {}),
    },
  };
}

/** A free deal needs no payment offer, so its link stands. A priced deal's link is revoked when its offer fails. */
export function offerFailureAction({ free, offerFailed }) {
  if (free) return 'none';
  return offerFailed ? 'revoke' : 'keep';
}
