// tools/upload-a-file-to-a-signed-slot/read-data/guarded-upload.mjs
//
// PURPOSE
//   Lets a hosted page cause an upload it cannot make itself, without letting it redirect local data: the page hands this
//   program a signed storage slot, this program checks the slot against DATA and uploads a file the page never sees.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: destinations, limits and words are read-data/guarded-upload.json; no host or bucket is named here.
//   2. The slot is checked as a whole before a byte leaves: https, host equal to a row's, path inside the row's folder, no
//      query, fragment, credentials or port, text-only fields within the field cap, and a content type the row lists.
//   3. The file is held in memory, once, for hold_minutes; the page learns an id and a size, never the bytes. A sent file is
//      gone; a refused slot does not use it up.
//   4. The signed fields are never logged and never in an error message.
//   5. (Workshop) The file is read only from the folder the person granted this tool (read-a-folder): a name that leaves
//      that folder, through `..`, an absolute path or a link, names nothing; its size is checked before it is read.
//
// Moved one to one from Trillion-X/trillion computer/guarded-upload.mjs (dc79bb0a87^). The Mac host that called it is
// gone; the Workshop row tool:upload-a-file-to-a-signed-slot runs uploadFromFolder through records-door's run-an-export.
//
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const uploadSettings = () => JSON.parse(readFileSync(join(HERE, 'guarded-upload.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 403) => Object.assign(new Error(message), { status, retry: false });

/** The destination row a slot is allowed by, or a refusal in words. slot = { url, fields }; contentType = the file's type. */
export function checkSlot(slot, contentType, settings = uploadSettings()) {
  let url;
  try { url = new URL(String(slot?.url ?? '')); } catch { throw refusal(settings.words.bad_address, 400); }
  if (url.protocol !== 'https:') throw refusal(settings.words.not_https, 400);
  if (!url.hostname || url.search || url.hash || url.username || url.password || url.port) throw refusal(settings.words.bad_address, 400);
  const row = settings.destinations.find(item => item.host === url.hostname);
  if (!row) throw refusal(fill(settings.words.host_not_allowed, { host: url.hostname }));
  const path = decodeURIComponent(url.pathname);
  if (path.split('/').includes('..') || !(path === row.path_prefix || path.startsWith(row.path_prefix.endsWith('/') ? row.path_prefix : `${row.path_prefix}/`))) throw refusal(fill(settings.words.path_not_allowed, { host: url.hostname }));
  const fields = slot.fields ?? {};
  const names = Object.keys(fields);
  if (names.length > row.max_fields) throw refusal(fill(settings.words.too_many_fields, { count: names.length, max: row.max_fields }), 400);
  for (const name of names) if (typeof fields[name] !== 'string') throw refusal(fill(settings.words.bad_field, { name }), 400);
  if (!row.content_types.includes(contentType)) throw refusal(fill(settings.words.type_not_allowed, { type: contentType, host: url.hostname }));
  return { row, url };
}

/** The holder: prepare() keeps a file once and answers { id, size }; send() uploads it to a checked slot. */
export function makeGuardedUploads({ settings = uploadSettings(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  const held = new Map();
  const sweep = () => { for (const [id, item] of held) if (item.expires <= now()) held.delete(id); };
  return {
    prepare({ bytes, contentType, name = 'file' }) {
      sweep();
      if (bytes.length > settings.max_hold_bytes) throw refusal(fill(settings.words.too_big, { bytes: bytes.length, max: settings.max_hold_bytes }), 413);
      const id = randomBytes(12).toString('hex');
      held.set(id, { bytes: Buffer.from(bytes), contentType, name, expires: now() + settings.hold_minutes * 60_000 });
      return { id, size: bytes.length };
    },
    async send({ id, slot }) {
      sweep();
      const item = held.get(id);
      if (!item) throw refusal(fill(settings.words.no_such_hold, { minutes: settings.hold_minutes }), 404);
      const { url } = checkSlot(slot, item.contentType, settings);
      const form = new FormData();
      for (const [name, value] of Object.entries(slot.fields ?? {})) form.append(name, value);
      form.append('file', new Blob([item.bytes], { type: item.contentType }), item.name);
      held.delete(id);
      const answer = await fetchImpl(url.href, { method: 'POST', body: form });
      if (!answer.ok) throw Object.assign(refusal(fill(settings.words.refused, { status: answer.status }), 502), { retry: true });
      return { sent: true, size: item.bytes.length, said: fill(settings.words.sent, { bytes: item.bytes.length }) };
    },
  };
}

/** The Workshop entry: read `input.file` from the granted folder, hold it once and send it to the checked `input.slot`.
 *  stdin = { input: { file, content_type, slot: { url, fields } }, folder }. Answers { sent, size, said }. */
export async function uploadFromFolder({ input = {}, folder } = {}, { settings = uploadSettings(), fetchImpl = fetch } = {}) {
  const name = String(input.file ?? '');
  if (typeof folder !== 'string' || !folder) throw refusal(settings.words.no_folder, 403);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw refusal(fill(settings.words.outside_folder, { file: name }), 400);
  const root = realpathSync(folder);
  let path;
  try { path = realpathSync(resolve(root, name)); } catch { throw refusal(fill(settings.words.no_such_file, { file: name }), 404); }
  const inside = relative(root, path);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw refusal(fill(settings.words.outside_folder, { file: name }), 400);
  const facts = statSync(path);
  if (!facts.isFile()) throw refusal(fill(settings.words.no_such_file, { file: name }), 404);
  if (facts.size > settings.max_hold_bytes) throw refusal(fill(settings.words.too_big, { bytes: facts.size, max: settings.max_hold_bytes }), 413);
  checkSlot(input.slot, input.content_type, settings);
  const uploads = makeGuardedUploads({ settings, fetchImpl });
  const held = uploads.prepare({ bytes: readFileSync(path), contentType: input.content_type, name: path.split(sep).pop() });
  return uploads.send({ id: held.id, slot: input.slot });
}
