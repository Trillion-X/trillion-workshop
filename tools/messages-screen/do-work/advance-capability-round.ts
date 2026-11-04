// PORTED FROM: bitfield-packages/packages/chat/do-work/advance-capability-round.ts @ e99ac5976
import { authorizeDiscoveredRound, expireRoundAuthorization, type RoundCapabilityAuthorization } from './execute-chat-work-requests';
import type { ChatToolRoundStep } from './advance-chat-tool-round';
import type { DiscoveredCapability } from './discover-capabilities';

export type CapabilityRoundState = { requestId: string; round: number; callerAuthorityRef: string; authorization: RoundCapabilityAuthorization | null; discovered: readonly DiscoveredCapability[] };
/** Pure active-view transition: discovery authority exists for exactly the next round. */
export function advanceCapabilityRound(state: CapabilityRoundState, step: ChatToolRoundStep, now: number, ttlMs: number): CapabilityRoundState | null {
  if (step.kind !== 'continue') { if (state.authorization) expireRoundAuthorization(state.authorization); return null; }
  // An authorization belongs to precisely one produced round.  Every
  // continuation replaces it (discovery) or clears it (ordinary tool follow-up);
  // it can never leak across the state transition.
  if (state.authorization) expireRoundAuthorization(state.authorization);
  const authorization = step.discoveredCapabilities
    ? authorizeDiscoveredRound({ turnId: step.nextRequestId, round: state.round + 1, callerAuthorityRef: state.callerAuthorityRef, authorityBindingRef: step.authorityBindingRef ?? '', ttlMs, now, discovered: step.discoveredCapabilities })
    : null;
  return { requestId: step.nextRequestId, round: state.round + 1, callerAuthorityRef: state.callerAuthorityRef, authorization, discovered: step.discoveredCapabilities ?? [] };
}
