// src/workspace/chat-records.ts
//
// NO PRIOR: searched src/workspace and parts for "chat-session-window", "selected-chat-message-window",
//   "read-chat-session-transcript-page" and answerTarget; nothing answered them. This is the records seam for the chat
//   brought over verbatim from bitfield-packages packages/chat (parts/chat), in the shape of
//   the records seam the Automations map once had (src/workspace/workflow-canvas-records.ts, since removed).
//
// PURPOSE
//   The chat reads its conversations and each open conversation's messages as records by name, and sends through the
//   egress front door a conversation row declares, exactly as it did on the record engine. This file supplies those
//   from what Trillion already keeps, through the same /work/api routes the person's AIs use:
//   - `chat-session-window`: one row per conversation in the person's work contexts (their own AIs' conversations
//     from /work/api/messages/threads, "All your AIs", each AI they have not talked with yet, and each Space they are
//     in from /work/api/spaces), newest activity first.
//   - `selected-chat-message-window:<conversation>`: the open conversation's latest messages, oldest first, published
//     when the chat reads it (`action:read-chat-session-transcript-page`) and again whenever the person's store changes.
//     Show older reads the next page through the same action, answered inline.
//   - `action:send-in-trillion-conversation` (each row's `sendCapability.frontDoorAction`): the words go where the row
//     says: to one AI (/work/api/messages/send), to every AI (/send-all), or into a Space as its item (/items), with
//     each `@Name` the words name resolved against the context's own mention list, and a mentioned AI at work in the
//     Space handed the message as a job.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The Worker stays the owner: every send is a /work/api press and the conversation is read again after it, so the
//      chat shows what was kept, never what was hoped for.
//   2. A Space message's id is its Space item id, and a private message's id is its message id: the chat, the Space's
//      own views and every AI name each message by its one identity.
//   3. Lines are oldest first; equal times keep the order of a page read newest first (the later is the older).
//   4. Nothing here draws or words anything on screen except each conversation's own name and who it is with: each
//      conversation's participant is published to `addressed-exchange-participants` with its name and mark (an AI's
//      app picture where activity-providers.json knows its maker, a Space's people icon, an AI's mark otherwise: an app is never given letters).

import { providerIconRegistry, resolveProviderMark } from '../../parts/ui';
import { canRetainAfterReadFailure } from '../../parts/ui/show/screen-state';
import { answerTarget, readRecordAt, showRecords } from './records';
import providerNames from './activity-providers.json';
import { postJson, readItemJson, readJson, readCollectionJson } from './api';
import { contextOfRecordId, recordIdOf as conversationIdOf, SHARED_CONVERSATION, EVERYONE_LABEL } from './conversation-navigation-rows.mjs';
import { AI_MESSAGES, onLiveEvent, onStoreChange } from './store-changes';
import { resolveBundle } from '../live-protocol.mjs';
import { shareOutbox } from './share-outbox';
import { pendingLines, pendingKeyOf } from './pending-lines';
import pendingWords from './pending-sends.json';

type Message = { id: string; app: string; conversation_id: string; speaker: string; text: string; at: string; authored_at?: string; attachments?: { identity: string; name?: string; media_type?: string }[] };
type Thread = { id: string; app: string; conversation_id: string; latest: Message };
type Agent = { agent_id: string; name: string; description?: string; source_id?: string | null; present?: boolean };
type Space = { space_id: string; title: string; label: string; last_activity_at: string | null };
type SpaceItem = { item_id: string; kind?: string; body: { text?: string; mentions?: unknown } | string | null; provenance: { by: string; by_you: boolean; added_at: string } };
type Mention = { kind: string; value: string; label: string };
export type Line = { type: 'text'; role: 'human' | 'assistant'; content: string; timestamp: string; atomRef: string; mentions?: Mention[]; author?: string; links?: { url: string; state: 'pending' | 'ready' | 'failed'; card?: Record<string, string> }[]; files?: { key: string; name: string; url: string; contentType: string }[] };
type Context = { kind: 'ai'; app: string; conversation_id: string; agent_id?: string; everyone?: boolean } | { kind: 'space'; space_id: string };
/** Each link as written in a window's messages, with its card (`ready`) or that it is still being read or could not be. */
export type Previews = Record<string, { state: 'pending' | 'ready' | 'failed'; card?: Record<string, string> }>;
type Page = { lines: Line[]; next: string | null; hasNewer?: boolean; anchor?: string; previews?: Previews };
type OpenWindow = { recordId: string; sessionId: string; messageId?: string };

const API = '/work/api/messages';
const SEND = 'action:send-in-trillion-conversation';
const READ = 'action:read-chat-session-transcript-page';
const SHARED = SHARED_CONVERSATION;
const PAGE = '100';
export const windowAddressOf = (recordId: string, messageId?: string) => `selected-chat-message-window:${recordId}${messageId ? `:message:${encodeURIComponent(messageId)}` : ''}`;
/** Equivalent URL encodings still name one conversation everywhere the screen, window and send action use it. */
export const canonicalConversationId = (recordId: string): string => {
  const context = contextOfRecordId(recordId);
  return context ? conversationIdOf(context) : recordId;
};
/** The record every conversation's row is published in (one row per conversation, its title among them). */
export const CONVERSATIONS_ADDRESS = 'chat-session-window';
// A conversation's id is made in one place, the same one its sidebar row uses (conversation-navigation-rows.mjs).
const recordIdOf = (context: Context): string => conversationIdOf(context);
/** The conversation id a Space's chat opens on (its row in the window). */
export const spaceConversationId = (spaceId: string) => recordIdOf({ kind: 'space', space_id: spaceId });
/** The conversation Messages opens on: one message for every AI the person uses. */
export const everyoneConversationId = recordIdOf({ kind: 'ai', ...SHARED, everyone: true });

const contexts = new Map<string, Context>();
const opened = new Set<string>();
const openedWindows = new Map<string, OpenWindow>();
const persisted = new Set<string>();
const conversationRows = new Map<string, ReturnType<typeof row>>();
let listedRows: ReturnType<typeof row>[] = [];
const readingWindows = new Map<string, { view: OpenWindow; request: Promise<void>; invalidate: () => void }>();
let ready: Promise<void> | null = null;
let readingAgents: Promise<{ agents: Agent[] }> | null = null;
let followingStore = false;

function readAgents(): Promise<{ agents: Agent[] }> {
  if (readingAgents) return readingAgents;
  readingAgents = readItemJson<{ agents: Agent[] }>(`${API}/agents`).finally(() => { readingAgents = null; });
  return readingAgents;
}

const agentFor = (context: { app: string; conversation_id: string }, agents: Agent[]) =>
  agents.find(candidate => candidate.source_id === context.conversation_id) ?? agents.find(candidate => candidate.name === context.app);

/** Whether the AI a direct conversation is with has said it is present (src/work-messages.mjs /agents `present`, set by agent_presence);
 *  null for a conversation that is not with one AI, or one this person has no connected AI for. */
export async function aiPresenceOf(focus: string): Promise<{ name: string; present: boolean } | null> {
  const context = contexts.get(focus);
  if (!context || context.kind !== 'ai' || context.everyone) return null;
  const agent = agentFor(context, (await readAgents()).agents);
  return agent ? { name: agent.name, present: agent.present === true } : null;
}

const timeOf = (at: string) => { const time = Date.parse(at); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; };
/** Oldest first from a page read newest first; equal times keep that page's order reversed. */
const oldestFirst = (lines: Line[]) => lines.map((line, index) => ({ line, index, time: timeOf(line.timestamp) }))
  .sort((a, b) => (a.time - b.time) || (b.index - a.index)).map(entry => entry.line);
/** Who said a message that is not the person's, when it is someone other than the conversation's own AI (speaker
 *  "ai"): a teammate heard nearby, an email's sender, a text's handle, as src/inbound.mjs keeps the speaker. */
const authorOf = (speaker: string) => (speaker && speaker !== 'person' && speaker !== 'ai' ? speaker : undefined);
const mentionsOf = (listed: unknown): Mention[] => (Array.isArray(listed) ? listed : [])
  .filter((one): one is Mention => Boolean(one) && typeof one.kind === 'string' && typeof one.value === 'string' && typeof one.label === 'string');

/** The links written in some words with what is known of each (the page's previews, keyed by the link as written). */
const linksOf = (text: string, previews?: Previews) => {
  const found = previews ? Object.entries(previews).filter(([link]) => text.includes(link)).map(([url, preview]) => ({ url, state: preview.state, ...(preview.card ? { card: preview.card } : {}) })) : [];
  return found.length ? { links: found } : {};
};

async function readOnePage(context: Context, before?: string, messageId?: string): Promise<Page> {
  const query = new URLSearchParams({ limit: PAGE, ...(before ? { before } : {}) });
  if (context.kind === 'space') {
    if (messageId) throw Object.assign(new Error('This message link could not be read. Open the Space to choose its message.'), { status: 400 });
    query.set('kind', 'message');
    const page = await readItemJson<{ items: SpaceItem[]; next_before: string | null }>(`/work/api/spaces/${encodeURIComponent(context.space_id)}/items?${query}`);
    return {
      next: page.next_before,
      lines: oldestFirst(page.items.map(item => {
        const mentions = item.body && typeof item.body === 'object' ? mentionsOf(item.body.mentions) : [];
        return {
          type: 'text' as const, role: item.provenance.by_you ? 'human' as const : 'assistant' as const, atomRef: item.item_id,
          content: typeof item.body === 'string' ? item.body : item.body?.text ?? '', timestamp: item.provenance.added_at,
          ...(mentions.length ? { mentions } : {}), ...(item.provenance.by_you ? {} : { author: item.provenance.by }),
        };
      })),
    };
  }
  query.set('app', context.app);
  query.set('conversation_id', context.conversation_id);
  if (messageId) query.set('message_id', messageId);
  // Each link in these messages with its card, or that it is pending or failed (src/link-previews.mjs).
  query.set('previews', '1');
  const page = await readItemJson<{ messages: Message[]; next_before: string | null; has_newer?: boolean; anchor_message_id?: string; previews?: Previews }>(`${API}/thread?${query}`);
  if (messageId && !page.messages.some(message => message.id === messageId)) {
    throw Object.assign(new Error('The message this link refers to could not be found.'), { status: 404 });
  }
  return {
    next: page.next_before,
    hasNewer: page.has_newer === true,
    ...(page.previews ? { previews: page.previews } : {}),
    ...(messageId ? { anchor: messageId } : {}),
    lines: oldestFirst(page.messages.map(message => ({
      type: 'text' as const, role: message.speaker === 'person' ? 'human' as const : 'assistant' as const, atomRef: message.id,
      content: message.text, timestamp: message.authored_at ?? message.at,
      ...(message.attachments?.length ? { files: message.attachments.map(file => ({ key: file.identity, name: file.name?.split('/').pop() || 'Attached file', url: `/work/api/namespace/bytes/${encodeURIComponent(file.identity)}`, contentType: file.media_type ?? 'application/octet-stream' })) } : {}),
      ...(authorOf(message.speaker) ? { author: authorOf(message.speaker) } : {}),
      ...linksOf(message.text, page.previews),
    }))),
  };
}

/** A bounded owner scan can exhaust a page before finding a matching row. Continue its cursor before calling a
 *  conversation empty; a repeated cursor is a failed read, never an empty answer or an endless loading loop. */
async function readPage(context: Context, before?: string, messageId?: string): Promise<Page> {
  const visited = new Set(before ? [before] : []);
  let page = await readOnePage(context, before, messageId);
  for (let scanned = 1; ; scanned += 1) {
    if (page.next != null && (typeof page.next !== 'string' || !page.next.trim() || visited.has(page.next))) {
      throw new Error('This conversation could not finish loading. Try again.');
    }
    if (page.lines.length || !page.next) return page;
    if (scanned >= 20) throw new Error('This conversation could not finish loading. Try again.');
    visited.add(page.next);
    page = await readOnePage(context, page.next);
  }
}

// The last page each window published, so a message kept on this device shows (and goes) at once, without a read.
const shownPages = new Map<string, { recordId: string; page: Page }>();
const windowOf = (recordId: string, page: Page, sessionId = windowAddressOf(recordId)) => {
  // A message the account has not answered yet ends the latest window as the person's own line (pending-lines.ts).
  const lines = page.hasNewer || page.anchor ? page.lines : [...page.lines, ...pendingLines(shareOutbox.list(), recordId)];
  return {
    version: 1, session_id: sessionId, window_key: page.anchor ? 'anchored' : 'latest',
    lines,
    limit: lines.length, total_count: page.next || page.hasNewer ? null : lines.length, total_count_known: !page.next && !page.hasNewer, has_older: Boolean(page.next), has_newer: page.hasNewer === true,
    ...(page.anchor ? { anchor_message_id: page.anchor } : {}),
    ...(page.previews ? { previews: page.previews } : {}),
    older_cursor: page.next ? { version: 1, path: recordId, revision: page.next, total_length: 1, before_offset: 0 } : null,
    file_path: recordId,
  };
};

function contextFor(recordId: string): Context {
  const known = contexts.get(recordId);
  if (known) return known;
  const decoded = contextOfRecordId(recordId) as Context | null;
  if (!decoded) throw Object.assign(new Error('This conversation link could not be read. Open Messages to choose a conversation.'), { status: 400 });
  return decoded.kind === 'ai' && decoded.app === SHARED.app && decoded.conversation_id === SHARED.conversation_id
    ? { ...decoded, everyone: true } : decoded;
}

async function publishWindow(recordId: string, view: OpenWindow = { recordId, sessionId: windowAddressOf(recordId) }): Promise<void> {
  const selected = openedWindows.get(view.sessionId);
  if (selected && selected !== view) return publishWindow(recordId, selected);
  if (!selected) openedWindows.set(view.sessionId, view);
  const reading = readingWindows.get(view.sessionId);
  if (reading?.view === view) return reading.request;
  let invalidated = false;
  const request = (async () => {
    try {
      const context = contextFor(recordId);
      let page: Page;
      do {
        invalidated = false;
        page = await readPage(context, undefined, view.messageId);
      } while (invalidated && openedWindows.get(view.sessionId) === view);
      // A different notification or Show latest may have been selected while this read was on its way. Only the
      // current selection can publish; its read also settles every older reader waiting for this window.
      const current = openedWindows.get(view.sessionId);
      if (current && current !== view) return publishWindow(recordId, current);
      // An unknown private target is not a new conversation. Known agent/shared conversations may legitimately be
      // empty; a successful Space read already confirms membership and existence through that Space's owner.
      const emptyAllowed = context.kind === 'space' || (context.kind === 'ai' && context.everyone)
        || (contexts.has(recordId) && !persisted.has(recordId) && conversationRows.get(recordId)?.messageCount === 0);
      if (!emptyAllowed && !page.lines.length) {
        throw Object.assign(new Error('This conversation could not be found. Open Messages to choose another conversation.'), { status: 404 });
      }
      if (page.lines.length) persisted.add(recordId);
      if (!conversationRows.has(recordId)) {
        const latest = page.lines.at(-1);
        row(context, context.kind === 'space' ? 'Conversation' : context.everyone ? EVERYONE_LABEL : context.app,
          latest?.timestamp ?? null, latest ? { text: latest.content, mine: latest.role === 'human' } : undefined);
      }
      opened.add(recordId);
      shownPages.set(view.sessionId, { recordId, page });
      showRecords({ ...conversationRecords(), [view.sessionId]: windowOf(recordId, page, view.sessionId) });
    } catch (error) {
      const current = openedWindows.get(view.sessionId);
      if (current && current !== view) return publishWindow(recordId, current);
      if (!canRetainAfterReadFailure(error)) showRecords({ [view.sessionId]: null });
      throw error;
    }
  })();
  readingWindows.set(view.sessionId, { view, request, invalidate: () => { invalidated = true; } });
  try { await request; } finally { if (readingWindows.get(view.sessionId)?.request === request) readingWindows.delete(view.sessionId); }
}

function selectWindow(recordId: string, sessionId: string, messageId?: string): OpenWindow {
  const current = openedWindows.get(sessionId);
  if (current?.recordId === recordId && current.messageId === messageId) return current;
  const view = { recordId, sessionId, ...(messageId ? { messageId } : {}) };
  openedWindows.set(sessionId, view);
  return view;
}

const participants = new Map<string, { label: string; metadata: Record<string, string> }>();
/** Who a conversation is with, by name and mark: what the chat's participant feed reads. */
function participantOf(context: Context, title: string) {
  const ref = context.kind === 'space' ? `space:${context.space_id}` : `app:${context.app}`;
  if (participants.has(ref)) return ref;
  const slug = context.kind === 'ai' ? (providerNames.names as Record<string, string>)[context.app] : undefined;
  const logo = slug ? resolveProviderMark({ providerSlug: slug, providerName: context.app }, providerIconRegistry)?.image : null;
  participants.set(ref, {
    label: title,
    metadata: logo ? { logo_url: logo } : context.kind === 'space' ? { icon_name: 'Users' } : context.kind === 'ai' && context.everyone ? { icon_name: 'Sparkles' } : { icon_name: 'Bot' },
  });
  return ref;
}
const participantFeed = () => [...participants].flatMap(([ref, participant]) => [
  { subject_id: ref, property_id: 'prop:addressed_participant:participant_ref', value: ref },
  { subject_id: ref, property_id: 'prop:addressed_participant:label', value: participant.label },
  { subject_id: ref, property_id: 'prop:addressed_participant:metadata', value: participant.metadata },
]);

function row(context: Context, title: string, at: string | null, preview?: { text: string; mine: boolean }): {
  recordId: string; sessionId: string; filePath: string; title: string; participantRef: string; participantRefs: string[];
  startedAt: string; lastActivityAt: string; messageCount: number; lastMessagePreview: string | null; lastMessageRole: string | null;
  sendCapability: { frontDoorAction: string; channel: string; destinationId: string }; sendRef: string;
} {
  const recordId = recordIdOf(context);
  contexts.set(recordId, context);
  const participantRef = participantOf(context, title);
  const value = {
    recordId, sessionId: windowAddressOf(recordId), filePath: recordId, title,
    participantRef, participantRefs: [participantRef],
    startedAt: at ?? '', lastActivityAt: at ?? '', messageCount: preview ? 1 : 0,
    lastMessagePreview: preview?.text ?? null, lastMessageRole: preview ? (preview.mine ? 'human' : 'assistant') : null,
    sendCapability: { frontDoorAction: SEND, channel: context.kind === 'space' ? 'space' : 'ai', destinationId: recordId },
    sendRef: recordId,
  };
  conversationRows.set(recordId, value);
  return value;
}

/** Keep directly resolved open targets alongside the preview page, so a later roster refresh cannot erase the
 *  selected conversation's identity. The preview remains a list optimization, never the authority for a target. */
function conversationRecords() {
  const listed = new Set(listedRows.map(one => one.recordId));
  const rows = [...listedRows, ...[...opened].filter(id => !listed.has(id)).flatMap(id => conversationRows.get(id) ?? [])];
  return {
    'addressed-exchange-participants': participantFeed(),
    [CONVERSATIONS_ADDRESS]: { version: 1, window_key: 'latest', rows, limit: rows.length, total_count: rows.length, total_count_known: true, has_older: false },
  };
}

/** Every conversation in the person's work contexts, as the chat's session window. */
async function readConversations() {
  const [threads, agents, spaces] = await Promise.all([
    readCollectionJson<{ conversations: Thread[]; backfill_pending?: boolean }>(`${API}/threads?limit=50`),
    readAgents().catch(() => ({ agents: [] as Agent[] })),
    readJson<{ spaces: Space[] }>('/work/api/spaces').catch(() => ({ spaces: [] as Space[] })),
  ]);
  const rows = [];
  let everyone = false;
  for (const thread of threads.conversations) {
    persisted.add(recordIdOf({ kind: 'ai', app: thread.app, conversation_id: thread.conversation_id }));
    const shared = thread.app === SHARED.app && thread.conversation_id === SHARED.conversation_id;
    everyone ||= shared;
    const agent = agentFor(thread, agents.agents);
    rows.push(row({ kind: 'ai', app: thread.app, conversation_id: thread.conversation_id, ...(agent ? { agent_id: agent.agent_id } : {}), ...(shared ? { everyone: true } : {}) },
      shared ? EVERYONE_LABEL : thread.app, thread.latest.at, { text: authorOf(thread.latest.speaker) ? `${thread.latest.speaker}: ${thread.latest.text}` : thread.latest.text, mine: thread.latest.speaker === 'person' }));
  }
  if (!everyone) rows.push(row({ kind: 'ai', ...SHARED, everyone: true }, EVERYONE_LABEL, null));
  for (const agent of agents.agents) {
    if (threads.conversations.some(thread => thread.app === agent.name)) continue;
    rows.push(row({ kind: 'ai', app: agent.name, conversation_id: `trillion:${agent.agent_id}`, agent_id: agent.agent_id }, agent.name, null));
  }
  for (const space of spaces.spaces) rows.push(row({ kind: 'space', space_id: space.space_id }, space.title, space.last_activity_at));
  listedRows = rows;
  showRecords(conversationRecords());
  return threads.backfill_pending === true;
}

/** `@Name` in the words, resolved against what this context lets the person mention. */
async function mentionsIn(text: string, space?: string) {
  if (!text.includes('@')) return { mentions: [] as Mention[], kinds: {} as Record<string, { hands_off?: boolean }> };
  const answer = await readJson<{ kinds?: Record<string, { hands_off?: boolean }>; candidates?: Mention[] }>(`/work/api/mentions?${new URLSearchParams(space ? { space } : {})}`).catch(() => null);
  const candidates = [...(answer?.candidates ?? [])].sort((a, b) => b.label.length - a.label.length);
  const mentions: Mention[] = [];
  let rest = text;
  for (const candidate of candidates) {
    const at = rest.indexOf(`@${candidate.label}`);
    if (at < 0) continue;
    mentions.push({ kind: candidate.kind, value: candidate.value, label: candidate.label });
    rest = `${rest.slice(0, at)}${' '.repeat(candidate.label.length + 1)}${rest.slice(at + candidate.label.length + 1)}`;
  }
  return { mentions, kinds: answer?.kinds ?? {} };
}

async function send(recordId: string, text: string) {
  const context = contexts.get(recordId);
  if (!context) throw new Error('This conversation is not open any more.');
  if (context.kind === 'space') {
    const space = `/work/api/spaces/${encodeURIComponent(context.space_id)}`;
    const { mentions, kinds } = await mentionsIn(text, context.space_id);
    await postJson(`${space}/items`, { items: [{ kind: 'message', body: { text, ...(mentions.length ? { mentions } : {}) } }] });
    for (const mention of mentions.filter(one => kinds[one.kind]?.hands_off)) {
      await postJson(`${space}/handoffs`, { job: text, request_key: crypto.randomUUID(), to_agent: mention.value });
    }
  } else if (context.everyone) {
    const { mentions } = await mentionsIn(text);
    // Through the device outbox: kept here before it is posted, shown at once, and sent again under the same client_id
    // until the account answers (share-outbox.ts). An unreachable account is told as waiting, not failed.
    await shareOutbox.deliver({ text, files: [], mentions }, { path: `${API}/send-all`, key_field: 'client_id' }, { conversation: recordId, text });
  } else {
    // A directly opened older conversation may never appear in the preview roster. Resolve its registered AI
    // before sending too, so saving a reply does not silently skip the AI's existing delivery channel.
    const agent_id = context.agent_id ?? agentFor(context, (await readAgents()).agents)?.agent_id;
    if (agent_id) contexts.set(recordId, { ...context, agent_id });
    // Through the device outbox like the Home box: kept here first, shown at once, and sent again under the same client_id.
    await shareOutbox.deliver({ agent_id, app: context.app, conversation_id: context.conversation_id, text, files: [] }, { path: `${API}/send`, key_field: 'client_id' }, { conversation: recordId, text });
  }
  opened.add(recordId);
  await Promise.allSettled([publishWindow(recordId), readConversations()]);
}

// A change to what this device is keeping (a message kept, sent, resent or let go) redraws the windows it ends at once.
let followingOutbox = false;
function followOutbox() {
  if (followingOutbox) return;
  followingOutbox = true;
  shareOutbox.subscribe(() => {
    for (const [sessionId, shown] of shownPages) showRecords({ [sessionId]: windowOf(shown.recordId, shown.page, sessionId) });
  });
}

/** Sends a message waiting on this device again now (its echo's reference); says how it went in the person's words. */
export async function resendPending(atomRef: string): Promise<string> {
  const key = pendingKeyOf(atomRef);
  const state = key ? await shareOutbox.resend(key) : 'gone';
  if (state === 'sent') await Promise.allSettled([...openedWindows.values()].map(view => publishWindow(view.recordId, view)));
  return state === 'sent' ? pendingWords.resent : state === 'kept' ? pendingWords.still_waiting : pendingWords.gone;
}

/** Lets a message waiting on this device go unsent (its echo's reference); false when none was waiting. */
export function cancelPending(atomRef: string): boolean {
  const key = pendingKeyOf(atomRef);
  return key ? shareOutbox.cancel(key) : false;
}

/** Keeps one conversation's latest messages published to its window, and following the person's store, whoever reads
 *  it (the chat, or any other view of the conversation). */
export async function followConversation(recordId: string, messageId?: string): Promise<void> {
  const canonical = canonicalConversationId(recordId);
  const sessionId = windowAddressOf(canonical, messageId);
  await publishWindow(canonical, openedWindows.get(sessionId) ?? { recordId: canonical, sessionId, ...(messageId ? { messageId } : {}) });
}

/** An explicit target can be read even while the unrelated preview roster is slow or unavailable. Only an empty
 *  target needs roster confirmation that it is a legitimate new conversation, before it can offer the composer. */
export async function openConversation(recordId: string, messageId?: string, restoreAnchor = true): Promise<void> {
  const canonical = canonicalConversationId(recordId);
  const sessionId = windowAddressOf(canonical, messageId);
  // A fresh navigation restores that link's requested anchor, independently of another view of this conversation.
  if (restoreAnchor) {
    selectWindow(canonical, sessionId, messageId);
    if (messageId && readRecordAt<{ anchor_message_id?: string }>(sessionId)?.anchor_message_id !== messageId) {
      showRecords({ [sessionId]: null });
    }
  }
  const roster = startChatRecords().then(() => true, () => false);
  try { await followConversation(canonical, messageId); }
  catch (error) {
    if (messageId || (error as { status?: number })?.status !== 404 || !(await roster)) throw error;
    await followConversation(canonical);
  }
}

/** Writes words into one conversation through its own front door, the way the chat sends them. */
export const sendInConversation = (recordId: string, text: string) => send(canonicalConversationId(recordId), text);

type Execute = { operation?: string; definition_id?: string; input?: Record<string, unknown> };
answerTarget('slot::workflow', async request => {
  const { definition_id = '', input = {} } = (request ?? {}) as Execute;
  if (definition_id === SEND) {
    await send(String(input.recipient ?? ''), String(input.body ?? ''));
    return { status: 'completed', output: { sent: true } };
  }
  const recordId = canonicalConversationId(String(input.file_path ?? ''));
  const context = contextFor(recordId);
  const sessionId = typeof input.session_id === 'string' ? input.session_id : windowAddressOf(recordId);
  const knownView = openedWindows.get(sessionId);
  const view = knownView?.recordId === recordId ? knownView : { recordId, sessionId: windowAddressOf(recordId) };
  const cursor = input.before_byte_offset as { revision?: unknown } | null;
  if (cursor && typeof cursor.revision === 'string') {
    // Show older: the next page, answered inline; the chat joins it above the window it has.
    return { status: 'completed', output: windowOf(recordId, await readPage(context, cursor.revision), view.sessionId) };
  }
  const selected = input.show_latest === true ? selectWindow(recordId, view.sessionId) : view;
  await publishWindow(recordId, selected);
  if (input.show_latest === true) return { status: 'completed', output: readRecordAt(selected.sessionId) };
  // Published to its window, which the chat reads (and which follows every change to the person's store).
  return { status: 'completed', output: { writes_emitted: 1 } };
}, { handles: request => [SEND, READ].includes(String((request as Execute | null)?.definition_id ?? '')) });

/** Reads the preview roster (and follows the store once). Concurrent readers share the read; a retry or later
 *  mount makes a fresh read instead of inheriting a failed or permanently stale initial promise. */
export function startChatRecords(): Promise<void> {
  followOutbox();
  if (ready) return ready;
  const request = (async () => {
    let pending = await readConversations();
    // Older messages predate the conversation index; each read indexes one more page of them.
    for (let pass = 0; pending && pass < 20; pass += 1) pending = await readConversations();
  })();
  ready = request.finally(() => { ready = null; });
  if (!followingStore) {
    followingStore = true;
    // The spaces list arrives as the socket's second message (each person named once, each space naming them by id): the
    // conversation list takes its space rows from it without asking again.
    onLiveEvent('supplemental', batch => {
      for (const event of batch as unknown as { name?: string; bundle?: Parameters<typeof resolveBundle>[0] }[]) {
        if (event.name !== 'spaces' || !event.bundle) continue;
        const spaces = resolveBundle(event.bundle).lists.spaces as unknown as Space[];
        listedRows = [...listedRows.filter(one => contexts.get(one.recordId)?.kind !== 'space'), ...spaces.map(space => row({ kind: 'space', space_id: space.space_id }, space.title, space.last_activity_at))];
        showRecords(conversationRecords());
      }
    });
    onStoreChange(async () => {
      // A change received during an older read needs one fresh answer after that read settles. Coalescing readers
      // must not coalesce away the invalidation and publish a reply captured before the change.
      for (const reading of readingWindows.values()) reading.invalidate();
      await Promise.allSettled([startChatRecords(), ...[...openedWindows.values()].map(view => publishWindow(view.recordId, view))]);
    }, AI_MESSAGES);
  }
  return ready;
}
