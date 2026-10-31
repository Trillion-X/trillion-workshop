// tools/guard-ai-spending/read-data/spend-authority.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The one type of a spend authority: the person's own `spend-authority` record, which says how much their AI may
// spend through one rail and how much it has spent. The person sets its limits and turns it on; the tools in this
// folder only read the limits and add what was spent. Ported from bitfield-packages
// packages/agent-wallet/read-data/read-agent-wallet.ts (SpendAuthority). Changed: the fields are the record's own
// snake_case names, which decide-budget.mjs and record-spend.mjs read; the x402 wallet fields (wallet address,
// facilitator, network, asset) and the X402Wallet alias are gone, because x402 is one rail row in
// spend-rails.json, not the shape of every authority. The status is an open string, as decide-budget.mjs reads it:
// only "active" lets a positive spend through.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Money is whole cents (integer minor units of USD).
// 2. An absent record, or one not enabled and active, denies every positive spend.
// 3. No key, card number or wallet secret is ever a field here; credentials are named by the rail's credential_ref.
//
// =============================================================================

export const SPEND_AUTHORITY_TYPE = 'spend-authority';

export interface SpendAuthority {
  label?: string;
  rail_ref?: string;
  status: string;
  enabled: boolean;
  per_transaction_limit: number;
  daily_limit: number;
  total_spent_today: number;
  total_spent_all_time: number;
  last_reset_day?: string;
}
