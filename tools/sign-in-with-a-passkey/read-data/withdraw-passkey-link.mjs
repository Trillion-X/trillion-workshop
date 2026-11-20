// tools/sign-in-build-and-hold/read-data/withdraw-passkey-link.mjs
//
// The one-time passkey link: making it, using it to add a passkey, and what a refused passkey is named back as. Ported from
// the earlier code base's account/passkeys/link route, makePasskeyLink and the passkey finish in src/worker.mjs, and
// refusePasskeyStep (b6ae0ebf815f), with the same words and statuses.
//
// Storage-free and random-free: the caller makes the random code, hashes it, keeps and reads the link record, verifies the
// passkey, and deletes the link when this module says `spend`. The earlier code had no route that withdrew a link before
// use or expiry; that is not here (see the DATA's _what).
//
// NON-NEGOTIABLE INVARIANTS (kept from the earlier code base):
//   1. A link works once, for the account it was made for, and only for as long as its lifetime; a used or old link is refused.
//   2. A link is spent once its passkey checks out, before that passkey is saved, so it never adds two passkeys.
//   3. A passkey whose user is not the link's account is not saved, and the link is still spent.
//   4. A recent sign-in is needed to make a link; a passkey that was made but not saved is named back to the device.
import settings from './withdraw-passkey-link.json' with { type: 'json' };

export const PASSKEY_LINK = settings;

const refusal = (key, error = settings.words[key]) => ({ error, status: settings.statuses[key] });

/** Making a link for the account asking. `code` is the caller's random code, `origin` the address the link opens on.
 *  → { store: { userId, expires_at }, ttl_seconds, reveal: { label, text }, said } for a made link, or { said, redirect } when a
 *  sign-in is needed. The caller keeps `store` under the hash of `code`, for `ttl_seconds`. */
export function decideMakePasskeyLink({ fresh, userId, code, origin, now = Date.now() }) {
  if (!fresh) return { said: settings.words.sign_in_again, redirect: `/sign-in?again=1&next=${encodeURIComponent(settings.sign_in_again_path)}` };
  const expires = new Date(now + settings.lifetime_seconds * 1000).toISOString();
  return {
    store: { userId, expires_at: expires },
    ttl_seconds: settings.lifetime_seconds,
    reveal: { label: settings.words.reveal_label, text: `${origin}${settings.path}?${settings.add_passkey_param}=${code}` },
    said: settings.words.made,
  };
}

/** Starting to use a link (the page that asks for the passkey). `link` is the stored record ({ userId, expires_at }) or null
 *  when it is used, expired or made up. → { mode: 'link', userId } to go on, else { error, status }. */
export function decideBeginLinkUse(link) {
  if (!link) return refusal('used_or_expired');
  return { mode: 'link', userId: link.userId };
}

/** Saving the passkey a link asked for, after the caller checked whether the link is still held (`alive`) and verified the
 *  passkey (`verified`, with its `passkeyUserId`). `linkUserId` is the link's account.
 *  → { spend, save: true, userId } when the passkey may be saved to the account; else { spend, error, status }. `spend` says the
 *  caller deletes the link now. */
export function decideLinkSave({ alive, verified, passkeyUserId, linkUserId }) {
  if (!alive || !verified) return { spend: false, ...refusal('not_saved') };
  if (passkeyUserId !== linkUserId) return { spend: true, ...refusal('not_saved') };
  return { spend: true, save: true, userId: linkUserId };
}

/** A refused passkey step's answer. A passkey the device made for an account that was not saved is named back in
 *  `forget_passkey` (rp_id and credential_id), so the device can drop it; a sign-in never is. Always status 400. */
export function refusedPasskeyAnswer({ mode, answer, responseId, domain }) {
  const made = mode !== 'sign-in' && typeof responseId === 'string' && responseId !== '';
  const forget = made && !answer.forget_passkey ? { forget_passkey: { rp_id: domain, credential_id: responseId } } : {};
  return { body: { ...answer, ...forget }, status: 400 };
}
