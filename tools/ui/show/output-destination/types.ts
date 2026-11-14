// packages/ui/show/output-destination/types.ts
//
// =============================================================================
// PURPOSE — generic, data-driven output destination contract.
// =============================================================================
//
// ONE primitive that DELIVERS produced bytes/text to ANYWHERE via an
// envelope-addressed, injected capability map. Destinations are not hardcoded;
// they are DATA rows that register `deliver` capability implementations.
//
// Physics: the seam never knows destination KINDS. It holds an injected
// capability map and dispatches through it. New destination = one DATA row in
// the calling package; seam stays ZERO change (L069/L090).
//
// =============================================================================

/**
 * A payload ready to deliver to an output destination.
 */
export interface OutputPayload {
  readonly filename: string;
  readonly mimeType: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

/**
 * A destination capability: takes a payload and attempts delivery.
 * Legacy true means confirmed delivery, false means failure. Destinations that
 * only request a download or show text must return that actual outcome.
 */
export type OutputDeliverCapability = (
  payload: OutputPayload,
) => Promise<boolean | OutputDeliveryOutcome>;

export type OutputDeliveryOutcome = 'delivered' | 'requested' | 'shown' | 'cancelled' | 'failed';

export function outputDeliveryOutcome(value: unknown): OutputDeliveryOutcome {
  if (value === true || value === 'delivered') return 'delivered';
  if (value === 'requested' || value === 'shown' || value === 'cancelled') return value;
  return 'failed';
}

/**
 * A registered output destination that appears in choice UI.
 * The `deliver` function is injected at registration time — the registry
 * never enumerates destination KINDS or hardcodes delivery logic.
 */
export interface OutputDestination {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly deliver: OutputDeliverCapability;
  /**
   * A silent fallback: it participates in an auto/first-success delivery chain but
   * is NOT rendered as its own visible choice. Use it for a destination that only
   * works in some environments (e.g. a browser anchor download that is dead inside a
   * WKWebView presenter) so it never sits next to the real destination as a
   * confusing, often-dead duplicate — while still catching the plain-browser case.
   * The seam stays blind: choice UI filters on this flag; the chain ignores it.
   */
  readonly fallbackOnly?: boolean;
}
