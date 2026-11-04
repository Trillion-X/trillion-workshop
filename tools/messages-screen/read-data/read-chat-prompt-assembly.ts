// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-prompt-assembly.ts @ e99ac5976
// packages/chat/read-data/read-chat-prompt-assembly.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Read the LIVE, per-app prompt-assembly descriptor from the global
// published-records projection. The prompt-assembly config (does this app's chat
// prepend the ~47k-token work catalog? the placeable-surface capability? what
// history window?) is per-APP Society DATA — the SAME chat package runs in the
// studio shell AND in a coaching app, and each wants a different prompt
// assembly. So the descriptor cannot be a single bundled package default; it is a
// live record at address `package::chat::prompt-assembly::default` that each app's
// log sets independently. When present it OVERRIDES the bundled default; when
// absent the caller falls back to the bundled contract (lean plain chat).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure function — no React, no I/O. Unit-testable with plain data.
// 2. Reuses the ONE shared parser (parsePromptAssemblyPayload) so the live and
//    bundled readers never drift (L100/SSOT).
// 3. Returns null when no live record exists → caller uses the bundled default.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { PublishedRecord } from '../../ui/show/placeable-surface-intent';
import {
  parsePromptAssemblyPayload,
  type PromptAssemblyDescriptor,
} from '../do-work/build-live-chat-prompt';

/** The canonical address of the per-app prompt-assembly DATA record. */
export const CHAT_PROMPT_ASSEMBLY_ADDRESS = 'package::chat::prompt-assembly::default';

/**
 * Find the live per-app prompt-assembly record in the published-records catalog
 * and parse it. Returns null when none is published (→ bundled default applies).
 */
export function readChatPromptAssembly(
  records: readonly PublishedRecord[],
): PromptAssemblyDescriptor | null {
  for (const record of records) {
    if (record.recordId !== CHAT_PROMPT_ASSEMBLY_ADDRESS) continue;
    const payload =
      record.payload && typeof record.payload === 'object' ? record.payload : record.row;
    return parsePromptAssemblyPayload(payload);
  }
  return null;
}
