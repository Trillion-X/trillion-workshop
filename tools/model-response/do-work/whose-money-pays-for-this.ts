// packages/model-response/do-work/whose-money-pays-for-this.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decide whether a model request has to pass a spend gate before it is made,
// and say what to ask the gate.
//
// The question is not "is this expensive". It is WHOSE CREDENTIAL PAYS. A
// person running this on their own machine with their own provider key is
// spending their own money with their provider, and standing between them and
// their own key would be an invention. A hosted app answering a customer with
// the operator's key is spending the OPERATOR's money, and nothing currently
// stands between a customer and an unbounded amount of it.
//
// Collecting money at signup does not bound this. Somebody can pay twenty
// dollars and use thirty. That confusion is worth naming here because it was
// made out loud: taking payment is revenue, and a spend ceiling is a limit,
// and neither one is the other.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure. A request in, a decision out. The gate call itself is the caller's.
// 2. A request that names a spend authority is GATED. The authority is the
//    operator saying "this is my money", so its presence is the whole signal
//    and no heuristic about hosts, accounts, or providers is consulted.
// 3. A named authority that the gate denies stops the request. Fail-closed:
//    an unreachable or unreadable gate is a denial, never a pass, because the
//    failure mode of the other choice is an unbounded bill.
// 4. No authority named means nobody claimed the spend, and the request
//    proceeds. That is the person's own key and their own provider bill.
//
// =============================================================================

export type SpendGateAsk = {
  operation_ref: string;
  estimated_cost: number;
  spend_authority_ref: string;
  idempotency_key: string;
};

/**
 * What to ask the spend gate before making this request, or null when nobody
 * has claimed the spend.
 *
 * `estimatedCostCents` is the caller's estimate for the call it is about to
 * make. It is required whenever an authority is named: an authority with no
 * estimate would reserve nothing, so every request would be approved and the
 * ledger would show a budget that never moves, which reads as a working limit.
 */
export function spendGateAskForModelRequest(input: {
  spendAuthorityRef?: unknown;
  estimatedCostCents?: unknown;
  threadRef?: unknown;
  requestId?: unknown;
}): SpendGateAsk | null {
  const authority = typeof input.spendAuthorityRef === 'string' ? input.spendAuthorityRef.trim() : '';
  if (!authority) return null;

  const cost = input.estimatedCostCents;
  if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) {
    throw new Error(
      'This request names a spend authority but no whole-cent estimate of what it will cost, so the gate would reserve nothing and approve everything.',
    );
  }

  const thread = typeof input.threadRef === 'string' ? input.threadRef.trim() : '';
  const request = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if (!request) {
    throw new Error('This request names a spend authority but nothing that identifies it, so the gate could not tell two requests apart.');
  }

  return {
    operation_ref: thread ? `model-response:${thread}` : 'model-response',
    estimated_cost: cost,
    spend_authority_ref: authority,
    // The gate is idempotent on this, so a retried request reuses its
    // reservation instead of taking a second bite of the same budget.
    idempotency_key: `model-response:${request}`,
  };
}

/**
 * Whether the gate's answer lets this request happen.
 *
 * Anything that is not an explicit approval is a denial, including a reply
 * that could not be read. A gate that cannot answer is a gate that is not
 * limiting anything, and treating silence as approval is how a spend ceiling
 * becomes decoration.
 */
export function spendGateApproved(reply: unknown): boolean {
  if (!reply || typeof reply !== 'object') return false;
  return (reply as { approved?: unknown }).approved === true;
}

/** What to tell the person when the gate says no. Their words, not the ledger's. */
export function spendGateRefusalMessage(reply: unknown): string {
  const reason = reply && typeof reply === 'object'
    ? (reply as { reason?: unknown }).reason
    : undefined;
  return typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : 'This account has reached its usage limit.';
}
