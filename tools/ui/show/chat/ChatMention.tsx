// parts/ui/show/chat/ChatMention.tsx
//
// PURPOSE
//   The one place a mention inside a chat message is drawn: the shared live record chip (parts/ui/show/record-chip
//   `RecordChip`), whose looks and addresses the screen hands down with `RecordChipProvider`. A mention is
//   `{ kind, value, label }`, the shape the composer's mention candidates carry. Finding mentions in a message's words
//   is the record chip part's one rule (`mentionRuns`), re-exported here for the thread.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `mentionRuns` never drops or reorders words: joining its text runs and each mention's `@label` gives the
//      original text back.
//   2. Each mention is found at its first `@label` not already taken; longer labels are matched first, so
//      "@Ann Lee" is never read as "@Ann". A mention whose `@label` is not in the words is not drawn.
//   3. Nothing here names a kind of mention; `kind` and `value` travel as DATA attributes for the chip to use.

import React from 'react';

import { RecordChip } from '../record-chip/RecordChip';
import { mentionRuns, type KeptMention, type MentionRun } from '../record-chip/mention-runs';

/** Something a message names: its kind, the thing's own id and what it is called. */
export type ChatMentionRef = KeptMention;
/** A message's words as plain text and mentions, in order. */
export type ChatWordRun = MentionRun;

export { mentionRuns };

/** One mention inside a message: its live chip. */
export function ChatMention({ kind, value, label }: ChatMentionRef) {
  return <RecordChip kind={kind} value={value} label={label} />;
}
