// tools/sign-in-build-and-hold/read-data/set-password.mjs
//
// Setting or changing the signed-in account's password. Ported from the earlier code base's setPassword route and its
// page gate in src/worker.mjs, src/passwords.mjs (passwordProblem), src/password-strength.mjs (passwordScore and
// passwordStrengthSaid) (b6ae0ebf815f), with the same order, statuses and words.
//
// Storage-free and hash-free: the caller normalises the email, counts the sign-in try for a change, checks the current
// password, reads the account's email and the other accounts that hold this email, keeps the new password (its own
// hashing), and ends the other browsers. Those are passed in as facts or as callbacks; this module only decides.
//
// NON-NEGOTIABLE INVARIANTS (kept from the earlier code base):
//   1. A recent sign-in is required; a stale one is sent to sign in again before anything else.
//   2. Changing a password asks for the current one first, and that try is counted and limited before it is checked.
//   3. The email the password signs in with must be the account's own confirmed email, and no other account may hold it.
//   4. Changing (not first setting) a password ends every other browser; the browser saving stays signed in.
//   5. A new password is one the service accepts only within the length limits, typed twice.
import settings from './set-password.json' with { type: 'json' };

export const SET_PASSWORD = settings;

const words = (key, values = {}) => settings.words[key].replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const refusal = (key, extra = {}) => ({ error: words(key, extra.values), status: settings.statuses[key], ...(extra.next ? { next: extra.next } : {}) });

/** Which refusal a new password earns (its statuses key), or null when it can be used. Lengths count characters, not bytes. */
export function passwordProblemKey(password) {
  if (typeof password !== 'string' || [...password].length < settings.min_length) return 'too_short';
  if ([...password].length > settings.max_length) return 'too_long';
  return null;
}

/** The words for a new password's refusal (`key` from passwordProblemKey), filled with the limits. */
const problemWords = key => words(key, { min: settings.min_length, max: settings.max_length });

const KINDS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];

/** How strong a new password reads as it is typed: 0 when shorter than min_length, then one point for each of 12 characters
 *  or more and for three kinds of character (lower case, upper case, digits, others). */
export function passwordScore(password) {
  const text = typeof password === 'string' ? password : '';
  if (text.length < settings.min_length) return 0;
  return 1 + (text.length >= settings.long_password_chars ? 1 : 0)
    + (KINDS.filter(kind => kind.test(text)).length >= settings.kinds_for_a_point ? 1 : 0);
}

/** The words for how strong `password` reads: the highest row at or under its score. */
export function passwordStrengthSaid(password) {
  const score = passwordScore(password);
  const row = [...settings.strength].sort((a, b) => b.score - a.score).find(entry => entry.score <= score) ?? settings.strength[0];
  return row.said.replace('{min}', String(settings.min_length));
}

/** Whether the page or the save should go to sign in again first (the same answer for a page and a save). */
const signInAgain = () => ({ error: settings.words.sign_in_again, sign_in_again: true, status: settings.statuses.sign_in_again });

/** Saving a password. Facts from the caller:
 *  - `fresh`: the browser signed in recently. `email`: the typed email, normalised, or null when it is not one.
 *  - `password`, `again`: the typed new password and its repeat (`again` is undefined when none was typed).
 *  - `kept`: whether the account already has a password.
 *  - `attempt` (only when `kept`): { waitMinutes, ownRecord, currentRight } from the caller's counted try for the current
 *    password: waitMinutes is null when the try may go on, ownRecord says the kept record is this account's, and
 *    currentRight says the typed current password checked out.
 *  - `emailConfirmed`: the account's own confirmed email is this email. `emailHeldByOther`: another account signs in with it.
 *  - `keep(password)`: async; keeps the password for this account and resolves 'kept' or 'taken'. Called only after every check.
 *  - `endOtherBrowsers()`: async; ends the other browsers. Called only when a password was already kept (a change).
 *  - `returnTo`: where to go after saving (the caller's return rule), or null for the account page.
 *  → { said, redirect } when saved, else { error, status, next? } (sign_in_again answers carry sign_in_again: true). */
export async function decideSetPassword({ fresh, email, password, again, kept, attempt = null, emailConfirmed, emailHeldByOther,
  keep, endOtherBrowsers, returnTo = null }) {
  if (!fresh) return signInAgain();
  if (!email) return refusal('not_an_email');
  const problem = passwordProblemKey(password);
  if (problem) return { error: problemWords(problem), status: settings.statuses[problem] };
  if (typeof again === 'string' && again !== password) return refusal('not_the_same');
  if (kept) {
    if (attempt.waitMinutes) return refusal('too_many', { values: { minutes: attempt.waitMinutes }, next: settings.forgot_password });
    if (!attempt.ownRecord || !attempt.currentRight) return refusal('current_wrong', { next: settings.forgot_password });
  }
  if (!emailConfirmed) return refusal('confirm_email', { next: settings.add_email });
  if (emailHeldByOther) return refusal('taken_by_other');
  if ((await keep(password)) === 'taken') return refusal('taken_by_other');
  if (kept) await endOtherBrowsers();
  return { said: words(kept ? 'changed' : 'saved'), redirect: returnTo ?? settings.default_return };
}

/** The set-password page's gate (GET): a stale sign-in goes to sign in again; an offer already passed by is sent on; an
 *  account with no confirmed email is sent to add one first. Facts from the caller:
 *  - `fresh`, `pathWithSearch` (the page's own path and query), `hasEmail` (a confirmed sign-in email exists),
 *  - `offeredPath`: where the offer was to send the person (null when this page is not an offer), and `offerWanted`
 *    (whether the device and the account still want this offer).
 *  → { redirect } for a path to go to, or { page: { changing, email, offered } } to show the page. */
export function decideSetPasswordPage({ fresh, pathWithSearch, offeredPath = null, offerWanted = false, hasEmail, kept, email }) {
  if (!fresh) return { redirect: `/sign-in?again=1&next=${encodeURIComponent(pathWithSearch)}` };
  if (offeredPath !== null && !offerWanted) return { redirect: offeredPath };
  if (!hasEmail) return { redirect: `${settings.add_email.action}?next=${encodeURIComponent(pathWithSearch)}` };
  return { page: { changing: Boolean(kept), email, offered: offeredPath } };
}
