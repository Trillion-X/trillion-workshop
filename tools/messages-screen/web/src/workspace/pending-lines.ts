// src/workspace/pending-lines.ts
//
// PURPOSE
//   A message the person sent that the account has not answered yet is shown in its conversation at once, in their own
//   words, as one more line at the end (an optimistic echo), with Send again and Don't send on it. The lines come from
//   the device outbox's kept rows (src/workspace/share-outbox.ts), so the echo is exactly what will be sent and goes
//   away when the account answers it; nothing here keeps a second copy.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A line exists only for a kept row that names this conversation and its words in `meta` ({ conversation, text }).
//   2. Its reference is `ref_prefix` + the row's request key (pending-sends.json), so the chat offers Resend/Cancel on
//      echoes only and the key finds the row.
//   3. Its time is when the device kept it; echoes sort after the conversation's own lines and among themselves oldest first.
//   4. Words are DATA (pending-sends.json).

import words from './pending-sends.json';
import type { KeptShare } from './share-outbox';

export type PendingLine = { type: 'text'; role: 'human'; content: string; timestamp: string; atomRef: string; author: string };

/** The echo lines for one conversation, oldest first. */
export function pendingLines(rows: readonly KeptShare[], conversation: string): PendingLine[] {
  return [...rows].sort((a, b) => a.kept_at - b.kept_at).flatMap(row => {
    const meta = row.meta as { conversation?: unknown; text?: unknown } | undefined;
    if (meta?.conversation !== conversation || typeof meta.text !== 'string') return [];
    return [{ type: 'text' as const, role: 'human' as const, content: meta.text, timestamp: new Date(row.kept_at).toISOString(), atomRef: `${words.ref_prefix}${row.request_key}`, author: words.author }];
  });
}

/** The request key an echo's reference names, or null when the reference is not an echo's. */
export const pendingKeyOf = (atomRef: string): string | null => (atomRef.startsWith(words.ref_prefix) ? atomRef.slice(words.ref_prefix.length) : null);
