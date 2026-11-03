// tools/register-trillion-in-my-ai-apps/do-work/config-file.mjs
//
// Moved from Trillion-X/trillion harness/config-file.mjs.
//
// Purpose
//   The one checked writer for another program's configuration file (an AI harness's hooks or MCP servers), used by
//   ./mcp-registration.mjs (MCP entries); the old harness/setup.mjs (hooks) used it too.
//
// Non-negotiable invariants
//   1. A symlinked config, a config another writer holds the lock on, or one changed while the write was prepared is
//      never overwritten; the earlier bytes are kept as a private backup beside it, and the write is read back.
//   2. Content identities are BLAKE3 (the declared identity owner), never SHA-256.
import { randomUUID } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => bytesToHex(blake3(typeof value === 'string' ? new TextEncoder().encode(value) : value));
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** How a config file's text is read and written: JSON by default; a text codec (TOML) hands the transform the text itself. */
export const JSON_CODEC = { empty: () => ({}), parse: text => JSON.parse(text), format: json };

/** A checked, backed-up atomic write; a concurrent editor or a symlink never gets overwritten. */
export function writeConfig(path, transform, { beforeCommit = () => {}, now = () => new Date().toISOString(), codec = JSON_CODEC } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.trillion-setup.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Another setup write owns ${lock}. Inspect that process before retrying.`); throw error; }
  let part;
  try {
    writeFileSync(lockFd, json({ pid: process.pid, started_at: now() }));
    if (stat(path)?.isSymbolicLink()) throw new Error('The host config is a symbolic link. Its target must be reviewed before changing it.');
    const original = read(path);
    const parsed = original === null ? codec.empty() : codec.parse(original);
    const next = transform(parsed);
    if (JSON.stringify(parsed) === JSON.stringify(next)) return { changed: false, path };
    const body = codec.format(next);
    part = `${path}.trillion-${randomUUID()}.part`;
    const file = openSync(part, 'wx', original === null ? 0o600 : lstatSync(path).mode & 0o777);
    try { writeFileSync(file, body); fsyncSync(file); } finally { closeSync(file); }
    beforeCommit();
    if (stat(path)?.isSymbolicLink() || read(path) !== original) throw new Error('The host config changed during setup. Nothing was overwritten; retry with its current settings.');
    const backup = original === null ? null : `${path}.trillion-backup-${now().replace(/[:.]/g, '-')}-${hash(original).slice(0, 12)}`;
    if (backup && read(backup) !== original) writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    renameSync(part, path); part = null;
    if (read(path) !== body) throw new Error('The host config readback did not match the written settings. Read its current state before retrying.');
    return { changed: true, path, backup, before_blake3: original === null ? null : hash(original), after_blake3: hash(body) };
  } finally {
    if (part) try { unlinkSync(part); } catch {}
    closeSync(lockFd); unlinkSync(lock);
  }
}

