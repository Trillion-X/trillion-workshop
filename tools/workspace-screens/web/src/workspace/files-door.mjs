// src/workspace/files-door.mjs
//
// PURPOSE
//   The person's own page reaching their files on their computer: the engine's account files door at
//   /work/api/files/<operation> (trillion-rust src/server/owner-routes.json, the row whose family is the files door's
//   resource; src/account_files/door.rs AccountFilesDoor::page_call). The page asks the same operations, with the same
//   inputs and answers, an AI's key asks at that door: list_files, find_file, read_file, write_file,
//   write_file_start / _piece / _finish / _cancel, set_aside, recent_files, record_file_use, set_file_facts and the
//   rest of trillion-rust src/account_files/account-files-door.json `operations`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A read (the door's `page.reads`) is GET with its input as the one `input` query field; every other operation is
//      POST with its input as the JSON body. The page's own signed-in session admits both; no key or lease is held here.
//   2. A file larger than one piece goes in by write_file_start, write_file_piece in order from offset 0 and
//      write_file_finish; the file is read one piece at a time, never whole. The door works out the identity itself.
//   3. A refused piece ends the upload with write_file_cancel, and the refusal reaches the caller unchanged.

/** The door's largest piece (trillion-rust src/account_files/write.rs: 1 to 32768 bytes a piece). */
export const PIECE_BYTES = 32 * 1024;

/** The two ways the page calls the door, over `ask(path, init)` (the page's own fetch of its JSON answer). */
export function filesDoor(ask) {
  const read = (operation, input = {}) =>
    ask(`/work/api/files/${encodeURIComponent(operation)}?input=${encodeURIComponent(JSON.stringify(input))}`, {});
  const change = (operation, input = {}) =>
    ask(`/work/api/files/${encodeURIComponent(operation)}`, { method: 'POST', body: JSON.stringify(input) });
  return { read, change };
}

/**
 * What was worked out about files (trillion-rust src/account_files/results.rs, the port of old trillion's
 * /namespace/results routes) over a filesDoor: `read` is the door's GET read_file_results {identity, kind?} (`path` is
 * its address, for a screen that keeps the address it reads), `record` is record_file_results {results}, `merge` is
 * merge_file_result {identity, kind, value, produced_by?, only_if_empty?} (set_file_facts is this merge of kind facts)
 * and `many` is read_file_results_many {kind, identities}, a POST because a thousand identities do not fit an address.
 * The answers are the old routes' answers.
 */
export function fileResultsOf(door) {
  const input = (identity, kind) => (kind ? { identity, kind } : { identity });
  return {
    path: (identity, kind = null) =>
      `/work/api/files/read_file_results?input=${encodeURIComponent(JSON.stringify(input(identity, kind)))}`,
    read: (identity, kind = null) => door.read('read_file_results', input(identity, kind)),
    record: results => door.change('record_file_results', { results }),
    merge: (identity, change) => door.change('merge_file_result', { identity, ...change }),
    many: (kind, identities) => door.change('read_file_results_many', { kind, identities }),
  };
}

function base64Of(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A fresh upload id: 32 lowercase hexadecimal characters. */
export function uploadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Put one file in under `name` through `change` (filesDoor(...).change): `source` is { size, readAt(offset, length) }.
 * `onBytes(n)` hears each piece kept. Answers the door's write_file_finish answer ({ identity, name, ... }).
 */
export async function putFile(change, { source, name, mediaType = null, onBytes = () => {} }) {
  const upload_id = uploadId();
  await change('write_file_start', { upload_id, name, byte_length: source.size, media_type: mediaType || 'application/octet-stream' });
  try {
    for (let offset = 0; offset < source.size; offset += PIECE_BYTES) {
      const bytes = await source.readAt(offset, Math.min(PIECE_BYTES, source.size - offset));
      await change('write_file_piece', { upload_id, name, offset, content_base64: base64Of(bytes) });
      onBytes(bytes.length);
    }
    return await change('write_file_finish', { upload_id, name });
  } catch (error) {
    await change('write_file_cancel', { upload_id, name }).catch(() => {});
    throw error;
  }
}
/** The door's largest read_file window (trillion-rust src/account_files/mod.rs READ_MAX_BYTES: 256 KiB). */
export const READ_BYTES = 256 * 1024;

/**
 * A whole small file's bytes by its name or any identity, read through `read` (filesDoor(...).read) one read_file
 * window at a time, each asked as base64 so no window is re-encoded. A file larger than `most` bytes is refused before
 * its second window, and a file that changed while it was read (another identity or length) is refused.
 */
export async function readWholeFile(read, nameOrIdentity, { most = 16 * 1024 * 1024 } = {}) {
  const parts = [];
  let offset = 0;
  let total = null;
  let identity = null;
  do {
    const page = await read('read_file', { name_or_identity: nameOrIdentity, offset, length: READ_BYTES, encoding: 'base64' });
    if (total === null) {
      total = page.byte_length;
      identity = page.identity;
      if (!Number.isSafeInteger(total) || total < 0 || total > most) throw new Error('This file is too large to read here.');
    } else if (page.byte_length !== total || page.identity !== identity) {
      throw new Error('This file changed while it was read.');
    }
    const bytes = Uint8Array.from(atob(page.content), value => value.charCodeAt(0));
    if (bytes.length !== page.bytes_returned) throw new Error('This file could not be read completely.');
    if (!bytes.length && offset < total) throw new Error('This file could not be read completely.');
    parts.push(bytes);
    offset += bytes.length;
  } while (offset < total);
  const whole = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) { whole.set(part, at); at += part.length; }
  return whole;
}

/** A whole small file read as UTF-8 text (readWholeFile). */
export const readFileText = async (read, nameOrIdentity, options) =>
  new TextDecoder().decode(await readWholeFile(read, nameOrIdentity, options));

/** A whole small JSON file read and parsed (readWholeFile). */
export const readFileJson = async (read, nameOrIdentity, options) => JSON.parse(await readFileText(read, nameOrIdentity, options));
