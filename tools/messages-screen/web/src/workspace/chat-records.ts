// src/workspace/chat-records.ts
//
// PURPOSE
//   The Messages screen's records seam. The person's conversations are rows of their own owners' tables
//   (messages-owner.json): the messages their apps told (`statements`, place message) and the conversations kept with
//   their AIs (`old_store.w_message`). Each is read in SQL through tool:run-sql-in-my-database with the store's own
//   connection, the same run an AI makes. A handle is named by the person's Mac Contacts (the contact rows in
//   the Mac Contacts rows named by the owner-places record, read once and matched on the last ten digits). This file publishes the conversation list
//   (`chat-session-window`) and each open conversation's lines (`selected-chat-message-window:<conversation>`), and
//   forgets one told message by setting its erased_at. AI threads, agents, Spaces and @mentions have no owner in this
//   version, so they are not listed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every read and write is the owner's SQL run on the store's connection. No /work/api address is called here.
//   2. Lines are oldest first; equal times keep the order of a page read newest first (the later is the older).
//   3. A conversation is named `<store>|<source>` and its chat, so its lines are read again from the store that listed it.
//   4. Nothing here words anything on screen except each conversation's own name and who it is with: the screen's words
//      come from messages-words.json.
//   5. At most two store reads are in flight; the list is drawn again after each store lands, so what is kept shows first.

import { providerIconRegistry, resolveProviderMark } from '../../../../ui';
import { canRetainAfterReadFailure } from '../../../../ui/show/screen-state';
import { answerTarget, readRecordAt, showRecords } from './records';
import providerNames from './activity-providers.json';
import { contextOfRecordId, recordIdOf as conversationIdOf } from './conversation-navigation-rows.mjs';
import { AI_MESSAGES, onStoreChange } from './store-changes';
import { runWorkshopTool } from './workshop-tool-api';
import owner from './messages-owner.json';
import words from './messages-words.json';
import { timeOfText } from './messages-turns';
import { plainPreview } from './plain-preview';

type Media = { identity?: string; name?: string; media_type?: string };
type Said = { id: string; at: string; words: string | null; mine: boolean | null; author: string | null; media: string };
type Store = { id: string; credential_name: string; list: string; page: string; forget?: string; reply_source?: string };
type Chat = { source: string; chat: string; last: string; name: string | null; words: string | null; mine: boolean | null; sender: string | null };
/** A reply the person sent from here: waiting to go, gone, or not sent (it stays until sent again or let go). */
type Delivery = 'sending' | 'sent' | 'failed';
export type Line = { type: 'text'; role: 'human' | 'assistant'; content: string; timestamp: string; atomRef: string; author?: string; forgettable?: boolean; delivery?: Delivery; files?: { key: string; name: string; url: string; contentType: string }[] };
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
/** The store's conversations, as each store answered them (a store that failed answers none). */
const chatsOf = new Map<string, { store: Store; chat: Chat }[]>();
/** Each conversation a reply can go to: the one person its one-to-one chat names (only where the store names reply_source). */
const replyTo = new Map<string, string>();
/** The replies sent from here, per conversation, each shown until the store has it (or it is let go). */
type Reply = { id: string; recordId: string; text: string; at: string; state: Delivery; error?: string };
const repliesOf = new Map<string, Reply[]>();
let replySeq = 0;
let listedRows: ReturnType<typeof row>[] = [];
let ready: Promise<void> | null = null;
let followingStore = false;

type StoreDef = { id: string; role: string; titles_role?: string; reply_source?: string; list: string; page: string; forget?: string };
type Place = { credential_name: string; table: string };
const storeDefs = owner.stores as StoreDef[];
/** Where each role's data is kept, from the owner-places record in the person's own records; null until it is written. */
let places: Map<string, Place> | null = null;
let placesSet = false;
const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** A statement with its {table} and {titles} filled in from the record; a name that is not a plain table name is refused. */
const fillSql = (sql: string, tables: Record<string, string>): string => sql.replace(/\{(\w+)\}/g, (_, key: string) => {
  const table = tables[key];
  if (!table || !TABLE_NAME.test(table)) throw new Error(words.places_invalid);
  return table;
});
/** The owner-places record: its roles' connections and tables. Null when it is not written (or cannot be read). */
async function readPlaces(): Promise<Map<string, Place> | null> {
  const ran = await runWorkshopTool<{ rows?: { value: string }[] }>(owner.tool, {
    credential_name: owner.records.credential_name,
    sql: `select value from ${owner.records.table} where label = $1`,
    params: [owner.records.label],
    statement_timeout_ms: owner.statement_timeout_ms,
  }).catch(() => null);
  const value = ran?.result?.rows?.[0]?.value;
  if (!value) return null;
  const roles = (JSON.parse(value) as { roles?: Record<string, Place> }).roles ?? {};
  return new Map(Object.entries(roles));
}
/** Each store whose roles are in the record, with its statements filled in; a store missing a role is left out. */
function storesFrom(from: Map<string, Place>): Store[] {
  return storeDefs.flatMap(def => {
    const place = from.get(def.role);
    const titles = def.titles_role ? from.get(def.titles_role) : undefined;
    if (!place || (def.titles_role && !titles)) return [];
    const tables = { table: place.table, titles: titles?.table ?? '' };
    return [{
      id: def.id, credential_name: place.credential_name, reply_source: def.reply_source,
      list: fillSql(def.list, tables), page: fillSql(def.page, tables),
      ...(def.forget ? { forget: fillSql(def.forget, tables) } : {}),
    }];
  });
}

const storeApps = new Map<string, { store: Store; source: string }>();
const storeRows = <T,>(store: { credential_name: string }, sql: string, params: unknown[]) =>
  runWorkshopTool<{ rows?: T[] }>(owner.tool, { credential_name: store.credential_name, sql, params, statement_timeout_ms: owner.statement_timeout_ms }).then(ran => {
    if (!Array.isArray(ran.result?.rows)) throw new Error(words.failed_title);
    return ran.result.rows;
  });

// The person's contacts: each Mac Contact's digits and name, keyed by the last ten digits of its number.
const contactNames = new Map<string, string>();
let contactsRead: Promise<void> | null = null;
let contactsFrom = '';
const lastTen = (handle: string): string | null => {
  const digits = handle.replace(/\D/g, '');
  return digits.length >= 7 && !handle.includes('@') ? digits.slice(-10) : null;
};
/** The contact's name for a handle (a phone number), or null when no contact has it. */
export const contactNameFor = (handle: string | null | undefined): string | null => {
  const key = handle ? lastTen(handle) : null;
  return key ? contactNames.get(key) ?? null : null;
};
/** Reads the Mac Contacts once per place the record names them in (none until the record is written). */
function readContactNames(): Promise<void> {
  const place = places?.get(owner.contacts.role) as Place | undefined;
  if (!place) return Promise.resolve();
  const from = `${place.credential_name}|${place.table}`;
  if (contactsRead && contactsFrom === from) return contactsRead;
  contactsFrom = from;
  contactsRead = storeRows<{ digits: string; name: string }>(place, fillSql(owner.contacts.list, { table: place.table }), [owner.contacts.most]).then(rows => {
    for (const contact of rows) {
      const key = lastTen(contact.digits);
      if (key && contact.name) contactNames.set(key, contact.name);
    }
  }, () => { contactsRead = null; });
  return contactsRead;
}

/** Runs the tasks, at most `limit` at a time, in order. */
async function inPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  const queue = [...tasks];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) await task();
  }));
}

const oldestFirst = (lines: Line[]) => lines.map((line, index) => ({ line, index, time: timeOf(line.timestamp) }))
  .sort((a, b) => (a.time - b.time) || (b.index - a.index)).map(entry => entry.line);

function lineOf(store: Store, said: Said): Line {
  const media: Media[] = JSON.parse(said.media || '[]');
  const atomRef = `${store.id}:${said.id}`;
  if (store.forget) toldLines.set(atomRef, { store, id: said.id });
  const author = said.author ? contactNameFor(said.author) ?? said.author : null;
  return {
    type: 'text', role: said.mine ? 'human' : 'assistant', atomRef, content: said.words ?? '', timestamp: said.at,
    ...(author ? { author } : {}),
    // The file's bytes are not reachable from here: a photo shows its name and kind, never a picture from another store.
    ...(media.length ? { files: media.map(file => ({ key: file.identity ?? '', name: file.name ?? '', url: '', contentType: file.media_type ?? 'application/octet-stream' })) } : {}),
    ...(store.forget ? { forgettable: true } : {}),
  };
}

/** One page of a store's conversation, newest first from the store, oldest first on the screen. */
async function readStorePage(context: Context, before?: string): Promise<Page> {
  const { store, source } = storeApps.get(context.app)!;
  await readContactNames();
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
      showRecords({ ...conversationRecords(), [windowAddressOf(recordId)]: windowOf(recordId, withReplies(recordId, page)) });
    } catch (error) {
      if (!canRetainAfterReadFailure(error)) showRecords({ [windowAddressOf(recordId)]: null });
      throw error;
    }
  })();
  readingWindows.set(recordId, { request, invalidate: () => { invalidated = true; } });
  try { await request; } finally { if (readingWindows.get(recordId)?.request === request) readingWindows.delete(recordId); }
}

/** The page with the replies sent from here after its newest line. A sent reply the store now has is let go. */
function withReplies(recordId: string, page: Page): Page {
  const kept = (repliesOf.get(recordId) ?? []).filter(reply => !(reply.state === 'sent' && page.lines.some(line => line.role === 'human' && line.content === reply.text)));
  repliesOf.set(recordId, kept);
  if (!kept.length) return page;
  const lines: Line[] = kept.map(reply => ({ type: 'text', role: 'human', atomRef: reply.id, content: reply.text, timestamp: reply.at, delivery: reply.state }));
  return { ...page, lines: [...page.lines, ...lines] };
}

/** Sends one reply from here to the one person its conversation names, through the Mac's Messages (owner.reply).
 *  It shows at once as sending, and as not sent (Try again, Don't send) when the Mac does not send it. */
export async function sendInConversation(recordId: string, text: string): Promise<void> {
  const canonical = canonicalConversationId(recordId);
  if (!replyTo.has(canonical)) throw new Error(words.send_refused);
  const reply: Reply = { id: `reply:${++replySeq}`, recordId: canonical, text, at: new Date().toISOString(), state: 'sending' };
  repliesOf.set(canonical, [...(repliesOf.get(canonical) ?? []), reply]);
  await deliver(reply);
}

async function deliver(reply: Reply): Promise<void> {
  reply.state = 'sending';
  reply.error = undefined;
  await publishWindow(reply.recordId).catch(() => undefined);
  try {
    const ran = await runWorkshopTool<{ sent?: { recipient: string; error?: string }[] }>(owner.reply.tool, { recipients: [replyTo.get(reply.recordId)!], text: reply.text });
    const answer = ran.result?.sent?.[0];
    if (answer?.error) throw new Error(answer.error);
    reply.state = 'sent';
  } catch (error) {
    reply.state = 'failed';
    reply.error = error instanceof Error && error.message ? error.message : words.send_error;
  }
  await publishWindow(reply.recordId).catch(() => undefined);
}

function replyNamed(atomRef: string): Reply | undefined {
  for (const replies of repliesOf.values()) {
    const found = replies.find(reply => reply.id === atomRef);
    if (found) return found;
  }
  return undefined;
}

/** Sends a reply that did not go again. */
export async function resendInConversation(atomRef: string): Promise<void> {
  const reply = replyNamed(atomRef);
  if (reply?.state === 'failed') await deliver(reply);
}

/** Lets a reply that did not go be dropped (it is not sent). */
export async function cancelInConversation(atomRef: string): Promise<void> {
  const reply = replyNamed(atomRef);
  if (!reply || reply.state !== 'failed') return;
  repliesOf.set(reply.recordId, (repliesOf.get(reply.recordId) ?? []).filter(one => one !== reply));
  await publishWindow(reply.recordId).catch(() => undefined);
}

const participants = new Map<string, { label: string; metadata: Record<string, string> }>();
/** The mark a conversation's app is drawn with (its picture from activity-providers.json); null otherwise, so the screen draws a mark from the name. */
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
    canReply: replyTo.has(recordId),
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
    'messages-owner-places': { set: placesSet },
    [CONVERSATIONS_ADDRESS]: { version: 1, window_key: 'latest', rows, limit: rows.length, total_count: rows.length, total_count_known: true, has_older: false },
  };
}

/** A conversation's name: its chat's name, else the contact who has its handle, else the handle when it is one, else its source (a sender word such as 'person' or 'ai' is no name). */
const titleOf = (chat: Chat): string => chat.name || contactNameFor(chat.sender) || (chat.sender && lastTen(chat.sender) ? chat.sender : chat.source);

/** Draws the list from every store that has answered so far, newest first. */
function publishList(): void {
  const rows = [];
  for (const chats of chatsOf.values()) {
    for (const { store, chat } of chats) {
      const app = `${store.id}|${chat.source}`;
      storeApps.set(app, { store, source: chat.source });
      const recordId = conversationIdOf({ kind: 'ai', app, conversation_id: chat.chat });
      if (owner.reply.enabled && store.reply_source === chat.source && chat.chat.includes(';-;')) replyTo.set(recordId, chat.chat.split(';').at(-1)!);
      else replyTo.delete(recordId);
      rows.push(row({ kind: 'ai', app, conversation_id: chat.chat }, titleOf(chat), chat.last,
        chat.words !== null ? { text: plainPreview(chat.words), mine: chat.mine === true } : undefined));
    }
  }
  rows.sort((a, b) => (timeOfText(b.lastActivityAt) || 0) - (timeOfText(a.lastActivityAt) || 0));
  listedRows = rows;
  showRecords(conversationRecords());
}

/** Every conversation in the person's stores, newest first; each store is read once, two at a time, and drawn as it lands. */
async function readConversations(): Promise<void> {
  places = await readPlaces();
  placesSet = places !== null;
  let stores: Store[] = [];
  try { stores = places ? storesFrom(places) : []; }
  catch { placesSet = false; stores = []; }
  if (!stores.length) {
    chatsOf.clear();
    listedRows = [];
    showRecords(conversationRecords());
    return;
  }
  await inPool([
    async () => { await readContactNames(); publishList(); },
    ...stores.map(store => async () => {
      const chats = await storeRows<Chat>(store, store.list, [owner.most_conversations]).catch(() => [] as Chat[]);
      chatsOf.set(store.id, chats.map(chat => ({ store, chat })));
      publishList();
    }),
  ], 2);
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
  if (definition_id === SEND) throw new Error(words.send_refused);
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
