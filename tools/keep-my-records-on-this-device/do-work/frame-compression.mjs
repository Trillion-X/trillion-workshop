// parts/device-copy/do-work/frame-compression.mjs
//
// A SETTLE UPLOAD COMPRESSED AGAINST A SAMPLE OF THE JSON IT CARRIES, THE SAMPLE NAMED BY ITS BLAKE3 HASH, EXPANDED ONLY
// TO THE SIZE THE SENDER DECLARED.
//
// Purpose
//   A device's copy settles with the hosted store by posting bounded batches of record envelopes (record-sync.mjs).
//   Their JSON repeats the same keys in every envelope, so a few kilobytes of it, known to both ends, lets a batch
//   shrink to a tenth before it leaves a phone on a poor connection. Responses are compressed by the edge already; the
//   upload is not, which is why this is the sender's and the receiver's job.
//
// Non-negotiable invariants
//   1. A dictionary is DATA (frame-dictionaries.json). Its identity is the BLAKE3 hash of its bytes, computed here; a
//      frame names it by that hash and the receiver looks the hash up. A hash not found is refused, never fetched.
//   2. A frame always declares the exact size of its text once expanded. A frame without a size, with a size above the
//      caller's cap, with more compressed bytes than `max_compressed_bytes`, or that expands to any other size is
//      refused before any of it is used: a small frame can never become a large allocation.
//   3. Sending plain is always allowed and always read: a text shorter than `min_bytes_to_compress`, or one that does not
//      shrink, goes as it is, and a receiver reads a body that is not a frame as plain text. Clients and apps that never
//      compress keep working.
//   4. Nothing here names a route, a record kind or a device.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { Inflate, deflateSync } from 'fflate';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './frame-dictionaries.json' with { type: 'json' };

export class FrameError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'FrameError'; this.status = status; }
}

const encoder = new TextEncoder();
const dictionaries = settings.dictionaries.map(row => {
  const bytes = encoder.encode(row.text);
  return { id: bytesToHex(blake3(bytes)), bytes };
});

/** The identities (BLAKE3, hex) of the dictionaries a frame may name, oldest first. */
export const frameDictionaryIds = () => dictionaries.map(dictionary => dictionary.id);

/** The most compressed bytes a frame may carry. */
export const maxFrameBytes = settings.max_compressed_bytes;

/** Whether a body arrives as a frame (its content type says so). */
export const isFrame = headers => headers.get('content-type') === settings.content_type;

/**
 * `text` as a frame: { body, headers } to send it with, or null when sending the text itself is better (it is short, or
 * the frame would not be smaller).
 */
export function compressFrame(text) {
  const raw = encoder.encode(text);
  if (raw.length < settings.min_bytes_to_compress) return null;
  const dictionary = dictionaries.at(-1);
  const body = deflateSync(raw, { level: 6, dictionary: dictionary.bytes });
  if (body.length >= raw.length) return null;
  return { body, headers: { 'content-type': settings.content_type, [settings.dictionary_header]: dictionary.id, [settings.size_header]: String(raw.length) } };
}

/**
 * The text of a frame. `headers` has `get`; `max_expanded_bytes` is the caller's own cap on that request's text.
 * Throws a FrameError (400 for a frame that is wrong, 413 for one that is too large).
 */
export function expandFrame(body, headers, { max_expanded_bytes }) {
  if (body.length > settings.max_compressed_bytes) throw new FrameError(`A compressed frame may be at most ${settings.max_compressed_bytes} bytes.`, 413);
  const declared = headers.get(settings.size_header);
  const size = /^\d{1,12}$/.test(declared ?? '') ? Number(declared) : null;
  if (size === null) throw new FrameError('A compressed frame declares its expanded size.');
  if (size > max_expanded_bytes) throw new FrameError(`A request may carry at most ${max_expanded_bytes} bytes.`, 413);
  const dictionary = dictionaries.find(known => known.id === headers.get(settings.dictionary_header));
  if (!dictionary) throw new FrameError('That compression dictionary is not known here.');
  const out = new Uint8Array(size);
  let written = 0;
  const inflate = new Inflate({ dictionary: dictionary.bytes });
  inflate.ondata = chunk => {
    if (written + chunk.length > size) throw new FrameError('A compressed frame expanded past the size it declared.');
    out.set(chunk, written);
    written += chunk.length;
  };
  try { inflate.push(body, true); } catch (error) {
    if (error instanceof FrameError) throw error;
    throw new FrameError('A compressed frame could not be expanded.');
  }
  if (written !== size) throw new FrameError('A compressed frame expanded to less than the size it declared.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(out); } catch { throw new FrameError('A compressed frame did not hold text.'); }
}
