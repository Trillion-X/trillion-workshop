// src/workspace/chat-records.ts
//
// PURPOSE
//   The Messages screen's records seam. The person's conversations are rows of their own owners' tables
//   (messages-owner.json): the messages their apps told (`statements`, place message) and the conversations kept with
//   their AIs (`old_store.w_message`). Each is read in SQL through tool:run-sql-in-my-database with the store's own
//   connection, the same run an AI makes. This file publishes the conversation list (`chat-session-window`) and each
//   open conversation's lines (`selected-chat-message-window:<conversation>`), and forgets one told message by setting
//   its erased_at. AI threads, agents, Spaces and @mentions have no owner in this version, so they are not listed, and
//   replying is refused in plain words (messages-words.json `no_reply`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every read and write is the owner's SQL run on the store's connection. The only /work/api address called here is
//      the door that names the vault's connections (messages-owner.json `names_method`), names only.
//   2. Lines are oldest first; equal times keep the order of a page read newest first (the later is the older).
//   3. A conversation is named `<store>|<source>` and its chat, so its lines are read again from the store that listed it.
//   4. Nothing here words anything on screen except each conversation's own name and who it is with: the screen's words
//      come from messages-words.json.

import { providerIconRegistry, resolveProviderMark } from '../../../../ui';
import { canRetainAfterReadFailure } from '../../../../ui/show/screen-state';
import { answerTarget, readRecordAt, showRecords } from './records';
import providerNames from './activity-providers.json';
import { postJson } from './api';
import { contextOfRecordId, recordIdOf as conversationIdOf } from './conversation-navigation-rows.mjs';
import { AI_MESSAGES, onStoreChange } from './store-changes';
import { runWorkshopTool } from './workshop-tool-api';
import owner from './messages-owner.json';
import words from './messages-words.json';
import { timeOfText } from './messages-turns';

type Media = { identity?: string; name?: string; media_type?: string };
type Said = { id: string; at: string; words: string | null; mine: boolean | null; author: string | null; media: string };
type Store = { id: string; credential_name?: string; credential_suffix?: string; list: string; page: string; forget?: string };
type Chat = { source: string; chat: string; last: string; name: string | null; words: string | null; mine: boolean | null; sender: string | null };
export type Line = { type: 'text'; role: 'human' | 'assistant'; content: string; timestamp: string; atomRef: string; author?: string; forgettable?: boolean; files?: { key: string; name: string; url: string; contentType: string }[] };
type Context = { kind: 'ai'; app: string; conversation_id: string };
type Page = { lines: Line[]; next: string | null };

const SEND = 'action:send-in-trillion-conversation';
const READ = 'action:read-chat-session-transcript-page';
/** The record every conversation's row is published in (one row per conversation, its title among them). */
export const CONVERSATIONS_ADDRESS = 'chat-session-window';
export const windowAddressOf = (recordId: string) => `selected-chat-message-window:${recordId}`;
/** Equivalent URL encodings still name one conversation everywhere the screen and window use it. */
export const canonicalConversationId = (recordId: string): string => {
  const context = contextOfRecordId(recordId);
  return context ? conversationIdOf(context) : recordId;
};

const timeOf = (at: string) => { const time = timeOfText(at); return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY; };

const contexts = new Map<string, Context>();
const opened = new Set<string>();
const shownPages = new Map<string, Page>();
const conversationRows = new Map<string, ReturnType<typeof row>>();
const readingWindows = new Map<string, { request: Promise<void>; invalidate: () => void }>();
/** Each told line the screen can forget, by its atom reference: its store and its statement id. */
const toldLines = new Map<string, { store: Store; id: string }>();
let listedRows: ReturnType<typeof row>[] = [];
let ready: Promise<void> | null = null;
let followingStore = false;

const stores = owner.stores as Store[];
const storeApps = new Map<string, { store: Store; source: string }>();
const storeRows = <T,>(store: Store, sql: string, params: unknown[]) =>
  runWorkshopTool<{ rows?: T[] }>(owner.tool, { credential_name: store.credential_name, sql, params }).then(ran => {
    if (!Array.isArray(ran.result?.rows)) throw new Error(words.failed_title);
    return ran.result.rows;
  });
/** Each store with its connection: a named one as it is, a suffix once for each connection the vault names with it. */
async function storesWithConnections(): Promise<Store[]> {
  if (!stores.some(store => store.credential_suffix)) return stores;
  const names = await postJson<{ names?: unknown }>(owner.names_method, {}).then(answer => (Array.isArray(answer?.names) ? answer.names as string[] : []), () => [] as string[]);
  return stores.flatMap(store => (store.credential_suffix
    ? names.filter(name => name.endsWith(store.credential_suffix!)).sort().map(name => ({ ...store, id: `${store.id}@${name}`, credential_name: name }))
    : [store]));
}
/** Every store's newest conversations; a store that cannot be read (or has no such tables) is left out, the others still list. */
const readStoreChats = async () => (await Promise.all((await storesWithConnections()).map(store => storeRows<Chat>(store, store.list, [owner.most_conversations]).then(
  chats => chats.map(chat => ({ store, chat })),
  () => [] as { store: Store; chat: Chat }[])))).flat();

const oldestFirst = (lines: Line[]) => lines.map((line, index) => ({ line, index, time: timeOf(line.timestamp) }))
  .sort((a, b) => (a.time - b.time) || (b.index - a.index)).map(entry => entry.line);

function lineOf(store: Store, said: Said): Line {
  const media: Media[] = JSON.parse(said.media || '[]');
  const atomRef = `${store.id}:${said.id}`;
  if (store.forget) toldLines.set(atomRef, { store, id: said.id });
  return {
    type: 'text', role: said.mine ? 'human' : 'assistant', atomRef, content: said.words ?? '', timestamp: said.at,
    ...(said.author ? { author: said.author } : {}),
    // The file's bytes are not reachable from here: a photo shows its name and kind, never a picture from another store.
    ...(media.length ? { files: media.map(file => ({ key: file.identity ?? '', name: file.name ?? '', url: '', contentType: file.media_type ?? 'application/octet-stream' })) } : {}),
    ...(store.forget ? { forgettable: true } : {}),
  };
}

/** One page of a store's conversation, newest first from the store, oldest first on the screen. */
async function readStorePage(context: Context, before?: string): Promise<Page> {
  const { store, source } = storeApps.get(context.app)!;
  const rows = await storeRows<Said>(store, store.page, [source, context.conversation_id, before ?? null, owner.page]);
  return {
    next: rows.length === owner.page ? rows.at(-1)!.at : null,
    lines: oldestFirst(rows.map(said => lineOf(store, said))),
  };
}

function contextFor(recordId: string): Context {
  const known = contexts.get(recordId);
  if (known) return known;
  const decoded = contextOfRecordId(recordId) as Context | null;
  if (!decoded || decoded.kind !== 'ai' || !storeApps.has(decoded.app)) {
    throw Object.assign(new Error(words.not_found), { status: 404 });
  }
  return decoded;
}

const windowOf = (recordId: string, page: Page) => ({
  version: 1, session_id: windowAddressOf(recordId), window_key: 'latest',
  lines: page.lines,
  limit: page.lines.length, total_count: page.next ? null : page.lines.length, total_count_known: !page.next,
  has_older: Boolean(page.next), has_newer: false,
  older_cursor: page.next ? { version: 1, path: recordId, revision: page.next, total_length: 1, before_offset: 0 } : null,
  file_path: recordId,
});

/** Reads one conversation's newest page and publishes it as its window. Concurrent readers share the read; a store
 *  change during a read reads again (readingWindows invalidate), so a reply is never shown from before the change. */
async function publishWindow(recordId: string): Promise<void> {
  const reading = readingWindows.get(recordId);
  if (reading) return reading.request;
  let invalidated = false;
  const request = (async () => {
    try {
      const context = contextFor(recordId);
      let page: Page;
      do {
        invalidated = false;
        page = await readStorePage(context);
      } while (invalidated);
      shownPages.set(recordId, page);
      opened.add(recordId);
      showRecords({ ...conversationRecords(), [windowAddressOf(recordId)]: windowOf(recordId, page) });
    } catch (error) {
      if (!canRetainAfterReadFailure(error)) showRecords({ [windowAddressOf(recordId)]: null });
      throw error;
    }
  })();
  readingWindows.set(recordId, { request, invalidate: () => { invalidated = true; } });
  try { await request; } finally { if (readingWindows.get(recordId)?.request === request) readingWindows.delete(recordId); }
}

const participants = new Map<string, { label: string; metadata: Record<string, string> }>();
/** The mark a conversation's app is drawn with (its picture from activity-providers.json); null otherwise, so the screen draws initials. */
function logoOf(app: string): string | null {
  const source = storeApps.get(app)?.source ?? app;
  const slug = (providerNames.names as Record<string, string>)[source];
  return slug ? resolveProviderMark({ providerSlug: slug, providerName: source }, providerIconRegistry)?.image ?? null : null;
}
/** Who a conversation is with, by name and mark: what the chat's participant feed reads. */
function participantOf(context: Context, title: string, logo: string | null) {
  const ref = `app:${context.app}`;
  if (!participants.has(ref)) participants.set(ref, { label: title, metadata: logo ? { logo_url: logo } : { icon_name: 'User' } });
  return ref;
}
const participantFeed = () => [...participants].flatMap(([ref, participant]) => [
  { subject_id: ref, property_id: 'prop:addressed_participant:participant_ref', value: ref },
  { subject_id: ref, property_id: 'prop:addressed_participant:label', value: participant.label },
  { subject_id: ref, property_id: 'prop:addressed_participant:metadata', value: participant.metadata },
]);

function row(context: Context, title: string, at: string | null, preview?: { text: string; mine: boolean }) {
  const recordId = conversationIdOf(context);
  contexts.set(recordId, context);
  const logoUrl = logoOf(context.app);
  const participantRef = participantOf(context, title, logoUrl);
  const value = {
    recordId, sessionId: windowAddressOf(recordId), filePath: recordId, title, logoUrl, source: storeApps.get(context.app)?.source ?? '',
    participantRef, participantRefs: [participantRef],
    startedAt: at ?? '', lastActivityAt: at ?? '', messageCount: preview ? 1 : 0,
    lastMessagePreview: preview?.text ?? null, lastMessageRole: preview ? (preview.mine ? 'human' : 'assistant') : null,
    sendCapability: { frontDoorAction: SEND, channel: 'ai', destinationId: recordId },
    sendRef: recordId,
  };
  conversationRows.set(recordId, value);
  return value;
}

/** The conversations the list holds, plus each one this screen has opened, so a refresh cannot erase an open target. */
function conversationRecords() {
  const listed = new Set(listedRows.map(one => one.recordId));
  const rows = [...listedRows, ...[...opened].filter(id => !listed.has(id)).flatMap(id => conversationRows.get(id) ?? [])];
  return {
    'addressed-exchange-participants': participantFeed(),
    [CONVERSATIONS_ADDRESS]: { version: 1, window_key: 'latest', rows, limit: rows.length, total_count: rows.length, total_count_known: true, has_older: false },
  };
}

/** Every conversation in the person's stores, newest first. */
async function readConversations(): Promise<void> {
  const chats = await readStoreChats();
  const rows = [];
  for (const { store, chat } of chats) {
    const app = `${store.id}|${chat.source}`;
    storeApps.set(app, { store, source: chat.source });
    rows.push(row({ kind: 'ai', app, conversation_id: chat.chat }, chat.name || chat.sender || chat.source, chat.last,
      chat.words !== null ? { text: chat.words, mine: chat.mine === true } : undefined));
  }
  rows.sort((a, b) => (timeOfText(b.lastActivityAt) || 0) - (timeOfText(a.lastActivityAt) || 0));
  listedRows = rows;
  showRecords(conversationRecords());
}

/** Forgets one of the person's told messages: its statement is marked erased in its store, then its conversation is read again. */
export async function forgetInConversation(recordId: string, atomRef: string): Promise<void> {
  const told = toldLines.get(atomRef);
  if (!told) throw new Error(words.forget_gone);
  const erased = await storeRows<{ id: string }>(told.store, told.store.forget!, [told.id]);
  if (!erased.length) throw new Error(words.forget_gone);
  toldLines.delete(atomRef);
  await publishWindow(canonicalConversationId(recordId));
}

type Execute = { operation?: string; definition_id?: string; input?: Record<string, unknown> };
answerTarget('slot::workflow', async request => {
  const { definition_id = '', input = {} } = (request ?? {}) as Execute;
  if (definition_id === SEND) throw new Error(words.no_reply);
  const recordId = canonicalConversationId(String(input.file_path ?? ''));
  const cursor = input.before_byte_offset as { revision?: unknown } | null;
  if (cursor && typeof cursor.revision === 'string') {
    // Show older: the next page, answered inline; the screen joins it above the window it has.
    return { status: 'completed', output: windowOf(recordId, await readStorePage(contextFor(recordId), cursor.revision)) };
  }
  await publishWindow(recordId);
  if (input.show_latest === true) return { status: 'completed', output: readRecordAt(windowAddressOf(recordId)) };
  // Published to its window, which the chat reads (and which follows every change to the person's store).
  return { status: 'completed', output: { writes_emitted: 1 } };
}, { handles: request => [SEND, READ].includes(String((request as Execute | null)?.definition_id ?? '')) });

/** Reads the conversation list (and follows the store once). Concurrent readers share the read; a retry or later mount
 *  makes a fresh read instead of inheriting a failed or permanently stale initial promise. */
export function startChatRecords(): Promise<void> {
  if (ready) return ready;
  ready = readConversations().finally(() => { ready = null; });
  if (!followingStore) {
    followingStore = true;
    onStoreChange(async () => {
      // A change received during an older read needs one fresh answer after that read settles. Coalescing readers
      // must not coalesce away the invalidation and publish a reply captured before the change.
      for (const reading of readingWindows.values()) reading.invalidate();
      await Promise.allSettled([startChatRecords(), ...[...shownPages.keys()].map(recordId => publishWindow(recordId))]);
    }, AI_MESSAGES);
  }
  return ready;
}

/** Reads one conversation's newest messages and publishes them to its window. */
export async function openConversation(recordId: string): Promise<void> {
  await publishWindow(canonicalConversationId(recordId));
}
