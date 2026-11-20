// harness/ai-auth.mjs
//
// Purpose
//   The logins one AI run uses on this computer, as take-open-work.json `ai_auth` names them for that AI: a pool of
//   Claude subscription tokens (one token per run, the first free one) or one Codex login (its own private CODEX_HOME
//   for the run, written back to the vault when the run refreshed it). Every login is one lock: a login is used by one
//   run at a time, so two runs never refresh the same single-use token. An AI with no `ai_auth` row uses its own
//   sign-in and nothing here runs.
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

/**
 * The logins for one run of the AI `auth` describes (its `ai_auth` row). Answers { env, done } where env joins the run's
 * environment and done() ends the run's use of the logins (writes a refreshed login back, removes the run's folder,
 * releases the lock). Answers null when every login the AI may use is in use by another run. Throws when the vault does
 * not answer; nothing is taken then.
 */
export function acquireAiAuth(auth, { folder, runId, vault, staleMs }) {
  if (!auth) return { env: {}, done() {} };
  const locks = join(folder, 'auth-locks');
  mkdirSync(locks, { recursive: true });
  if (Array.isArray(auth.claude_token_names)) {
    for (const name of auth.claude_token_names) {
      const lock = join(locks, lockName(name));
      if (!takeLock(lock, staleMs)) continue;
      let token;
      try { token = readVaultValue(vault, name).trim(); } catch (error) { unlock(lock); throw error; }
      return { env: { [auth.claude_env ?? 'CLAUDE_CODE_OAUTH_TOKEN']: token }, done() { unlock(lock); } };
    }
    return null;
  }
  if (typeof auth.codex_login === 'string') {
    const name = auth.codex_login;
    const lock = join(locks, lockName(name));
    if (!takeLock(lock, staleMs)) return null;
    const home = join(folder, 'codex-homes', runId);
    const file = join(home, 'auth.json');
    let before;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
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
    };
  }
  throw new Error('The AI names no login the runner knows (claude_token_names or codex_login).');
}
