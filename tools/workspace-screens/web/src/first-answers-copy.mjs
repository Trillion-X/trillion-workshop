// src/first-answers-copy.mjs
//
// PURPOSE
//   The workspace page's first answers (src/workspace/first-answers.json: the reads the page makes before anything
//   shows, and the reads of the screen its address asks for), kept at the edge for one browser sign-in, so a page that
//   opens while the person's store is asleep draws at once instead of waiting for the store to wake. The Worker
//   writes the copy from the store's own answers each time it reads them for a page (src/worker.mjs workspacePage), and
//   sends it first in the next page, each answer marked as a copy (`data-page-copy`, src/workspace-files.mjs
//   withAnswers); each address's own answer follows in the same page as the store gives it, and the page draws the
//   copy at once and the store's answer wherever it differs (src/workspace/api.ts), the way it treats a copy kept on
//   the device itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A copy is named by its sign-in's id (the session's BLAKE3 hash, which the Account & security list and
//      forgetSession already use) and sealed with AES-GCM under a key made from that sign-in's secret token alone
//      (BLAKE3 in key-derivation mode), so only the browser holding the cookie can have it opened, and nothing kept
//      can be read once the sign-in is gone. Ending a sign-in, and disconnecting everything, delete its copy.
//   2. Only reads: a copy is answered only to a page the Worker already let open (src/worker.mjs sessionUser), and
//      never decides who is signed in. Every read the page makes after it opens still waits for the store's word.
//   3. Only the page's first answers are copied, never the reads of the one item an address names (a file's own bytes
//      and results), and only good answers (200). None of these reads carries a value sealed in the person's locked
//      box (saved logins, connection secrets): those are shown only by their own routes after the person confirms.
//   4. A copy holds one revision: the screen revision the store answered and the answers read after it. The page
//      never takes a copy as the store's word: it carries only the store's own revision (src/workspace/store-changes.ts)
//      and only a read that draws again when its answer changes (a screen's loader) is answered from a copy.
//   5. A copy is rewritten only when the store's revision moved since it was written or a page read something it
//      lacks, so an unchanged account costs no write; it runs out on its own after `keep_days` without a write.
//   6. A look-only sign-in (a picture drawn for an AI, someone let look) and a showcase's throwaway sign-in keep no copy.
//
import { blake3 } from '@noble/hashes/blake3.js';
import firstAnswers from './workspace/first-answers.json' with { type: 'json' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_CONTEXT = encoder.encode('trillion 2026-10-06 first answers copy key');
const { kv_prefix: PREFIX, keep_days: KEEP_DAYS } = firstAnswers.edge_copy;
const toBase64 = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); return btoa(text); };
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const sealingKey = token => crypto.subtle.importKey('raw', blake3(encoder.encode(String(token)), { context: KEY_CONTEXT }), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** The name a sign-in's copy is kept under, from the sign-in's id (its session hash). */
export const copyName = sessionId => `${PREFIX}${sessionId}`;

/** Whether a sign-in keeps a copy at all (invariant 6). */
export const keepsCopy = session => Boolean(session && !session.look_only && !session.throwaway && session.token && session.id);

/** The copy kept for this sign-in, `{ revision, answers: { [path]: { status, body } } }`, or null when there is none or
 *  it cannot be opened (another sign-in's, damaged). */
export async function readCopy(kv, session) {
  if (!keepsCopy(session)) return null;
  const kept = await kv.get(copyName(session.id), 'json').catch(() => null);
  if (!kept?.iv || !kept?.data) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(kept.iv) }, await sealingKey(session.token), fromBase64(kept.data));
    const copy = JSON.parse(decoder.decode(plain));
    return copy && typeof copy.answers === 'object' && copy.answers ? copy : null;
  } catch {
    return null;
  }
}

/** The part of a page's answers a copy keeps (invariant 3): every good answer of `paths`, which the caller lists as the
 *  page's first answers and the asked-for screen's reads, item reads left out. */
export function copyOf(revision, answered) {
  const answers = {};
  for (const [path, answer] of answered) if (answer?.status === 200) answers[path] = { status: 200, body: answer.body };
  return { revision, answers };
}

/** Keeps `copy` for this sign-in (invariant 5): nothing is written when the copy it replaces already holds the same
 *  revision and every one of its reads; at the same revision the two are joined, so pages opened on different screens
 *  all find theirs; at a new revision the older answers are dropped. Answers whether it wrote. */
export async function writeCopy(kv, session, copy, replacing = null) {
  if (!keepsCopy(session) || copy?.revision === undefined || copy.revision === null) return false;
  if (replacing && JSON.stringify(replacing.revision) === JSON.stringify(copy.revision)) {
    if (Object.keys(copy.answers).every(path => path in replacing.answers)) return false;
    copy = { revision: copy.revision, answers: { ...replacing.answers, ...copy.answers } };
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealingKey(session.token), encoder.encode(JSON.stringify(copy))));
  await kv.put(copyName(session.id), JSON.stringify({ iv: toBase64(iv), data: toBase64(data) }), { expirationTtl: KEEP_DAYS * 24 * 60 * 60 });
  return true;
}

/** Deletes a sign-in's copy (invariant 1), by the sign-in's id. */
export const forgetCopy = (kv, sessionId) => kv.delete(copyName(sessionId));
