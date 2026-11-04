// tools/records-door/read-data/whole-file.mjs
//
// Purpose: one of the person's files read whole through a run's door (find_file, then read_file page by page), for a
// tool that hands the bytes to a program on the computer (a recording to hear, a sound to measure).
//
// Non-Negotiable Invariants:
//   1. A file larger than `mostBytes` is never read past its first page: the answer says so with bytes null.
//   2. Only find_file and read_file are asked, so the row's files right names exactly those two operations.
//
//   3. A file is written in pieces that each fit one door message (write_file_start, write_file_piece, write_file_finish
//      under one upload id), so writing it again with the same id resumes and its finish answers the same receipt.
//
//   readWholeFile(door, name, { readBytes, mostBytes }) → { title, size, bytes } (bytes null when too large).
//   writeWholeFile(door, name, bytes, { mediaType, pieceBytes, uploadId }) → the door's finish answer.
import { randomBytes } from 'node:crypto';

export const READ_BYTES = 4 * 1024 * 1024;
export const MOST_BYTES = 512 * 1024 * 1024;
// Raw bytes per written piece: their base64 and the call around it stay inside the door's 64 KiB message.
export const PIECE_BYTES = 40 * 1024;

export async function readWholeFile(door, name, { readBytes = READ_BYTES, mostBytes = MOST_BYTES } = {}) {
  const found = await door.files('find_file', { name_or_identity: name });
  const title = String(found.names?.[0] ?? found.name ?? name).split('/').pop();
  const parts = [];
  let offset = 0;
  for (;;) {
    const piece = await door.files('read_file', { name_or_identity: name, offset, length: readBytes });
    if (piece.byte_length > mostBytes) return { title, size: piece.byte_length, bytes: null };
    parts.push(Buffer.from(piece.content ?? '', piece.encoding === 'base64' ? 'base64' : 'utf8'));
    offset += piece.bytes_returned;
    if (!piece.bytes_returned || offset >= piece.byte_length) return { title, size: offset, bytes: Buffer.concat(parts) };
  }
}

export async function writeWholeFile(door, name, bytes, { mediaType = 'application/octet-stream', pieceBytes = PIECE_BYTES, uploadId = randomBytes(16).toString('hex') } = {}) {
  const started = await door.files('write_file_start', { upload_id: uploadId, name, byte_length: bytes.length, media_type: mediaType });
  for (let offset = started?.next_offset ?? 0; offset < bytes.length; offset += pieceBytes) {
    await door.files('write_file_piece', { upload_id: uploadId, name, offset, content_base64: Buffer.from(bytes.subarray(offset, offset + pieceBytes)).toString('base64') });
  }
  return door.files('write_file_finish', { upload_id: uploadId, name });
}
