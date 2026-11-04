// PORTED FROM: bitfield-packages/packages/chat/show/resolve-source-session-ref.ts @ e99ac5976
import type { AddressedParticipantLaunchSpec } from '../read-data/read-addressed-exchange-participants';

export interface ResolveInitialConversationSourceSessionRefInput {
  launch: AddressedParticipantLaunchSpec;
  shouldResumeSourceSession: boolean;
  selectedSessionId: string | null;
}

export function resolveInitialConversationSourceSessionRef(
  input: ResolveInitialConversationSourceSessionRefInput,
): string | null {
  if (!input.shouldResumeSourceSession) return null;
  if (!input.selectedSessionId) return null;
  return Array.isArray(input.launch.resumeArgv) && input.launch.resumeArgv.length > 0
    ? input.selectedSessionId
    : null;
}
