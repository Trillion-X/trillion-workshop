// tools/conversations/read-data/chat-archives.mjs (moved from Trillion-X/trillion src/chat-archives.mjs)
//
// Chat archives read into messages: one conversation as a chat app exports it, turned into the message shape
// record_messages keeps (src/messages.mjs) and a space keeps (src/spaces.mjs).
//
// Purpose
//   A person brings earlier conversations into Trillion in one of two ways, which stay distinct: one chat's archive
//   (a single conversation object) or a whole account export (a file holding a list of conversations). Either can go
//   into their private Trillion or into one space they name. This file only reads the archive's shape.
//
// Shape read (the ChatGPT export, and any app exporting the same tree): { id | conversation_id, title, create_time,
// mapping: { <node>: { id, parent, message: { author: { role }, create_time, content: { parts }, metadata: {
// model_slug, attachments } } } }, current_node }. The conversation is the path from current_node back to the root,
// oldest first, so edited branches the person moved away from are left out, as the app shows it.
//
// Second shape read: a conversation as it was read off its own page (the browser extension's Save this chat,
// extension/src/read-conversation.mjs): { conversation_id, title, messages: [{ id, speaker, text, at, model }] }. Each
// message names its place on the page (id), who said it (speaker: "person", "ai", or anyone else's name as the page
// shows it) and, when the page shows them, its time and the model that wrote it. The id is kept as the message's node, so saving the same chat again adds
// nothing twice even where the page shows no times.
//
// Attachments: a message names the files it carried in metadata.attachments ([{ id, name, mime_type, size }]) and in
// content parts of content_type "image_asset_pointer" (asset_pointer "file-service://file-XXXX" or
// "sediment://file_XXXX"). Each becomes one reference { id, name, mime_type }, id being the bare file id, which is also
// how an account export names the file beside conversations.json (file-XXXX-photo.png). Finding the bytes is the
// importer's job (src/chat-import.mjs); this file only names them.
//
// Non-negotiable invariants
//   1. Words are kept exactly as exported; nothing is summarized. Non-text parts are never described: a file part is
//      carried as an attachment reference, anything else is left out.
//   2. Each message carries where it came from (conversation and node), so bringing the same archive in again adds
//      nothing twice.
//   3. Nothing here decides where messages go; the caller names the target.
//   4. A message longer than one kept message holds (src/messages.mjs MAX_TEXT) is kept in parts, in order: its parts
//      joined are its words exactly, each part's node is the message's node with ":part-<n>" after it (so bringing it
//      in again adds nothing twice), each later part's time is one millisecond after the one before (so the parts read
//      in order), and its files go with its first part. A part ends at a line break where one falls in its last tenth.
//      Where one kept message must fit one write of the records door (64 KiB), the importer names a smaller bound
//      (`most_text`); the parts are made the same way under it.
//
import { MAX_TEXT } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';

const SPEAKERS = { user: 'person', assistant: 'ai' };
const isoOf = seconds => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// "file-service://file-XXXX" or "sediment://file_XXXX" names the file "file-XXXX" or "file_XXXX".
const bareId = pointer => (nonempty(pointer) ? pointer.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : '');

/** The files one exported message carried, once each: [{ id, name, mime_type }]. */
export function attachmentsOf(message) {
  const found = new Map();
  for (const item of Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : []) {
    const id = bareId(item?.id);
    if (id && !found.has(id)) found.set(id, { id, name: nonempty(item.name) ? item.name : null, mime_type: nonempty(item.mime_type) ? item.mime_type : null });
  }
  for (const part of Array.isArray(message?.content?.parts) ? message.content.parts : []) {
    const id = part && typeof part === 'object' && part.content_type === 'image_asset_pointer' ? bareId(part.asset_pointer) : '';
    if (id && !found.has(id)) found.set(id, { id, name: null, mime_type: null });
  }
  return [...found.values()];
}

/** Where the first part of `text` ends: at most MAX_TEXT characters, after a line break in its last tenth when there is
 *  one, and never between the two halves of a character written as a pair. */
function partEnd(text, most = MAX_TEXT) {
  if (text.length <= most) return text.length;
  const lineBreak = text.lastIndexOf('\n', most - 1);
  if (lineBreak >= most * 0.9) return lineBreak + 1;
  const code = text.charCodeAt(most - 1);
  return code >= 0xd800 && code <= 0xdbff ? most - 1 : most;
}

/** One message as the messages it is kept as: itself, or its parts in order (invariant 4). */
function inParts(message, most = MAX_TEXT) {
  if (message.text.length <= most) return [message];
  const parts = [];
  for (let rest = message.text; rest.length;) {
    const end = partEnd(rest, most);
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  const start = message.at ? Date.parse(message.at) : null;
  return parts.map((text, index) => ({
    ...message,
    node: `${message.node}:part-${index + 1}`,
    text,
    at: start === null ? null : new Date(start + index).toISOString(),
    attachments: index === 0 ? message.attachments : [],
  }));
}

/** A conversation read off its page as { conversation_id, title, app, messages } (the second shape above). */
function conversationReadFromPage(page, app, most = MAX_TEXT) {
  if (!nonempty(page.conversation_id)) throw new Error('A conversation read from its page names its conversation_id.');
  const messages = page.messages.flatMap((message, index) => {
    const at = `messages[${index}]`;
    if (!message || typeof message !== 'object') throw new Error(`${at} must be an object with id, speaker and text.`);
    for (const field of ['id', 'speaker']) if (!nonempty(message[field])) throw new Error(`${at}.${field} is required.`);
    const attachments = attachmentsOf(message);
    if (typeof message.text !== 'string' || (!nonempty(message.text) && !attachments.length)) throw new Error(`${at}.text is required: the message exactly as the page shows it, or empty when it carries files.`);
    const time = message.at == null ? null : new Date(message.at);
    if (time && Number.isNaN(time.getTime())) throw new Error(`${at}.at must be a date and time, like 2026-09-27T17:13:00Z.`);
    return inParts({ node: message.id, speaker: message.speaker, text: message.text, at: time ? time.toISOString() : null,
      ...(typeof message.at === 'string' && time ? { source_at: message.at } : {}),
      model: nonempty(message.model) ? message.model : null, attachments }, most);
  });
  const nodes = new Set(messages.map(message => message.node));
  if (nodes.size !== messages.length) throw new Error('Each message read from the page has its own id; two share one.');
  return { conversation_id: page.conversation_id, title: nonempty(page.title) ? page.title : null, app, messages };
}

/** One conversation as { conversation_id, title, messages: [{ node, speaker, text, at, model, attachments }] }. */
export function conversationFrom(archive, app = 'ChatGPT', { most_text: most = MAX_TEXT } = {}) {
  if (archive && typeof archive === 'object' && !archive.mapping && Array.isArray(archive.messages)) return conversationReadFromPage(archive, app, most);
  if (!archive || typeof archive !== 'object' || !archive.mapping || typeof archive.mapping !== 'object') throw new Error('A chat archive is one exported conversation with its mapping of messages, or one read from its page with its messages.');
  const conversationId = String(archive.conversation_id ?? archive.id ?? archive.title ?? 'conversation');
  const path = [];
  const seen = new Set();
  let node = archive.current_node ?? Object.values(archive.mapping).find(item => !item.children?.length)?.id;
  while (node && archive.mapping[node] && !seen.has(node)) { seen.add(node); path.push(archive.mapping[node]); node = archive.mapping[node].parent; }
  const messages = path.reverse().flatMap(item => {
    const message = item.message;
    const speaker = SPEAKERS[message?.author?.role];
    const text = (message?.content?.parts ?? []).filter(part => typeof part === 'string').join('\n');
    const attachments = attachmentsOf(message);
    // A message of only files (a photo sent without words) is kept for its files.
    if (!speaker || (!text.trim() && !attachments.length)) return [];
    return inParts({ node: String(item.id), speaker, text, at: isoOf(message.create_time) ?? isoOf(archive.create_time), model: message.metadata?.model_slug ?? null, attachments }, most);
  });
  return { conversation_id: conversationId, title: typeof archive.title === 'string' ? archive.title : null, app, messages };
}

/** A whole export: a list of conversations (or one), each read as conversationFrom reads it. */
export function conversationsFrom(exported, app = 'ChatGPT', options = {}) {
  const list = Array.isArray(exported) ? exported : [exported];
  return list.map(item => conversationFrom(item, app, options));
}
