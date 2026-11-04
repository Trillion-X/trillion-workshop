// src/kept-answers.mjs
//
// Purpose
//   Names and keys the store in which a signed-in browser keeps the last answer to each workspace read
//   (parts/ui/show/request/kept-values.ts, used by src/workspace/api.ts), so a screen opened again draws at once.
//   The Worker writes both into the workspace page for this sign-in (src/worker.mjs workspacePage).
//
// Non-negotiable invariants
//   - The store's name comes from the account alone, so each account on a shared computer has its own store and the
//     page deletes every other account's store as it opens.
//   - The key comes from this sign-in's secret session token alone (BLAKE3 in key-derivation mode), so a copy kept
//     under one sign-in never opens under another, and once the sign-in ends nothing left on the disk can be read.
//   - Neither is kept anywhere: both are worked out again from the session on every page.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import firstAnswers from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/first-answers.json' with { type: 'json' };

const encoder = new TextEncoder();
const STORE_CONTEXT = encoder.encode('trillion 2026-09-30 kept answers store');
const KEY_CONTEXT = encoder.encode('trillion 2026-09-30 kept answers key');
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `{ store, key }` for a session `{ userId, token }`: the store's name and its 32-byte sealing key (base64url). */
export const keptAnswerStore = userId => `${firstAnswers.kept.store_prefix}${bytesToHex(blake3(encoder.encode(String(userId)), { context: STORE_CONTEXT })).slice(0, 32)}`;

export function keptAnswerSettings({ userId, token }) {
  return {
    store: keptAnswerStore(userId),
    key: base64url(blake3(encoder.encode(String(token)), { context: KEY_CONTEXT })),
  };
}
