// src/workspace/messages-screen.tsx
//
// The Messages screen is the chat part brought over from bitfield-packages packages/chat (parts/chat): one
// conversation, its message list and its composer. The conversations themselves are rows of Trillion's sidebar
// (conversation-navigation-rows.mjs), like every other screen's things (The maker 2026-09-29: it was not using the
// sidebar), so the chat draws no list of its own. This file only starts the records the chat reads
// (src/workspace/chat-records.ts: every conversation with the person's AIs, All your AIs and each Space, each
// conversation's pages, and the front door each conversation sends through) and mounts the chat on All your AIs, or on
// the conversation a sidebar row or an address names.
// One conversation's messages are also one list like any other (The maker 2026-10-06: the same data is any view): the chat
// is its first view, and every view any list is offered draws the same messages, an email thread or a chat alike: Draw
// (each message a card on the board, a line from each message to the one answering it), the Document, the Sheet, the
// Board, the Inbox and the rest. Each message is its words, who said it and when, and sits under the message it answers
// (the one said before it); words written in a view that takes them go through the conversation's own front door.

import React from 'react';
import { Container, Text, notify } from '../../parts/ui';
import { mountReactSurface } from '../../parts/ui/show/react-surface-mount';
import { canRetainAfterReadFailure, ScreenState, useScreenLoad } from '../../parts/ui/show/screen-state';
import { RecordViews, type FieldDescriptor, type RecordNesting, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { addMember, emptyGraph, ensureGroup } from '../../../../turn-frames-into-slides/read-data/group-graph.ts';
import { ChatView } from '../../parts/chat/show/ChatView';
import type { MessageActionDescriptor, MessageIntent } from '../../parts/chat/read-data/chat-message-types';
import recordModel from '../record-model.json' with { type: 'json' };
import pendingWords from './pending-sends.json';
import { aiPresenceWords, conversationPresence, presenceWords, type Person } from './conversation-presence';
import { contextOfRecordId } from './conversation-navigation-rows.mjs';
import { CONVERSATIONS_ADDRESS, aiPresenceOf, cancelPending, resendPending, canonicalConversationId, everyoneConversationId, openConversation, sendInConversation, windowAddressOf, type Line } from './chat-records';
import { readRecordAt, showRecords, subscribeRecordLabel } from './records';
import { recordFilter } from './record-filter';
import { refusal } from './failure';
import liveScopes from '../live-scopes.json';
import { AI_MESSAGES, onStoreChange, watchWindow } from './store-changes';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';

// How much of a message names it where a view shows one line for it (a card, a heading, a row).
const NAME_CHARS = 80;
// How many of the newest messages the screen holds as a window the store keeps current (src/live-scopes.json).
const MESSAGE_WINDOW = liveScopes.windows.find(window => window.list === 'messages')?.watch ?? 50;
// The chat fills the screen under the list's view bar.
const CHAT_HEIGHT = 'max(420px, calc(100dvh - 120px))';

type MessageRecord = { id: string; title: string; words: string; author: string; when: string; replies_to: string | null };
type Conversations = { rows?: { recordId: string; title: string }[] } | null;
type Window = { lines?: Line[]; anchor_message_id?: string } | null;

const nameOf = (words: string) => {
  const line = words.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > NAME_CHARS ? `${line.slice(0, NAME_CHARS - 1)}…` : line;
};

/** A conversation's lines, oldest first, as records: each answers the message said before it. */
function messagesOf(lines: Line[], them: string): MessageRecord[] {
  return lines.map((line, index) => ({
    id: line.atomRef,
    title: nameOf(line.content) || line.atomRef,
    words: line.content,
    author: line.author ?? (line.role === 'human' ? 'You' : them),
    when: line.timestamp,
    replies_to: index ? lines[index - 1].atomRef : null,
  }));
}

const MESSAGE_FIELDS = (titleOf: Map<string, string>): FieldDescriptor[] => [
  { id: 'title', label: 'Message', icon: 'MessageSquare', ruleKind: 'text', filterable: true, width: 320, role: 'title', editable: false },
  { id: 'words', label: 'Words', icon: 'AlignLeft', kind: 'excerpt', ruleKind: 'text', filterable: true, width: 420, role: 'body', editable: false },
  { id: 'author', label: 'From', icon: 'User', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 160, role: 'author', editable: false },
  { id: 'when', label: 'When', icon: 'CalendarClock', kind: 'date', ruleKind: 'date', filterable: true, sortable: true, width: 180, role: 'when', editable: false,
    factValue: (message: MessageRecord) => Date.parse(message.when), sortValue: (message: MessageRecord) => Date.parse(message.when) },
  { id: 'replies_to', label: 'Answers', icon: 'Reply', ruleKind: 'text', width: 240, hiddenByDefault: true, editable: false,
    read: (message: MessageRecord) => (message.replies_to ? titleOf.get(message.replies_to) ?? '' : '') },
];

/** How the messages nest: each under the message it answers, so a thread reads as one conversation to any depth and a
 *  board draws a line from each message to its answer. */
function nestingOf(messages: MessageRecord[]): RecordNesting {
  const ref = (id: string) => ({ family: 'conversation-message', parts: { id } });
  return {
    field: 'replies_to',
    graph: messages.reduce((graph, message) => (message.replies_to
      ? addMember(ensureGroup(graph, ref(message.replies_to)), ref(message.replies_to), ref(message.id), { memberId: message.id })
      : graph), emptyGraph()),
  };
}

// The message kind's erase action (DATA: src/record-model.json `erase_action`), offered on each message the person's
// store keeps: one secondary action that asks once in place, then erases the message through erase_record.
type EraseAction = { label: string; glyph: string; confirm: string };
const ERASE_ACTION = (recordModel.kinds as Array<{ type: string; erase_action?: EraseAction }>).find(kind => kind.type === 'message')?.erase_action;
// A message still waiting on this device offers Send again and Don't send (pending-sends.json), on its own line only.
const RECORD_ACTIONS: readonly MessageActionDescriptor[] = [
  ...(ERASE_ACTION ? [{ intentKind: 'erase', label: ERASE_ACTION.label, glyph: ERASE_ACTION.glyph, confirm: ERASE_ACTION.confirm, forRefs: 'message:' }] : []),
  { intentKind: pendingWords.resend.intent, label: pendingWords.resend.label, glyph: pendingWords.resend.glyph, forRefs: pendingWords.ref_prefix, always: true, note: pendingWords.author },
  { intentKind: pendingWords.cancel.intent, label: pendingWords.cancel.label, glyph: pendingWords.cancel.glyph, confirm: pendingWords.cancel.confirm, forRefs: pendingWords.ref_prefix, always: true },
];
async function eraseRecord(record: string): Promise<void> {
  const reply = await fetch('/work/api/records/erase', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record }) });
  if (!reply.ok) throw new Error(((await reply.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not forget it.');
}

const useRecord = <T,>(label: string) => React.useSyncExternalStore(React.useCallback((listener: () => void) => subscribeRecordLabel(label, listener), [label]), () => readRecordAt<T>(label), () => readRecordAt<T>(label));

// The others in a Space's conversation: watched only while this is on screen, told typing and away (conversation-presence.ts).
function useOthers(room: string | null): Person[] {
  const [others, setOthers] = React.useState<Person[]>([]);
  React.useEffect(() => {
    if (!room) { setOthers([]); return undefined; }
    const stop = conversationPresence.watch(room, setOthers);
    const shown = () => conversationPresence.visible(room, document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', shown);
    return () => { document.removeEventListener('visibilitychange', shown); stop(); };
  }, [room]);
  return others;
}

// The AI a direct conversation is with, whether it has said it is present: read when the conversation opens and again whenever the store changes.
function useAiPresence(focus: string): string {
  const [words, setWords] = React.useState('');
  React.useEffect(() => {
    let live = true;
    const read = () => aiPresenceOf(focus).then(ai => { if (live) setWords(aiPresenceWords(ai)); }, () => undefined);
    void read();
    const stop = onStoreChange(read);
    return () => { live = false; stop(); };
  }, [focus]);
  return words;
}

function Conversation({ focus, message }: { focus: string; message?: string }) {
  const context = contextOfRecordId(focus) as { kind?: string; space_id?: string } | null;
  const room = context?.kind === 'space' && context.space_id ? context.space_id : null;
  const others = useOthers(room);
  const onTyping = React.useCallback(() => { if (room) conversationPresence.typing(room); }, [room]);
  const aiWords = useAiPresence(focus);
  const presence = presenceWords(others) || aiWords;
  const conversations = useRecord<Conversations>(CONVERSATIONS_ADDRESS);
  const window = useRecord<Window>(windowAddressOf(focus, message));
  const title = conversations?.rows?.find(row => row.recordId === focus)?.title ?? 'Messages';
  const records = React.useMemo(() => messagesOf(window?.lines ?? [], title), [window, title]);
  const fields = React.useMemo(() => MESSAGE_FIELDS(new Map(records.map(message => [message.id, message.title]))), [records]);
  const nesting = React.useMemo(() => nestingOf(records), [records]);
  // The erase action answered here: the message is erased, then the window read again without it.
  const onRecordAction = React.useCallback((intent: MessageIntent) => {
    if (!intent.targetAtomRef) return;
    if (intent.intentKind === pendingWords.resend.intent) { void resendPending(intent.targetAtomRef).then(said => notify(said)); return; }
    if (intent.intentKind === pendingWords.cancel.intent) { cancelPending(intent.targetAtomRef); return; }
    if (intent.intentKind !== 'erase') return;
    eraseRecord(intent.targetAtomRef)
      .then(() => openConversation(focus, message, false))
      .catch((error: unknown) => notify(errorWords(error, 'Could not forget it.'), { kind: 'error' }));
  }, [focus, message]);
  const views = React.useMemo<RecordView[]>(() => [{
    id: 'chat', label: 'Chat', icon: 'MessagesSquare', fadeEdges: [],
    render: () => (
      <Container layout="vertical" heightPx={CHAT_HEIGHT} minHeight="0">
        <ChatView key={`${focus}:${message ?? ''}`} surfaceInput={{ focusConversation: focus, navigationSections: [],
          ...(message ? { transcriptSessionId: windowAddressOf(focus, message) } : {}) }}
          recordActions={RECORD_ACTIONS} onRecordAction={onRecordAction} onTyping={room ? onTyping : undefined} />
        {presence ? <Text variant="caption" color="muted" aria-live="polite" data-conversation-presence="">{presence}</Text> : null}
      </Container>
    ),
  }], [focus, message, onRecordAction, onTyping, presence]);
  const compose = React.useMemo(() => ({ send: ({ text }: { text: string }) => sendInConversation(focus, text) }), [focus]);
  return (
    <RecordViews
      label={title}
      fields={fields}
      records={records}
      identify={(message: MessageRecord) => message.id}
      identity={message ? windowAddressOf(focus, message) : focus}
      nesting={nesting}
      views={views}
      defaultView="chat"
      preferenceKey="trillion-conversation-views"
      compose={compose}
      {...recordFilter}
      emptyMessage="Nothing said here yet."
    />
  );
}
export const messagesFocus = (props?: { surfaceInput?: { conversation?: string } }): string => canonicalConversationId(props?.surfaceInput?.conversation ?? everyoneConversationId);

function MessagesLoad({ focus, message }: { focus: string; message?: string }) {
  // Read the addressed content inside its keyed lifecycle. No view may call an unresolved or
  // refused target empty. A previously verified window of this exact target stays visible during a return read.
  const initialRead = React.useMemo(() => ({ pending: true }), [focus, message]);
  const window = useRecord<Window>(windowAddressOf(focus, message));
  const cached = initialRead.pending && message && window?.anchor_message_id !== message ? null : window;
  const loaded = useScreenLoad(windowAddressOf(focus, message), {
    loading: { label: 'Loading your messages', layout: 'rows' },
    read: async () => {
      const restoreAnchor = initialRead.pending;
      initialRead.pending = false;
      try { await openConversation(focus, message, restoreAnchor); return true; }
      catch (error) {
        if (!canRetainAfterReadFailure(error)) showRecords({ [windowAddressOf(focus, message)]: null });
        throw error;
      }
    },
    failed: refusal('This conversation could not load', { label: 'Open Messages', run: () => location.assign('/messages') }),
  });
  React.useEffect(() => onStoreChange(loaded.reload, AI_MESSAGES), [loaded.reload]);
  // The newest messages are a window the store keeps up to date by ops: a change in them reads this screen again.
  React.useEffect(() => watchWindow('messages', MESSAGE_WINDOW).stop, []);
  const state = loaded.state?.status === 'loading' && cached ? null : loaded.state;
  return (
    <Container as="main" layout="vertical" height="full" minHeight="0" overflow="y-auto" aria-label="Messages" aria-busy={state?.status === 'loading' ? 'true' : 'false'}>
      {state ? <ScreenState state={cached && state.status === 'failed' ? { ...state, inline: true } : state} /> : null}
      {!state || cached ? <Conversation key={`${focus}:${message ?? ''}`} focus={focus} message={message} /> : null}
    </Container>
  );
}

export function mountMessagesScreen(element: HTMLElement, props?: { surfaceInput?: { conversation?: string; message?: string } }): () => void {
  return mountReactSurface(element, <MessagesLoad focus={messagesFocus(props)} message={props?.surfaceInput?.message} />);
}
