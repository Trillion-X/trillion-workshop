// PORTED FROM: bitfield-packages/packages/chat/show/ChatTeammateBar.tsx @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/ChatTeammateBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Compact roster for chat teammate identities. This is chat-specific display
// state derived from message authorship, not a generic runtime agent panel.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure presentational component — no reads, no writes, no store imports
// 2. Accepts chat-owned teammate records only
// 3. Empty roster renders nothing
//
// =============================================================================

import type { ChatTeammate } from '../read-data/read-chat-launch-options';

export interface ChatTeammateBarProps {
  teammates: ChatTeammate[];
}

export function ChatTeammateBar({ teammates }: ChatTeammateBarProps) {
  // These records contain execution identities and private summaries rather
  // than conversation participant display names. Keep them available to the
  // work owner, but never paint them in product Chat.
  void teammates;
  return null;
}
