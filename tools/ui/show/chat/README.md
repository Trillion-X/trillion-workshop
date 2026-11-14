# parts/ui/show/chat

One conversation drawn as a chat: messages grouped by day and by speaker, newest at the bottom, the box to write pinned under them. Behaviour lives here; the look is `parts/screen-look/show/chat-thread.css`. The box itself is the caller's (the one composer, `parts/ui/show/composer`); this part draws where it sits and what the next message answers, never a second box.

## Files

| File | Purpose |
|------|---------|
| `chat-groups.ts` | `groupChat`: messages to days to runs of one speaker, oldest first, whatever order a page arrived in. Pure, no DOM. Also the message shape (`ChatEntry`, `ChatAttachment`). |
| `ChatThread.tsx` | One conversation: days (named between them), runs (others on the left with their picture at the run's foot and their name and time on top; the reader's own on the right in the look's ink, the run's time under its last bubble), a quoted reply at a bubble's top, a shared thing as a compact card that opens it, reactions as chips on a bubble's edge, tools beside a bubble on hover, focus or a tap (react, reply, copy, its `…` menu, its clock time), a "New" line over what arrived since the reader looked, Show older at the top, auto-scroll that follows only a reader already at the bottom, a round button back to the newest, and under it all what the next message answers and the caller's box. |
| `ChatMention.tsx` | The one mention adapter: `ChatMention` draws each `{ kind, value, label }` as the shared live `RecordChip` (`../record-chip`), found where its `@label` is written by `mentionRuns` (the record chip part's one rule, re-exported). |
| `index.ts` | Public barrel, declared in `parts/ui/part.json`. |
| `README.md` | This file. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `ChatSpeaker` | `{ id, name, mine }` | Who wrote a message; `mine` puts it on the reader's side. |
| `ChatAttachment` | `{ kind, title, detail?, picture?, icon?, open?, openLabel? }` | A shared thing: its own picture (drawn by the caller) or its kind's `icon` (a NamedIcon name); `open` makes the whole card its press. |
| `ChatEntry` | `{ id, speaker, text, at, mentions?, quote?: { name?, text }, attachment?, reactions?, palette?, onReact?, onReply?, menu?: { items, onAction }, withdrawn?, unread? }` | One message and every action on it, each the caller's. |
| `ChatMentionRef` / `mentionRuns` / `ChatMention` | `{ kind, value, label }` / `(text, mentions?) => ChatWordRun[]` / component | Mentions in a message. |
| `ChatRun` / `ChatDay` | `{ key, speaker, entries }` / `{ key, day, runs }` | What `groupChat` returns. |
| `groupChat` | `(entries, { now?, gapMinutes? = 5 }) => ChatDay[]` | Days named by `relative-time` `relativeDay`; a run breaks on a new speaker, a new day or a gap longer than `gapMinutes`. |
| `ChatThreadWords` | `{ newest, copy, copied, reply, react, more, unread, replyingTo, cancelReply, open }` | Every word the thread draws itself; `replyingTo` fills `{name}`. |
| `ChatThread` | `{ entries, markOf?, empty, older?, ariaLabel, composer?, replying?: { name, text, onCancel }, palette?, words?, now? }` | A `role="log"` viewport over the pinned box. Remount per conversation (React `key`) so each opens at its newest message. |

## Usage

```tsx
<ChatThread
  entries={messages}
  ariaLabel="Messages"
  empty="Nothing here yet."
  markOf={speaker => <DisplayMark spec={{ name: speaker.name }} size="sm" />}
  composer={<Composer onSend={send} />}
  replying={answering ? { name: answering.speaker.name, text: answering.text, onCancel: stop } : null}
/>
```

The `chat` design of every list (`../record-views/designs/chat-design.tsx`) is the caller a pursuit's Messages uses.

## Sources and licences

| Source | Taken | Licence |
|--------|-------|---------|
| 21st.dev 28186 "Chat" by joyco (https://21st.dev/@joyco/components/chat) | Self and peer rows, picture anchored to the row's foot, auto-scroll that yields to the reader's own scrolling | The entry states no licence. Anatomy only: re-written on Trillion parts, no code copied. |
| 21st.dev 29393 "Chat Bubble Thread" by bundui (https://21st.dev/@bundui/components/bubble6) | Consecutive bubbles from one sender grouped under one picture, tightened inner corners | The entry states no licence. Anatomy only, re-written. |
| 21st.dev 28759 "Chat Bubble Reactions" by bundui (https://21st.dev/@bundui/components/bubble4) | Reaction badges anchored to the bubble's edge | The entry states no licence. Anatomy only, re-written. |
| 21st.dev 34988 "Message Bubble" by framecn (https://21st.dev/@framecn/components/message-bubble) | Incoming and outgoing variants | The entry states no licence. Anatomy only, re-written. |
| 21st.dev 28485 "AI Messages" (AI Elements) | Scroll-to-bottom button shown only away from the bottom | The entry states no licence. Anatomy only, re-written. |
| 21st.dev 23819 "AI Message" and 31661 "Message Thread" | Actions revealed on hover instead of crowding the bubble | Inspiration only. |
| 21st.dev 12404 "Agent Chat" by serafimcloud | Centred reading column and centred empty state | The entry states no licence. Anatomy only, re-written. |
| Messenger, WhatsApp, iMessage and Slack as people use them | A quoted reply inside the bubble, tools beside the bubble, a "New" line, day names between days | Inspiration only. |

## Dependencies

**Depends on:** `button`, `container`, `text`, `icon` (`NamedIcon`), `copy-button`, `action-menu`, `reactions` (`ReactionRow` with `only`), `relative-time`, `record-chip` (`RecordChip`, `mentionRuns`); look in `parts/screen-look/show/chat-thread.css` (loaded through `scripts/workspace-looks.json`).
**Depended on by:** `../record-views/designs/chat-design.tsx` (the `chat` design: a pursuit's Messages and every list's Chat view); `test/record-views-designed-views.test.mjs`.

## Invariants

1. Domain-blind: no AI, space or person words; every visible word, picture and action comes from the caller.
2. Loading older messages keeps the message being read in place; a new message is followed only when the reader was at the bottom or wrote it.
3. Each run carries its time once; a message's own clock time shows with its tools, with the full date as the title.
4. Nothing that only acts on a message is drawn at rest; tools appear on hover, keyboard focus or a tap.
5. Reduced motion: scrolling to the newest is instant and nothing fades.
