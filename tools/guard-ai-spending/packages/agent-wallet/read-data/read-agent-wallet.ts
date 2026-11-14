//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical type definitions for rail spend-authority configuration and state.
// Single source of truth for spend-authority data across all components.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. SpendAuthority is the only wallet-shaped type exported from this module
// 2. X402Wallet remains a compatibility alias for current readers
// 3. Status enum is the source of truth for authority lifecycle states
// 4. Fields are machine-readable, not abbreviated (no "amt", "cfg", "sec")
// 5. All numeric fields are exact (no rounding in type definition)
//
// =============================================================================

export interface SpendAuthority {
  id: string;
  railRef?: string;
  serviceName: string;
  walletAddress: string;
  facilitatorUrl: string;
  network: string;
  asset: string;
  status: 'active' | 'pending_setup' | 'disabled';
  autoApproveThreshold: number;
  dailyLimit: number;
  totalSpentToday: number;
  totalSpentAllTime: number;
}

/** Compatibility name for the legacy x402 UI reader; x402 is now one DATA rail. */
export type X402Wallet = SpendAuthority;
