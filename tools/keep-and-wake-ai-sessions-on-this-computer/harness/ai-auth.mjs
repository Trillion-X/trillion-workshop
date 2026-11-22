// harness/ai-auth.mjs
//
// Purpose
//   The logins one AI run uses on this computer, as take-open-work.json `ai_auth` names them for that AI: a pool of
//   Claude subscription tokens (one token per run, the first free one) or a pool of Codex logins (`codex_logins`, the
//   first free one; its own private CODEX_HOME for the run, written back to the vault under its own name when the run
//   refreshed it). `codex_login` names a single login. Every login is one lock: a login is used by one
//   run at a time, so two runs never refresh the same single-use token. An AI with no `ai_auth` row uses its own
//   sign-in and nothing here runs.
//   A login that reached its usage limit rests on its own (take-open-work.mjs keeps the rest under the login's name), so a
//   run takes the first login of the pool that is neither held by another run nor resting; a login with no rest kept is
//   untested, never full, and is used. Another login of the same AI still runs while one rests.
//
// Non-negotiable invariants
//   1. A value leaves the vault only into the run's environment (a token) or the run's private folder (Codex's auth.json,
//      mode 0600 in a 0700 folder), and that folder is removed when the run ends.
//   2. A refreshed Codex login is written back to the vault before its lock is released; if the write fails the lock and
//      the folder stay (the lock goes stale and is taken back later), so the new token is never lost.
//   3. Nothing here reads a computer name: the names and the vault command come from the computer's config.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { readVaultValue, writeVaultValue } from './vault-value.mjs';
import { symlinkSync } from 'node:fs';
import { homedir } from 'node:os';

const lockName = name => name.replace(/[^A-Za-z0-9_-]/g, '_');

// A lock is a folder: mkdir is atomic, so two runs cannot both take one. A lock older than staleMs was left by a run that
// ended without releasing it; it is taken back once.
function takeLock(path, staleMs) {
  try { mkdirSync(path); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (Date.now() - statSync(path).mtimeMs <= staleMs) return false;
  rmSync(path, { recursive: true, force: true });
  try { mkdirSync(path); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

const unlock = path => rmSync(path, { recursive: true, force: true });

/** The names of the logins an AI's `ai_auth` row pools, in the order they are tried (empty for an AI on its own sign-in). */
export function loginsOf(auth) {
  if (Array.isArray(auth?.claude_token_names)) return auth.claude_token_names;
  if (Array.isArray(auth?.codex_logins)) return auth.codex_logins;
  return typeof auth?.codex_login === 'string' ? [auth.codex_login] : [];
}

/** The logins of the pool that rest at `now` (`resting`: { login: until ISO }), with the earliest reset among them. */
export function restingLogins(auth, resting = {}, now = new Date().toISOString()) {
  const logins = loginsOf(auth);
  const rest = logins.filter(name => resting?.[name] > now);
  return { logins, resting: rest, all: logins.length > 0 && rest.length === logins.length, earliest: rest.map(name => resting[name]).sort()[0] ?? null };
}

/**
 * The logins for one run of the AI `auth` describes (its `ai_auth` row). Answers { env, done, login } where env joins the
 * run's environment, done() ends the run's use of the logins (writes a refreshed login back, removes the run's folder,
 * releases the lock) and login names the login taken (null on the AI's own sign-in). A login resting at `now` is passed
 * over. Answers null when every login the AI may use is resting or in use by another run. Throws when the vault does not
 * answer; nothing is taken then.
 */
export function acquireAiAuth(auth, { folder, runId, vault, staleMs, resting = {}, now = new Date().toISOString() }) {
  if (!auth) return { env: {}, done() {}, login: null };
  const locks = join(folder, 'auth-locks');
  mkdirSync(locks, { recursive: true });
  const awake = name => !(resting?.[name] > now);
  if (Array.isArray(auth.claude_token_names)) {
    for (const name of auth.claude_token_names.filter(awake)) {
      const lock = join(locks, lockName(name));
      if (!takeLock(lock, staleMs)) continue;
      let token;
      try { token = readVaultValue(vault, name).trim(); } catch (error) { unlock(lock); throw error; }
      return { env: { [auth.claude_env ?? 'CLAUDE_CODE_OAUTH_TOKEN']: token }, done() { unlock(lock); }, login: name };
    }
    return null;
  }
  const logins = loginsOf(auth);
  if (logins.length) {
    // The first login no other run holds and none rests: one login per run, and a refreshed login goes back under its own name.
    const name = logins.filter(awake).find(login => takeLock(join(locks, lockName(login)), staleMs));
    if (!name) return null;
    const lock = join(locks, lockName(name));
    const home = join(folder, 'codex-homes', runId);
    const file = join(home, 'auth.json');
    let before;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      // The run's chats outlive the run (its login does not): `chats_folder` is where this AI keeps them, and the private
      // home's `sessions` is a link to it, so a later turn finds the chat and resumes it. Without it every Codex chat was
      // removed with its run's home: the always-on's second turn waited for a chat that no longer existed (5:09 AM CST
      // Nov 22 2026). Removing the home removes only the link.
      if (typeof auth.chats_folder === 'string' && auth.chats_folder) {
        const chats = auth.chats_folder.replace(/^~(?=\/|$)/, homedir());
        mkdirSync(chats, { recursive: true, mode: 0o700 });
        symlinkSync(chats, join(home, 'sessions'));
      }
      const text = readVaultValue(vault, name);
      writeFileSync(file, text, { mode: 0o600 });
      before = makeHashCodeHexFromBytes(Buffer.from(text));
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      unlock(lock);
      throw error;
    }
    return {
      env: { CODEX_HOME: home },
      done() {
        // Codex rewrites auth.json only when it refreshed the login; an unchanged login is not written back.
        if (existsSync(file) && makeHashCodeHexFromBytes(readFileSync(file)) !== before) writeVaultValue(vault, name, file);
        rmSync(home, { recursive: true, force: true });
        unlock(lock);
      },
      login: name,
    };
  }
  throw new Error('The AI names no login the runner knows (claude_token_names, or codex_logins / codex_login).');
}
