// src/messages.mjs
//
// Every message between a person and any of their AIs, kept in the person's own store so their other AIs can read it.
//
// Purpose
//   A person talks to several AIs (Claude, ChatGPT, Muse, Grok, Gemini...). Each AI records both sides of every turn
//   here, verbatim, and any AI on the same account reads what was said elsewhere. A message is one root record of type
//   `message` in the person's EEAF tables (decision-store.mjs), beside their decisions and pursuits, and it can name
//   what it is about (a pursuit, a decision, a tool, a file), so the words and the work link in one graph.
//
// Non-negotiable invariants
//   1. Text is kept exactly as sent. Nothing here rewrites, trims or summarizes it.
//   2. The same message recorded twice with the same time is one message, even inside one batch: its id is its time
//      plus the BLAKE3 identity of its conversation, app, speaker, time and text, and an unchanged record appends
//      nothing to the log. A message sent without `at` is stamped with the time it arrives, and the same message
//      (conversation, app, speaker, text) sent again without `at` within RESEND_MINUTES is the one already kept, so an
//      AI retrying a call never has to guess a clock (AIs asked for the time invent one). A sender that names the
//      message's place (`source_ref`, 3a) is not guessed for: the person's own composers send a fresh client id with each
//      message and the same one on a retry, so "yes" typed twice is two messages and one send retried is one.
//   2a. The same words from the person in the same conversation of an app whose transcript owner records them
//      (src/harnesses.json recorded_by_ai false) within DUPLICATE_MINUTES of each other are one
//      message, whatever times they were sent with: a transcript hook and a carrier each record a prompt once, a
//      retry records it again a moment later with a time of its own, and each copy opened its own decision and job
//      (2026-10-08: 65 prompts in a day recorded two to five times). A key made of the conversation, speaker and words
//      and the five-minute slot of the time finds the earlier copy by one point read, never a scan of the
//      conversation. A message with a `source_ref` is kept by that instead (3a). Words repeated after the window, and the
//      same words in any other app or from any other speaker, are a new message.
//   3. A message kept again with links it does not have yet (a file found after the first time) gains those links;
//      its time and id never change, and its words change only as 3a says.
//   3a. A message that names its place in the conversation it came from (`source_ref`: a chat export's node, the id
//      a chat page gives it, the item a carrier read it from) is kept once per conversation and app, however often and
//      whenever it is sent again, even without a time: the page a chat is saved from often shows none. Sent again with
//      other words (a renamed voice memo, an edited note), it is the same message with its words now: its id, time
//      and links stay, `reworded_at` says when, and the earlier words stay in the log.
//   4. Ids sort by time, so the newest messages are read a page at a time, never by reading every message.
//   5. Nothing here names an app, a speaker or a kind of thing a message is about: those are the caller's words. Who
//      recorded a message (recorded_by: the sign-in; recorded_app: its app) is the service's, never the caller's. A link
//      may name the piece of the thing it is about (`part`, src/responses.mjs), so a note on some words of a decision or
//      a moment of a recording is kept pointing at exactly that piece.
//
// Security
//   One store per person (the host's partition). Nothing is read across people.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonical } from './decision-store.mjs';
import { partFrom } from './responses.mjs';
import { canonicalApp, harnessOf, isFinalReply, transcriptHookNames } from './harnesses.mjs';
import { claimedTime, claimedTimeProblem } from './claimed-time.mjs';
import { isHybridTimestamp, receiveHybridClock, tickHybridClock } from './hybrid-clock.mjs';
import { keptLabel, sessionsCover, voiceSessions } from './voice-sessions.mjs';

const TYPE = 'message';
const KEY_TYPE = 'message-resend-key';
const SOURCE_KEY_TYPE = 'message-source-key';
const CONTENT_KEY_TYPE = 'message-content-key';
const THREAD_TYPE = 'message-thread-index';
const HLC_STATE = 'setting:hybrid-clock-state';
export const MAX_BATCH = 100;
// The most characters one kept message holds; a longer one is kept in parts (src/chat-archives.mjs inParts).
export const MAX_TEXT = 200_000;
const FILE_IDENTITY = /^(?:1f|12):[0-9a-f]{64}$/;
// scan: the most messages one read looks through, so a rare filter answers in bounded time and goes on by next_before.
const PAGE = { default: 20, max: 100, scan: 1000 };
// Retained candidate identities have a fixed memory bound. A wider discovery
// still answers normally, but conservatively rebuilds after message changes.
const SPEAKER_CACHE_IDS = 10_000;
// The Waiting on you screen asks for unnamed speakers often. Reuse the bounded
// message scan until a turn that can affect it changes. Ordinary chat traffic
// does not change indexed voices; a new clip link, renamed speaker, deleted turn
// or new matching label refreshes the answer. Before the speaker index is ready,
// every message change can shift the bounded fallback window and must refresh it.
const unnamedSpeakerCaches = new WeakMap();
// Exact top window of bounded app-major label ranges: a label admits its first `scan` turns in index order (app
// descending, then newest first), and the window is the newest `scan` admitted turns of every label. The window is
// merged newest first from each (label, app) group's newest entry (lastPerGroup), reading a group a page at a time only
// once its next turn is the newest left, so turns older than the window are never read. Each label's whole first `scan`
// turns were once read: on the founder's store that was 9,000 statements and 100,000 rows per pass of one voices read,
// out of CPU (2026-10-16). A lower app's turn is admitted only while its label's higher apps hold fewer than `scan`
// turns before it, counted once per group and capped at `scan`.
const SESSION_GROUP_PAGE = 128;
function selectedSessionTurns(eeaf, groups, scan) {
  const json = value => JSON.stringify(value);
  // Original label/entry order breaks ties: a label's order, then its app-major entry order (app, at, id descending).
  const newer = (a, b) => String(b.at).localeCompare(String(a.at)) || a.group.order - b.group.order
    || (json(a.group.app) === json(b.group.app) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : json(a.group.app) < json(b.group.app) ? 1 : -1);
  const heap = [];
  const push = item => {
    heap.push(item);
    for (let at = heap.length - 1; at > 0;) {
      const up = (at - 1) >> 1;
      if (newer(heap[at], heap[up]) >= 0) break;
      [heap[at], heap[up]] = [heap[up], heap[at]]; at = up;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let at = 0; ;) {
        const left = at * 2 + 1, right = left + 1;
        let best = at;
        if (left < heap.length && newer(heap[left], heap[best]) < 0) best = left;
        if (right < heap.length && newer(heap[right], heap[best]) < 0) best = right;
        if (best === at) break;
        [heap[at], heap[best]] = [heap[best], heap[at]]; at = best;
      }
    }
    return top;
  };
  // The next entries of a group after its last taken (at, id), newest first; a page of one shared time is widened.
  // A group's pages start small and double, so many labels each with one recent turn read little.
  const nextPage = group => {
    for (let limit = group.page; ; limit *= 2) {
      const found = eeaf.scan(TYPE, 'speaker', { equal: [group.speaker, group.app], reverse: true, to: group.lastAt, limit });
      const fresh = found.filter(({ id, values: [, , at] }) => String(at) !== String(group.lastAt) || id < group.lastId);
      group.page = Math.min(limit * 2, SESSION_GROUP_PAGE);
      if (fresh.length || found.length < limit) return { entries: fresh, more: found.length === limit };
    }
  };
  // Every turn read is a candidate, selected or not: deleting a counted higher-app turn can admit a lower-app one.
  let candidates = new Set();
  const note = id => {
    if (candidates === null) return;
    candidates.add(id);
    if (candidates.size > SPEAKER_CACHE_IDS) candidates = null;
  };
  // How many turns a label's apps above this group hold, capped at `scan`.
  const higher = group => {
    if (group.higher === undefined) {
      const above = group.app === group.labelFirstApp ? [] : eeaf.scan(TYPE, 'speaker', { equal: [group.speaker], after: group.app, limit: scan });
      for (const { id } of above) note(id);
      group.higher = above.length;
    }
    return group.higher;
  };
  const firstApp = new Map();
  for (const group of groups) {
    const app = firstApp.get(group.speaker);
    if (app === undefined || json(group.app) > json(app)) firstApp.set(group.speaker, group.app);
  }
  for (const group of groups) {
    group.labelFirstApp = firstApp.get(group.speaker);
    group.taken = 0; group.buffer = []; group.more = true; group.page = 8;
    note(group.head.id);
    push({ group, id: group.head.id, at: group.head.at });
  }
  const selected = [];
  while (heap.length && selected.length < scan) {
    const item = pop(), { group } = item;
    if (higher(group) + group.taken >= scan) continue;
    group.taken += 1; group.lastAt = item.at; group.lastId = item.id;
    selected.push([item.id, { app: group.app, speaker: group.speaker, at: item.at }]);
    if (!group.buffer.length && group.more) {
      const page = nextPage(group);
      for (const { id } of page.entries) note(id);
      group.buffer = page.entries; group.more = page.more;
    }
    const next = group.buffer.shift();
    if (next) push({ group, id: next.id, at: next.values[2] });
  }
  return { turns: selected, candidates };
}

function voiceCursorFor(speaker, { pattern, scan, session_gap_seconds }) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, at: speaker.last_at, id: speaker.id, pattern, scan, session_gap_seconds }));
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function voiceCursorAt(cursor, { pattern, scan, session_gap_seconds }) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new MessageError('cursor must be a valid unnamed-speaker page cursor.');
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - cursor.length % 4) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value?.v !== 1 || typeof value.at !== 'string' || !nonempty(value.id)
      || value.pattern !== pattern || value.scan !== scan || value.session_gap_seconds !== session_gap_seconds)
      throw new Error('invalid cursor fields');
    return { at: value.at, id: value.id };
  } catch {
    throw new MessageError('cursor does not belong to this unnamed-speaker query.');
  }
}
// The top-level fields read() filters on, read for a whole page of ids in one query.
// The top-level fields record() compares a kept message by, read for a whole batch in one query.
const KEPT_FIELDS = ['conversation_id', 'app', 'speaker', 'at', 'text', 'source_ref', 'source_at', 'attachments'];
const OWN_FILTER_FIELDS = ['conversation_id', 'app', 'speaker', 'text'];
const RESEND_MINUTES = 10;
// The same words, speaker and conversation closer in time than this are one message (invariant 2a).
const DUPLICATE_MINUTES = 5;
// The most messages one conversation of the earlier one-item shape is looked through for (record()).
const LEGACY_CANDIDATES = 20;
// A speaker named afterward (nameSpeaker): the longest window named at once, and how many messages one read takes.
const NAMING_DAYS = 2;
const NAMING_PAGE = 200;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class MessageError extends Error {}

// Apps whose rows (src/harnesses.json) say a transcript owner records both sides of their conversation.
// The transcript sender names each AI row with its source_ref. A manual MCP reply
// has no verified row identity and would otherwise appear beside the hook copy.
const hookOwned = name => harnessOf(name)?.turns.recorded_by_ai === false;
export const mustUseTranscriptForPerson = (reader, app, batch) =>
  batch?.messages?.some(message =>
    (hookOwned(typeof reader === 'string' && reader.startsWith('app:') ? reader.slice(4) : null)
      || hookOwned(app)
      || hookOwned(message.app))
    && (message.speaker === 'person'
      || (message.speaker === 'ai' && !nonempty(message.source_ref))));

// Said with every read, because the reply is where an AI looks for what to do next: most apps end a turn when the
// reply is sent, so the turn is recorded before it is sent.
export const RECORD_THIS_TURN = `In ${transcriptHookNames()}, the verified transcript hook records both your messages and the person’s prompts; do not call record_messages for this chat. In other apps, before replying, record the actual person message and your reply word for word with record_messages. Never record generated context, peer traffic, or SDK diagnostics as the person.`;

// One message as sent, checked, with its time made exact. Missing time is the time it was recorded, one millisecond
// later for each message after it in the batch, so a conversation sent in one call reads in the order it was sent
// (ids sort by time, and two messages with one time would otherwise sort by their words' hash).
function admit(item, index, now, defaultApp, stampFrom = now) {
  if (object(item) && !nonempty(item.app) && nonempty(defaultApp)) item = { ...item, app: defaultApp };
  if (object(item) && nonempty(item.app)) item = { ...item, app: canonicalApp(item.app) };
  const at = `messages[${index}]`;
  if (!object(item)) throw new MessageError(`${at} must be an object with conversation_id, app, speaker and text.`);
  const problems = [];
  for (const field of ['conversation_id', 'app', 'speaker']) if (!nonempty(item[field])) problems.push(`${at}.${field} is required${field === 'app' ? ': name your app, like "Claude" or "ChatGPT" (this connection did not name one)' : ''}`);
  const about = item.about ?? [];
  const aboutOk = Array.isArray(about) && about.every(link => object(link) && nonempty(link.kind) && nonempty(link.id));
  const attachments = item.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.some(file => !FILE_IDENTITY.test(typeof file === 'string' ? file : file?.identity ?? '')))
    problems.push(`${at}.attachments must be a list of file identities already in the person's Files`);
  // A message of only files (a photo sent without words) names its files in attachments.
  if (typeof item.text !== 'string' || (!item.text.length && !attachments.length)) problems.push(`${at}.text is required: the message exactly as it was written (empty only for a message with attached files)`);
  else if (item.text.length > MAX_TEXT) problems.push(`${at}.text is ${item.text.length} characters; at most ${MAX_TEXT}. Send a longer message in parts.`);
  // A given time is checked once here (src/claimed-time.mjs): any past time, never one that has not happened yet.
  const claimed = item.at === undefined ? { at: new Date(stampFrom.getTime() + index).toISOString() } : claimedTimeProblem(item.at, { now, field: `${at}.at` });
  if (claimed.problem) problems.push(claimed.problem);
  if (!aboutOk) problems.push(`${at}.about must be a list of { kind, id }, like { "kind": "pursuit", "id": "pursuit:content" }`);
  // A link may name the piece of the thing the words are about (src/responses.mjs partFrom): some of its words, a moment.
  const parts = aboutOk ? about.map((link, place) => { try { return partFrom(link.part); } catch (error) { problems.push(`${at}.about[${place}].part: ${error.message}`); return null; } }) : [];
  if (item.source_ref !== undefined && !nonempty(item.source_ref)) problems.push(`${at}.source_ref, when given, names the message's place in the conversation it came from`);
  if (item.source_at !== undefined) {
    const sourceTime = claimedTimeProblem(item.source_at, { now, field: `${at}.source_at` });
    if (typeof item.source_at !== 'string' || sourceTime.problem) problems.push(sourceTime.problem ?? `${at}.source_at must be the original date and time as text`);
    if (!nonempty(item.source_ref)) problems.push(`${at}.source_at needs the original message's source_ref`);
  }
  if (item.clock !== undefined && !isHybridTimestamp(item.clock)) problems.push(`${at}.clock must contain a non-negative wall_ms and logical count, plus a device_id`);
  if (problems.length) throw new MessageError(problems.join('; '));
  return {
    stamped: item.at === undefined,
    conversation_id: item.conversation_id, app: item.app, speaker: item.speaker, at: claimed.at, text: item.text,
    ...(item.clock ? { clock: { wall_ms: item.clock.wall_ms, logical: item.clock.logical, device_id: item.clock.device_id } } : {}),
    ...(nonempty(item.model) ? { model: item.model } : {}),
    // Who the AI's hook read the row as written by (human, peer, ...); the store opens a decision only for a human's.
    ...(nonempty(item.origin) ? { origin: item.origin } : {}),
    ...(isFinalReply(item, now) ? { final_reply: true } : {}),
    ...(about.length ? { about: about.map(({ kind, id }, place) => ({ kind, id, ...(parts[place] ? { part: parts[place] } : {}) })) } : {}),
    ...(attachments.length ? { attachments: [...new Map(attachments.map(file => {
      const identity = typeof file === 'string' ? file : file.identity;
      return [identity, { identity, ...(typeof file === 'object' && nonempty(file.name) ? { name: file.name } : {}), ...(typeof file === 'object' && nonempty(file.media_type) ? { media_type: file.media_type } : {}) }];
    })).values()] } : {}),
    ...(nonempty(item.source_ref) ? { source_ref: item.source_ref } : {}),
    ...(nonempty(item.source_at) ? { source_at: item.source_at } : {}),
    // Why these words are kept under a speaker other than the one they were heard as (src/heard-echo.mjs names the notice).
    ...(nonempty(item.evidence) ? { evidence: item.evidence } : {}),
  };
}

// Links a kept message does not have yet, added after the ones it has; null when there are none to add.
const withNewLinks = (kept, about) => {
  if (!kept || !about?.length) return null;
  const has = new Set((kept.about ?? []).map(link => `${link.kind}\n${link.id}`));
  const extra = about.filter(link => !has.has(`${link.kind}\n${link.id}`));
  return extra.length ? [...(kept.about ?? []), ...extra] : null;
};
const withNewAttachments = (kept, attachments) => {
  if (!kept || !attachments?.length) return null;
  const existing = new Set((kept.attachments ?? []).map(file => typeof file === 'string' ? file : file.identity));
  const extra = attachments.filter(file => !existing.has(typeof file === 'string' ? file : file.identity));
  return extra.length ? [...(kept.attachments ?? []), ...extra] : null;
};

const eventOrderKey = message => message.clock
  ? `${new Date(message.clock.wall_ms).toISOString()}!${String(message.clock.logical).padStart(16, '0')}!${encodeURIComponent(message.clock.device_id)}`
  : message.at;
const idOf = message => `${TYPE}:${eventOrderKey(message)}:${bytesToHex(blake3(new TextEncoder().encode(canonical({
  conversation_id: message.conversation_id, app: message.app, speaker: message.speaker, at: message.at, text: message.text,
})))).slice(0, 24)}`;
export const messageIdOf = idOf;
const sourceKeyOf = message => `${SOURCE_KEY_TYPE}:${bytesToHex(blake3(new TextEncoder().encode(canonical({
  app: message.app, conversation_id: message.conversation_id, source_ref: message.source_ref,
})))).slice(0, 32)}`;
export const sourceKeyOfMessage = sourceKeyOf;
const contentKeyOf = (message, slot) => `${CONTENT_KEY_TYPE}:${slot}:${bytesToHex(blake3(new TextEncoder().encode(canonical({
  conversation_id: message.conversation_id, speaker: message.speaker, text: message.text,
})))).slice(0, 24)}`;
const slotOf = message => Math.floor(Date.parse(message.at) / (DUPLICATE_MINUTES * 60000));
const threadIdentity = message => bytesToHex(blake3(new TextEncoder().encode(canonical({ app: message.app, conversation_id: message.conversation_id })))).slice(0, 24);

// Older inbox cursors name a separate conversation-index record. That record is no longer made; convert cursors
// already in people's links to the message they point at before paging the message records themselves.
const messageCursor = (eeaf, id) => nonempty(id) && id.startsWith(`${THREAD_TYPE}:`) ? eeaf.read(id)?.message_id ?? null : id;

// eeaf: the person's record store ({ write, read, ids, scan }).
// fields: the record store's field reads (src/record-engine.mjs; the store's own eeaf.fields unless given), which
// correctProvenance finds a message's arrivals through and read() filters a page of messages by
export function messages(eeaf, { now = () => new Date(), fields = eeaf.fields ?? null } = {}) {
  // Every write of turns here also keeps the stretches unnamed speakers were heard in (src/voice-sessions.mjs), in the
  // same write, so the voices read finds them from the newest stretches.
  const stretches = voiceSessions(eeaf, { fields });
  const write = (batch, options) => {
    const turns = batch.filter(entry => entry.type === TYPE && entry.value && keptLabel(entry.value.speaker)).map(entry => entry.value);
    return eeaf.write(turns.length ? [...batch, ...stretches.rowsFor(turns)] : batch, options);
  };
  // The old carrier made implicit conversations with its exact route spelling,
  // while this owner already canonicalized app. Reuse only real original keys
  // addressed by that supplied spelling or a spelling declared by the harness
  // owner. Never guess spellings, scan history, or write another source key.
  const implicitConversations = (inputs, { per_source = false } = {}) => {
    const sources = inputs.map(({ route, source_id, source_ref = source_id }) => {
      if (![route, source_id, source_ref].every(nonempty)) throw new MessageError('route, source_id and source_ref name a stable source.');
      const app = canonicalApp(route);
      const spellings = [...new Set([route, app, ...(harnessOf(route)?.names ?? [])])];
      const candidates = spellings.map(spelling => ({ app, source_ref, conversation_id: `${spelling}:${source_id}` }))
        .map(source => ({ ...source, key: sourceKeyOf(source) }));
      return { app, source_ref, fallback: `${app}:${source_id}`, candidates };
    });
    const wanted = sources.flatMap(source => source.candidates.map(candidate => candidate.key));
    if (!wanted.length) return sources.map(source => source.fallback);
    if (!fields) throw new MessageError('Resolving an original source needs the message field owner.');
    const pointers = fields.fieldsOf(SOURCE_KEY_TYPE, [...new Set(wanted)], ['message_id'], { groupRoots: true });
    const ids = [...new Set([...pointers.values()].map(row => row.message_id).filter(nonempty))];
    const retained = fields.fieldsOf(TYPE, ids, ['app', 'conversation_id', 'source_ref'], { groupRoots: true });
    const resolved = sources.map(source => {
      try {
      const original = new Map();
      for (const candidate of source.candidates) {
        const id = pointers.get(candidate.key)?.message_id;
        if (!nonempty(id)) continue;
        const message = retained.get(id);
        if (!message) {
          if (eeaf.erasure?.(id)) throw new MessageError('This source input was erased and cannot be replayed.');
          throw new MessageError('The original source message is unavailable.');
        }
        if (message.app !== source.app || message.source_ref !== source.source_ref
          || message.conversation_id !== candidate.conversation_id)
          throw new MessageError('The original source key no longer names its exact message.');
        original.set(id, message.conversation_id);
      }
      if (original.size > 1) throw new MessageError('This source has conflicting original messages; name its exact conversation.');
      return original.values().next().value ?? source.fallback;
      } catch (error) { if (error instanceof MessageError) return error; throw error; }
    });
    if (!per_source) { const error = resolved.find(value => value instanceof MessageError); if (error) throw error; }
    return resolved;
  };
  return {
    voiceSessions: stretches,
    implicitConversations,
    implicitConversation: input => implicitConversations([input])[0],
    // An AI sometimes called record_messages before the transcript hook kept
    // the same reply. Keep the source-backed row and its links; retire only an
    // exact manual copy after checking both records and their nearby times.
    correctDuplicate({ duplicate_id, kept_id, evidence } = {}) {
      if (!nonempty(duplicate_id) || !nonempty(kept_id) || duplicate_id === kept_id || !nonempty(evidence))
        throw new MessageError('Two different message IDs and source evidence are required.');
      const correctionId = `message-duplicate-correction:${duplicate_id}`;
      const previous = eeaf.read(correctionId);
      if (previous) {
        if (previous.kept_id !== kept_id || previous.evidence !== evidence) throw new MessageError('This duplicate already has a different correction.');
        return previous;
      }
      const duplicate = eeaf.read(duplicate_id);
      const kept = eeaf.read(kept_id);
      if (!duplicate || !kept || duplicate.speaker !== 'ai' || kept.speaker !== 'ai'
        || duplicate.source_ref || !kept.source_ref || duplicate.app !== kept.app
        || duplicate.conversation_id !== kept.conversation_id || duplicate.text !== kept.text
        || Math.abs(Date.parse(duplicate.at) - Date.parse(kept.at)) > 120_000)
        throw new MessageError('An exact nearby manual AI copy and a source-backed AI reply are required.');
      const about = withNewLinks(kept, duplicate.about);
      const correction = { duplicate_id, kept_id, evidence, corrected_at: now().toISOString(), duplicate };
      write([
        ...(about ? [{ id: kept_id, type: TYPE, value: { ...kept, about } }] : []),
        { id: duplicate_id, type: TYPE, value: null },
        ...(eeaf.read(`${THREAD_TYPE}:${duplicate.at}:${threadIdentity(duplicate)}:${duplicate_id.slice(-24)}`)
          ? [{ id: `${THREAD_TYPE}:${duplicate.at}:${threadIdentity(duplicate)}:${duplicate_id.slice(-24)}`, type: THREAD_TYPE, value: null }] : []),
        { id: correctionId, type: 'message-duplicate-correction', value: correction },
      ], { actor: { by: 'duplicate-correction', app: duplicate.app }, unwatched: true });
      return correction;
    },
    // An older chat may be recorded later without its original timestamp. Keep its message ID
    // and every linked decision/handoff intact, but show when the person actually wrote it.
    correctAuthoredAt({ message_id, authored_at, evidence } = {}) {
      if (!nonempty(message_id) || !nonempty(evidence) || typeof authored_at !== 'string'
        || Number.isNaN(Date.parse(authored_at))) throw new MessageError('message_id, authored_at, and source evidence are required.');
      claimedTime(authored_at, { now: now(), field: 'authored_at', make: words => new MessageError(words) });
      const original = eeaf.read(message_id);
      if (!original || original.speaker !== 'person') throw new MessageError('A kept person message is required.');
      const exact = new Date(authored_at).toISOString();
      if (Date.parse(exact) > Date.parse(original.at)) throw new MessageError('Authored time cannot follow the stored capture time.');
      const correctionId = `message-time-correction:${message_id}`;
      const previous = eeaf.read(correctionId);
      if (previous) {
        if (previous.authored_at !== exact || previous.evidence !== evidence) throw new MessageError('This message already has a different time correction.');
        return previous;
      }
      const correction = { message_id, authored_at: exact, captured_at: original.at, evidence, corrected_at: now().toISOString() };
      write([
        { id: message_id, type: TYPE, value: { ...original, authored_at: exact, captured_at: original.at } },
        { id: correctionId, type: 'message-time-correction', value: correction },
      ], { actor: { by: 'time-correction', app: original.app }, unwatched: true });
      return correction;
    },
    // Someone learned to be the author afterward (a voice heard while listening, named once that person said yes; a
    // handle later known to be a teammate): every message one app kept from `speaker` between `since` and `until` is
    // kept under `name` from now on. Its id, time, words and links stay; `named_from` keeps what it was kept as, and one
    // naming record keeps who it was, why and which messages. Only a speaker other than the person or an AI is named,
    // and the window is at most NAMING_DAYS, read a page at a time from its newest message back.
    nameSpeaker({ app, speaker, name, since, until, evidence, expected_name, remove = false } = {}) {
      if (typeof remove !== 'boolean' || ![app, speaker, evidence].every(nonempty) || (!remove && !nonempty(name)) || (expected_name !== undefined && !nonempty(expected_name)) || (remove && !nonempty(expected_name))
        || [since, until].some(time => typeof time !== 'string' || Number.isNaN(Date.parse(time))))
        throw new MessageError('app, speaker, evidence, since and until are required; corrections and removal require the current expected_name.');
      if (['person', 'ai'].includes(speaker) || (!remove && ['person', 'ai'].includes(name))) throw new MessageError('Only a speaker other than the person or an AI can be named.');
      const from = new Date(since).toISOString();
      const to = new Date(until).toISOString();
      if (to < from || Date.parse(to) - Date.parse(from) > NAMING_DAYS * 86_400_000) throw new MessageError(`until must follow since, at most ${NAMING_DAYS} days later.`);
      const namingId = `message-speaker-naming:${bytesToHex(blake3(new TextEncoder().encode(canonical({ app, speaker, from, to })))).slice(0, 32)}`;
      const previous = eeaf.read(namingId);
      if (!previous && (remove || expected_name !== undefined)) throw new MessageError('This voice has no current name in that listening window. Reopen the current voice before changing it.');
      if (previous) {
        if (previous.active === false && !remove) {
          if (expected_name !== undefined) throw new MessageError('A removed name cannot be corrected using its stale expected_name. Reopen the original voice label to name it again.');
          const restored = previous.message_ids.map(id => ({ id, message: eeaf.read(id) }));
          if (restored.some(({ message }) => message?.app !== app || message.speaker !== speaker || message.named_from !== undefined))
            throw new MessageError('This voice changed after its name was removed. Reopen the current voice before naming it again.');
          const renamed_at = now().toISOString();
          const correction = { from: speaker, to: name, evidence, at: renamed_at };
          const renamed = { ...previous, active: true, name, evidence, named_at: renamed_at, correction_history: [...(previous.correction_history ?? []), correction] };
          write([
            ...restored.map(({ id, message }) => ({ id, type: TYPE, value: { ...message, speaker: name, named_from: speaker, named_at: renamed_at } })),
            { id: namingId, type: 'message-speaker-naming', value: renamed },
          ], { actor: { by: 'speaker-naming', app }, unwatched: true });
          return renamed;
        }
        if (!remove && previous.name === name) {
          if (expected_name && (previous.active === false || previous.name !== expected_name)) throw new MessageError('This voice changed after the name on the card. Reopen the current voice before correcting it.');
          if (previous.message_ids.some(id => { const message = eeaf.read(id); return message?.app !== app || message.speaker !== name || message.named_from !== speaker; }))
            throw new MessageError('This voice changed after the name on the card. Reopen the current voice before correcting it.');
          return previous;
        }
        if (remove && previous.active === false && previous.removed_name === expected_name) {
          if (previous.message_ids.some(id => { const message = eeaf.read(id); return message?.app !== app || message.speaker !== speaker || message.named_from !== undefined; }))
            throw new MessageError('The removed voice changed afterward. Reopen the current voice before retrying removal.');
          return previous;
        }
        if (previous.active === false || previous.name !== expected_name) throw new MessageError(`${speaker} in ${app} at that time is already named ${previous.name}.`);
        const current = previous.message_ids.map(id => ({ id, message: eeaf.read(id) }));
        if (current.some(({ message }) => message?.app !== app || message.speaker !== expected_name || message.named_from !== speaker))
          throw new MessageError('This voice changed after the name on the card. Reopen the current voice before correcting it.');
        const corrected_at = now().toISOString();
        if (remove) {
          const corrected = { ...previous, active: false, removed_name: expected_name, removal_evidence: evidence, removed_at: corrected_at };
          write([
            ...current.map(({ id, message }) => { const { named_from, named_at, ...rest } = message; return { id, type: TYPE, value: { ...rest, speaker } }; }),
            { id: namingId, type: 'message-speaker-naming', value: corrected },
          ], { actor: { by: 'speaker-naming-removal', app }, unwatched: true });
          return corrected;
        }
        const correction = { from: expected_name, to: name, evidence, at: corrected_at };
        const corrected = { ...previous, active: true, name, previous_name: expected_name, correction_evidence: evidence, corrected_at,
          correction_history: [...(previous.correction_history ?? []), correction] };
        write([
          ...current.map(({ id, message }) => ({ id, type: TYPE, value: { ...message, speaker: name, named_from: speaker, named_at: corrected_at } })),
          { id: namingId, type: 'message-speaker-naming', value: corrected },
        ], { actor: { by: 'speaker-naming-correction', app }, unwatched: true });
        return corrected;
      }
      const found = [];
      let cursor = `${TYPE}:${to}\uffff`;
      for (;;) {
        const ids = eeaf.ids(TYPE, { before: cursor, limit: NAMING_PAGE });
        const inWindow = ids.filter(id => id >= `${TYPE}:${from}`);
        for (const id of inWindow) {
          const message = eeaf.read(id);
          if (message?.app === app && message.speaker === speaker) found.push({ id, message });
        }
        if (inWindow.length < NAMING_PAGE) break;
        cursor = ids.at(-1);
      }
      const named_at = now().toISOString();
      const naming = { app, speaker, name, since: from, until: to, evidence, named_at, message_ids: found.map(({ id }) => id) };
      write([
        ...found.map(({ id, message }) => ({ id, type: TYPE, value: { ...message, speaker: name, named_from: speaker, named_at } })),
        { id: namingId, type: 'message-speaker-naming', value: naming },
      ], { actor: { by: 'speaker-naming', app }, unwatched: true });
      return naming;
    },
    // Metadata for turns kept through one capture road, within the newest `limit`
    // turns by this speaker/app since the supplied time. The original speaker
    // window is retained exactly, including turns without capture provenance.
    // The same speaker entry carries provenance, so filtering needs no second
    // ordered index. Each value needs the owner's current scalar proof. Older
    // or unqualified entries use authoritative field reads. Neither path writes.
    capturedTurns({ app, speaker, road, since, limit = 500 } = {}) {
      if (![app, speaker, road].every(nonempty) || typeof since !== 'string' || Number.isNaN(Date.parse(since))
        || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE.scan)
        throw new MessageError('app, speaker, road, since and a limit from 1 to 1000 are required.');
      const entries = eeaf.scan(TYPE, 'speaker', { equal: [speaker, app], from: since, reverse: true, limit, carried: true });
      const ids = entries.map(entry => entry.id);
      if (!ids.length) return [];
      const qualified = entry => typeof eeaf.indexReady === 'function'
        && entry.carried && Object.hasOwn(entry.carried, 'captured_road')
        && entry.carried_defined && Object.hasOwn(entry.carried_defined, 'captured_road')
        && typeof entry.carried_defined.captured_road === 'boolean';
      const trusted = new Set(entries.filter(qualified).map(entry => entry.id));
      const captured = new Map(entries.filter(entry => trusted.has(entry.id) && entry.carried.captured_road === road)
        .map(entry => [entry.id, { id: entry.id, at: entry.values[2] }]));
      // Coverage certifies a visited key, not a value an older writer left on it.
      const missing = ids.filter(id => !trusted.has(id));
      const own = !missing.length ? new Map() : fields ? fields.fieldsOf(TYPE, missing, ['captured_road', 'at'])
        : new Map(missing.map(id => [id, eeaf.read(id)]));
      return ids.flatMap(id => captured.has(id) ? [captured.get(id)]
        : own.get(id)?.captured_road === road ? [{ id, at: own.get(id).at }] : []);
    },
    // The speakers nobody has named yet, from at most `scan` of each one's newest turns: each label matching `pattern` (DATA, such as
    // "Someone (voice-3)" or "Unsure (Morgan?)") once, with how many times it spoke, when first and last, its newest words
    // and the newest file a turn of it carried (a clip of the voice its carrier kept), newest speaker first. A label
    // renamed by nameSpeaker no longer matches, so a named voice leaves by itself.
    // A label is stable only inside one listening session (the listener numbers voices afresh for each: "Someone
    // (voice-1)" tomorrow is not today's), so with `session_gap_seconds` (DATA) each app's messages are cut into sessions
    // wherever two neighbouring unnamed turns of that app are further apart than the gap, and a label is one speaker per
    // session: each row carries `since` and `until` (that voice's first and last message in its session) and its id
    // names the session, so naming one names only its own session (nameSpeakerInSession). Without the gap a label is one
    // speaker for the whole scan. `most` bounds expensive reads; a paged read continues after an opaque raw voice cursor.
    unnamedSpeakers({ pattern, starts, scan = PAGE.scan, clip_reads = 20, word_reads = 1, session_gap_seconds = 0, most = Infinity, cursor, paged = false } = {}) {
      if (!nonempty(pattern)) throw new MessageError('pattern names which speaker labels count as nobody named yet.');
      if (!fields) throw new MessageError('Reading speakers needs the store\'s field reads (messages(eeaf, { fields })).');
      if (paged && (!Number.isSafeInteger(most) || most < 1 || most > PAGE.max)) throw new MessageError(`A page must ask for 1 to ${PAGE.max} voices.`);
      if (cursor !== undefined && !paged) throw new MessageError('cursor is available only for paged unnamed-speaker reads.');
      const after = paged && cursor !== undefined ? voiceCursorAt(cursor, { pattern, scan, session_gap_seconds }) : null;
      const key = JSON.stringify([pattern, starts ?? null, scan, clip_reads, word_reads, session_gap_seconds, most, paged, cursor ?? null]);
      const unnamed = new RegExp(pattern);
      const speakerIndexReady = eeaf.indexReady?.(TYPE, 'speaker') === true;
      // The stretches unnamed speakers were heard in (src/voice-sessions.mjs) answer a session read whose label starts they keep.
      const sessionWindow = speakerIndexReady && session_gap_seconds > 0 && Number.isSafeInteger(scan) && scan > 0 && sessionsCover(starts) && stretches.started();
      const readBy = `${speakerIndexReady}:${sessionWindow}`;
      const seq = eeaf.changeSeq?.();
      const cache = unnamedSpeakerCaches.get(eeaf);
      if (cache?.key === key && cache.indexed === readBy && Number.isSafeInteger(seq)) {
        const changed = seq === cache.seq ? [] : eeaf.changedSince?.(cache.seq);
        if (Array.isArray(changed)) {
          const turnsChanged = changed.filter(id => id.startsWith(`${TYPE}:`));
          let relevant = turnsChanged.length > 0;
          // The existing field owner inspects only a bounded changed batch. A
          // known candidate is relevant even if renamed/deleted. All scanned
          // candidates are tracked, including voices outside the visible page:
          // their edits can join sessions or move one into the newest results.
          if (speakerIndexReady && cache.ids !== null && !turnsChanged.some(id => cache.ids.has(id))) {
            relevant = false;
            // changedSince is the existing bounded mutation journal. Inspect
            // scalar metadata in field-owner pages; a second page of ordinary
            // chat traffic does not make the retained voice answer stale.
            for (let start = 0; start < turnsChanged.length && !relevant; start += PAGE.max) {
              const ids = turnsChanged.slice(start, start + PAGE.max);
              const own = fields.fieldsOf(TYPE, ids, ['speaker']);
              relevant = ids.some(id => nonempty(own.get(id)?.speaker) && unnamed.test(own.get(id).speaker));
            }
          }
          if (!relevant) {
            cache.seq = seq;
            return structuredClone(cache.answer);
          }
        }
      }
      const speakers = new Map();
      // The turns to group, newest first, as [id, { app, speaker, at, text? }]. The speaker index holds who spoke, in which
      // app and when in its keys: the distinct speakers are skipped across, and only the turns (at most `scan` of each) of
      // a speaker nobody named are listed, so no message is read to find a voice and the many turns of people and AIs are
      // never walked, with or without sessions (a session is cut on the gaps between those turns). While the index is
      // being built the newest `scan` messages are read a page at a time. Sessions once walked the newest `scan` messages
      // whole, of every app, to see the gaps: on an account whose AI chats are kept that read a thousand long replies
      // to find a few voices, 250,000 statements a read (2026-10-10).
      const keyed = speakerIndexReady;
      // `starts` (DATA: the literal text every unnamed label begins with) limits the speaker index to those ranges, so
      // the speakers already named are never sought one by one; a label outside every start is not found. Without it
      // each distinct speaker was sought: one read of a store with many speakers took 80,000 statements and 860,000
      // rows and ran out of CPU, resetting every call beside it (2026-10-16).
      const labelStarts = starts === undefined ? {} : { startsWith: starts };
      const turns = [];
      let candidateIds;
      if (sessionWindow) {
        // The newest `scan` unnamed turns, merged from the newest stretches of listening: a statement for each label of a
        // stretch the window reaches, however many labels and apps were ever heard. Each (label, app) group once cost its
        // own statements, about 20,000 statements and 230,000 rows a read on the founder's store, which ran out of CPU and
        // reset every call beside it (2026-10-16). While the stretches are still being built this throws VoicesPreparing.
        const found = stretches.window({ unnamed, starts, scan, gap: session_gap_seconds * 1000 });
        turns.push(...found.turns);
        candidateIds = found.candidates;
      } else if (keyed) {
        if (session_gap_seconds > 0 && Number.isSafeInteger(scan) && scan > 0) {
          // The original window is app-major within each label, not chronological (selectedSessionTurns).
          const bySpeaker = new Map(), groups = [];
          for (const { id, values: [speaker, app, at] } of eeaf.lastPerGroup(TYPE, 'speaker', {
            depth: 2, include: speaker => nonempty(speaker) && unnamed.test(speaker), ...labelStarts,
          })) {
            if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, bySpeaker.size);
            groups.push({ speaker, app, order: bySpeaker.get(speaker), head: { id, at } });
          }
          const selection = selectedSessionTurns(eeaf, groups, scan);
          turns.push(...selection.turns);
          candidateIds = selection.candidates;
        } else {
          for (const { values: [speaker] } of eeaf.lastPerGroup(TYPE, 'speaker', {
            include: speaker => nonempty(speaker) && unnamed.test(speaker), ...labelStarts,
          })) {
            for (const { id, values: [, app, at] } of eeaf.scan(TYPE, 'speaker', { equal: [speaker], reverse: true, limit: scan })) turns.push([id, { app, speaker, at }]);
          }
          turns.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
          candidateIds = turns.length <= SPEAKER_CACHE_IDS ? new Set(turns.map(([id]) => id)) : null;
        }
        if (session_gap_seconds > 0) turns.splice(scan);
      } else {
        let cursor;
        while (turns.length < scan) {
          const ids = eeaf.ids(TYPE, { before: cursor, limit: Math.min(200, scan - turns.length) });
          if (!ids.length) break;
          const own = fields.fieldsOf(TYPE, ids, ['app', 'speaker', 'at']);
          for (const id of ids) turns.push([id, own.get(id)]);
          cursor = ids.at(-1);
        }
        candidateIds = turns.length <= SPEAKER_CACHE_IDS ? new Set(turns.map(([id]) => id)) : null;
      }
      const sessions = new Map();
      for (const [id, row] of turns) {
        if (!row) continue;
        const sessionOf = sessions.get(row.app) ?? { index: 0, at: null };
        if (session_gap_seconds > 0 && sessionOf.at && Date.parse(sessionOf.at) - Date.parse(row.at) > session_gap_seconds * 1000) sessionOf.index += 1;
        sessionOf.at = row.at;
        sessions.set(row.app, sessionOf);
        if (!nonempty(row.speaker) || !unnamed.test(row.speaker)) continue;
        const key = `${row.app}\u0000${row.speaker}\u0000${sessionOf.index}`;
        const held = speakers.get(key);
        if (held) { held.turns += 1; held.first_at = row.at; held.ids.push(id); continue; }
        speakers.set(key, { app: row.app, speaker: row.speaker, turns: 1, last_at: row.at, first_at: row.at, last_words: String(row.text ?? '').trim().slice(0, 240), ids: [id] });
      }
      // Only the selected page is answered (the caller shows no more), so only its voices are read: each one's newest
      // message for its last words and at most `clip_reads` of its turns for a clip. Every voice of every session once
      // read up to 20 whole messages for a clip, so a week of listening read 2 million rows a read (2026-10-10).
      const voiceId = speaker => session_gap_seconds > 0 ? `${speaker.app}:${speaker.speaker}@${speaker.first_at}` : `${speaker.app}:${speaker.speaker}`;
      const ordered = [...speakers.values()].map(speaker => ({ ...speaker, id: voiceId(speaker) }))
        .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)) || (paged ? String(a.id).localeCompare(String(b.id)) : 0));
      const remaining = after ? ordered.filter(speaker => String(speaker.last_at).localeCompare(after.at) < 0
        || (speaker.last_at === after.at && String(speaker.id).localeCompare(after.id) > 0)) : ordered;
      const pageHasMore = paged && remaining.length > most;
      const chosen = remaining.slice(0, most);
      // Both discovery paths need words only for the chosen voices. The
      // fallback still groups every scanned turn using its unchanged metadata.
      if (chosen.length) {
        const wanted = chosen.flatMap(speaker => speaker.ids.slice(0, Math.max(1, word_reads)));
        const read = new Map();
        for (let from = 0; from < wanted.length; from += PAGE.max) for (const [id, own] of fields.fieldsOf(TYPE, wanted.slice(from, from + PAGE.max), ['text', 'conversation_id', 'source_ref'])) read.set(id, own);
        for (const speaker of chosen) {
          const conversation = read.get(speaker.ids[0])?.conversation_id;
          if (nonempty(conversation)) speaker.conversation_id = conversation;
          const wordIds = speaker.ids.slice(0, Math.max(1, word_reads));
          const texts = wordIds.map(id => String(read.get(id)?.text ?? '').trim());
          speaker.last_words = (texts[0] ?? '').slice(0, 240);
          const clearest = texts.reduce((best, text, index) => (text.length > best.text.length ? { text, index } : best), { text: '', index: 0 });
          const clear = clearest.text.slice(0, 240);
          const sourceRef = read.get(wordIds[clearest.index])?.source_ref;
          if (nonempty(sourceRef)) speaker.source_ref = sourceRef;
          else delete speaker.source_ref;
          if (clear && clear !== speaker.last_words) speaker.clear_words = clear;
        }
      }
      const clipped = new Map();
      let pending = chosen.map((speaker, index) => ({ index, ids: speaker.ids.slice(0, clip_reads) }));
      // Read only the next turn of each unresolved voice. A first clip stops that voice before any older turn is read.
      for (let depth = 0; pending.length; depth += 1) {
        const asks = pending.filter(item => depth < item.ids.length);
        if (!asks.length) break;
        const ids = asks.map(item => item.ids[depth]);
        const metadata = typeof eeaf.memberFieldsMany === 'function'
          ? eeaf.memberFieldsMany(ids, 'about', ['kind', 'id'])
          : new Map(ids.map(id => [id, eeaf.memberFields(id, 'about', ['kind', 'id'])]));
        pending = [];
        for (const item of asks) {
          const file = metadata.get(item.ids[depth]).find(link => link.kind === 'file');
          if (file) clipped.set(item.index, file.id);
          else pending.push(item);
        }
      }
      const rows = chosen.map(({ ids, ...speaker }, index) => {
        const clip = clipped.get(index);
        return { ...speaker, since: speaker.first_at, until: speaker.last_at, ...(clip ? { clip } : {}) };
      });
      const afterRead = eeaf.changeSeq?.();
      const answer = paged ? { voices: rows, cursor: pageHasMore && chosen.length ? voiceCursorFor(chosen.at(-1), { pattern, scan, session_gap_seconds }) : null, has_more: pageHasMore } : rows;
      if (Number.isSafeInteger(afterRead)) unnamedSpeakerCaches.set(eeaf, { key, seq: afterRead, answer, indexed: readBy, ids: candidateIds });
      return structuredClone(answer);
    },
    // The words of `speaker`'s newest `limit` turns (at most PAGE.max, any app), as text: what a reader tells which language
    // a person writes and speaks in from (src/voice-guesses.mjs). Nothing when the speaker index is not ready yet.
    speakerWords({ speaker, limit = PAGE.default } = {}) {
      if (!nonempty(speaker)) throw new MessageError('speaker is required.');
      if (!fields) throw new MessageError('Reading speakers needs the store\'s field reads (messages(eeaf, { fields })).');
      if (eeaf.indexReady?.(TYPE, 'speaker') !== true) return [];
      const ids = eeaf.scan(TYPE, 'speaker', { equal: [speaker], reverse: true, limit: Math.min(Math.max(1, limit), PAGE.max) }).map(entry => entry.id);
      return ids.length ? [...fields.fieldsOf(TYPE, ids, ['text']).values()].map(own => String(own?.text ?? '').trim()).filter(Boolean) : [];
    },
    // What was said in one conversation between `since` and `until`, oldest first: at most `limit` messages (never more
    // than PAGE.max) from the start of the window, each as { app, speaker, text, at }. The conversation_id index bounds
    // the ids to the window, so nothing outside it and no more than `limit` bodies are read (src/voice-guesses.mjs).
    wordsAround({ conversation_id, since, until, limit = PAGE.default } = {}) {
      if (!nonempty(conversation_id) || [since, until].some(time => typeof time !== 'string' || Number.isNaN(Date.parse(time))))
        throw new MessageError('conversation_id, since and until are required.');
      if (!fields) throw new MessageError('Reading what was said needs the store\'s field reads (messages(eeaf, { fields })).');
      const ids = eeaf.scan(TYPE, 'conversation_id', {
        equal: [conversation_id], idFrom: `${TYPE}:${new Date(since).toISOString()}`, idTo: `${TYPE}:${new Date(until).toISOString()}\uffff`,
        limit: Math.min(Math.max(1, Math.floor(Number(limit)) || PAGE.default), PAGE.max),
      }).map(entry => entry.id);
      if (!ids.length) return [];
      const own = fields.fieldsOf(TYPE, ids, ['app', 'speaker', 'text', 'at']);
      return ids.filter(id => own.has(id)).map(id => ({ app: own.get(id).app, speaker: own.get(id).speaker, text: String(own.get(id).text ?? ''), at: own.get(id).at }));
    },
    // A speaker named only inside one listening session: every message of `speaker` in `app` from `since` to `until` (a row of
    // unnamedSpeakers: that voice's first and last message in its session) reads under `name`, in windows of at most
    // NAMING_DAYS. The same label in another session, which is another voice, is left as it was. Answers how many
    // messages were named and each naming record.
    nameSpeakerInSession({ app, speaker, name, since, until, evidence, expected_name, remove = false } = {}) {
      if (typeof remove !== 'boolean' || ![app, speaker, evidence].every(nonempty) || (!remove && !nonempty(name)) || (expected_name !== undefined && !nonempty(expected_name)) || (remove && !nonempty(expected_name))
        || [since, until].some(time => typeof time !== 'string' || Number.isNaN(Date.parse(time))))
        throw new MessageError('app, speaker, evidence, since and until are required; corrections and removal require the current expected_name.');
      const windows = [];
      for (let from = Date.parse(since); from <= Date.parse(until); from += NAMING_DAYS * 86_400_000) {
        const to = Math.min(from + NAMING_DAYS * 86_400_000 - 1, Date.parse(until));
        windows.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
      }
      // Validate every existing session slice before the first write so a later stale slice cannot leave earlier edits committed.
      const renamingRemoved = expected_name === undefined && !remove && windows.some(({ from, to }) => {
        const id = `message-speaker-naming:${bytesToHex(blake3(new TextEncoder().encode(canonical({ app, speaker, from, to })))).slice(0, 32)}`;
        return eeaf.read(id)?.active === false;
      });
      if (expected_name || remove || renamingRemoved) for (const { from, to } of windows) {
        const namingId = `message-speaker-naming:${bytesToHex(blake3(new TextEncoder().encode(canonical({ app, speaker, from, to })))).slice(0, 32)}`;
        const previous = eeaf.read(namingId);
        if (renamingRemoved && !expected_name && !remove) {
          if (previous?.active !== false || previous.message_ids.some(id => { const message = eeaf.read(id); return message?.app !== app || message.speaker !== speaker || message.named_from !== undefined; }))
            throw new MessageError('This removed voice changed afterward. Reopen the current voice before naming it again.');
          continue;
        }
        if (!previous || previous.active === false || previous.name !== expected_name) {
          if (remove && previous?.active === false && previous.removed_name === expected_name) {
            if (previous.message_ids.some(id => { const message = eeaf.read(id); return message?.app !== app || message.speaker !== speaker || message.named_from !== undefined; }))
              throw new MessageError('The removed voice changed afterward. Reopen the current voice before retrying removal.');
            continue;
          }
          throw new MessageError('This voice changed after the name on the card. Reopen the current voice before correcting it.');
        }
        if (previous.message_ids.some(id => { const message = eeaf.read(id); return message?.app !== app || message.speaker !== expected_name || message.named_from !== speaker; }))
          throw new MessageError('This voice changed after the name on the card. Reopen the current voice before correcting it.');
      }
      const namings = [];
      for (const { from, to } of windows) namings.push(this.nameSpeaker({ app, speaker, name, since: from, until: to, evidence, expected_name, remove }));
      return { named: namings.reduce((sum, naming) => sum + naming.message_ids.length, 0), namings };
    },
    // A speaker named across everything they said in the newest `scan` messages: every window of at most NAMING_DAYS from
    // their first kept message there to their newest is named (nameSpeaker), so a voice heard over a week reads under its name everywhere. Answers how many
    // messages were named and each naming record.
    nameSpeakerEverywhere({ app, speaker, name, evidence, scan = 5000 } = {}) {
      if (![app, speaker, name, evidence].every(nonempty)) throw new MessageError('app, speaker, name and evidence are required.');
      if (!fields) throw new MessageError('Naming a speaker everywhere needs the store\'s field reads (messages(eeaf, { fields })).');
      let first = null;
      let last = null;
      let cursor;
      // The newest `scan` messages are looked through: a label is a recent carrier's, so older ones are not its.
      for (let looked = 0; looked < scan;) {
        const ids = eeaf.ids(TYPE, { before: cursor, limit: Math.min(200, scan - looked) });
        if (!ids.length) break;
        looked += ids.length;
        for (const [, row] of fields.fieldsOf(TYPE, ids, ['app', 'speaker', 'at'])) {
          if (row.app !== app || row.speaker !== speaker) continue;
          if (!last || row.at > last) last = row.at;
          if (!first || row.at < first) first = row.at;
        }
        cursor = ids.at(-1);
      }
      if (!first) return { named: 0, namings: [] };
      const namings = [];
      const day = 86_400_000;
      for (let from = Date.parse(first); from <= Date.parse(last); from += NAMING_DAYS * day) {
        const until = Math.min(from + NAMING_DAYS * day - 1, Date.parse(last));
        namings.push(this.nameSpeaker({ app, speaker, name, since: new Date(from).toISOString(), until: new Date(until).toISOString(), evidence }));
      }
      return { named: namings.reduce((sum, naming) => sum + naming.message_ids.length, 0), namings };
    },
    // Words kept as the person's that nobody confirmed were theirs (a room heard before its carrier said how sure it was
    // of the voice): every message one app kept from the person between `since` and `until` is kept under `as` (a
    // speaker other than the person or an AI, such as "Unsure (Sam?)") from now on, so it no longer reads as the
    // person's and name_speaker can name it later. Its id, time, words and links stay; `unconfirmed_from` keeps what it
    // was kept as, and one record keeps why and which messages. The window is at most NAMING_DAYS.
    /** The person's own messages one app kept between since and until (at most NAMING_DAYS apart): [{ id, message }]. */
    personMessagesIn({ app, since, until }) {
      const from = new Date(since).toISOString();
      const to = new Date(until).toISOString();
      if (!nonempty(app) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || to < from || Date.parse(to) - Date.parse(from) > NAMING_DAYS * 86_400_000)
        throw new MessageError(`app, since and until (at most ${NAMING_DAYS} days apart) are required.`);
      const found = [];
      let cursor = `${TYPE}:${to}\uffff`;
      for (;;) {
        const ids = eeaf.ids(TYPE, { before: cursor, limit: NAMING_PAGE });
        const inWindow = ids.filter(id => id >= `${TYPE}:${from}`);
        for (const id of inWindow) {
          const message = eeaf.read(id);
          if (message?.app === app && message.speaker === 'person') found.push({ id, message });
        }
        if (inWindow.length < NAMING_PAGE) break;
        cursor = ids.at(-1);
      }
      return found;
    },
    unconfirmPerson({ app, as, since, until, evidence } = {}) {
      if (![app, as, evidence].every(nonempty) || [since, until].some(time => typeof time !== 'string' || Number.isNaN(Date.parse(time))))
        throw new MessageError('app, as (the speaker the words are kept under now), since, until and evidence are required.');
      if (['person', 'ai'].includes(as)) throw new MessageError('as is a speaker other than the person or an AI.');
      const from = new Date(since).toISOString();
      const to = new Date(until).toISOString();
      if (to < from || Date.parse(to) - Date.parse(from) > NAMING_DAYS * 86_400_000) throw new MessageError(`until must follow since, at most ${NAMING_DAYS} days later.`);
      const recordId = `message-speaker-unconfirmed:${bytesToHex(blake3(new TextEncoder().encode(canonical({ app, as, from, to })))).slice(0, 32)}`;
      const previous = eeaf.read(recordId);
      if (previous) return previous;
      const found = this.personMessagesIn({ app, since: from, until: to });
      const unconfirmed_at = now().toISOString();
      const record = { app, as, since: from, until: to, evidence, unconfirmed_at, message_ids: found.map(({ id }) => id) };
      write([
        ...found.map(({ id, message }) => ({ id, type: TYPE, value: { ...message, speaker: as, unconfirmed_from: 'person', unconfirmed_at } })),
        { id: recordId, type: 'message-speaker-unconfirmed', value: record },
      ], { actor: { by: 'speaker-unconfirmed', app }, unwatched: true });
      return record;
    },
    // Correct a diagnostic or peer prompt once its raw source proves it was not the person's speech.
    // Keep both versions and the evidence in the append-only log; retire the false founder row and
    // its arrival so future readers and rules cannot act on it as a person message.
    correctProvenance({ message_id, speaker, evidence } = {}) {
      if (!nonempty(message_id) || !['sdk diagnostic', 'peer', 'generated context'].includes(speaker) || !nonempty(evidence))
        throw new MessageError('message_id, speaker (sdk diagnostic, peer, or generated context), and source evidence are required.');
      const correctionId = `message-provenance-correction:${message_id}`;
      const previous = eeaf.read(correctionId);
      if (previous) {
        if (previous.speaker !== speaker || previous.evidence !== evidence) throw new MessageError('This message already has a different provenance correction.');
        return previous;
      }
      const original = eeaf.read(message_id);
      if (!original || original.speaker !== 'person') throw new MessageError('A currently kept person message is required.');
      const revised = { ...original, speaker };
      delete revised.recorded_at;
      const newId = idOf(revised);
      if (!fields) throw new MessageError('Correcting a message needs the store\'s field reads (messages(eeaf, { fields })).');
      const arrivals = fields.idsWhere('arrival', 'message_id', message_id);
      const originalIndex = `${THREAD_TYPE}:${original.at}:${threadIdentity(original)}:${message_id.slice(-24)}`;
      const correctedAt = now().toISOString();
      const correction = { message_id, corrected_message_id: newId, speaker, evidence, corrected_at: correctedAt,
        original, retired_arrival_ids: arrivals };
      write([
        { id: newId, type: TYPE, value: { ...revised, recorded_at: original.recorded_at, corrected_from: message_id } },
        { id: message_id, type: TYPE, value: null },
        ...(eeaf.read(originalIndex) ? [{ id: originalIndex, type: THREAD_TYPE, value: null }] : []),
        ...arrivals.map(id => ({ id, type: 'arrival', value: null })),
        { id: correctionId, type: 'message-provenance-correction', value: correction },
      ], { actor: { by: 'provenance-correction', app: original.app }, unwatched: true });
      return correction;
    },
    // Keeps each message; returns how many were new and the id of each, in the order sent. `app` is the calling app's
    // own name, used for a message that names none.
    // `app` and `reader` are the sign-in that sent the batch, named by the service (src/worker.mjs), never by the batch:
    // each new message keeps them as recorded_by and recorded_app, so who recorded it cannot be claimed by its sender.
    // `road` is the way into the store, named by the service's own code and never by the batch (admit() keeps only the
    // fields it lists, so a sender cannot supply captured_road): saved logins read it to know a person's words were
    // captured, not written by an AI (src/saved-logins.mjs grantRefusal). A caller that names none is 'unspecified'.
    record({ messages: list } = {}, { app, reader = null, road = 'unspecified' } = {}) {
      if (!Array.isArray(list) || !list.length) throw new MessageError('messages must be a list of at least one message.');
      if (list.length > MAX_BATCH) throw new MessageError(`At most ${MAX_BATCH} messages at a time; send the rest in another call.`);
      const at = now();
      // A message stamped on arrival is never placed before the newest one kept (a high-water mark): a time given a
      // little ahead of this clock (claimed-time.json) would otherwise read as newer than everything said after it.
      const newest = list.some(item => object(item) && item.at === undefined) ? eeaf.ids(TYPE, { limit: 1 })[0] : null;
      const highWater = newest ? Date.parse(newest.slice(TYPE.length + 1, -25)) : Number.NaN;
      const stampFrom = Number.isFinite(highWater) && highWater >= at.getTime() ? new Date(highWater + 1) : at;
      let clockState = eeaf.read(HLC_STATE)?.clock ?? null;
      const identityIds = [];
      const admitted = list.map((item, index) => {
        const message = admit(item, index, at, app, stampFrom);
        // A locally assigned clock changes on a retry, so only a stable source clock participates in identity.
        identityIds.push(idOf(message));
        const clockNow = at.getTime() + index;
        const clock = message.clock ?? tickHybridClock(clockState, clockNow, 'trillion');
        clockState = receiveHybridClock(clockState, clock, clockNow, 'trillion');
        return { ...message, clock };
      });
      // A stamped message's key names it for RESEND_MINUTES: this window and the one before it.
      const window = Math.floor(at.getTime() / (RESEND_MINUTES * 60000));
      const keyOf = (message, slot) => `${KEY_TYPE}:${slot}:${bytesToHex(blake3(new TextEncoder().encode(canonical({
        conversation_id: message.conversation_id, app: message.app, speaker: message.speaker, text: message.text,
      })))).slice(0, 24)}`;
      if (!fields) throw new MessageError('Recording messages needs the store\'s field reads (messages(eeaf, { fields })).');
      // What the batch's keys name and what its kept messages hold is read for the whole batch at once (fields.fieldsOf:
      // a few named fields, never a record whole). A transcript hook sends the turns it already sent again, so most
      // messages in a batch are kept already; each used to cost three or four whole-record reads (2026-10-05: about
      // 10 000 a minute on Sam's store). A kept message is read whole only when its links are compared or it is
      // written again.
      const keysOf = (message, stamped) => {
        const sourceKey = message.source_ref ? sourceKeyOf(message) : null;
        // A message without a source_ref is found by its words in this slot of its time and the ones either side. Only the
        // person's words recorded by a transcript owner are folded: a person in any other app can mean to send "yes" twice.
        const slot = slotOf(message);
        const contentKeys = sourceKey || !Number.isFinite(slot) || message.speaker !== 'person' || !hookOwned(message.app) ? [] : [contentKeyOf(message, slot), contentKeyOf(message, slot - 1), contentKeyOf(message, slot + 1)];
        // A message that names its own place (source_ref) is found by that alone: the sender knows a retry from a repeat, so
        // two sends of the same words with two places are two messages, and the arrival-time guess is only for senders
        // that name none.
        return { sourceKey, contentKeys, keys: [...(sourceKey ? [sourceKey] : []), ...(stamped && !sourceKey ? [keyOf(message, window), keyOf(message, window - 1)] : [])] };
      };
      const batchKeys = admitted.map(({ stamped, ...message }) => keysOf(message, stamped));
      // This batch already names all roots to match. Traverse their runs together
      // rather than repeating filtered point seeks for each previously kept turn.
      // The generic field reader preserves projection budgets and scalar semantics.
      const named = new Map();
      for (const type of [SOURCE_KEY_TYPE, KEY_TYPE, CONTENT_KEY_TYPE]) {
        const ids = batchKeys.flatMap(({ keys, contentKeys }) => [...keys, ...contentKeys].filter(key => key.startsWith(`${type}:`)));
        for (const [key, row] of fields.fieldsOf(type, ids, ['message_id'], { groupRoots: true })) named.set(key, row.message_id ?? null);
      }
      const keptOwn = new Map();
      const readOwn = list => {
        const wanted = [...new Set(list)].filter(id => !keptOwn.has(id));
        const found = fields.fieldsOf(TYPE, wanted, KEPT_FIELDS, { groupRoots: true });
        for (const id of wanted) keptOwn.set(id, found.get(id) ?? null);
      };
      readOwn(admitted.flatMap(({ stamped }, index) => [batchKeys[index].keys.map(key => named.get(key)).find(Boolean) ?? identityIds[index], ...batchKeys[index].contentKeys.map(key => named.get(key)).filter(Boolean)]));
      // An item kept before source keys existed was its own conversation: the oldest of its few messages by the same app
      // and speaker, read as a page of at most LEGACY_CANDIDATES by three fields at once, never the conversation whole.
      const legacyItemOf = message => {
        const candidates = fields.idsWhere(TYPE, 'conversation_id', message.conversation_id, { limit: LEGACY_CANDIDATES });
        const held = fields.fieldsOf(TYPE, candidates, ['app', 'speaker', 'recorded_at']);
        return candidates.map(id => ({ id, kept: held.get(id) }))
          .filter(({ kept }) => kept?.app === message.app && kept?.speaker === message.speaker)
          .sort((left, right) => String(left.kept.recorded_at ?? '').localeCompare(String(right.kept.recorded_at ?? '')) || left.id.localeCompare(right.id))[0]?.id ?? null;
      };
      const ownOf = id => { if (!keptOwn.has(id)) readOwn([id]); return keptOwn.get(id); };
      const seen = new Map();
      // When each message this batch keeps was said, for the next of the same words in the batch to be compared with.
      const saidAt = new Map();
      const ids = [];
      const fresh = [];
      let recorded = 0;
      let linked = 0;
      for (const [index, { stamped, ...message }] of admitted.entries()) {
        const { sourceKey, keys, contentKeys } = batchKeys[index];
        // An item kept before source keys existed was its own conversation (`<app>:<source_ref>`). While its source key is
        // not kept yet, that earlier message is the item, so a rename or re-read folds into it and the key is kept from
        // then on. Ordinary chats, whose conversation holds many items, never match this shape.
        const sourceKept = sourceKey ? (seen.get(sourceKey) ?? named.get(sourceKey) ?? null) : null;
        const legacyId = sourceKey && !sourceKept && fields && message.conversation_id === `${message.app}:${message.source_ref}`
          ? legacyItemOf(message)
          : null;
        // The same words in this conversation within the window: the copy already kept, found by key, not by looking.
        const sameWords = contentKeys.map(key => seen.get(key) ?? named.get(key)).find(candidate => candidate
          && Math.abs(Date.parse(saidAt.get(candidate) ?? ownOf(candidate)?.at ?? '') - Date.parse(message.at)) <= DUPLICATE_MINUTES * 60000) ?? null;
        const earlier = keys.map(key => seen.get(key) ?? named.get(key)).find(Boolean) ?? legacyId ?? sameWords;
        const bySource = sourceKey ? (sourceKept ?? legacyId) : null;
        const id = earlier ?? identityIds[index];
        ids.push(id);
        if (seen.has(id)) continue;
        const own = ownOf(id);
        if (sourceKept && own === null) {
          if (eeaf.erasure?.(id)) throw new MessageError('This source input was erased and cannot be replayed.');
          throw new MessageError('The original source message is unavailable.');
        }
        // A message kept before it named its source (an export brought in earlier, or a resend within the window) is
        // found by its time and words; it is named by its source from then on.
        if (sourceKey && (earlier || own !== null) && !sourceKept) { seen.set(sourceKey, id); fresh.push({ id: sourceKey, type: SOURCE_KEY_TYPE, value: { message_id: id } }); }
        if (earlier || own !== null) {
          // Kept already: links it does not have yet (a file found since) are added; its words change only when its
          // source item was reworded (3a). Its links live beside it, so it is read whole only when links came with it.
          let whole = (message.about?.length || message.attachments?.length) && own !== null ? eeaf.read(id) : undefined;
          const kept = whole ?? own;
          const about = withNewLinks(kept, message.about);
          const attachments = withNewAttachments(kept, message.attachments);
          // A transcript hook may first keep the answer before learning the exact
          // final-row ID. Attach that ID only to the same immutable words and time.
          const sourceRef = sourceKey && kept && !kept.source_ref
            && kept.conversation_id === message.conversation_id && kept.app === message.app
            && kept.speaker === message.speaker && (id === legacyId || (kept.at === message.at && kept.text === message.text))
            ? message.source_ref : null;
          // The same item at its source, now with other words (3a): its words are the ones sent now.
          const reworded = bySource && kept && kept.text !== message.text ? message.text : null;
          const sourceAt = bySource && kept && !kept.source_at && message.source_at ? message.source_at : null;
          if (about || attachments || sourceRef || sourceAt || reworded !== null) {
            seen.set(id, id);
            if (whole === undefined && own !== null) whole = eeaf.read(id);
            fresh.push({ id, type: TYPE, value: { ...whole, ...(about ? { about } : {}), ...(attachments ? { attachments } : {}), ...(sourceRef ? { source_ref: sourceRef } : {}), ...(sourceAt ? { source_at: sourceAt } : {}),
              ...(reworded !== null ? { text: reworded, reworded_at: at.toISOString() } : {}) } });
            if (about || attachments) linked += 1;
          }
          continue;
        }
        seen.set(id, id);
        saidAt.set(id, message.at);
        fresh.push({ id, type: TYPE, value: { ...message, recorded_at: at.toISOString(), captured_road: nonempty(road) ? road : 'unspecified', ...(nonempty(reader) ? { recorded_by: reader } : {}), ...(nonempty(app) ? { recorded_app: app } : {}) } });
        recorded += 1;
        if (sourceKey) { seen.set(sourceKey, id); fresh.push({ id: sourceKey, type: SOURCE_KEY_TYPE, value: { message_id: id } }); }
        if (stamped && !sourceKey) { const key = keyOf(message, window); seen.set(key, id); fresh.push({ id: key, type: KEY_TYPE, value: { message_id: id } }); }
        if (contentKeys.length) { const key = contentKeys[0]; seen.set(key, id); fresh.push({ id: key, type: CONTENT_KEY_TYPE, value: { message_id: id } }); }
      }
      if (fresh.length) write([...fresh, { id: HLC_STATE, type: 'setting', value: { clock: clockState } }], { actor: { by: nonempty(reader) ? reader : 'ai', app: nonempty(app) ? app : admitted[0].app } });
      return { recorded, already_kept: ids.length - recorded, ids, ...(linked ? { linked } : {}) };
    },

    // The newest messages first, optionally only one conversation, only one app, only other apps than the caller's
    // (not_app), only those about one thing, only one speaker, or only those whose text holds every word of `query`
    // (in any order, any case). `before` is next_before from the previous page. A named conversation reads its existing
    // conversation_id index, so newer messages elsewhere cannot hide the message a notice opens. One read looks
    // through at most PAGE.scan candidates however rare its other filters: it answers what it found, how many it
    // looked through (looked_through), and next_before within that same selection, so no read walks the whole history.
    // A notice may name message_id as well as its exact app and conversation: that kept message is the newest row
    // of the page, with earlier context behind it. Its identity is verified before its body is opened; a missing or
    // mismatched target is refused, never replaced by some other message or an apparently empty conversation.
    read({ conversation_id, app, not_app, about_id, speaker, query, before, limit, message_id } = {}) {
      const wanted = Math.min(Math.max(Math.floor(Number(limit) || PAGE.default), 1), PAGE.max);
      const anchored = message_id !== undefined && message_id !== null;
      if (anchored && (!nonempty(message_id) || !nonempty(app) || !nonempty(conversation_id)))
        throw new MessageError('A message link must name its message, app and conversation.');
      if (anchored && nonempty(before)) throw new MessageError('Choose a message to open or an earlier page, not both.');
      const words = nonempty(query) ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const holdsWords = message => {
        const text = String(message.text ?? '').toLowerCase();
        return words.every(word => text.includes(word));
      };
      // The filters on a message's own top-level fields, which are read for a whole page of ids in one query
      // (fields.fieldsOf); only a message they keep is read whole, where about_id (a list) is checked.
      const ownFilters = [conversation_id, app, not_app, speaker].some(nonempty) || words.length > 0;
      if (ownFilters && !fields) throw new MessageError('Reading messages by their words, app, speaker or conversation needs the store\'s field reads (messages(eeaf, { fields })).');
      const keepOwn = message => (!nonempty(conversation_id) || message.conversation_id === conversation_id)
        && (!nonempty(app) || message.app === app) && (!nonempty(not_app) || message.app !== not_app)
        && (!nonempty(speaker) || message.speaker === speaker)
        && holdsWords(message);
      const keep = message => keepOwn(message) && (!nonempty(about_id) || (message.about ?? []).some(link => link.id === about_id));
      const found = [];
      let cursor = nonempty(before) ? before : undefined;
      let looked = 0;
      if (anchored) {
        const unavailable = () => Object.assign(new MessageError('This message could not be found in this conversation.'), { status: 404 });
        const own = message_id.startsWith(`${TYPE}:`)
          ? fields.fieldsOf(TYPE, [message_id], words.length ? OWN_FILTER_FIELDS : OWN_FILTER_FIELDS.filter(field => field !== 'text')).get(message_id)
          : null;
        if (!own || !keepOwn(own)) throw unavailable();
        const message = eeaf.read(message_id);
        if (!message || !keep(message)) throw unavailable();
        found.push({ id: message_id, ...message });
        cursor = message_id;
        looked = 1;
      }
      // Every value of the existing conversation_id index is fixed here, so its id order is the same newest-first
      // order as the global inbox. The cursor therefore remains a message id across both reads and both engines.
      const idsBefore = (before, limit) => nonempty(conversation_id)
        ? eeaf.scan(TYPE, 'conversation_id', { equal: [conversation_id], idTo: before, reverse: true, limit }).map(entry => entry.id)
        : eeaf.ids(TYPE, { before, limit });
      // Pages of candidate ids, newest first, until enough match or PAGE.scan candidates have been looked through.
      while (found.length < wanted && looked < PAGE.scan) {
        const ids = idsBefore(cursor, Math.min(Math.max(wanted * 2, 50), PAGE.scan - looked));
        if (!ids.length) break;
        // A message's words are read only when a query asks for them: a filter on its app or speaker alone that looks
        // through a thousand messages never reads a thousand bodies (some hold whole hour-long transcripts).
        const own = ownFilters ? fields.fieldsOf(TYPE, ids, words.length ? OWN_FILTER_FIELDS : OWN_FILTER_FIELDS.filter(field => field !== 'text')) : null;
        // The bodies a page needs are read together, as many as are still wanted (more only when about_id turns some away).
        const candidates = own ? ids.filter(id => own.has(id) && keepOwn(own.get(id))) : ids;
        const bodies = new Map();
        const body = id => {
          if (!bodies.has(id) && typeof eeaf.readMany === 'function') {
            for (const [read, value] of eeaf.readMany(candidates.slice(candidates.indexOf(id), candidates.indexOf(id) + wanted - found.length))) bodies.set(read, value);
          }
          return bodies.has(id) ? bodies.get(id) : eeaf.read(id);
        };
        for (const id of ids) {
          cursor = id;
          looked += 1;
          if (own && !(own.has(id) && keepOwn(own.get(id)))) continue;
          const message = body(id);
          if (message && keep(message)) found.push({ id, ...message });
          if (found.length === wanted) break;
        }
      }
      const more = looked > 0 && idsBefore(cursor, 1).length > 0;
      // A named message need not be the latest. Probe only the conversation's index and app fields, never newer
      // bodies. When other apps reuse this conversation id, a bounded probe may still be unfinished: offer Latest
      // conservatively then, rather than claim the addressed window reaches the end of the conversation.
      const hasNewer = () => {
        let upper;
        let checked = 0;
        while (checked < PAGE.scan) {
          const count = Math.min(50, PAGE.scan - checked);
          const ids = eeaf.scan(TYPE, 'conversation_id', { equal: [conversation_id], idFrom: message_id, idTo: upper, reverse: true, limit: count })
            .map(entry => entry.id).filter(id => id !== message_id);
          if (!ids.length) return false;
          const own = fields.fieldsOf(TYPE, ids, ['app']);
          if (ids.some(id => own.get(id)?.app === app)) return true;
          checked += ids.length;
          upper = ids.at(-1);
          if (ids.length < count) return false;
        }
        return eeaf.scan(TYPE, 'conversation_id', { equal: [conversation_id], idFrom: message_id, idTo: upper, reverse: true, limit: 1 })
          .some(entry => entry.id !== message_id);
      };
      return { messages: found, next_before: more ? cursor : null, looked_through: looked, ai_instructions: [RECORD_THIS_TURN],
        ...(anchored ? { anchor_message_id: message_id, has_newer: hasNewer() } : {}) };
    },

    // One current preview per app + conversation, newest activity first. Batch field reads avoid opening every body.
    listConversations({ app, before, limit } = {}) {
      const wanted = Math.min(Math.max(Math.floor(Number(limit) || PAGE.default), 1), PAGE.max);
      const conversations = [];
      let pageCursor = null;
      try { if (nonempty(before)) pageCursor = JSON.parse(decodeURIComponent(before)); } catch { pageCursor = { before }; }
      const seen = new Set(Array.isArray(pageCursor?.skip) ? pageCursor.skip : []);
      let cursor = messageCursor(eeaf, pageCursor?.before) ?? undefined;
      let hasMore = false;
      let include = messageCursor(eeaf, pageCursor?.include) ?? null;
      let first = true;
      while (true) {
        const ids = first && include ? [include, ...eeaf.ids(TYPE, { before: cursor, limit: Math.max(wanted * 2, 50) })] : eeaf.ids(TYPE, { before: cursor, limit: Math.max(wanted * 2, 50) });
        const own = fields?.fieldsOf(TYPE, ids, ['app', 'conversation_id']) ?? null;
        first = false;
        include = null;
        if (!ids.length) break;
        for (const id of ids) {
          if (id === cursor && id !== pageCursor?.include) continue;
          cursor = id;
          const message = own?.get(id) ?? eeaf.read(id);
          if (!message || (nonempty(app) && message.app !== app)) continue;
          const key = threadIdentity(message);
          if (seen.has(key)) continue;
          if (conversations.length === wanted) { hasMore = true; include = id; break; }
          const latest = eeaf.read(id);
          if (!latest) continue;
          seen.add(key);
          conversations.push({ id: `conversation:${key}`, app: message.app, conversation_id: message.conversation_id, latest: { id, ...latest } });
        }
        if (hasMore || ids.length < Math.max(wanted * 2, 50)) break;
      }
      const next_before = hasMore ? encodeURIComponent(JSON.stringify({ before: cursor, include, skip: [...seen] })) : null;
      return { conversations, next_before, backfill_pending: false };
    },
  };
}

// Required native-owner API additions, retained from verified main; existing owner behavior stays above.
