// tools/sign-in-build-and-hold/read-data/verify-every-port-sign-in-guarded-change-confirm.mjs
//
// A passkey confirmation for one exact guarded change. A change that moves a way the person is told or signs in by, a
// passkey, a limit or the account itself needs a confirmation from a known passkey, bound to the sign-in that asked and
// to exactly that change, used once, and past its time after `confirmation_seconds`. A refusal names the step and the
// exact change so the page can run the confirmation and send the same request again. Ported from the earlier code base's
// src/cap-change.mjs (changeKey, confirmationBy, takeAccountConfirmation, holdCapConfirmation) and src/passkey-authority.mjs
// (confirmWords, guardedChangeRefusal, removalRefusal, confirmedNotice), b6ae0ebf815f.
//
// Storage-free: the caller reads the held confirmation from its store, uses it up, and passes in what was found. This
// module decides whether the change may go and what the person and the page are told.
//
// Invariants (kept from the earlier code base):
// - A confirmation is for one sign-in and one change: `changeKey` gives the same text for the same change whatever the
//   order of its keys, and a confirmation for one change never authorizes another.
// - A confirmation is used once; the caller takes it whether or not it matched, so it is never tried twice.
// - While anything waits on the ways the person is told, a change to those ways is held (`held_while_waiting`), before
//   any confirmation is looked at.
// - On an account with no known passkey nothing only the person can do exists, so the change goes (the risk the DATA
//   states in passkey-authority.json; not decided here).
import settings from './verify-every-port-sign-in-guarded-change-confirm.json' with { type: 'json' };

export const CONFIRMATION_SECONDS = settings.confirmation_seconds;
export const NOT_A_CHANGE = settings.words.not_a_change;
export const PASSKEY_CONFIRMATION = settings.step_needed;

const SECOND_MS = 1000;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** One change as the text a confirmation is bound to: the same change always gives the same text, whatever its key order;
 *  keys with no value are left out. */
export function changeKey(change) {
  const sorted = value => (Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sorted(value[key])]))
      : value);
  return JSON.stringify(sorted(change ?? null));
}

/** What the page shows while the passkey prompt for confirming `change` is up, or null when `change` is not one a
 *  confirmation may be for. */
export function confirmWords(change) {
  const template = Object.hasOwn(settings.confirm_words, change?.action) ? settings.confirm_words[change.action] : null;
  return template && fill(template, change);
}

/** The record a confirmation is kept as while it waits to be used: its sign-in, its exact change, and (when the change
 *  is made from another account) the account and the passkey that approved it. */
export function confirmationRecord({ signIn, change, userId = null, by = null }) {
  return { mode: 'cap-confirm', sign_in: signIn, change: changeKey(change), ...(userId ? { user_id: userId } : {}), ...(by ? { by } : {}) };
}

/** When a confirmation made at `now` (ms) stops being usable (ms). */
export const confirmationEnds = now => now + CONFIRMATION_SECONDS * SECOND_MS;

/** The passkey that made a held confirmation, when it was held for exactly `signIn` and `change`; else null. The caller
 *  has already used the held record up (it is taken whether or not it matched). */
export function confirmationBy(held, { signIn, change }) {
  if (!held || held.mode !== 'cap-confirm' || held.sign_in !== signIn || held.change !== changeKey(change)) return null;
  return { passkey: held.by?.passkey ?? null, known_from: held.by?.known_from ?? null };
}

/** Whether a held confirmation was made in account `userId` for exactly `change` (a change asked from another account). */
export const accountConfirmationMatches = (held, { userId, change }) =>
  Boolean(held && held.mode === 'cap-confirm' && held.user_id === userId && held.change === changeKey(change));

/** The notice told on every channel each time a known passkey confirms a change: one touch is one told change. */
export function confirmedNotice(change) {
  return { title: settings.confirmed_notice.title, body: fill(settings.confirmed_notice.body, { words: confirmWords(change) ?? '' }) };
}

/** The refusal for a change that needs a known passkey's confirmation for exactly `change`, or null when it may go.
 *  `state` is { known: the ids of the account's known passkeys, pending: whether anything waits or a recovery or a
 *  delayed change is waiting }. `channel` marks a change to the ways the person is told or signs in elsewhere, held while
 *  anything waits. `confirmed` is whether the caller's confirmation was one for exactly `change` (confirmationBy). */
export function guardedChangeRefusal({ state, change, confirmed, channel = false }) {
  if (channel && state.pending) return { error: settings.words.held_while_waiting, status: 409 };
  if (!state.known.length) return null;
  if (confirmed) return null;
  return { error: settings.words.needs_known_passkey, status: 403, step_needed: settings.step_needed, change };
}

/** Removing the passkey `id`: a known passkey goes only with a known passkey's confirmation for exactly this removal; a
 *  passkey that is not known goes without one. */
export function removalRefusal({ state, id, confirmed }) {
  if (!state.known.includes(id)) return null;
  return guardedChangeRefusal({ state, change: { action: 'passkeys/remove', passkey_id: id }, confirmed });
}
