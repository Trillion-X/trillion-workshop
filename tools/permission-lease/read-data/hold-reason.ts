//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE canonical translation of the agent's `hold_reason` code into a human
// sentence. `hold_reason` is the permission-lease/guardrail domain's vocabulary
// (why the agent did NOT place an order this cycle), so the translation lives
// with its owner (L098: the data owner does ALL translation; consumers speak the
// human language, never the raw code).
//
// This replaces three drifted copies that each translated a PARTIAL set of the
// codes with slightly different phrasing (investment-command, portfolio-connector,
// market-data-feed). One owner, one superset, one phrasing — every surface that
// shows a hold reason imports this (L043: no whack-a-mole).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This is the ONLY place a hold_reason code becomes a sentence. A new code is
//    added HERE; every consumer gets it for free.
// 2. Unknown/future codes are surfaced readably (token de-slugged), never dropped
//    and never shown raw.
// 3. `thresholdPct` (when known) names the exact momentum gate the symbols failed
//    to clear, so the sentence reflects the real configured gate.
// =============================================================================

/**
 * Translate a `hold_reason` code into a human sentence about what the agent is
 * doing. Returns null when there is no reason (the agent traded — nothing to
 * explain). `thresholdPct` interpolates the configured momentum gate when known.
 */
export function holdReasonSentence(reason: string | null | undefined, thresholdPct: number | null): string | null {
  if (!reason) return null;
  const gate = thresholdPct !== null ? `the ${thresholdPct}% momentum gate` : 'the momentum gate';
  switch (reason) {
    case 'no-signal-above-threshold':
      return `No symbol cleared ${gate}, so the agent held.`;
    case 'signal-but-guarded':
      return 'A symbol cleared the gate, but a risk guardrail held the order back this cycle.';
    case 'cooldown':
      return 'The agent is cooling down after a recent order, so it held this cycle.';
    case 'at-max-positions':
      return 'The agent is already at its maximum number of open positions, so it held.';
    case 'kill-switch':
      return "Today's loss limit was hit — the agent halted new trading to protect capital.";
    case 'no-buying-power':
      return 'Buying power is fully committed, so the agent held this cycle.';
    case 'market-closed':
      return 'The market is closed — orders are queued for the next open.';
    case 'target-reached':
      return "The day's target was reached — the agent is holding its gains.";
    default:
      // Unknown future reason: present it readably rather than dropping it or
      // leaking the raw token.
      return `The agent held this cycle (${reason.replace(/[-_]/g, ' ')}).`;
  }
}
