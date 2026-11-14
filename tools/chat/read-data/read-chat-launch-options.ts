// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-launch-options.ts @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/read-data/team-roster.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure chat-owned derivation for teammate roster display. Team membership in
// chat is established by teammate-wrapped messages, not by the legacy global
// agent aggregate.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure derivation from AgentMessage[] only — no store, no effects, no I/O
// 2. First-seen ordering is stable across re-renders
// 3. Duplicate teammate IDs collapse to one record
// 4. Missing color/summary stay absent — no synthetic compatibility fields
//
// =============================================================================

import type { AgentMessage } from './chat-message-types';

export interface ChatTeammate {
  id: string;
  color: string;
  summary: string;
}

export function collectChatTeammates(messages: AgentMessage[]): ChatTeammate[] {
  const teammates = new Map<string, ChatTeammate>();

  for (const message of messages) {
    const teammate = message.teammate;
    if (!teammate || teammates.has(teammate.id)) continue;
    teammates.set(teammate.id, {
      id: teammate.id,
      color: teammate.color,
      summary: teammate.summary,
    });
  }

  return Array.from(teammates.values());
}
