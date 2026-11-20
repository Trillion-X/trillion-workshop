// tools/sign-in-build-and-hold/read-data/passkey-remove.mjs
//
// Removing one of an account's passkeys. Ported from the earlier code base's account/passkeys/remove route in
// src/account-routes.mjs (b6ae0ebf815f): its checks, their order, their statuses and its words.
//
// Storage-free: the caller reads the account's passkey list, whether a password signs in, the stored passkey's owner and
// the known-passkey authority's answer for this removal (that rule is the known-passkey-authority item's, passed in here,
// not copied). The caller deletes the passkey and its list entry when the answer says `remove`.
//
// NON-NEGOTIABLE INVARIANTS (kept from the earlier code base):
//   1. A passkey is removed only from its own account; an id that is not on the account's list is refused as not found.
//   2. The last passkey goes only while a password still signs in, so a person is never left with no way in.
//   3. A removal the known-passkey authority refuses is answered with that refusal unchanged.
//   4. A sign-in that is not recent is sent to sign in again before anything is removed.
import settings from './passkey-remove.json' with { type: 'json' };

export const PASSKEY_REMOVE = settings;

/** The address that sends a person to sign in again and back to `next` (src/sign-in-again.mjs). */
export const signInAgainAddress = next => `/sign-in?again=1&next=${encodeURIComponent(next)}`;

const refusal = key => ({ error: settings.words[key], status: settings.statuses[key] });

/** What removing one passkey answers.
 *  - `fresh`: whether the browser signed in recently enough to change a way in.
 *  - `passkeyIds`: the ids on the account's passkey list (its own passkeys only).
 *  - `passwordSet`: whether the account has a password that still signs in.
 *  - `saved`: the stored passkey record ({ userId }), or null when none is stored under that id.
 *  - `sessionUserId`: the account the sign-in belongs to.
 *  - `authorityRefusal`: the known-passkey authority's refusal for this removal, or null when it allows it.
 *  → { remove, said, refresh } when it may go, { said, redirect } when a sign-in is needed, else { error, status }. */
export function decidePasskeyRemoval({ fresh, passkeyId, passkeyIds, passwordSet, saved, sessionUserId, authorityRefusal = null }) {
  if (!fresh) return { said: settings.words.sign_in_again, redirect: signInAgainAddress(settings.sign_in_again_path) };
  const id = String(passkeyId ?? '');
  if (!passkeyIds.includes(id)) return refusal('not_on_account');
  if (passkeyIds.length <= 1 && !passwordSet) return refusal('only_way_in');
  if (saved && saved.userId !== sessionUserId) return refusal('not_on_account');
  if (authorityRefusal) return authorityRefusal;
  return { remove: id, said: settings.words.removed, refresh: true };
}
