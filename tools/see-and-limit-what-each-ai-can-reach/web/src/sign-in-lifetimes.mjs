// src/sign-in-lifetimes.mjs
//
// How long one of a person's sign-ins may go unused before it stops working. A sign-in approved in a weaker way gets a
// shorter idle lifetime: src/sign-in-lifetimes.json maps how it was approved (`approved_by` in its props: a passkey,
// a browser signed in by password or emailed code, a personal key that connected an app, a personal key itself) to its
// days, and an approval this service did not record reads as `unknown`. The person may choose another lifetime for
// each AI on its Account & security row, up to `most_days`; that choice is kept in their store
// (PersonStore.chooseSignInIdle) and applies on the sign-in's next request, where PersonStore.authorizeSignIn ends a
// sign-in unused past its lifetime and closes everything it opened.
//
// Invariants:
// - A sign-in with no recorded use yet has used nothing up: its clock starts at its first request after this ships.
// - A new way of approving is one row of DATA; nothing here names one.
import settings from './sign-in-lifetimes.json' with { type: 'json' };

const DAY_MS = 86_400_000;
export const SIGN_IN_LIFETIMES = settings;

/** The idle days a sign-in gets: the person's choice when they made one, else its approval's row, else `unknown`. */
export function idleDaysOf(approvedBy, chosen = null) {
  if (settings.never_idle.includes(approvedBy)) return Infinity;
  if (Number.isInteger(chosen) && chosen >= 1 && chosen <= settings.most_days) return chosen;
  return settings.idle_days_by_approval[approvedBy] ?? settings.idle_days_by_approval.unknown;
}

/** Whether a sign-in last used at `lastUsed` (ISO, or null for never recorded) has gone unused past `days`. */
export const unusedPast = (lastUsed, days, now = Date.now()) => Boolean(lastUsed) && now - Date.parse(lastUsed) > days * DAY_MS;

/** Whether a sign-in's use should be written again: never written, or written longer ago than the noting interval. */
export const useWorthNoting = (lastUsed, now = Date.now()) => !lastUsed || now - Date.parse(lastUsed) >= settings.use_noted_every_seconds * 1000;

/** A person's choice, checked: one of the offered day counts, or an error in their words. */
export function chosenDays(value) {
  const days = Number(value);
  if (!settings.choices_days.includes(days)) throw new Error(`Choose one of ${settings.choices_days.join(', ')} days.`);
  return days;
}

/** The words for a lifetime of `days`. */
export const daysWords = days => (days === 1 ? settings.words.choice_one : settings.words.choice.replace('{days}', String(days)));
