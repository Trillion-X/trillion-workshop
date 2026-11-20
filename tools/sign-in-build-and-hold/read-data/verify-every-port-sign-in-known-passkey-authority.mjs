// tools/sign-in-build-and-hold/read-data/verify-every-port-sign-in-known-passkey-authority.mjs
//
// Which of a person's passkeys are known (may confirm a guarded change), from when, and the decisions and notices that
// move that authority: a recovery, a delayed deletion or move, a vouch, the notice room. Ported from the earlier code base's
// src/passkey-authority.mjs (b6ae0ebf815f) with the same words (the DATA is read-data/verify-every-port-sign-in-known-passkey-authority.json).
//
// Storage-free and clock-free: the caller reads the passkey rows, the recovery, the delayed change and the notice times from
// its store and passes them in with `now` (ms). Every function answers a value; the caller writes what it is told to write
// and sends the notices it is given (the host's senders are not here).
//
// Non-negotiable invariants (kept from the earlier code base):
//   1. A passkey is known only from `authority.from`, fixed when it is saved (see provenanceOf). A record with no provenance is
//      never known until it is classified (legacyAuthority), once.
//   2. Any use of a known passkey cancels everything waiting that no known passkey confirmed (cancelWaiting).
//   3. A recovery that has run its wait unknows every passkey known before it started; nothing else unknows one.
//   4. A change that destroys or carries away an account, on an account with no known passkey, waits out the notice: told on
//      every channel at once, cancelled by a known passkey's use or any recent sign-in, and done only when asked again after
//      the wait (delayedChangeDecision).
//   5. Notices are bounded per window (noticeRoom), so a flood cannot use up the mail they ride.
//   6. The confirmation of a single guarded change is in verify-every-port-sign-in-guarded-change-confirm.mjs, not here.
import data from './verify-every-port-sign-in-known-passkey-authority.json' with { type: 'json' };
import { changeKey } from './verify-every-port-sign-in-guarded-change-confirm.mjs';

const HOUR_MS = 3_600_000;
const waitMs = by => (data.provenance[by].wait_hours ?? 0) * HOUR_MS;
const said = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
const when = ms => new Date(ms).toUTCString();
const iso = ms => new Date(ms).toISOString();
// What every authority notice is told as: a service notice on every channel.
export const NOTICE = { kind: data.notice.kind, open: data.notice.open, every_channel: data.notice.every_channel };
export const TOO_MANY_NOTICES = data.words.too_many_notices;

/** How a passkey being saved was added (invariant 1): `mode` is the passkey step's, `vouched` whether a known passkey
 *  confirmed the ceremony, `known` whether the account has a known passkey now, `recovering` whether a recovery waits. */
export function provenanceOf({ mode, vouched = false, known = false, recovering = false }) {
  if (mode === 'create') return 'sign-up';
  if (vouched === true) return 'known-passkey';
  return !known || recovering ? 'notice' : 'unvouched';
}

/** The provenance a passkey record carries: { by, at, from } (ISO times; `from` is when it is known, null for never).
 *  `notBefore` (ms) holds a notice-route passkey back until a waiting recovery ends. */
export function authorityFor(by, now = Date.now(), { notBefore = 0 } = {}) {
  if (!Object.hasOwn(data.provenance, by)) throw new Error(`${by} is not a passkey provenance.`);
  return {
    by,
    at: iso(now),
    from: data.provenance[by].gains_authority ? iso(Math.max(now + waitMs(by), notBefore)) : null,
  };
}

/** When a saved passkey record is known from, in ms, or null when it never is. */
export function authorityFrom(saved) {
  if (!saved?.authority || saved.authority.from === null) return null;
  return Date.parse(saved.authority.from);
}

/** Whether a saved passkey record is known now; a recovery that ran its wait unknows those known before it started. `recovery`
 *  is the account's recovery row ({ started_at, from }) or null. */
export function hasAuthority(saved, now = Date.now(), recovery = null) {
  const from = authorityFrom(saved);
  if (from === null || from > now) return false;
  return !(recovery && Date.parse(recovery.from) <= now && from <= Date.parse(recovery.started_at));
}

/** The passkeys saved before provenance existed, classified once (invariant 1). `legacy` rows are { id, saved }; `known` says
 *  whether another passkey is known now; `signUp` is the account's sign-up record ({ method, at }) or null when no evidence
 *  is held. The one saved within `legacy.sign_up_seconds` before the account was made with a passkey is known from its
 *  creation; every other one is unvouched when the account keeps a known passkey, else it waits out the notice from `now`. */
export function legacyAuthority({ legacy, known, signUp = null, now = Date.now(), by = 'legacy' }) {
  const madeAt = signUp?.method === 'passkey' ? Date.parse(signUp.at) : NaN;
  const before = row => madeAt - Date.parse(row.saved?.created_at ?? '');
  const signUpRow = legacy.filter(row => before(row) >= 0 && before(row) <= data.legacy.sign_up_seconds * 1000)
    .sort((a, b) => before(a) - before(b))[0] ?? null;
  const stays = known || Boolean(signUpRow);
  return Object.fromEntries(legacy.map(row => [row.id, row === signUpRow
    ? { by: 'sign-up', at: iso(now), from: row.saved.created_at, classified: by }
    : { ...authorityFor(stays ? 'unvouched' : 'notice', now), classified: by }]));
}

/** The passkey rows with their classified provenance written in (legacyAuthority's answer), each { id, saved }. */
export const withClassified = (passkeys, decided) => passkeys.map(row => (decided[row.id] ? { id: row.id, saved: { ...row.saved, authority: decided[row.id] } } : row));

/** The notice telling the person how their older passkeys were classified, or null when only the sign-up passkey was. */
export function legacyNotice(userId, decided) {
  const rows = Object.values(decided).filter(authority => authority.by !== 'sign-up');
  if (!rows.length) return null;
  const waits = rows.find(authority => authority.by === 'notice');
  return {
    key: `passkey-legacy:${userId}`, ...NOTICE, update: true, title: data.words.legacy_title,
    body: waits
      ? said(data.words.legacy_waits_body, { count: rows.length, from: when(Date.parse(waits.from)) })
      : said(data.words.legacy_unvouched_body, { count: rows.length }),
  };
}

/** The account's passkeys as the authority sees them at `now`: { passkeys, known, waiting, recovery (waiting, or null),
 *  recovered (done, or null), delayed (the change waiting, or null) }. `passkeys` are { id, saved } rows already classified. */
export function authorityView({ passkeys, recovery = null, delayed = null, now = Date.now() }) {
  const done = recovery && Date.parse(recovery.from) <= now;
  const known = passkeys.filter(row => hasAuthority(row.saved, now, recovery));
  const waiting = passkeys.filter(row => !known.includes(row) && authorityFrom(row.saved) !== null && authorityFrom(row.saved) > now);
  return {
    passkeys, known, waiting,
    recovery: recovery && !done ? recovery : null,
    recovered: done ? recovery : null,
    delayed: delayed && Date.parse(delayed.from) > now ? delayed : null,
  };
}

/** The words a passkey that is not known answers when it tries to confirm a change. */
export function notKnownWords(saved) {
  const from = authorityFrom(saved);
  return from === null ? data.words.never_known : said(data.words.not_known_yet, { from: when(from) });
}

/** A known passkey was used (invariant 2): every waiting passkey that no known passkey confirmed becomes unvouched, a
 *  waiting recovery ends and a waiting delayed change is cleared. → { updates: [{ id, saved }], cancelled: ids,
 *  recovery_cancelled, clear_delayed }. */
export function cancelWaiting({ state, now = Date.now() }) {
  const cancelled = state.waiting.filter(row => row.saved.authority.by === 'notice');
  const updates = cancelled.map(row => ({
    id: row.id,
    saved: { ...row.saved, authority: { ...authorityFor('unvouched', now), cancelled: row.saved.authority } },
  }));
  return {
    updates,
    cancelled: cancelled.map(row => row.id),
    recovery_cancelled: Boolean(state.recovery),
    clear_delayed: true,
  };
}

/** The notice times kept for the account, read against the window: { room, times }. `room` is false when `notice.most` were
 *  told within `notice.window_hours`; otherwise `times` includes this one, which the caller keeps. */
export function noticeRoom({ times = [], now = Date.now() }) {
  const window = data.notice.window_hours * HOUR_MS;
  const kept = times.filter(at => now - Date.parse(at) < window);
  if (kept.length >= data.notice.most) return { room: false, times: kept };
  return { room: true, times: [...kept, iso(now)] };
}

/** A change that destroys or carries away the account, on an account with no known passkey (invariant 4). `delayed` is the
 *  waiting change row ({ change, started_at, from }) or null; `room` is noticeRoom's answer. → one of
 *    { kind: 'go', clear: true }                        the same change, asked again after its wait
 *    { kind: 'refused', error, status }                  it waits, or another delayed change does
 *    { kind: 'started', row, said, notice }              the notice starts; the caller keeps `row` and sends `notice`
 *  `changeKey` of the change is the same text the earlier code kept (verify-every-port-sign-in-guarded-change-confirm.mjs). */
export function delayedChangeDecision({ change, delayed = null, room, now = Date.now() }) {
  const key = changeKey(change);
  if (delayed?.change === key && Date.parse(delayed.from) <= now) return { kind: 'go', clear: true };
  if (delayed && Date.parse(delayed.from) > now) {
    return { kind: 'refused', error: said(delayed.change === key ? data.words.delayed_waiting : data.words.delayed_other, { from: when(Date.parse(delayed.from)) }), status: 409 };
  }
  if (!room) return { kind: 'refused', error: data.words.too_many_notices, status: 429 };
  const row = { change: key, started_at: iso(now), from: iso(now + waitMs('notice')) };
  return {
    kind: 'started',
    row,
    said: said(data.words.delayed_started, { from: when(Date.parse(row.from)) }),
    notice: { key: `passkey-delayed:${row.started_at}`, ...NOTICE, title: data.words.delayed_title, body: said(data.words.delayed_body, { from: when(Date.parse(row.from)) }) },
  };
}

/** The words a waiting delayed change is ended with. */
export const delayedCancelledWords = () => data.words.delayed_cancelled;

/** Starting or cancelling a recovery for an account whose known passkeys are lost. `known` is the count of known passkeys,
 *  `recovery` the waiting recovery row or null, `room` noticeRoom's answer. → one of
 *    { kind: 'cancelled', said }   { kind: 'waiting', said }   { kind: 'not-needed', said }
 *    { kind: 'refused', error, status }   { kind: 'started', row, said, notice } */
export function recoverDecision({ cancel = false, known, recovery = null, room, now = Date.now() }) {
  if (cancel) return { kind: 'cancelled', said: data.words.recovery_cancelled };
  if (recovery) return { kind: 'waiting', said: said(data.words.recovery_started, { from: when(Date.parse(recovery.from)) }) };
  if (!known) return { kind: 'not-needed', said: data.words.recovery_not_needed };
  if (!room) return { kind: 'refused', error: data.words.too_many_notices, status: 429 };
  const row = { started_at: iso(now), from: iso(now + waitMs('notice')) };
  return {
    kind: 'started',
    row,
    said: said(data.words.recovery_started, { from: when(Date.parse(row.from)) }),
    notice: { key: `passkey-recovery:${row.started_at}`, ...NOTICE, title: data.words.recovery_title, body: said(data.words.recovery_body, { from: when(Date.parse(row.from)) }) },
  };
}

/** A known passkey vouches for another of the account's passkeys (invariant 1): the passkey's record is written with the
 *  known-passkey provenance, and the notice is told now. → { saved, notice, said }. */
export function vouchDecision({ row, now = Date.now() }) {
  const authority = authorityFor('known-passkey', now);
  return {
    saved: { ...row.saved, authority },
    notice: addedNotice(row.id, authority),
    said: said(data.words.vouched, { from: when(Date.parse(authority.from)) }),
  };
}

/** Whether saving a passkey of this provenance is told to the person: every one but the passkey that made the account. */
export const toldWhenAdded = by => by !== 'sign-up';

/** The notice for an added passkey; null for the sign-up passkey. */
export function addedNotice(credentialId, authority) {
  if (!toldWhenAdded(authority.by)) return null;
  const body = authority.from === null
    ? data.words.added_unvouched_body
    : said(authority.by === 'known-passkey' ? data.words.added_vouched_body : data.words.added_body, { from: when(Date.parse(authority.from)) });
  return { key: `passkey-added:${credentialId}`, ...NOTICE, title: data.words.added_title, refs: { passkey: credentialId }, body };
}

/** The notice an account is told when the operator made a passkey link for it, until `expiresAt` (ISO). */
export function linkForNotice(userId, expiresAt) {
  return { key: `passkey-link-for:${userId}:${expiresAt}`, ...NOTICE, title: data.words.link_for_title, body: said(data.words.link_for_body, { until: when(Date.parse(expiresAt)) }) };
}
