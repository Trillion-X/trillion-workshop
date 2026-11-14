// src/passkey-step.mjs
// The one way a page makes a passkey or confirms a change with one, and the words for how the browser's passkey step ended. Both the sign-in pages
// (src/client/passkey.mjs) and the Account & security screen (src/workspace/guide-screens.tsx) use it, so every
// place says the same thing about the same ending.
//
// Purpose
//   Making a passkey names the passkeys the account already has (`exclude_credential_ids` from
//   src/passkey-options.mjs), so a device that already holds one says so instead of making a second; and every way the
//   step can end reads as what happened, never "cancelled" for a step nobody cancelled.
//
// Non-negotiable invariants
//   1. The words are DATA (src/passkey-step.json), keyed by the step and the error's own name; a new ending is one row.
//   2. A device that already holds a passkey for the account (InvalidStateError while making one) is a finished step:
//      `already` is true and the page carries on as after a new passkey.
//   3. Credential ids travel as base64url text and become bytes only here, at the browser's door.
//   4. A change that only a passkey with ceiling authority may make (src/passkey-authority.mjs) is confirmed here: the
//      Worker's confirm options, the browser's passkey step with user verification, and the confirmation the Worker
//      answers, which the page sends with the same request again. Nothing about it is kept on the page.
//
import { authenticate, register } from '@passwordless-id/webauthn/dist/esm/client.js';
import STEP from './passkey-step.json' with { type: 'json' };

export const PASSKEY_STEP = STEP;

/** base64url text to its bytes. */
export function base64urlBytes(text) {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(plain + '='.repeat((4 - (plain.length % 4)) % 4)), char => char.charCodeAt(0));
}

/** The browser's `excludeCredentials` for the account's passkeys, named by their base64url ids. */
export const excludedCredentials = ids => (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id).map(id => ({ type: 'public-key', id: base64urlBytes(id) }));

/** Make a passkey with options from the Worker (src/passkey-options.mjs creationOptions). */
export function makePasskey(options, make = register) {
  const { exclude_credential_ids: excluded, ...rest } = options;
  return make({ ...rest, customProperties: { ...rest.customProperties, excludeCredentials: excludedCredentials(excluded) } });
}

/** A passkey confirmation for one exact `change` (the one a refusal named): `post(path, body)` sends to the Worker and
 *  answers its JSON (it throws a refusal); `show(words)` puts the Worker's words for exactly that change on the page
 *  while the passkey prompt is up, since the prompt itself looks like a sign-in's. → the confirmation id the change's
 *  request carries as `confirmation`. */
export async function confirmWithPasskey(post, change, { show, use = authenticate }) {
  const started = await post('/passkey/options', { mode: 'confirm', change });
  show(started.words);
  const response = await use(started.options);
  return (await post('/passkey/finish', { mode: 'confirm', challenge_id: started.challenge_id, response })).confirmation;
}

/** How a passkey step ended: `step` is 'sign-in' or 'make'. `said` is the words, `kind` is done, cancelled or error,
 *  and `already` is true when this device already holds a passkey for the account. */
export function passkeyStepEnded(error, step) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const row = (name && (STEP.errors[step]?.[name] ?? STEP.errors.any[name])) || null;
  if (row) return { said: row.said, kind: row.kind, already: row.already === true };
  return { said: String(error?.message || error || STEP.unknown), kind: 'error', already: false };
}
