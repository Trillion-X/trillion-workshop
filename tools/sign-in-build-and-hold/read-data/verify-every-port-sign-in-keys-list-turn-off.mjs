// tools/sign-in-build-and-hold/read-data/verify-every-port-sign-in-keys-list-turn-off.mjs
//
// Listing a person's personal keys and turning one off. Ported from the earlier code base's src/personal-keys.mjs
// (b6ae0ebf815f): keyRow (what any road may answer about a key), personalKeysOf (the list), expiryFrom and expiryOfChoice
// (what an expiry may be), endPersonalKey and ownKey (who may turn a key off), with the same words.
//
// Storage-free: the caller reads the key's record and list entry, and passes them in with the time, the caller's reach and
// the reach test. The reach test is the reach owner's function (`within(inner, outer)`), passed in, not copied here.
// Every function answers a value or throws an Error with a `status` (the refusals the earlier code gave).
//
// NON-NEGOTIABLE INVARIANTS (kept from the earlier code base):
//   1. A key is never listed or answered: keyRow names every field it answers, and the key's value is not one of them.
//   2. An expired key signs nothing in and is answered with the `expired` words. A list says whether there are more.
//   3. A caller manages only keys whose reach is within its own; a key cannot last longer than the sign-in that sets its
//      expiry.
//   4. A key is turned off only for its own account (or by holding the key itself); a key the caller may not reach is
//      refused. The sign-in that key makes is ended by the caller at the account's policy owner, before the record goes.
//   5. Reads are bounded: a list answers at most `list_max` entries.
import settings from './verify-every-port-sign-in-keys-list-turn-off.json' with { type: 'json' };

export const PERSONAL_KEYS = settings;
const KEY_ID = /^[0-9a-f]{64}$/;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const refused = (message, status) => Object.assign(new Error(message), { status });

/** Whether a key expiring at `expiresAt` (ISO text, or none) has expired by `now` (ms). */
export const keyExpired = (expiresAt, now = Date.now()) => typeof expiresAt === 'string' && Date.parse(expiresAt) <= now;

/** The words a sign-in answers an expired key with. */
export const expiredWords = expiresAt => fill(settings.words.expired, { at: expiresAt });

/** What any road answers about one key: never the key, only these fields. `entry` is the key's stored record merged with
 *  its list entry; `reach` null is the caller's own full reach, as stored. */
export function keyRow(entry, now = Date.now()) {
  return {
    id: entry.id,
    name: entry.name ?? null,
    purpose: entry.purpose ?? null,
    ending: entry.ending ?? null,
    created_at: entry.created_at ?? null,
    last_used_at: entry.last_used_at ?? null,
    expires_at: entry.expires_at ?? null,
    expired: keyExpired(entry.expires_at, now),
    reach: entry.reach ?? null,
    ceiling: entry.ceiling ?? null,
  };
}

/** Whether the caller may manage the key `entry`: its reach is within the caller's. `within(inner, outer)` is the reach
 *  owner's test, where a reach of null is the full reach. A caller with no reach (null) manages every key. */
export const manages = (within, caller, entry) => !caller || !caller.reach || within(entry.reach ?? null, caller.reach);

/** The account's keys for a list: newest first, at most `list_max`, and whether there are more. `caller`, when given,
 *  keeps only the keys it may manage. */
export function personalKeysPage({ entries, caller = null, now = Date.now(), within }) {
  const rows = entries.map(entry => keyRow(entry, now))
    .filter(row => !caller || manages(within, caller, row))
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  return { keys: rows.slice(0, settings.list_max), more: rows.length > settings.list_max };
}

/** When a key asked to expire does, from `expires_in` (whole seconds from now) or `expires_at` (a date and time): an ISO
 *  time; null for never; undefined when neither was asked. Refused (400) past `expires_in_max_seconds`. */
export function expiryFrom({ expires_in: inSeconds, expires_at: at } = {}, now = Date.now()) {
  if (inSeconds === undefined && at === undefined) return undefined;
  if (inSeconds === null || at === null) return null;
  const most = settings.expires_in_max_seconds;
  const bad = () => refused(fill(settings.words.bad_expiry, { max: most }), 400);
  const asked = inSeconds !== undefined ? Number(inSeconds) : NaN;
  if (inSeconds !== undefined && !(Number.isInteger(asked) && asked >= 1 && asked <= most)) throw bad();
  const when = inSeconds !== undefined ? now + asked * 1000 : Date.parse(String(at));
  if (!Number.isFinite(when) || when <= now || when > now + most * 1000) throw bad();
  return new Date(when).toISOString();
}

/** The expiry a person chose on the account page: '' keeps it, 'never' takes it away, else one of `expiry_choices`'
 *  seconds. Answers what expiryFrom reads. */
export function expiryOfChoice(value) {
  if (value === undefined || value === null || value === '') return {};
  if (value === 'never') return { expires_at: null };
  const seconds = Number(value);
  if (!settings.expiry_choices.some(choice => choice.seconds === seconds)) throw refused(fill(settings.words.bad_expiry, { max: settings.expires_in_max_seconds }), 400);
  return { expires_in: seconds };
}

/** Whether a key may be given the expiry `at` (ISO, or null for never) by a sign-in that expires at `callerExpiresAt`
 *  (null for never). Refused (403) when the key would outlive that sign-in. */
export function lastsWithin(at, callerExpiresAt) {
  if (!callerExpiresAt) return;
  if (at === null || Date.parse(at) > Date.parse(callerExpiresAt)) throw refused(fill(settings.words.outlives, { at: callerExpiresAt }), 403);
}

/** Whether `id` is the id a key is kept under (BLAKE3 hex, 64 characters). */
export const isKeyId = id => typeof id === 'string' && KEY_ID.test(id);

/** Who may turn a key off, from what the caller's storage read found. `saved` is the key's record (with its owning
 *  account), `entry` its list entry, `listedOnly` says a list entry alone may be taken away (a record already gone), and
 *  `held` that the caller holds the key itself (it proved it may). Refused (404) when the key is not this account's, and
 *  (403) when the caller reaches less than the key. Answers the entry the list keeps. */
export function endKeyDecision({ id, saved, entry, userId, caller = null, within, listedOnly = true, held = false }) {
  if (!isKeyId(id)) throw refused(settings.words.not_yours, 404);
  const mine = saved ? saved.userId === userId : listedOnly && !held;
  if (!mine || !(entry || (held && saved))) throw refused(settings.words.not_yours, 404);
  const row = { id, ...(entry ?? {}) };
  if (!held && !manages(within, caller, row)) throw refused(settings.words.reaches_less, 403);
  return row;
}

/** The answer a turn-off gives once the key's sign-in is ended and its record and list entry are gone. */
export const endedWords = () => settings.words.ended;
