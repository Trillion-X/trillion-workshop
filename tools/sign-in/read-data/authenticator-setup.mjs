// tools/sign-in-build-and-hold/read-data/authenticator-setup.mjs
//
// Setting up the ways an account signs in besides its passkeys: new backup codes, and an authenticator app's first right
// code. Ported from the earlier code base's src/sign-in-methods.mjs (b6ae0ebf815f): the generation of codes, their
// reading form, the setup's wait, the first-code rule, the tries and the words.
//
// Storage-free and clock-free: the caller reads the storage (the earlier code kept codes as hashes, and the setup's
// secret with its expiry), counts the tries, checks a one-time code, and passes the answers in. This module decides.
//
// Invariants (kept from the earlier code base):
// - Making new backup codes ends every older one: the caller drops the old set when it stores the new one. The codes are
//   shown once, in the form `formatBackupCode` gives, and each signs in once (the caller keeps only their hashes).
// - Adding or changing a way in is allowed only for a sign-in that is fresh (`isFreshSignIn`).
// - An authenticator app is on only after its setup's first right code. A setup waits `setup_minutes` for that code, and
//   after it is ended, a new setup starts a new secret.
// - Each time step signs in once: the caller keeps the step the setup's first code used (`step` in the result).
//
// Dropped from the earlier code: the issuer label (named by the wiring owner, not here), the sign-in tries per address
// and per email, the backup-code sign-in and the authenticator sign-in (they are sign-in, not setup), the code hashes
// (storage), and the TOTP arithmetic (the caller passes `checkStep`, the one time code check).
import settings from './authenticator-setup.json' with { type: 'json' };

export const BACKUP_CODES = settings.backup_codes;
export const AUTHENTICATOR = settings.authenticator;

const MINUTE_MS = 60_000;
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const codeLength = () => BACKUP_CODES.groups * BACKUP_CODES.group_length;

/** A typed backup code in the one form it is kept by: lower case, without spaces or dashes. */
export const normalBackupCode = typed => (typeof typed === 'string' ? typed.toLowerCase().replace(/[^a-z0-9]/g, '') : '');

/** The code as the person reads it: groups of `group_length` characters joined by dashes (abcd-efgh-jkmn). */
export function formatBackupCode(code) {
  return code.match(new RegExp(`.{${BACKUP_CODES.group_length}}`, 'g')).join('-');
}

/** One code of the form the person reads, unbiased: each character is a random byte below the largest multiple of the
 *  alphabet's length. `random(n)` answers n random bytes as a Uint8Array. */
function randomCode(random) {
  const letters = BACKUP_CODES.alphabet;
  const below = Math.floor(256 / letters.length) * letters.length;
  const length = codeLength();
  let code = '';
  while (code.length < length) {
    for (const byte of random(new Uint8Array(length * 2))) if (byte < below && code.length < length) code += letters[byte % letters.length];
  }
  return code;
}

/** A new set of backup codes: [{ code, shown }] where `code` is the normal form the caller keeps as a hash and `shown`
 *  the form the person reads. Making them ends every older set; the caller does that when it stores this one. */
export function newBackupCodes(random) {
  return Array.from({ length: BACKUP_CODES.count }, () => {
    const code = randomCode(random);
    return { code, shown: formatBackupCode(code) };
  });
}

/** Whether a way in may be added or changed by a sign-in made `createdAt` (ISO text) with method `method`, at `now` (ms).
 *  A phone sign-in never may. */
export const isFreshSignIn = ({ method, created_at: createdAt } = {}, now = Date.now()) =>
  method !== 'phone' && now - Date.parse(createdAt ?? '') <= settings.fresh_minutes * MINUTE_MS;

/** The words a person reads when new backup codes are made: the count, and that they are kept away from the device. */
export const backupRevealWords = () => ({
  label: fill(settings.words.backup_reveal, { count: BACKUP_CODES.count }),
  note: settings.words.backup_made,
});
export const backupRemovedWords = () => settings.words.backup_removed;

/** When an authenticator setup begun at `now` (ms) stops waiting for its first right code (ms). */
export const authenticatorSetupEnds = now => now + AUTHENTICATOR.setup_minutes * MINUTE_MS;

/** The first right code turns a setup into the account's authenticator. `waiting` says the setup is still waiting at
 *  `now` (its `ends` time, ms, is after `now`); `waitMinutes` is the wait the caller's count gave (0 when the setup may
 *  try); `checkStep(code)` answers the time step the code matches, or null when it matches none.
 *  → { outcome: 'ended' } | { outcome: 'wait', wait_minutes } | { outcome: 'wrong' } | { outcome: 'on', step } */
export function finishAuthenticatorSetup({ ends, now, waitMinutes = 0, code, checkStep }) {
  if (!(ends > now)) return { outcome: 'ended' };
  if (waitMinutes) return { outcome: 'wait', wait_minutes: waitMinutes };
  const step = checkStep(code);
  if (step === null || step === undefined) return { outcome: 'wrong' };
  return { outcome: 'on', step };
}

/** The words for the answer finishAuthenticatorSetup gave. */
export function authenticatorSetupWords(answer) {
  switch (answer.outcome) {
    case 'on': return settings.words.authenticator_on;
    case 'wrong': return settings.words.authenticator_wrong;
    case 'ended': return settings.words.authenticator_setup_ended;
    case 'wait': return fill(settings.words.authenticator_too_many, { minutes: answer.wait_minutes });
    default: throw new Error(`No words for the authenticator setup answer ${answer.outcome}.`);
  }
}

export const authenticatorRemovedWords = () => settings.words.authenticator_removed;
export const signInAgainWords = () => settings.words.sign_in_again;
