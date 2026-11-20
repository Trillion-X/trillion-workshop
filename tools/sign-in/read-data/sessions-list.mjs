// tools/sign-in-build-and-hold/read-data/sessions-list.mjs
//
// The account's signed-in browsers: the list the Account & security screen shows, and ending one. Ported from the earlier
// code base's src/screen-reads.mjs (accountSecurityFacts: this browser first, then newest; the day each was signed in)
// and src/account-routes.mjs (account/sessions/end) (b6ae0ebf815f), with the same words.
//
// Storage-free: the caller reads each session record, whether this session's entry exists, and the guarded-change answer
// for ending another browser (passed in, not copied). The caller forgets the session when the answer says `forget`.
//
// NON-NEGOTIABLE INVARIANTS (kept from the earlier code base):
//   1. The list shows only the account's own browsers, this browser first, then newest, each with its day and device only.
//   2. Ending a browser that is already gone is refused as gone (404), before anything else is checked.
//   3. Ending another browser needs a recent sign-in and the guarded-change answer; this browser signing itself out needs
//      neither. A session's cookie is never listed.
import settings from './sessions-list.json' with { type: 'json' };

export const SESSIONS_LIST = settings;

/** The day a sign-in was made, in words ("Nov 20, 2026"); null when the time is not an ISO date. */
export const dayWords = iso => (typeof iso === 'string' && iso.length >= 10
  ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);

const newestFirst = (a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));

/** The rows the screen shows: `sessions` are { id, device, created_at } for the account's own browsers; `currentSignIn`
 *  is the sign-in asking (session:<id>), so the one browser that is this one is marked. This browser first, then newest. */
export function sessionRows({ sessions, currentSignIn = null }) {
  return sessions
    .map(session => ({ session, current: `session:${session.id}` === currentSignIn }))
    .sort((a, b) => Number(b.current) - Number(a.current) || newestFirst(a.session, b.session))
    .map(({ session, current }) => ({
      id: session.id, device: session.device ?? null, signed_in_day: dayWords(session.created_at), current,
    }));
}

/** What ending one browser answers.
 *  - `sessionId`: the id asked to end. `currentSessionId`: the id of the browser asking.
 *  - `entryExists`: whether the account still lists that browser.
 *  - `fresh`: whether the asking browser signed in recently enough.
 *  - `wayInRefusal`: the guarded-change refusal for ending another browser (null when it may go).
 *  → { forget, said, refresh } when it may go; { said, redirect } when a sign-in is needed; else { error, status }. */
export function decideEndSession({ sessionId, currentSessionId, entryExists, fresh, wayInRefusal = null }) {
  const id = String(sessionId ?? '');
  if (!entryExists) return { error: settings.words.gone, status: settings.statuses.gone };
  if (id !== currentSessionId) {
    if (!fresh) return { said: settings.words.sign_in_again, redirect: `/sign-in?again=1&next=${encodeURIComponent(settings.sign_in_again_path)}` };
    if (wayInRefusal) return wayInRefusal;
  }
  return { forget: id, said: settings.words.signed_out, refresh: true };
}
