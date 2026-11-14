// parts/ui/show/chat/chat-groups.ts
//
// PURPOSE
//   The one rule for how a conversation reads on screen: messages oldest to newest, broken into days, and within a
//   day into runs by one speaker (after 21st.dev 29393 "Chat Bubble Thread", which groups consecutive bubbles from
//   one sender under one avatar). Zero DOM and zero React, so every rule here is testable on its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Messages are ordered by time. Two messages with the same time keep the order of a page read newest first
//      (the order every conversation route answers in): the later one in the input is the older one.
//   2. A run breaks when the speaker changes, when the day changes, or when more than `gapMinutes` pass between two
//      messages of the same speaker, so a reply hours later reads as a new moment.
//   3. A message whose time cannot be read sorts last and joins the final day; it is never dropped.
//   4. Nothing here names a kind of speaker: `mine` is the only fact read, and it only decides the side.
//   5. A run never holds more than one person's words: a message that answers another or carries a shared thing
//      stays in its speaker's run like any other.

import { relativeDay } from '../relative-time/relative-time';
import type React from 'react';
import type { ChatMentionRef } from './ChatMention';
import type { OfferedReaction, Reaction, ReactionChoice } from '../reactions/ReactionRow';

/** Who wrote a message. `id` tells two speakers apart; `mine` puts the message on the reader's side. */
export type ChatSpeaker = { id: string; name: string; mine: boolean };
/** A thing shared into the conversation, drawn as a compact card in its message: `picture` its own picture (drawn
 *  by the caller), else `icon` (a NamedIcon name) for its kind; `open` opens it, the whole card being the press. */
export type ChatAttachment = { kind: string; title: string; detail?: string; picture?: React.ReactNode; icon?: string; open?: () => unknown; openLabel?: string };
/** One message: its words, when it was written, and what it mentions (each drawn where its `@label` is written).
 *  `quote` is what it answers (who said it and its words), `attachment` a thing shared in it, `reactions` the
 *  reactions given and `onReact` how to give one (`palette` the reactions offered on it), `onReply` answers it,
 *  `menu` its `…` rows, `withdrawn` one quiet line in place of its words, `unread` arrived since the reader looked. */
export type ChatEntry = {
  id: string; speaker: ChatSpeaker; text: string; at: string; mentions?: readonly ChatMentionRef[];
  quote?: { name?: string; text: string }; attachment?: ChatAttachment;
  reactions?: readonly Reaction[]; palette?: readonly OfferedReaction[]; onReact?: (choice: ReactionChoice) => unknown;
  onReply?: () => void; menu?: { items: readonly { id: string; label: string; icon?: string }[]; onAction: (id: string) => void };
  withdrawn?: string; unread?: boolean;
};
/** Consecutive messages by one speaker. */
export type ChatRun = { key: string; speaker: ChatSpeaker; entries: ChatEntry[] };
/** One calendar day of a conversation, named as the reader says it ("Today", "Yesterday", "Monday", "Sep 3"). */
export type ChatDay = { key: string; day: string; runs: ChatRun[] };

export type ChatGroupOptions = { now?: number; gapMinutes?: number };

const timeOf = (entry: ChatEntry) => {
  const time = Date.parse(entry.at);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

/** The conversation as days of runs, oldest first. */
export function groupChat(entries: readonly ChatEntry[], { now = Date.now(), gapMinutes = 5 }: ChatGroupOptions = {}): ChatDay[] {
  const ordered = entries.map((entry, index) => ({ entry, index, time: timeOf(entry) }))
    .sort((a, b) => (a.time - b.time) || (b.index - a.index));
  const days: ChatDay[] = [];
  let lastTime = Number.NEGATIVE_INFINITY;
  for (const { entry, time } of ordered) {
    const readable = Number.isFinite(time);
    const day = readable ? relativeDay(time, now) : days.at(-1)?.day ?? '';
    let current = days.at(-1);
    if (!current || current.day !== day) {
      current = { key: `day:${entry.id}`, day, runs: [] };
      days.push(current);
    }
    const run = current.runs.at(-1);
    if (run && run.speaker.id === entry.speaker.id && (!readable || time - lastTime <= gapMinutes * 60_000)) run.entries.push(entry);
    else current.runs.push({ key: `run:${entry.id}`, speaker: entry.speaker, entries: [entry] });
    if (readable) lastTime = time;
  }
  return days;
}
