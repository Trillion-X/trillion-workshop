// tools/workflows/read-data/whole-file.mjs
//
// Purpose: one of the person's files read or written whole through a run's host actions (`host.files`, `host.writeLarge`,
// read-data/host-actions.mjs), for a tool that hands the bytes to a program on the computer (a recording to hear, a sound to
// measure), and a file on this computer kept as one of the person's files.
//
// Non-Negotiable Invariants:
//   1. A file larger than `mostBytes` is never read past its first page: the answer says so with bytes null.
//   2. Only find_file and read_file are asked to read, and only the write_file_* operations to write, so the row's files right
//      names exactly those operations.
//   3. A file is written in pieces that each fit one message (write_file_start, write_file_piece, write_file_finish under one
//      upload id), so writing it again with the same id resumes and its finish answers the same receipt.
//   4. A file above `threshold_bytes` (large-file.json) is never written in 40 KiB pieces: it goes in raw pieces of up to 32 MiB
//      (host.writeLarge, tools/records-door/read-data/raw-pieces.mjs) under the same upload id, so writing it again resumes.
//      That road keeps no upload id, so a second write is a new upload of the same bytes, and the engine names the same identity.
//   5. A run whose host has no raw-piece road is refused for a file above the threshold, with the reason, never sent in pieces.
//
//   readWholeFile(host, name, { readBytes, mostBytes })  -> { title, size, bytes } (bytes null when too large)
//   writeWholeFile(host, name, bytes, { mediaType, pieceBytes, uploadId }) -> the finish answer
//   writeWholeFileOnce(host, name, bytes, options)        -> { already_kept: true } when the file already holds exactly these bytes
//   keepLocalFile(host, name, path, { mediaType, uploadId }) -> the same answer for a file on this computer, read a chunk at a time when large
//
// `host` is any object with `files(method, input)` and, for a large file, `writeLarge(name, source, { mediaType })`.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileSource } from '../../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';

// Settings of the large-file road (large-file.json): a file above `threshold_bytes` goes in raw pieces.
export const LARGE_FILE = JSON.parse(readFileSync(fileURLToPath(new URL('./large-file.json', import.meta.url)), 'utf8'));

export const READ_BYTES = 4 * 1024 * 1024;
export const MOST_BYTES = 512 * 1024 * 1024;
// Raw bytes per written piece: their base64 and the call around it stay inside one message's bound.
export const PIECE_BYTES = 40 * 1024;

export async function readWholeFile(host, name, { readBytes = READ_BYTES, mostBytes = MOST_BYTES } = {}) {
  const found = await host.files('find_file', { name_or_identity: name });
  const title = String(found.names?.[0] ?? found.name ?? name).split('/').pop();
  const parts = [];
  let offset = 0;
  for (;;) {
    const piece = await host.files('read_file', { name_or_identity: name, offset, length: readBytes });
    if (piece.byte_length > mostBytes) return { title, size: piece.byte_length, bytes: null };
    parts.push(Buffer.from(piece.content ?? '', piece.encoding === 'base64' ? 'base64' : 'utf8'));
    offset += piece.bytes_returned;
    if (!piece.bytes_returned || offset >= piece.byte_length) return { title, size: offset, bytes: Buffer.concat(parts) };
  }
}

// The bytes of one file already in memory, as the sender's source reads them.
export function bufferSource(bytes) {
  return { size: bytes.length, readAt: async (offset, length) => bytes.subarray(offset, offset + length), close() {} };
}

// The host's raw-piece road, or the refusal that says this run has none.
function largeRoute(host) {
  if (typeof host.writeLarge !== 'function') {
    throw Object.assign(new Error('This run has no route for a file this large; a run takes pieces only.'), { code: 'large_file_route_unavailable' });
  }
  return host;
}

export async function writeWholeFile(host, name, bytes, { mediaType = 'application/octet-stream', pieceBytes = PIECE_BYTES, uploadId = randomBytes(16).toString('hex') } = {}) {
  if (bytes.length > LARGE_FILE.threshold_bytes) return largeRoute(host).writeLarge(name, bufferSource(bytes), { mediaType, uploadId });
  const started = await host.files('write_file_start', { upload_id: uploadId, name, byte_length: bytes.length, media_type: mediaType });
  // An upload already finished under this id (the same file kept again) answers its finish at the start: nothing is sent.
  if (started?.state === 'finished') return started;
  for (let offset = started?.next_offset ?? 0; offset < bytes.length; offset += pieceBytes) {
    await host.files('write_file_piece', { upload_id: uploadId, name, offset, content_base64: Buffer.from(bytes.subarray(offset, offset + pieceBytes)).toString('base64') });
  }
  return host.files('write_file_finish', { upload_id: uploadId, name });
}

// The bytes written once: a file that already holds exactly them is left alone and answers { already_kept: true }.
export async function writeWholeFileOnce(host, name, bytes, options = {}) {
  let held = null;
  try { held = await readWholeFile(host, name); } catch { held = null; }
  if (held?.bytes && held.bytes.equals(bytes)) return { already_kept: true };
  return writeWholeFile(host, name, bytes, options);
}

// A file on this computer: a small one is read whole and written in pieces; a large one is sent by the chunked sender.
// `uploadId`, when given, is the upload's own id, so a run that ends partway is gone on with by the next run under it.
export async function keepLocalFile(host, name, path, { mediaType, uploadId } = {}) {
  const source = await fileSource(path);
  const named = uploadId ? { uploadId } : {};
  try {
    if (source.size <= LARGE_FILE.threshold_bytes) return await writeWholeFile(host, name, readFileSync(path), { mediaType, ...named });
    return await largeRoute(host).writeLarge(name, source, { mediaType, ...named });
  } finally {
    await source.close();
  }
}
