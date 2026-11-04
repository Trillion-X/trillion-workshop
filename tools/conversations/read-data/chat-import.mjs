// tools/conversations/read-data/chat-import.mjs (moved from Trillion-X/trillion src/chat-import.mjs)
//
// A whole chat export brought into Trillion: read here on the person's own computer, inside the folder they granted,
// then kept one conversation at a time through the same road one chat's archive takes, into the private Trillion or
// into the one space the person names. The person's records are reached through the records door the run was handed
// (tools/records-door): the message owner that keeps them (src/messages.mjs, moved to
// tools/keep-and-wake-ai-sessions-on-this-computer) runs unchanged over a staged view of the door (stagedRecords).
//
// The export is a file on the person's computer. It is read a page of conversations at a time, so an export of
// thousands of chats goes in over several runs and a repeat adds nothing twice: each file has a cursor row
// (record conversation-import-cursor) that moves only past conversations the door kept, so a run that stops (a busy
// door, a timeout, the run's time box) continues where it stopped. Every app's conversations come in this way: the
// account exports, and the sessions local AI apps keep (read by the harness rules old Trillion recorded them by).
// Where each one is, is DATA (read-data/conversation-sources-on-this-computer.json).
//
// Attachments: a chat's messages name the files they carried (src/chat-archives.mjs attachmentsOf). An account export
// puts each file beside conversations.json, named with its id first (file-XXXX-photo.png), sometimes in a folder under
// it. attachmentFinder finds each one among the person's own files: by the name or identity the person gave for that
// id, or by that id at the start of a file's name in the export's folder (or the folder the person names) and the
// folders under it. Bytes are never copied: a private message links the file, a space gets a file item whose bytes
// stay in the importer's store. A file that cannot be found is reported, never an error. Over the records door (the run
// on the person's computer below), the export's files are on the computer beside it: each one a message names is found
// there and copied into the person's files through the files door (fileKeeper, exportFilesBeside), and an image pasted
// into a local AI app's session is copied the way old Trillion's recorder kept it (/messages/<conversation>/<message>-<n>).
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conversationFrom } from './chat-archives.mjs';
import { messages } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { RecordsDoorError } from '../../records-door/read-data/records-door.mjs';
import { writeWholeFile } from '../../records-door/read-data/whole-file.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import conversationList from './ai-conversations-list.json' with { type: 'json' };
import places from './conversation-sources-on-this-computer.json' with { type: 'json' };
import { archiveEntries, profile } from '../../take-pictures-out-of-a-zip-archive/src/archive-entries.mjs';
import { messagesOf, personSpeaksIn, rowsFrom, sessionOfTranscript, settings as harnessRules } from '../../keep-and-wake-ai-sessions-on-this-computer/harness/record-every-message.mjs';

const cleanFolder = value => (typeof value === 'string' && value.trim().startsWith('/') ? value.trim().replace(/\/+$/, '') || '/' : null);

/**
 * Finds the file one attachment reference names among this person's files (namespace: src/namespace-store.mjs).
 * attachments: { <attachment id>: a file name ("/exports/file-XXXX-photo.png") or identity } the person gave.
 * folder: where the export's files are (its folder and the folders under it are searched by id at the start of a
 * name). namespace answers byName, locate, foldersUnder and namesStartingWith, directly or as promises.
 * Returns async ref => { identity, name, byte_length, media_type } | null. Files still being uploaded are not found.
 */
export function attachmentFinder(namespace, { attachments, folder } = {}) {
  const given = attachments && typeof attachments === 'object' && !Array.isArray(attachments) ? attachments : {};
  const root = cleanFolder(folder);
  let folders = null;
  const found = (row, name) => (row && !row.growing ? { identity: row.identity, name: name ?? row.names?.[0] ?? null, byte_length: row.byte_length, media_type: row.media_type ?? null } : null);
  return async ref => {
    const named = typeof given[ref.id] === 'string' ? given[ref.id].trim() : '';
    if (named) return named.startsWith('/') ? found(await namespace.byName(named), named) : found(await namespace.locate(named));
    if (!root) return null;
    folders ??= await namespace.foldersUnder(root);
    for (const collection of folders) {
      for (const hit of await namespace.namesStartingWith(collection, ref.id)) {
        // The id must end where the name's id ends: file-AB never finds file-ABC-photo.png.
        const after = hit.name.charAt(hit.name.lastIndexOf('/') + 1 + ref.id.length);
        if (/[A-Za-z0-9]/.test(after) || !hit.identity) continue;
        const file = found(await namespace.locate(hit.identity), hit.name);
        if (file) return file;
      }
    }
    return null;
  };
}

/**
 * One row per imported conversation in the AI conversations list (read-data/ai-conversations-list.json), made once with
 * ensure. Only facts read from the chat are written, so labels, people, pursuits and follow-ups the person or an AI
 * set stay as they are on a re-import. chat: conversationFrom's shape; conversationId: the id its messages carry.
 * lists: the person's lists over the door (tools/records-door listsOverDoor). totals, when given, are the facts of the
 * whole conversation where this chat is only the part read this time (a long transcript read a piece at a time);
 * original_file names the export file it came from.
 */
export async function keepConversationRow(lists, chat, conversationId, { totals = null, original_file: originalFile = null } = {}) {
  const { _what, row_id_max: max, ...definition } = conversationList;
  await lists.ensure(definition);
  const times = chat.messages.map(message => message.at).filter(Boolean).sort();
  const models = [...new Set(chat.messages.map(message => message.model).filter(Boolean))];
  const facts = totals ?? { messages: chat.messages.length, started: times[0], last: times.at(-1), models };
  const values = { title: chat.title ?? conversationId, app: chat.app, conversation_id: conversationId, messages: facts.messages,
    ...(facts.started ? { started: facts.started, last: facts.last } : {}), ...(facts.models?.length ? { models: facts.models } : {}),
    ...(originalFile ? { original_file: originalFile } : {}) };
  const id = String(chat.conversation_id).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, max);
  return lists.putRows(definition.id, { rows: [{ id, values }] });
}

/**
 * One chat's archive kept in the private Trillion or one space (the bring_in_chat road), by whichever store keeps the
 * account's records: eeaf is its records, namespace its files (attachmentFinder), addSpaceItems the space owner's write and
 * relay() the account's network relay. A repeat adds nothing twice; files not found are listed, never an error.
 * A private import's writes are synchronous, so `commit` keeps them with their answer in one step (CHAT_RECEIPTED_WRITES):
 * a lost import is answered from that receipt, never imported again. Over the records door, eeaf is stagedRecords(door)
 * .eeaf and commit its commit, which runs the step again until everything it reads has been read from the door, then
 * sends its writes; `now` is the one time the step runs at, so each run of it makes the same records. lists keeps the
 * conversation's row (keep_row false leaves that to the caller, which knows the whole conversation's facts).
 */
export const CHAT_RECEIPTED_WRITES = ['chats:import'];
export async function importConversation({ conversation, space_id: spaceId = null, reach, app = 'ChatGPT', attachments, attachments_folder: folder, preserve_conversation_id = false, most_text, keep_row = true, original_file }, { eeaf, namespace, addSpaceItems, relay, commit = change => change(), lists, now = () => new Date(), find: findFile = null }) {
  const chat = conversationFrom(conversation, app, most_text ? { most_text } : {});
  const label = chat.title ?? chat.conversation_id;
  if (!spaceId && !reach.private) throw new Error('This sign-in reaches shared pursuits only, so it cannot keep messages in the private Trillion.');
  // Finding a file reads the private files, so a sign-in held to shared spaces finds none.
  // Over the records door the run hands its own finder (the export's files on this computer, copied through the door).
  const find = findFile ?? (reach.private && namespace ? attachmentFinder(namespace, { attachments, folder }) : () => null);
  const files = new Map();
  const missing = [];
  for (const ref of chat.messages.flatMap(message => message.attachments)) {
    if (files.has(ref.id) || missing.some(item => item.id === ref.id)) continue;
    const file = await find(ref);
    if (file) files.set(ref.id, { ...file, name: ref.name ?? file.name?.split('/').pop() ?? null, media_type: file.media_type ?? ref.mime_type });
    else missing.push({ conversation: label, id: ref.id, name: ref.name });
  }
  // A message of only files, none of them found yet, has nothing to keep until they are.
  const kept = chat.messages.filter(message => message.text.trim() || message.attachments.some(ref => files.has(ref.id)));
  const batches = [];
  for (let start = 0; start < kept.length; start += 100) batches.push(kept.slice(start, start + 100));
  let added = 0;
  let already = 0;
  const times = kept.map(message => message.at).filter(Boolean).sort();
  const answer = () => ({ conversation: label, conversation_id: preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`, into: spaceId ? { space_id: spaceId } : 'private', messages: kept.length, added, already_there: already, attachments_found: files.size, missing_attachments: missing,
    started: times[0] ?? null, last: times.at(-1) ?? null, models: [...new Set(kept.map(message => message.model).filter(Boolean))],
    ...(reach.private || !missing.length ? {} : { attachments_note: 'This sign-in reaches shared pursuits only, so your files were not searched for the chat\'s attachments.' }) });
  if (spaceId) {
    const at = { relay: await relay(), space_id: spaceId, origin: 'import' };
    const itemOf = new Map();
    const found = [...files];
    for (let start = 0; start < found.length; start += 100) {
      const page = found.slice(start, start + 100);
      const { ids } = await addSpaceItems({ ...at, items: page.map(([id, file]) => ({
        kind: 'file', title: file.name, source_ref: `chat-file:${chat.conversation_id}:${id}`,
        body: { identity: file.identity, name: file.name, byte_length: file.byte_length, media_type: file.media_type } })) });
      page.forEach(([id], index) => itemOf.set(id, ids[index]));
    }
    for (const batch of batches) {
      const result = await addSpaceItems({ ...at, items: batch.map(message => ({
        kind: 'message', title: chat.title, source_ref: `chat:${chat.conversation_id}:${message.node}`,
        about: message.attachments.filter(ref => itemOf.has(ref.id)).map(ref => itemOf.get(ref.id)),
        body: { app: chat.app, conversation_id: chat.conversation_id, conversation: chat.title, speaker: message.speaker, text: message.text, at: message.at, ...(message.source_at ? { source_at: message.source_at } : {}), attachments: message.attachments.filter(ref => files.has(ref.id)).map(ref => files.get(ref.id).identity), ...(message.model ? { model: message.model } : {}) } })) });
      added += result.added.length; already += result.already_there;
    }
    return answer();
  }
  const kept_answer = await commit(() => {
    added = 0; already = 0;
    const store = messages(eeaf, { now });
    for (const batch of batches) {
      const result = store.record({ messages: batch.map(message => {
        const about = message.attachments.filter(ref => files.has(ref.id)).map(ref => ({ kind: 'file', id: files.get(ref.id).identity }));
        const attachments = message.attachments.filter(ref => files.has(ref.id)).map(ref => {
          const file = files.get(ref.id);
          return { identity: file.identity, ...(file.name ? { name: file.name } : {}), ...(file.media_type ? { media_type: file.media_type } : {}) };
        });
        return { conversation_id: preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`, app: chat.app, speaker: message.speaker, text: message.text, source_ref: message.node, ...(message.at ? { at: message.at } : {}), ...(message.source_at ? { source_at: message.source_at } : {}), ...(message.model ? { model: message.model } : {}), ...(attachments.length ? { attachments } : {}), ...(about.length ? { about } : {}) };
      }) }, { app: chat.app, road: 'chat_import' });
      added += result.recorded; already += result.already_kept;
    }
    return answer();
  }, { operation: 'chats:import' });
  if (keep_row && lists && kept.length) await keepConversationRow(lists, chat, preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`, { original_file });
  return kept_answer;
}

export const CHAT_IMPORT_PATHS = ['/chats/import', '/chats/import-history'];
/** POST /chats/import (and /chats/import-history, which keeps the conversation id as given) for the private Trillion,
 *  answered by whichever store keeps the account's records: keeps() says whether its plan keeps messages. */
export async function handleChatImportRequest({ keeps, reach, keep }, request) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !CHAT_IMPORT_PATHS.includes(path)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!(await keeps())) return Response.json({ error: 'On the free plan nothing is kept, so chats are not brought in. A paid plan keeps every message.', upgrade_needed: true }, { status: 402 });
  try { return Response.json(await keep({ ...(await request.json()), ...(path === '/chats/import-history' ? { preserve_conversation_id: true } : {}), space_id: null, reach })); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}

/** The conversations an export file holds: a JSON file's own, or, for an account export zip (it starts with PK), those of every
 *  conversations*.json inside, read by the one archive reader (src/archive-entries.mjs, profile chat_export). */
export function exportedConversations(bytes) {
  const zipped = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  let texts;
  if (zipped) {
    try { texts = archiveEntries(bytes, profile('chat_export')).map(entry => new TextDecoder().decode(entry.bytes)); } catch (error) { throw new Error(`This zip is not a chat export: ${error.message}`); }
    if (!texts.length) throw new Error('This zip holds no conversations.json.');
  } else texts = [new TextDecoder().decode(bytes)];
  try { return texts.flatMap(text => { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : [parsed]; }); } catch { throw new Error('This file is not a chat export (it is not JSON).'); }
}

// (importChatExport, the Worker's read of an export from the person's hosted files a page at a time, is the run below:
// importConversationsFrom reads the export where it is on this computer and keeps its place in a cursor row.)

// ---------------------------------------------------------------------------------------------------------------------
// Over the records door
// ---------------------------------------------------------------------------------------------------------------------

const settings = places.settings;
const CURSOR_TYPE = 'conversation-import-cursor';
const BUSY = new Set(['selected_owner_unavailable', 'original_workspace_source_unavailable', 'transport_unavailable', 'call_timed_out', 'http_502', 'http_503', 'http_504']);

/** A run ended before its source was done: the door stayed busy or slow past its retries. Its cursor rows say where it
 *  stopped, so the next run (resume) starts there. */
export class ImportStopped extends Error {
  constructor(reason, cause) { super(reason); this.reason = reason; this.cause = cause; }
}

const waitFor = ms => new Promise(done => setTimeout(done, ms));
const isTransport = error => error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError';

/**
 * The door the run was handed, patient: a call the door answers busy (503, selected_owner_unavailable), with an unknown
 * outcome, or not within call_timeout_ms is sent again after a growing wait (first_wait_ms doubling to most_wait_ms),
 * up to `retries` times. A write is sent again with its own request key, so a write that did land answers its first
 * receipt and nothing is written twice. Past the retries the run stops (ImportStopped) and keeps its cursor.
 */
export function patientDoor(door, { rules = settings, wait = waitFor } = {}) {
  async function patiently(what, call) {
    for (let attempt = 0; ; attempt += 1) {
      let timer;
      try {
        return await Promise.race([call(), new Promise((_, fail) => { timer = setTimeout(() => fail(new RecordsDoorError('call_timed_out', `The records door did not answer within ${rules.call_timeout_ms} ms.`, 'unknown')), rules.call_timeout_ms); })]);
      } catch (error) {
        const again = error instanceof RecordsDoorError ? BUSY.has(error.code) || error.outcome === 'unknown' : isTransport(error);
        if (!again) throw error;
        if (attempt >= rules.retries) throw new ImportStopped(`The records door stayed busy or slow through ${rules.retries + 1} tries of a ${what} (${error.code ?? error.message}); run the import again to go on from here.`, error);
        await wait(Math.min(rules.first_wait_ms * 2 ** attempt, rules.most_wait_ms));
      } finally { clearTimeout(timer); }
    }
  }
  return {
    read: (type, id) => patiently('read', () => door.read(type, id)),
    write: (records, options) => patiently('write', () => door.write(records, options)),
    // The person's files (find_file, write_file_start, write_file_piece, write_file_finish): a piece sent again lands at
    // its own offset, so a retried piece is the same piece.
    files: (method, input) => patiently(method, () => door.files(method, input)),
    // A list is read again from its start when a page fails, up to `most` records; the caller sees each once.
    async *list(query, { most = Infinity } = {}) {
      const seen = [];
      await patiently('list', async () => {
        seen.length = 0;
        for await (const record of door.list(query)) { seen.push(record); if (seen.length >= most) break; }
      });
      yield* seen;
    },
  };
}

const typeOfId = id => (id.startsWith('setting:') ? 'setting' : id.slice(0, id.indexOf(':')));
const keyOfWrite = records => `conversations-import:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(records))).slice(3, 51)}`;

/**
 * The person's records as the message owner reads and writes them (messages(eeaf, { fields })), over the door. The
 * owner reads and writes synchronously, the door answers later, so `commit(step)` runs the step against what has been
 * read so far, notes every record it asked for that has not been read yet, reads those from the door and runs the step
 * again, until a run asks for nothing new; then it sends that run's writes, in order, in door writes that each fit one
 * message. A record the step writes before a later one (a message before its source key) is never sent after it.
 */
export function stagedRecords(door, { rules = settings } = {}) {
  const held = new Map();
  const queries = new Map();
  let overlay = new Map();
  let missing = new Set();
  let writes = [];
  const known = id => {
    if (overlay.has(id)) return overlay.get(id);
    if (held.has(id)) return held.get(id);
    missing.add(id);
    return null;
  };
  const asked = (key, fallback) => { if (queries.has(key)) return queries.get(key); missing.add(key); return fallback; };
  const eeaf = {
    read: known,
    ids: (type, { limit = 1 } = {}) => asked(JSON.stringify(['ids', type, limit]), []),
    // The voice stretches the owner keeps for speakers a live voice session names; an import names none.
    scan: () => [],
    write(batch) { for (const record of batch) { overlay.set(record.id, record.value); writes.push(record); } return { written: batch.length }; },
    fields: {
      fieldsOf(type, ids, names) {
        const found = new Map();
        for (const id of ids) {
          const value = known(id);
          if (value && typeof value === 'object') found.set(id, Object.fromEntries(names.filter(name => name in value).map(name => [name, value[name]])));
        }
        return found;
      },
      idsWhere: (type, field, value, { limit = 20 } = {}) => asked(JSON.stringify(['where', type, field, value, limit]), []),
    },
  };
  async function fetchMissing() {
    for (const key of missing) {
      if (key.startsWith('[')) {
        const [how, type, ...rest] = JSON.parse(key);
        const ids = [];
        const query = how === 'ids' ? { type, limit: rest[0] } : { type, where: { [rest[0]]: rest[1] }, fields: [], limit: rest[2] };
        for await (const record of door.list(query, { most: query.limit })) { ids.push(record.id); if (ids.length >= query.limit) break; }
        queries.set(key, ids);
      } else held.set(key, await door.read(typeOfId(key), key));
    }
  }
  return {
    eeaf,
    async commit(step) {
      for (let round = 0; ; round += 1) {
        overlay = new Map(); missing = new Set(); writes = [];
        let result, failure = null;
        try { result = step(); } catch (error) { failure = error; }
        if (missing.size) {
          if (round > 50) throw new Error('The message owner kept asking for records it had not read; nothing was written.');
          await fetchMissing();
          continue;
        }
        if (failure) throw failure;
        const batches = writeBatches(writes, { rows: rules.write_rows, bytes: rules.write_bytes });
        try { for (const batch of batches) await door.write(batch, { key: keyOfWrite(batch) }); }
        catch (error) { held.clear(); queries.clear(); throw error; }
        for (const [id, value] of overlay) held.set(id, value);
        // The newest message changes with every write; read it again when it is next asked for.
        for (const key of [...queries.keys()]) if (key.startsWith('["ids"')) queries.delete(key);
        return result;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The files a message carried, copied into the person's files through the files door
// ---------------------------------------------------------------------------------------------------------------------

const safePart = value => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
const extensionOf = (mediaType, rules = settings) => Object.entries(rules.media_types).find(([, type]) => type === mediaType)?.[0]
  ?? rules.magic.find(item => item.media_type === mediaType)?.extension ?? '.bin';

/** What a file is, by its extension, else by the bytes it starts with (settings.media_types, settings.magic). */
export function mediaTypeOf(name, bytes, rules = settings) {
  const byName = rules.media_types[extname(String(name ?? '')).toLowerCase()];
  if (byName) return byName;
  const hex = Buffer.from(bytes.subarray(0, 16)).toString('hex');
  const magic = rules.magic.find(item => hex.startsWith(item.starts) && (!item.then || hex.slice(item.then_at * 2).startsWith(item.then)));
  return magic?.media_type ?? 'application/octet-stream';
}

/**
 * Keeps bytes as one of the person's files at `name` through the run's files door. A file already there with the same
 * identity (BLAKE3 of its bytes) is not written again, so a rerun copies nothing twice; otherwise it is written in pieces
 * (records-door whole-file.mjs writeWholeFile) under an upload id made of its name and identity, so a write sent again
 * resumes the same upload. Returns async ({ name, bytes, media_type }) => { identity, name, byte_length, media_type, already }.
 */
export function fileKeeper(door) {
  return async function keepFile({ name, bytes, media_type: mediaType }) {
    const identity = makeHashCodeHexFromBytes(bytes);
    let there = null;
    try { there = await door.files('find_file', { name_or_identity: name }); }
    catch (error) { if (error instanceof ImportStopped) throw error; }
    const thereIdentity = there?.identity ?? there?.names?.[0]?.identity ?? null;
    if (thereIdentity === identity) return { identity, name, byte_length: bytes.length, media_type: mediaType, already: true };
    const uploadId = `conversations-${makeHashCodeHexFromBytes(new TextEncoder().encode(`${name}\n${identity}`)).slice(3, 35)}`;
    const finished = await writeWholeFile(door, name, bytes, { mediaType, uploadId });
    return { identity: finished?.identity ?? identity, name, byte_length: bytes.length, media_type: mediaType, already: false };
  };
}

/**
 * The files beside an export on this computer: its folder and the folders under it, settings.attachment_depth deep.
 * locate(id) is the file an attachment id names: one whose name starts with the id and goes on with no further letter or
 * digit (file-AB never finds file-ABC-photo.png, as attachmentFinder above), or one in a folder named the id (a Grok
 * asset's <id>/content).
 */
export function exportFilesBeside(home, exportPath, rules = settings) {
  let index = null;
  const build = () => {
    index = [];
    const budget = { left: rules.attachment_index_files };
    const visit = (path, left) => {
      let entries;
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (budget.left-- <= 0) return;
        const child = join(path, entry.name);
        if (entry.isDirectory()) { if (left > 0 && !entry.name.startsWith('.')) visit(child, left - 1); }
        else if (entry.isFile() && child !== exportPath && !entry.name.startsWith('.')) index.push({ path: child, name: entry.name, folder: basename(path) });
      }
    };
    visit(dirname(exportPath), rules.attachment_depth);
  };
  return {
    locate(id) {
      if (!id) return null;
      if (!index) build();
      const hit = index.find(file => file.name.startsWith(id) && !/[A-Za-z0-9]/.test(file.name.charAt(id.length)))
        ?? index.find(file => file.folder === id);
      return hit && inside(home, hit.path) ? hit : null;
    },
  };
}

/** The finder importConversation takes for one export's messages: each attachment at the path the person gave for its
 *  id (`given`: { id: a path in the granted folder }), else found beside the export, and copied to
 *  <attachments_folder>/<app>/<its name>; a file not found, too large or refused by the door is missing. */
function exportAttachmentFinder(home, exportPath, keepFile, app, count, rules = settings, given = {}) {
  const beside = exportFilesBeside(home, exportPath, rules);
  const kept = new Map();
  const named = id => {
    const path = typeof given?.[id] === 'string' && given[id].trim() ? inside(home, resolve(home, given[id].trim())) : null;
    return path && statSync(path).isFile() ? { path, name: basename(path), folder: basename(dirname(path)) } : null;
  };
  return async ref => {
    if (kept.has(ref.id)) return kept.get(ref.id);
    const hit = named(ref.id) ?? beside.locate(ref.id);
    let file = null;
    if (hit) {
      if (statSync(hit.path).size > rules.most_attachment_bytes) count.attachments_too_large += 1;
      else {
        const bytes = readFileSync(hit.path);
        const media = ref.mime_type ?? mediaTypeOf(hit.name, bytes, rules);
        // A file with no extension (Grok's <id>/content) is kept under its id, with the extension its bytes say.
        const name = extname(hit.name) ? hit.name : `${ref.id}${extensionOf(media, rules)}`;
        try { file = await keepFile({ name: `${rules.attachments_folder}/${safePart(app)}/${safePart(name)}`, bytes, media_type: media }); }
        catch (error) {
          if (error instanceof ImportStopped) throw error;
          count.attachments_refused.push({ id: ref.id, reason: String(error.message).slice(0, 200) });
        }
      }
    }
    kept.set(ref.id, file);
    return file;
  };
}

/** The images pasted into one session message (the harness rules' attachment_sources), copied the way old Trillion's
 *  recorder kept them: <attachments_folder>/<conversation>/<message>-<n><extension>. Returns the message's attachment refs. */
async function keepPastedFiles(message, conversationId, keepFile, count, rules = settings) {
  const refs = [];
  for (const [index, source] of (message.attachment_sources ?? []).entries()) {
    const bytes = Buffer.from(source.data, 'base64');
    const name = `${rules.attachments_folder}/${safePart(conversationId)}/${safePart(message.source_ref ?? message.at)}-${index + 1}${extensionOf(source.media_type, rules)}`;
    if (bytes.length > rules.most_attachment_bytes) { count.attachments_too_large += 1; continue; }
    try {
      const file = await keepFile({ name, bytes, media_type: source.media_type });
      refs.push({ id: file.identity, name: source.name ?? basename(name), mime_type: source.media_type, file });
    } catch (error) {
      if (error instanceof ImportStopped) throw error;
      count.attachments_refused.push({ id: name, reason: String(error.message).slice(0, 200) });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------------------------------
// Where each app's conversations are on this computer (read-data/conversation-sources-on-this-computer.json)
// ---------------------------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DECODER = join(HERE, 'decode_source.py');
const fileKey = file => makeHashCodeHexFromBytes(new TextEncoder().encode(file)).slice(3, 27);
const cursorId = (source, file) => `${CURSOR_TYPE}:${source}${file === undefined ? '' : `:${fileKey(file)}`}`;
const globPattern = name => new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** The granted folder, read as the person's home; refuses a path that leaves it. */
function homeOf(folder) {
  if (typeof folder !== 'string' || !folder) throw new Error('This run was not handed the folder the person granted (read-a-folder). Grant the home folder, where the exports and the AI apps\' sessions are.');
  return realpathSync(folder);
}
function inside(home, path) {
  let real;
  try { real = realpathSync(path); } catch { return null; }
  return real === home || real.startsWith(home + sep) ? real : null;
}

function headOf(path, bytes) {
  const handle = openSync(path, 'r');
  try { const buffer = Buffer.alloc(bytes); return buffer.subarray(0, readSync(handle, buffer, 0, bytes, 0)).toString('utf8'); }
  finally { closeSync(handle); }
}

/** Every file under `folder` (a path in the home) to `depth` levels that `wanted(path, name)` takes; hidden folders
 *  and Library are not walked unless the place itself is one. */
function walk(home, folder, depth, wanted, budget) {
  const found = [];
  const visit = (path, left) => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.left-- <= 0) return;
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (left > 0 && !entry.name.startsWith('.') && entry.name !== 'Library' && entry.name !== 'node_modules') visit(child, left - 1); }
      else if (entry.isFile() && wanted(child, entry.name)) {
        const real = inside(home, child);
        if (real) { const stat = statSync(real); found.push({ file: relative(home, real), bytes: stat.size, changed_ms: Math.floor(stat.mtimeMs) }); }
      }
    }
  };
  const start = resolve(home, folder);
  if (inside(home, start)) visit(start, depth);
  return found;
}

/** Each source row with the files of it found in the home: [{ source, files: [{ file, bytes, changed_ms }] }]. */
export function sourcesFoundIn(home, { only, more_places: morePlaces = [], rules = places } = {}) {
  const budget = { left: rules.settings.most_files_looked_at };
  const exportPlaces = [...rules.export_places, ...morePlaces];
  return rules.sources.filter(source => !only || only.includes(source.id)).map(source => {
    let files = [];
    if (source.reader === 'harness') {
      const harness = harnessRules.harnesses.find(row => row.id === source.harness);
      for (const root of harness?.transcript_roots ?? []) {
        const suffix = root.suffix ?? '.jsonl';
        files.push(...walkHidden(home, root.folder.replace(/^~\/?/, ''), root.depth, name => name.endsWith(suffix) && (!root.name_includes || name.includes(root.name_includes)), budget));
      }
    } else {
      const names = source.files.names.map(globPattern);
      const folders = source.files.in_folder ?? null;
      const take = (path, name) => names.some(pattern => pattern.test(name))
        && (!folders || folders.includes(path.split(sep).at(-2)))
        && (!source.files.head_has || headOf(path, rules.settings.head_bytes).includes(source.files.head_has));
      for (const place of exportPlaces) files.push(...walk(home, place.folder, place.depth, take, budget));
    }
    files = [...new Map(files.map(file => [file.file, file])).values()].sort((a, b) => a.file.localeCompare(b.file));
    return { source, files };
  });
}

// An AI app keeps its sessions in a hidden folder of the home (~/.codex), which the export walk leaves alone.
function walkHidden(home, folder, depth, wanted, budget) {
  const found = [];
  const visit = (path, left) => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.left-- <= 0) return;
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (left > 0) visit(child, left - 1); }
      else if (entry.isFile() && wanted(entry.name)) {
        const real = inside(home, child);
        if (real) { const stat = statSync(real); found.push({ file: relative(home, real), bytes: stat.size, changed_ms: Math.floor(stat.mtimeMs) }); }
      }
    }
  };
  const start = resolve(home, folder);
  if (inside(home, start)) visit(start, depth);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading one file of a source, from its cursor
// ---------------------------------------------------------------------------------------------------------------------

/** One page of read-data/decode_source.py over a file in the home. */
function decodePage(home, request) {
  return new Promise((done, fail) => {
    const child = spawn('python3', ['-I', DECODER, home], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => fail(new Error(`python3 could not be started to read the export (${error.message}). Install Python 3.`)));
    child.on('close', () => {
      let answer;
      try { answer = JSON.parse(out.trim().split('\n').at(-1)); } catch { fail(new Error(`The decoder answered nothing readable${err ? `: ${err.slice(0, 300)}` : ''}.`)); return; }
      if (answer.error) fail(new Error(answer.error)); else done(answer.result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const mergeTotals = (totals, answer) => ({
  messages: (totals?.messages ?? 0) + answer.messages,
  started: [totals?.started, answer.started].filter(Boolean).sort()[0] ?? null,
  last: [totals?.last, answer.last].filter(Boolean).sort().at(-1) ?? null,
  models: [...new Set([...(totals?.models ?? []), ...answer.models])],
});
const tally = (count, answer) => {
  count.conversations_kept += 1;
  count.messages_added += answer.added;
  count.messages_already_kept += answer.already_there;
  count.attachments_kept += answer.attachments_found;
  count.attachments_not_kept += answer.missing_attachments.length;
};

/** An account export of conversation trees (read-data/chat-archives.mjs): next is the next conversation's place. */
async function readArchiveFile({ home, path, file, source, cursor, keep, keepFile, save, deadline, count, given }) {
  const all = exportedConversations(readFileSync(path));
  const find = exportAttachmentFinder(home, path, keepFile, source.app, count, settings, given);
  let next = cursor.next ?? 0;
  let since = 0;
  while (next < all.length) {
    if (Date.now() >= deadline) return { done: false, next };
    try { tally(count, await keep({ conversation: all[next], app: source.app, original_file: file }, find)); }
    catch (error) {
      if (error instanceof ImportStopped) throw error;
      count.conversations_refused.push({ at: next, reason: String(error.message).slice(0, 200) });
    }
    next += 1;
    if (++since >= settings.cursor_every && next < all.length) { await save({ next, done: false }); since = 0; }
  }
  return { done: true, next, conversations_in_file: all.length };
}

/**
 * An export read by a sources.json row (decode_source.py, mode all): pages of atoms, a thread's atoms always together.
 * A conversation that reaches the end of a page waits for the next page before it is kept whole; next is the page a
 * conversation not yet kept starts in, so a stopped run reads that page again (what it already kept adds nothing).
 */
async function readDecodedFile({ home, path, file, source, cursor, keep, keepFile, save, deadline, count, given }) {
  const find = exportAttachmentFinder(home, path, keepFile, source.app, count, settings, given);
  // The files the source named for a message (sources.json `attachments`) go as the page shape's metadata.attachments.
  const withFiles = message => {
    const { attachments, ...rest } = message;
    const ids = (Array.isArray(attachments) ? attachments : []).map(item => (item && typeof item === 'object' ? item.id ?? item.file_id ?? item.name : item)).filter(item => typeof item === 'string' && item);
    return ids.length ? { ...rest, metadata: { attachments: ids.map(id => ({ id })) } } : rest;
  };
  let next = cursor.next ?? 0;
  let waiting = null;
  let waitingFrom = next;
  for (;;) {
    if (Date.now() >= deadline) return { done: false, next: waiting ? waitingFrom : next };
    const page = await decodePage(home, { file, source: source.decode_source, mode: 'all', cursor: next, limit: settings.decode_page_atoms, descriptor: { source_ref: source.id, app: source.app } });
    const idOf = new Map((page.threads ?? []).map(thread => [thread.thread_ref, thread.session_id]));
    const chats = (page.conversations ?? []).map(chat => ({ conversation_id: idOf.get(chat.conversation_id) ?? chat.conversation_id, title: chat.title, messages: chat.messages.map(withFiles) }));
    if (waiting && chats[0]?.conversation_id === waiting.conversation_id) { waiting.messages.push(...chats.shift().messages); }
    const ready = [];
    if (waiting && (chats.length || page.next_cursor === null)) { ready.push(waiting); waiting = null; }
    if (page.next_cursor !== null && chats.length) { const last = chats.pop(); if (!waiting) { waiting = last; waitingFrom = next; } }
    ready.push(...chats);
    for (const conversation of ready) {
      try { tally(count, await keep({ conversation, app: source.app, original_file: file }, find)); }
      catch (error) {
        if (error instanceof ImportStopped) throw error;
        count.conversations_refused.push({ at: conversation.conversation_id, reason: String(error.message).slice(0, 200) });
      }
    }
    if (page.next_cursor === null) return { done: true, next: page.total_atoms ?? next };
    next = page.next_cursor;
    await save({ next: waiting ? waitingFrom : next, done: false });
  }
}

/**
 * A session transcript of a local AI app, read the way old Trillion's recorder read it (harness/record-every-message.mjs
 * rowsFrom and messagesOf: only the rows its rules say are the person's, the AI's, a peer's or generated context, each
 * with its own place as source_ref), a bounded piece at a time from the byte offset (a row count for a whole-document
 * session) the cursor holds. Its conversation is `<app id>:<session id>`, as the recorder kept it, and its row's facts
 * are the whole session's, carried in the cursor.
 */
async function readTranscriptFile({ path, file, source, cursor, keep, keepFile, save, deadline, count, lists }) {
  const rules = { ...harnessRules, transcript_read_bytes: settings.transcript_read_bytes, transcript_row_bytes: settings.transcript_row_bytes };
  const session = sessionOfTranscript(path, rules);
  if (!session || session.harness.id !== source.harness) return { done: true, next: null, note: 'not a session of this app' };
  const { harness, sessionId } = session;
  const conversationId = `${harness.id}:${sessionId}`;
  let state = cursor.next ?? { offset: 0, context: {}, deferred: [], totals: null };
  for (;;) {
    if (Date.now() >= deadline) return { done: false, next: state };
    const read = rowsFrom(path, state.offset, rules);
    if (read.blocked_row) return { done: true, next: state, note: `a row longer than ${read.blocked_row.byte_limit} bytes at byte ${read.blocked_row.offset}; the rest of this session is not read` };
    const waiting = state.deferred ?? [];
    const parsed = messagesOf([...waiting.map(item => item.row), ...read.rows], harness, { sessionId, context: state.context, ends: [...waiting.map(item => item.offset), ...read.ends], personSpeaks: personSpeaksIn(path, harness, rules) }, rules);
    // The images pasted into a message are copied first, so the message names them; a message of only files is kept with
    // them. A row the transcript holds twice (a session resumed from another copies its rows) is one message.
    const ids = new Set();
    const said = parsed.messages.filter(message => message.source_ref && (message.text.trim() || message.attachment_sources?.length) && !ids.has(message.source_ref) && ids.add(message.source_ref));
    const pasted = new Map();
    for (const message of said) if (message.attachment_sources?.length) pasted.set(message.source_ref, await keepPastedFiles(message, conversationId, keepFile, count));
    const files = new Map([...pasted.values()].flat().map(ref => [ref.id, ref.file]));
    const spoken = said.filter(message => message.text.trim() || pasted.get(message.source_ref)?.length);
    if (spoken.length) {
      const answer = await keep({ conversation: { conversation_id: conversationId, messages: spoken.map(message => ({ id: message.source_ref, speaker: message.speaker, text: message.text, at: message.at, ...(message.model ? { model: message.model } : {}),
        ...(pasted.get(message.source_ref)?.length ? { metadata: { attachments: pasted.get(message.source_ref).map(({ id, name, mime_type }) => ({ id, name, mime_type })) } } : {}) })) },
        app: harness.app, preserve_conversation_id: true, keep_row: false }, async ref => files.get(ref.id) ?? null);
      count.attachments_kept += answer.attachments_found;
      count.attachments_not_kept += answer.missing_attachments.length;
      count.messages_added += answer.added;
      count.messages_already_kept += answer.already_there;
      state = { ...state, totals: mergeTotals(state.totals, answer) };
    }
    // Rows still waiting for who sent them are carried in the cursor while they fit it; past that they are let go.
    let deferred = parsed.deferred;
    while (deferred.length && JSON.stringify(deferred).length > settings.cursor_bytes / 2) { deferred = deferred.slice(1); count.rows_let_go += 1; }
    const end = read.offset;
    const finished = !read.more;
    state = { offset: end, context: parsed.context, deferred, totals: state.totals };
    if (state.totals && (spoken.length || finished)) {
      await keepConversationRow(lists, { conversation_id: conversationId, title: null, app: harness.app, messages: [] }, conversationId, { totals: state.totals });
    }
    if (finished) { if (state.totals) count.conversations_kept += 1; return { done: true, next: state }; }
    await save({ next: state, done: false });
  }
}

const READERS = { 'chat-archive': readArchiveFile, decode: readDecodedFile, harness: readTranscriptFile };

const freshCount = () => ({ conversations_kept: 0, messages_added: 0, messages_already_kept: 0, attachments_kept: 0, attachments_not_kept: 0, attachments_too_large: 0, rows_let_go: 0, conversations_refused: [], attachments_refused: [] });
const COUNTED = ['conversations_kept', 'messages_added', 'messages_already_kept', 'attachments_kept', 'attachments_not_kept', 'attachments_too_large'];

/** The cursor rows of every source (or one), by id. */
async function cursorsOf(door, source) {
  const found = new Map();
  for await (const record of door.list({ type: CURSOR_TYPE, prefix: source ? `${CURSOR_TYPE}:${source}` : `${CURSOR_TYPE}:` })) found.set(record.id, record.value);
  return found;
}

/**
 * One source's files kept, each from its cursor row: a file already done whose size and time are unchanged is skipped;
 * a file that grew (a session still being written, a new export in the same place) is read on from where it was.
 */
async function importOneSource(home, door, { source, files }, { deadline, now, given = {} }) {
  const patient = door;
  const staged = stagedRecords(patient);
  const lists = listsOverDoor(patient);
  const cursors = await cursorsOf(patient, source.id);
  const keep = (input, find) => importConversation({ ...input, reach: { private: true }, most_text: settings.most_text },
    { eeaf: staged.eeaf, commit: step => staged.commit(step), lists, now, find });
  const keepFile = fileKeeper(patient);
  const result = { source: source.id, app: source.app, files_found: files.length, files_done: 0, files_skipped: 0, ...freshCount(), files: [] };
  let stopped = null;
  for (const found of files) {
    const id = cursorId(source.id, found.file);
    const before = cursors.get(id) ?? null;
    if (before?.done && before.bytes === found.bytes && before.changed_ms === found.changed_ms) { result.files_done += 1; result.files_skipped += 1; continue; }
    // A whole document (a JSON export or session) that changed is read again from its start; a JSON-lines session that
    // grew is read on from its byte offset.
    const grows = source.reader === 'harness' && found.file.endsWith('.jsonl') && before && found.bytes >= (before.bytes ?? 0);
    const cursor = before && (!before.done || grows) ? before : { next: null };
    const count = freshCount();
    const row = done => ({ source: source.id, app: source.app, file: found.file, bytes: found.bytes, changed_ms: found.changed_ms, done,
      ...Object.fromEntries(COUNTED.map(field => [field, (before?.[field] ?? 0) + count[field]])),
      conversations_refused: [...(before?.conversations_refused ?? []), ...count.conversations_refused].slice(-20),
      attachments_refused: [...(before?.attachments_refused ?? []), ...count.attachments_refused].slice(-20), updated_at: now().toISOString() });
    const save = async ({ next, done }) => { await patient.write([{ id, type: CURSOR_TYPE, value: { ...row(done), next } }], { key: keyOfWrite([id, next, done, count]) }); };
    let outcome;
    try {
      outcome = await READERS[source.reader]({ home, path: join(home, found.file), file: found.file, source, cursor, keep, keepFile, save, deadline, count, lists, given });
    } catch (error) {
      if (!(error instanceof ImportStopped)) { count.conversations_refused.push({ at: 'file', reason: String(error.message).slice(0, 200) }); outcome = { done: true, next: cursor.next, note: error.message }; }
      else { stopped = error.reason; outcome = null; }
    }
    for (const field of [...COUNTED, 'rows_let_go']) result[field] += count[field];
    result.conversations_refused.push(...count.conversations_refused.map(item => ({ file: found.file, ...item })));
    result.attachments_refused.push(...count.attachments_refused.map(item => ({ file: found.file, ...item })));
    if (!outcome) break;
    try { await save({ next: outcome.next, done: outcome.done }); }
    catch (error) { if (error instanceof ImportStopped) { stopped = error.reason; break; } throw error; }
    result.files.push({ file: found.file, done: outcome.done, ...(outcome.note ? { note: outcome.note } : {}) });
    if (outcome.done) result.files_done += 1;
    if (!outcome.done) break;
  }
  result.conversations_refused = result.conversations_refused.slice(0, 50);
  result.attachments_refused = result.attachments_refused.slice(0, 50);
  const done = !stopped && result.files_done === result.files_found;
  const summary = { source: source.id, app: source.app, files_found: result.files_found, files_done: result.files_done, state: done ? 'done' : stopped ? 'stopped' : 'more', ...(stopped ? { stopped: stopped } : {}), updated_at: now().toISOString() };
  try { await patient.write([{ id: cursorId(source.id), type: CURSOR_TYPE, value: summary }], { key: keyOfWrite([summary]) }); }
  catch (error) { if (!(error instanceof ImportStopped)) throw error; stopped ??= error.reason; }
  return { ...result, done, ...(stopped ? { stopped } : {}) };
}

const requestOf = request => ({ input: request?.input ?? (request?.folder === undefined ? request ?? {} : {}), folder: request?.folder });
const rulesOf = context => ({ ...settings, ...(context.rules ?? {}) });
const runOptions = (input, context) => ({
  deadline: Date.now() + 1000 * Math.min(Math.max(Number(input.time_box_seconds) || settings.time_box_seconds, 1), settings.time_box_seconds),
  now: context.now ?? (() => new Date()),
});
const knownSource = id => {
  const source = places.sources.find(row => row.id === id);
  if (!source) throw new Error(`source is one of ${places.sources.map(row => row.id).join(', ')} (tool:list-the-conversation-sources-on-this-computer lists what is here).`);
  return source;
};

/** tool:list-the-conversation-sources-on-this-computer */
export async function listConversationSourcesHere(request) {
  const { input, folder } = requestOf(request);
  const home = homeOf(folder);
  const found = sourcesFoundIn(home, { more_places: input.more_places ?? [] });
  return { sources: found.map(({ source, files }) => ({ source: source.id, label: source.label, app: source.app, kind: source.kind, files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0), found: files.slice(0, Math.min(Number(input.most_files) || 20, 500)).map(file => file.file) })) };
}

/** tool:import-my-conversations-from-a-source */
export async function importConversationsFrom(request, context = {}) {
  const { input, folder } = requestOf(request);
  const source = knownSource(input.source);
  const home = homeOf(folder);
  let [{ files }] = sourcesFoundIn(home, { only: [source.id], more_places: input.more_places ?? [] });
  if (Array.isArray(input.files) && input.files.length) {
    files = input.files.map(file => {
      const real = inside(home, resolve(home, file));
      if (!real) throw new Error(`${file} is not a file inside the folder you granted.`);
      const stat = statSync(real);
      return { file: relative(home, real), bytes: stat.size, changed_ms: Math.floor(stat.mtimeMs) };
    });
  }
  const door = patientDoor(context.door, { wait: context.wait, rules: rulesOf(context) });
  const given = input.attachments && typeof input.attachments === 'object' && !Array.isArray(input.attachments) ? input.attachments : {};
  const result = await importOneSource(home, door, { source, files }, { ...runOptions(input, context), given });
  return { ...result, more: !result.done };
}

/** tool:resume-importing-my-conversations: every source found here (or the ones named), each from its cursor. */
export async function resumeConversationImports(request, context = {}) {
  const { input, folder } = requestOf(request);
  const home = homeOf(folder);
  const only = Array.isArray(input.sources) && input.sources.length ? input.sources.map(id => knownSource(id).id) : undefined;
  const door = patientDoor(context.door, { wait: context.wait, rules: rulesOf(context) });
  const options = runOptions(input, context);
  const sources = [];
  for (const found of sourcesFoundIn(home, { only, more_places: input.more_places ?? [] })) {
    if (!found.files.length) continue;
    if (Date.now() >= options.deadline) { sources.push({ source: found.source.id, done: false, waiting: true }); continue; }
    const result = await importOneSource(home, door, found, options);
    const { files: _files, ...shown } = result;
    sources.push(shown);
    if (result.stopped) break;
  }
  return { sources, more: sources.some(source => !source.done) };
}

/** tool:show-how-far-my-conversation-import-is */
export async function conversationImportProgress(request, context = {}) {
  const door = patientDoor(context.door, { wait: context.wait, rules: rulesOf(context) });
  const cursors = await cursorsOf(door);
  const bySource = new Map();
  for (const [id, value] of cursors) {
    const entry = bySource.get(value.source) ?? { source: value.source, app: value.app, files_seen: 0, files_done: 0, ...Object.fromEntries(COUNTED.map(field => [field, 0])), state: null, updated_at: null };
    if (id === cursorId(value.source)) Object.assign(entry, { state: value.state, files_found: value.files_found, ...(value.stopped ? { stopped: value.stopped } : {}) });
    else {
      entry.files_seen += 1;
      if (value.done) entry.files_done += 1;
      for (const field of COUNTED) entry[field] += value[field] ?? 0;
    }
    if (!entry.updated_at || value.updated_at > entry.updated_at) entry.updated_at = value.updated_at;
    bySource.set(value.source, entry);
  }
  return { sources: [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)) };
}

/** tool:count-my-ai-conversations-per-app: the rows of the AI conversations list, read back, per app. */
export async function countConversationsPerApp(request, context = {}) {
  const door = patientDoor(context.door, { wait: context.wait, rules: rulesOf(context) });
  const type = `record:${conversationList.row_type}`;
  const apps = new Map();
  let total = 0;
  for await (const record of door.list({ type, fields: ['app', 'messages'] })) {
    const app = record.value?.app ?? '(no app)';
    const entry = apps.get(app) ?? { app, conversations: 0, messages: 0 };
    entry.conversations += 1;
    entry.messages += Number(record.value?.messages) || 0;
    apps.set(app, entry);
    total += 1;
  }
  return { conversations: total, apps: [...apps.values()].sort((a, b) => b.conversations - a.conversations || a.app.localeCompare(b.app)) };
}
