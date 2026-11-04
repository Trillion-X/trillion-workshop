// tools/sign-in-with-a-passkey/judge-a-new-password.mjs
//
// How strong a new password reads, as the sign-in pages say it under the new password's box (password-strength.mjs, in
// the words of passwords.json `strength`): score 0 is shorter than min_length; each of 12 characters or more, and three
// kinds of character (lower case, upper case, digits, others), adds one. Pure: the password is judged in memory and is
// never kept, printed back or sent.
//
// Input:  { password }
// Answer: { score (0-3), said, min_length, max_length, too_long }
// Refuses: a password that is not text.
import settings from './passwords.json' with { type: 'json' };
import { passwordScore, passwordStrengthSaid } from './password-strength.mjs';

export function judgeNewPassword({ password } = {}) {
  if (typeof password !== 'string') throw new Error('Give password: the new password as text (it is judged and never kept).');
  return {
    score: passwordScore(password),
    said: passwordStrengthSaid(password),
    min_length: settings.min_length,
    max_length: settings.max_length,
    too_long: password.length > settings.max_length,
  };
}
