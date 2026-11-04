// harness/account-key.mjs
//
// PURPOSE
//   The one place a program on a person's computer reads the account key (the personal key the Mac app and `trillion login`
//   keep). About thirty programs each called `security find-generic-password` themselves, each with its own timeout and its own
//   idea of what a failure meant.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the homes the shipped code already writes (account-key.json): the Keychain item on a Mac, the 0600 file
//      `trillion login` keeps elsewhere. No other home is read here, so there is no second source of truth.
//   2. The answer says which of three things is true: `held` (the key), `absent` (the home was read and holds no key: the
//      Keychain says no such item, or the file does not exist), `unreadable` (the home could not be read: a locked or missing
//      Keychain, a refused or timed-out ask, a file anyone but its owner can read). A caller retries `unreadable`; it never
//      tells the person they have no key because of it.
//   3. The key goes to the caller in memory only. It is never in an argument, a message or a log: the Keychain is asked by
//      item name, and the reason an answer is `unreadable` is a fixed word, not the program's output.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import settings from './account-key.json' with { type: 'json' };

const expand = path => path.replace(/^~(?=\/|$)/, homedir());

/** { state: 'held', key } | { state: 'absent' } | { state: 'unreadable', reason }.
 *  `item`: the Keychain item (default account-key.json keychain_item). `keychain`: a Keychain file to ask instead of the
 *  person's search list (a test's own). `platform`, `exec`, `file`: the system, the program runner and the file home. */
export function readAccountKey({ item = settings.keychain_item, keychain = null, platform = process.platform, exec = execFileSync,
  file = settings.key_file, timeout = settings.timeout_ms } = {}) {
  if (platform === 'darwin') {
    let out;
    try {
      out = exec(settings.security_program, ['find-generic-password', '-s', item, '-w', ...(keychain ? [keychain] : [])],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout });
    } catch (error) {
      if (error?.status === settings.keychain_missing_item_status) return { state: 'absent' };
      return { state: 'unreadable', reason: error?.code === 'ETIMEDOUT' || error?.signal ? 'keychain did not answer' : 'keychain refused' };
    }
    const key = String(out).trim();
    return key ? { state: 'held', key } : { state: 'absent' };
  }
  const path = expand(file);
  let stat;
  try { stat = statSync(path); } catch (error) { return error?.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', reason: 'key file unreadable' }; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) return { state: 'unreadable', reason: 'key file is readable by others' };
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key ? { state: 'held', key } : { state: 'absent' };
  } catch { return { state: 'unreadable', reason: 'key file unreadable' }; }
}

/** The key or null, for a caller that treats both other states as "not now". Prefer readAccountKey where the person is told something. */
export const accountKeyOrNull = options => { const answer = readAccountKey(options); return answer.state === 'held' ? answer.key : null; };

/** The key, or an error saying which of the two it is: no key kept, or a key that could not be read just now (a caller may try again). */
export function requireAccountKey(options) {
  const answer = readAccountKey(options);
  if (answer.state === 'held') return answer.key;
  throw Object.assign(new Error(answer.state === 'absent' ? 'No Trillion account key is kept on this computer.' : `The Trillion account key could not be read: ${answer.reason}.`),
    { code: answer.state === 'absent' ? 'account_key_absent' : 'account_key_unreadable' });
}
