// PORTED FROM: bitfield-packages/packages/chat/read-data/merge-agent-selection-participants.ts @ e99ac5976
import type { AddressedParticipantInfo } from './read-addressed-exchange-participants';

/** Merge overlapping participant feeds without changing their routing identities. */
export function mergeAgentSelectionParticipants(
  participants: readonly AddressedParticipantInfo[],
): AddressedParticipantInfo[] {
  const byRef = new Map<string, AddressedParticipantInfo>();
  for (const participant of participants) {
    const current = byRef.get(participant.participantRef);
    byRef.set(participant.participantRef, current
      ? {
          ...current,
          ...participant,
          accounts: participant.accounts.length > 0 ? participant.accounts : current.accounts,
          models: participant.models.length > 0 ? participant.models : current.models,
          adapter: participant.adapter ?? current.adapter,
          routeDescriptors: [...current.routeDescriptors, ...participant.routeDescriptors],
        }
      : participant);
  }
  return [...byRef.values()];
}
