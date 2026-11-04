// PORTED FROM: bitfield-packages/packages/chat/show/chat-send-readiness.ts @ e99ac5976
export interface ParticipantSendReadinessInput {
  participantRef: string | null | undefined;
  participantRegistryCount: number;
  reachableParticipantCount: number;
  hasOwnerTargetRef: boolean;
  hasRouteTargetRef: boolean;
}

export function getParticipantSendReadinessError(input: ParticipantSendReadinessInput): string | null {
  if (input.hasOwnerTargetRef || input.hasRouteTargetRef) return null;
  if (!input.participantRef || input.participantRegistryCount === 0) {
    return 'No receiver is available yet. Add a participant with a published route before sending.';
  }
  if (input.reachableParticipantCount === 0) {
    return 'No receiver has a published route yet. Add one before sending.';
  }
  return 'The selected receiver does not have a published route yet. Pick another receiver or add a route before sending.';
}
