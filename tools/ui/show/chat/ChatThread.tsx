// parts/ui/show/chat/ChatThread.tsx
//
// PURPOSE
//   One conversation drawn as a chat: days, then runs of one speaker, the reader's own messages on the right in
//   their ink and everyone else's on the left under their picture and name, newest at the bottom with the box to
//   write pinned under it. A message can answer another (the words it answers quoted at its top), carry a thing
//   someone shared (a compact card: its picture or kind mark, its kind, title and a line of its words, the whole
//   card opening it), and wear reactions as small chips on its lower edge. Pointing at a message (or keyboard focus,
//   or a tap on a touch screen) shows its tools beside it: react, reply, copy and its `…` menu, with its clock time.
//   Messages that arrived since the reader last looked sit under a "New" line. Newest stays in view as messages
//   arrive; scrolling up to read stops that, and a round button brings the reader back to the newest.
//   Anatomy from 21st.dev: 28186 "Chat" (joyco: self/peer rows, picture anchored to the row's foot, auto-scroll that
//   yields to the reader's own scroll), 29393 "Chat Bubble Thread" (consecutive bubbles grouped under one picture),
//   28759 "Chat Bubble Reactions" (reaction badges on the bubble's edge), 34988 "Message Bubble" (incoming and
//   outgoing variants), 28485 "AI Messages" (scroll-to-bottom button shown only away from the bottom), 23819 "AI
//   Message" and 31661 "Message Thread" (actions revealed on hover), 12404 "Agent Chat" (centred reading column);
//   and from Messenger, WhatsApp and Slack as people use them (a quoted reply, hover tools beside the bubble, a "New"
//   line, day names between days).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: it knows speakers, messages, times and what a press reports, never who an AI or a space is. The
//      caller supplies each speaker's picture through `markOf`, every word shown on screen and every action.
//   2. Reading older messages never jumps: when messages are added ABOVE (the newest is unchanged) the reader stays
//      on the same message. When a newer message arrives the view follows only if the reader was already at the
//      bottom or wrote it themselves.
//   3. Each run carries its time once (beside the name for others, under the last bubble for the reader); a
//      message's own clock time shows with its tools, its full date as the title.
//   4. Nothing that only acts on a message is drawn at rest: tools appear on hover, focus or a tap.
//   5. Motion respects reduced motion: scrolling to the newest is instant when the reader asked for less motion.
//   6. Callers remount it per conversation (a React `key`), so each conversation opens at its newest message.
//
// The extensive documentation in this codebase is a critical design feature. You are forbidden from simplifying or
// removing it.

import React from 'react';

import { ActionMenu, type ActionMenuItem } from '../action-menu/ActionMenu';
import { Button } from '../button';
import { CopyButton } from '../copy-button/CopyButton';
import { Container } from '../container';
import { NamedIcon } from '../icon';
import { Text } from '../text';
import { ReactionRow, type OfferedReaction, type Reaction, type ReactionChoice } from '../reactions/ReactionRow';
import { groupChat, type ChatEntry, type ChatSpeaker } from './chat-groups';
import { ChatMention, mentionRuns } from './ChatMention';

/** Every word the thread draws itself; the caller's, with these as the plain defaults. */
export type ChatThreadWords = {
  newest: string; copy: string; copied: string; reply: string; react: string; more: string; unread: string;
  replyingTo: string; cancelReply: string; open: string;
};
const WORDS: ChatThreadWords = {
  newest: 'Go to the newest message', copy: 'Copy message', copied: 'Copied', reply: 'Reply', react: 'Add a reaction',
  more: 'More', unread: 'New', replyingTo: 'Replying to {name}', cancelReply: 'Stop replying', open: 'Open',
};

export interface ChatThreadProps {
  entries: readonly ChatEntry[];
  /** The picture beside a speaker's messages (the caller's mark for that speaker). */
  markOf?: (speaker: ChatSpeaker) => React.ReactNode;
  /** Shown in the reading column when there are no messages yet. */
  empty: React.ReactNode;
  /** A way to read earlier messages, drawn at the top while there are more. */
  older?: { label: string; onLoad: () => void; busy?: boolean } | null;
  ariaLabel: string;
  /** The box to write in, pinned under the conversation in the same column. */
  composer?: React.ReactNode;
  /** The message the next one answers, drawn over the box with a way to stop. */
  replying?: { name: string; text: string; onCancel: () => void } | null;
  /** The reactions offered on every message that may be reacted to. */
  palette?: readonly OfferedReaction[];
  words?: Partial<ChatThreadWords>;
  /** The moment days are named against; tests pass one so "Today" stays today. */
  now?: number;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
const BOTTOM_SLACK_PX = 48;
const fill = (words: string, values: Record<string, string>) => words.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

function readable(at: string): { short: string; long: string } {
  const time = Date.parse(at);
  return Number.isFinite(time) ? { short: clock.format(time), long: full.format(time) } : { short: '', long: '' };
}

const lessMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const touchOnly = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;
const excerpt = (words: string) => (words.length > 140 ? `${words.slice(0, 139).trimEnd()}…` : words);

/** A message's words, with each mention drawn where its `@label` is written. */
function Words({ entry }: { entry: ChatEntry }) {
  return (
    <Text as="p" variant="body" className="chat-bubble-text">
      {mentionRuns(entry.text, entry.mentions).map((run, index) => run.type === 'text'
        ? <React.Fragment key={index}>{run.text}</React.Fragment>
        : <ChatMention key={index} kind={run.kind} value={run.value} label={run.label} />)}
    </Text>
  );
}

/** A thing shared into the conversation: its picture (or its kind's mark), its kind, title and a line of its words;
 *  the whole card opens it when the caller can. */
function Attachment({ entry, words }: { entry: ChatEntry; words: ChatThreadWords }) {
  const attachment = entry.attachment!;
  const inside = (
    <>
      <Container gap="none" className="chat-attachment-picture" data-picture={attachment.picture ? '' : undefined} aria-hidden="true">
        {attachment.picture ?? <NamedIcon name={attachment.icon ?? 'File'} size="md" />}
      </Container>
      <Container gap="none" className="chat-attachment-words">
        <Text as="span" variant="caption" color="muted" className="chat-attachment-kind">{attachment.kind}</Text>
        <Text as="span" variant="body" weight="semibold" className="chat-attachment-title">{attachment.title}</Text>
        {attachment.detail ? <Text as="span" variant="caption" color="muted" className="chat-attachment-detail">{attachment.detail}</Text> : null}
      </Container>
    </>
  );
  return attachment.open
    ? <Button type="button" variant="ghost" className="chat-attachment" aria-label={`${attachment.openLabel ?? words.open} ${attachment.title}`} onClick={() => { return attachment.open?.(); }}>{inside}</Button>
    : <Container layout="horizontal" gap="none" className="chat-attachment">{inside}</Container>;
}

/** The tools beside a message: its clock time, react, reply, copy and its menu. */
function Tools({ entry, palette, words }: { entry: ChatEntry; palette: readonly OfferedReaction[]; words: ChatThreadWords }) {
  const when = readable(entry.at);
  const react = entry.onReact;
  return (
    <Container layout="horizontal" alignItems="center" gap="none" className="chat-message-tools" role="toolbar" aria-label={words.more}>
      {react ? <ReactionRow only="add" reactions={entry.reactions ?? []} palette={entry.palette ?? palette} onReact={choice => Promise.resolve(react(choice))} words={{ add: words.react }} /> : null}
      {entry.onReply ? (
        <Button type="button" variant="ghost" size="icon" aria-label={words.reply} title={words.reply} onClick={entry.onReply}>
          <NamedIcon name="Reply" size="sm" aria-hidden="true" />
        </Button>
      ) : null}
      {entry.text ? <CopyButton text={entry.text} label={words.copy} copiedLabel={words.copied} iconOnly size="icon" /> : null}
      {entry.menu?.items.length ? <ActionMenu label={words.more} items={entry.menu.items as ActionMenuItem[]} onAction={entry.menu.onAction} align="end" /> : null}
      {when.short ? <Text as="time" variant="caption" color="muted" dateTime={entry.at} title={when.long} className="chat-message-time">{when.short}</Text> : null}
    </Container>
  );
}

function Message({ entry, palette, words, chosen, onChoose }: {
  entry: ChatEntry; palette: readonly OfferedReaction[]; words: ChatThreadWords; chosen: boolean; onChoose: (id: string | null) => void;
}) {
  const given = entry.reactions?.filter(reaction => reaction.count > 0) ?? [];
  const react = entry.onReact;
  return (
    <Container layout="horizontal" alignItems="center" gap="none" className="chat-message" data-message-id={entry.id}
      data-chosen={chosen ? 'true' : undefined} data-has-reactions={given.length ? 'true' : undefined}
      onClick={() => { if (touchOnly()) onChoose(chosen ? null : entry.id); }}>
      <Container gap="none" className="chat-message-stack">
        {entry.withdrawn ? (
          <Container gap="none" className="chat-bubble" data-quiet="true"><Text as="p" variant="body" color="muted" className="chat-bubble-text">{entry.withdrawn}</Text></Container>
        ) : (
          <>
            {entry.text || entry.quote ? (
              <Container gap="none" className="chat-bubble">
                {entry.quote ? (
                  <Container gap="none" className="chat-reply-quote">
                    {entry.quote.name ? <Text as="span" variant="caption" weight="semibold" className="chat-reply-quote-name">{entry.quote.name}</Text> : null}
                    <Text as="span" variant="caption" className="chat-reply-quote-text">{excerpt(entry.quote.text)}</Text>
                  </Container>
                ) : null}
                {entry.text ? <Words entry={entry} /> : null}
              </Container>
            ) : null}
            {entry.attachment ? <Attachment entry={entry} words={words} /> : null}
          </>
        )}
        {given.length && react ? (
          <Container layout="horizontal" gap="none" className="chat-message-reactions">
            <ReactionRow only="given" reactions={given} palette={entry.palette ?? palette} onReact={choice => Promise.resolve(react(choice))} words={{ add: words.react }} compact />
          </Container>
        ) : null}
      </Container>
      {entry.withdrawn ? null : <Tools entry={entry} palette={palette} words={words} />}
    </Container>
  );
}

export function ChatThread({ entries, markOf, empty, older, ariaLabel, composer, replying, palette = [], words: given, now }: ChatThreadProps) {
  const words = { ...WORDS, ...given };
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const atBottom = React.useRef(true);
  const fromBottom = React.useRef(0);
  const seen = React.useRef<{ first: string; last: string } | null>(null);
  const [away, setAway] = React.useState(false);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const days = React.useMemo(() => groupChat(entries, { now }), [entries, now]);
  const firstUnread = React.useMemo(() => days.flatMap(day => day.runs.flatMap(run => run.entries)).find(entry => entry.unread && !entry.speaker.mine)?.id ?? null, [days]);

  const toBottom = React.useCallback((smooth: boolean) => {
    const view = viewport.current;
    if (!view) return;
    view.scrollTo({ top: view.scrollHeight, behavior: smooth && !lessMotion() ? 'smooth' : 'auto' });
    atBottom.current = true;
    setAway(false);
  }, []);

  const onScroll = React.useCallback(() => {
    const view = viewport.current;
    if (!view) return;
    fromBottom.current = view.scrollHeight - view.scrollTop;
    atBottom.current = view.scrollHeight - view.scrollTop - view.clientHeight <= BOTTOM_SLACK_PX;
    setAway(!atBottom.current);
  }, []);

  React.useLayoutEffect(() => {
    const view = viewport.current;
    const newest = days.at(-1)?.runs.at(-1)?.entries.at(-1);
    const shown = { first: days[0]?.runs[0]?.entries[0]?.id ?? '', last: newest?.id ?? '' };
    const before = seen.current;
    seen.current = shown;
    if (!view) return;
    if (!before || !before.last) toBottom(false);
    else if (before.last === shown.last && before.first !== shown.first) view.scrollTop = view.scrollHeight - fromBottom.current;
    else if (before.last !== shown.last && (atBottom.current || newest?.speaker.mine)) toBottom(true);
    else onScroll();
  }, [days, toBottom, onScroll]);

  // The box under the conversation can grow while writing, and pictures load late; a reader at the bottom stays there.
  React.useEffect(() => {
    const view = viewport.current;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const column = view.firstElementChild;
    const watch = new ResizeObserver(() => { if (atBottom.current) view.scrollTop = view.scrollHeight; });
    watch.observe(view);
    if (column) watch.observe(column);
    return () => watch.disconnect();
  }, []);

  return (
    <Container gap="none" data-slot="chat-thread" className="chat-thread">
      <Container gap="none" className="chat-thread-frame">
        <Container gap="none" ref={viewport} role="log" aria-label={ariaLabel} aria-live="polite" tabIndex={0} className="chat-thread-viewport" onScroll={onScroll}>
          <Container layout="vertical" gap="none" className="chat-thread-column">
            {older ? (
              <Container layout="horizontal" justifyContent="center" gap="none" className="chat-thread-older">
                <Button type="button" size="sm" variant="ghost" disabled={older.busy} onClick={older.onLoad}>{older.label}</Button>
              </Container>
            ) : null}
            {entries.length === 0 ? <Container layout="vertical" alignItems="center" justifyContent="center" className="chat-thread-empty">{empty}</Container> : days.map(day => (
              <Container key={day.key} role="group" aria-label={day.day} layout="vertical" gap="none" className="chat-day">
                {day.day ? <Container layout="horizontal" justifyContent="center" gap="none" className="chat-day-divider"><Text variant="caption" color="muted">{day.day}</Text></Container> : null}
                {day.runs.map(run => {
                  const mine = run.speaker.mine;
                  const first = readable(run.entries[0]!.at);
                  const last = readable(run.entries.at(-1)!.at);
                  const unreadAt = run.entries.findIndex(entry => entry.id === firstUnread);
                  return (
                    <React.Fragment key={run.key}>
                      {unreadAt === 0 ? <Container layout="horizontal" alignItems="center" gap="none" className="chat-unread-line" role="separator"><Text as="span" variant="caption" weight="semibold">{words.unread}</Text></Container> : null}
                      <Container layout="horizontal" gap="none" className="chat-run" data-side={mine ? 'mine' : 'theirs'}>
                        {mine ? null : <Container gap="none" className="chat-run-mark">{markOf?.(run.speaker)}</Container>}
                        <Container layout="vertical" gap="none" className="chat-run-body">
                          {mine ? null : (
                            <Container layout="horizontal" alignItems="baseline" gap="none" className="chat-run-head">
                              <Text as="span" variant="caption" weight="semibold" className="chat-run-name">{run.speaker.name}</Text>
                              {first.short ? <Text as="time" variant="caption" color="muted" dateTime={run.entries[0]!.at} title={first.long} className="chat-run-time">{first.short}</Text> : null}
                            </Container>
                          )}
                          {run.entries.map((entry, index) => (
                            <React.Fragment key={entry.id}>
                              {index > 0 && index === unreadAt ? <Container layout="horizontal" alignItems="center" gap="none" className="chat-unread-line" role="separator"><Text as="span" variant="caption" weight="semibold">{words.unread}</Text></Container> : null}
                              <Message entry={entry} palette={palette} words={words} chosen={chosen === entry.id} onChoose={setChosen} />
                            </React.Fragment>
                          ))}
                          {mine && last.short ? <Text as="time" variant="caption" color="muted" dateTime={run.entries.at(-1)!.at} title={last.long} className="chat-run-foot">{last.short}</Text> : null}
                        </Container>
                      </Container>
                    </React.Fragment>
                  );
                })}
              </Container>
            ))}
          </Container>
        </Container>
        <Container gap="none" className="chat-thread-newest" data-shown={away ? 'true' : 'false'}>
          <Button type="button" variant="secondary" size="icon" aria-label={words.newest} tabIndex={away ? 0 : -1} onClick={() => toBottom(true)}>
            <NamedIcon name="ArrowDown" size="sm" aria-hidden="true" />
          </Button>
        </Container>
      </Container>
      {composer ? (
        <Container gap="none" className="chat-compose">
          {replying ? (
            <Container layout="horizontal" alignItems="center" gap="none" className="chat-replying">
              <NamedIcon name="Reply" size="sm" aria-hidden="true" />
              <Container gap="none" className="chat-replying-words">
                <Text as="span" variant="caption" weight="semibold">{fill(words.replyingTo, { name: replying.name })}</Text>
                <Text as="span" variant="caption" color="muted" className="chat-replying-text">{excerpt(replying.text)}</Text>
              </Container>
              <Button type="button" variant="ghost" size="icon" aria-label={words.cancelReply} title={words.cancelReply} onClick={replying.onCancel}>
                <NamedIcon name="X" size="sm" aria-hidden="true" />
              </Button>
            </Container>
          ) : null}
          {composer}
        </Container>
      ) : null}
    </Container>
  );
}

export type { Reaction, ReactionChoice, OfferedReaction };
