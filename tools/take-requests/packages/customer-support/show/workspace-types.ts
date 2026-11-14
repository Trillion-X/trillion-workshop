// package-set://bitfield-studio/packages/customer-support/show/workspace-types.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One canonical alias for the decorated record the show layer renders, derived
// straight from the workspace projection so it can never drift (SSOT). The
// projection (`readCustomerSupportWorkspace`) decorates each record with its
// resolved evidence + actions; the blind renderers consume exactly that shape.
//
// Keeping the alias here (instead of re-deriving it per file) means a change to
// the projection's record shape flows to every renderer with ZERO edits.
//
// =============================================================================

import type { CustomerSupportWorkspace } from '../read-data/read-customer-support-workspace';

/** A workspace record decorated with its resolved evidence + actions. */
export type SupportRecord = CustomerSupportWorkspace['records'][number];
