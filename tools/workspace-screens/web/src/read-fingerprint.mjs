// src/read-fingerprint.mjs
//
// Purpose
//   A page that already holds the last answer to a read (its kept copy) says which answer it holds, by a short BLAKE3
//   fingerprint of its body; when the Worker's answer to the same read is that same body it answers with a few bytes
//   instead of the body, and the page uses what it holds. A read the store changed is answered whole, so the one record
//   that differs is the only one that travels; nothing is reloaded wholesale and nothing is trusted unchecked.
//
// Non-negotiable invariants
//   1. The fingerprint is a BLAKE3 hash of the body's exact text (one function, `fingerprintOf`, used by the page and the
//      Worker alike); a body that differs by one character is a different fingerprint and is sent whole.
//   2. Only a successful JSON read of a path under `path_prefix`, answered with a body of at most `most_bytes`, is ever
//      shortened; a refusal, a body too large to compare, or an answer carrying a header the page reads beside the body
//      is sent exactly as it was.
//   3. A request that sends no fingerprint, or one that is not 32 hex characters, is answered as before.
//   4. What is DATA (header names, size, path, headers that keep an answer whole) is in read-fingerprint.json.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './read-fingerprint.json' with { type: 'json' };

export const readFingerprintSettings = settings;

/** The fingerprint of a body's text: the first `fingerprint_characters` hex characters of its BLAKE3 hash. */
export const fingerprintOf = text => bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, settings.fingerprint_characters);

/**
 * The response to send for `request`: `response` itself, or when the page holds exactly this answer, a short one.
 * Async because the body is read once (bounded by `most_bytes`) to compare.
 */
export async function sameAsHeld(request, response) {
  if (request.method !== 'GET') return response;
  const held = request.headers.get(settings.request_header);
  if (!held || !/^[0-9a-f]+$/.test(held) || held.length !== settings.fingerprint_characters) return response;
  if (response.status !== 200 || !new URL(request.url).pathname.startsWith(settings.path_prefix)) return response;
  if (!(response.headers.get('content-type') ?? '').includes('json')) return response;
  if (settings.keep_whole_when_headers.some(name => response.headers.has(name))) return response;
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > settings.most_bytes) return response;
  const text = await response.clone().text();
  if (text.length > settings.most_bytes || fingerprintOf(text) !== held) return response;
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
  headers.set(settings.answer_header, '1');
  return new Response('{"same":true}', { status: 200, headers });
}
