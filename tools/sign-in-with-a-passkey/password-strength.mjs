// src/password-strength.mjs
// How strong a new password reads as it is typed, in the words of src/passwords.json `strength`. The sign-in pages'
// script (src/client/passkey.mjs) writes it under the new password's box; nothing is sent anywhere.
//
// Non-negotiable invariants
//   1. Score 0 is shorter than min_length, the one rule the service refuses on; each of 12 characters or more, and
//      three kinds of character (lower case, upper case, digits, others), adds one.
//   2. The words are DATA: a row for each score, and the highest row at or under the score is said.
//
import settings from './passwords.json' with { type: 'json' };

const KINDS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];

export function passwordScore(password, min = settings.min_length) {
  const text = typeof password === 'string' ? password : '';
  if (text.length < min) return 0;
  return 1 + (text.length >= 12 ? 1 : 0) + (KINDS.filter(kind => kind.test(text)).length >= 3 ? 1 : 0);
}

/** The words for how strong `password` is. */
export function passwordStrengthSaid(password) {
  const score = passwordScore(password);
  const row = [...settings.strength].sort((a, b) => b.score - a.score).find(entry => entry.score <= score) ?? settings.strength[0];
  return row.said.replace('{min}', String(settings.min_length));
}
