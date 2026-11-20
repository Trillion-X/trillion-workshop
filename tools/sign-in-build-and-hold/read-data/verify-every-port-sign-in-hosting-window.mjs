// tools/sign-in-build-and-hold/read-data/verify-every-port-sign-in-hosting-window.mjs
//
// The hosting app's own browser window as a session of the account. The window signs in by a token; its session row is
// keyed by the hash of that token (the caller makes the hash, with the BLAKE3 owner, and passes the id in). Ported from
// the earlier Rust code base's src/account/sign_in/sessions.rs (commit 2b8b821a4): start_window, window_live and
// renew_if_due. There is no earlier JavaScript counterpart.
//
// Storage-free and clock-free: `row` is the stored session row (or null when none is stored), `now` is ms, and
// `sessionSeconds` is the account's session length (null when the account has no settings row). Every function answers a
// new value; the caller writes what it is told to write.
//
// Invariants (kept from the earlier code base):
// - A row is live only for the account it was started for; another account's row is never this window's.
// - A row past its expiry, or none, is not live: a removed or expired window refuses at the next check.
// - A live row slides: when it was last renewed more than `renew_after_seconds` before `now`, it is renewed and its expiry
//   moves to `now` plus the account's session length. With no settings row it does not slide: its expiry stays as it is.
// - Starting the window keeps a row that is still live and makes a new one otherwise, so a new start replaces an expired
//   row.
import settings from './verify-every-port-sign-in-hosting-window.json' with { type: 'json' };

export const RENEW_AFTER_MS = settings.renew_after_seconds * 1000;
export const WINDOW_METHOD = settings.method;

/** When a session of `seconds` made or renewed at `now` (ms) expires (ms). */
export const expiry = (now, seconds) => now + seconds * 1000;

/** `row` slid to `now` when it is due: renewed, with its expiry moved by the account's session length. A row that is not
 *  due, or an account with no session length (`sessionSeconds` null), is answered as it stands. */
export function renewIfDue(row, now, sessionSeconds) {
  if (now - row.value.renewed_at <= RENEW_AFTER_MS || sessionSeconds === null || sessionSeconds === undefined) return row;
  return { ...row, expires_at: expiry(now, sessionSeconds), value: { ...row.value, renewed_at: now } };
}

/** Whether the window whose session row is `row` is live for `account` at `now`. → { live, row } where `row` is the row
 *  as it stands after any sliding (the caller stores it when it changed). */
export function windowLive({ row, account, now, sessionSeconds }) {
  if (!row || row.account !== account || !(row.expires_at > now)) return { live: false, row: row ?? null };
  return { live: true, row: renewIfDue(row, now, sessionSeconds) };
}

/** Starting the window for `account` under session id `id` at `now`. → { keep, row }: `keep` is true when a live row was
 *  kept as it is (slid when due), false when `row` is a new row the caller stores in its place. An account with no session
 *  length cannot start a window: that is a refusal, not a guess. */
export function startWindow({ row, account, id, now, sessionSeconds }) {
  if (sessionSeconds === null || sessionSeconds === undefined) throw new Error('This account has no session length, so a window cannot start.');
  const live = windowLive({ row, account, now, sessionSeconds });
  if (live.live) return { keep: true, row: live.row };
  return {
    keep: false,
    row: { id, account, expires_at: expiry(now, sessionSeconds), value: { method: WINDOW_METHOD, created_at: now, renewed_at: now } },
  };
}
