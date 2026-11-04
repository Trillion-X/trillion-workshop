// A whole chat export brought into Trillion: read here in the Worker, where a person's file bytes are streamed
// (src/namespace.mjs), then kept one conversation at a time through the same road one chat's archive takes, into the
// private Trillion or into the one space the person names.
//
// The export is a file the person already put in their files (its name, like /exports/conversations.json, or its
// identity). It is read a page of conversations at a time (offset, limit), so an export of thousands of chats goes in
// over several calls and a repeat adds nothing twice. Reading it needs the private reach: the file is private.
//
// Attachments: a chat's messages name the files they carried (src/chat-archives.mjs attachmentsOf). An account export
// puts each file beside conversations.json, named with its id first (file-XXXX-photo.png), sometimes in a folder under
// it. attachmentFinder finds each one among the person's own files: by the name or identity the person gave for that
// id, or by that id at the start of a file's name in the export's folder (or the folder the person names) and the
// folders under it. Bytes are never copied: a private message links the file, a space gets a file item whose bytes
// stay in the importer's store. A file that cannot be found is reported, never an error.
import { rangeStream } from './namespace.mjs';
import { conversationFrom, conversationsFrom } from './chat-archives.mjs';
import { messages } from './messages.mjs';
import { makeLists } from './lists.mjs';
import conversationList from './ai-conversations-list.json' with { type: 'json' };
import { hostOf } from './resource-host.mjs';
import { archiveEntries, profile } from './archive-entries.mjs';

const MAX_EXPORT_BYTES = 80 * 1024 * 1024;
const PAGE = { default: 20, max: 100 };

const folderOf = name => name.replace(/\/[^/]*$/, '') || '/';
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
 * One row per imported conversation in the AI conversations list (src/ai-conversations-list.json), made once with
 * ensure. Only facts read from the chat are written, so labels, people, pursuits and follow-ups the person or an AI
 * set stay as they are on a re-import. chat: conversationFrom's shape; conversationId: the id its messages carry.
 */
export function keepConversationRow(eeaf, chat, conversationId) {
  const { _what, row_id_max: max, ...definition } = conversationList;
  const lists = makeLists({ eeaf });
  const actor = { by: 'chat-import' };
  lists.ensure(definition, { actor });
  const times = chat.messages.map(message => message.at).filter(Boolean).sort();
  const models = [...new Set(chat.messages.map(message => message.model).filter(Boolean))];
  const values = { title: chat.title ?? conversationId, app: chat.app, conversation_id: conversationId, messages: chat.messages.length,
    ...(times.length ? { started: times[0], last: times.at(-1) } : {}), ...(models.length ? { models } : {}) };
  const id = String(chat.conversation_id).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, max);
  return lists.putRows(definition.id, { rows: [{ id, values }] }, { actor });
}

/**
 * One chat's archive kept in the private Trillion or one space (the bring_in_chat road), by whichever store keeps the
 * account's records: eeaf is its records, namespace its files (attachmentFinder), addSpaceItems the space owner's write and
 * relay() the account's network relay. A repeat adds nothing twice; files not found are listed, never an error.
 * A private import's writes are synchronous, so `commit` keeps them with their answer in one step (CHAT_RECEIPTED_WRITES):
 * a lost import is answered from that receipt, never imported again.
 */
export const CHAT_RECEIPTED_WRITES = ['chats:import'];
export async function importConversation({ conversation, space_id: spaceId = null, reach, app = 'ChatGPT', attachments, attachments_folder: folder, preserve_conversation_id = false }, { eeaf, namespace, addSpaceItems, relay, commit = change => change() }) {
  const chat = conversationFrom(conversation, app);
  const label = chat.title ?? chat.conversation_id;
  if (!spaceId && !reach.private) throw new Error('This sign-in reaches shared pursuits only, so it cannot keep messages in the private Trillion.');
  // Finding a file reads the private files, so a sign-in held to shared spaces finds none.
  const find = reach.private ? attachmentFinder(namespace, { attachments, folder }) : () => null;
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
  const answer = () => ({ conversation: label, conversation_id: preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`, into: spaceId ? { space_id: spaceId } : 'private', messages: kept.length, added, already_there: already, attachments_found: files.size, missing_attachments: missing,
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
  return commit(() => {
    for (const batch of batches) {
      const result = messages(eeaf).record({ messages: batch.map(message => {
        const about = message.attachments.filter(ref => files.has(ref.id)).map(ref => ({ kind: 'file', id: files.get(ref.id).identity }));
        const attachments = message.attachments.filter(ref => files.has(ref.id)).map(ref => {
          const file = files.get(ref.id);
          return { identity: file.identity, ...(file.name ? { name: file.name } : {}), ...(file.media_type ? { media_type: file.media_type } : {}) };
        });
        return { conversation_id: preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`, app: chat.app, speaker: message.speaker, text: message.text, source_ref: message.node, ...(message.at ? { at: message.at } : {}), ...(message.source_at ? { source_at: message.source_at } : {}), ...(message.model ? { model: message.model } : {}), ...(attachments.length ? { attachments } : {}), ...(about.length ? { about } : {}) };
      }) }, { app: chat.app, road: 'chat_import' });
      added += result.recorded; already += result.already_kept;
    }
    keepConversationRow(eeaf, chat, preserve_conversation_id ? chat.conversation_id : `${chat.app}:${chat.conversation_id}`);
    return answer();
  }, { operation: 'chats:import' });
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

export async function importChatExport({ env, userId, reach, body = {}, keep }) {
  if (!reach.private) throw new Error('A whole export is read from your private files, so this sign-in cannot bring one in.');
  const person = hostOf(env, { kind: 'person', key: userId });
  const file = typeof body.file === 'string' ? body.file.trim() : '';
  if (!file) throw new Error('file is needed: the name or identity of the export in your files, like /exports/conversations.json, or the export zip itself.');
  const row = file.startsWith('/') ? await person.namespaceByName(file) : await person.namespaceLocate(file);
  if (!row) throw new Error(`${file} is not in your files. Put the export in your files first (write_file or the upload).`);
  if (row.byte_length > MAX_EXPORT_BYTES) throw new Error(`This export is ${Math.round(row.byte_length / 1048576)} MB; one read takes up to ${MAX_EXPORT_BYTES / 1048576} MB. Split it, or bring chats in one at a time.`);
  const all = exportedConversations(new Uint8Array(await new Response(rangeStream(env, userId, row, 0, row.byte_length - 1)).arrayBuffer()));
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const limit = Math.min(Math.max(Math.floor(Number(body.limit) || PAGE.default), 1), PAGE.max);
  conversationsFrom(all.slice(offset, offset + limit));
  const target = typeof body.space_id === 'string' && body.space_id ? `/spaces/${encodeURIComponent(body.space_id)}/import` : '/chats/import';
  // The export's files are looked for in the folder the person names, else the folder the export is in.
  const exportName = file.startsWith('/') ? file : row.names?.[0];
  const folder = cleanFolder(body.attachments_folder) ?? (exportName ? folderOf(exportName) : null);
  const results = [];
  for (const conversation of all.slice(offset, offset + limit)) {
    results.push(await keep(target, { conversation, ...(body.app ? { app: body.app } : {}), ...(folder ? { attachments_folder: folder } : {}), ...(body.attachments ? { attachments: body.attachments } : {}) }));
  }
  const missing = results.flatMap(result => result.missing_attachments ?? []);
  const broughtIn = results.map(({ missing_attachments: _, ...result }) => result);
  return { into: body.space_id ? { space_id: body.space_id } : 'private', conversations_in_file: all.length, brought_in: broughtIn, missing_attachments: missing, next_offset: offset + limit < all.length ? offset + limit : null };
}
