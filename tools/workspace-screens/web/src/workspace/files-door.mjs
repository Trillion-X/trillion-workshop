// src/workspace/files-door.mjs
//
// PURPOSE
//   What the page does over the person's files operations (api.ts `files`: the operations of the tool that keeps the
//   person's files, files-owner.json): putting a file in piece by piece, reading a whole small file window by window,
//   and the results worked out about files. The operations and their inputs and answers are that tool's (list_files,
//   find_file, read_file, write_file_start / _piece / _finish / _cancel, set_aside, recent_files and the rest).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A file larger than one piece goes in by write_file_start, write_file_piece in order from offset 0 and
//      write_file_finish; the file is read one piece at a time, never whole. The owner works out the identity itself.
//   2. A refused piece ends the upload with write_file_cancel, and the refusal reaches the caller unchanged.

/** The door's largest piece (trillion-rust src/account_files/write.rs: 1 to 32768 bytes a piece). */
export const PIECE_BYTES = 32 * 1024;

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
