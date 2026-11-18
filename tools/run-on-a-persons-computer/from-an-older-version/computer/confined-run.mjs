// computer/confined-run.mjs
//
// Purpose: one way to run a program on this Mac so it can do only what its job needs. The caller names a tier (read
// only, workspace, workspace with network); this file writes a Seatbelt profile for it, starts the program under
// sandbox-exec with only the environment names allowed, and, when the caller pins the program, checks the program first.
//
// Non-negotiable invariants
//   1. Tiers, credential folders, the environment allowlist and every word are DATA (computer/confined-run.json); this
//      file names no program, folder or service.
//   2. The profile starts from allow-default and subtracts: file writes outside the tier's roots, reads of the credential
//      folders, and the network when the tier says so. A tier that lists no root writes nowhere but the always-writable devices.
//   3. A secret reaches the program only as a named variable the caller passes in `scoped_env`; it is never an argument,
//      never part of the profile and never in an error. Variables not in env_allow are not inherited.
//   4. A pinned program is checked before it starts: its BLAKE3 equals the pin, and/or its signature's Team ID equals the pin;
//      a program that does not match is not started.
//   5. Paths in the profile are real paths (links resolved), so a link cannot lead a write outside its root.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const confinementSettings = () => JSON.parse(readFileSync(join(HERE, 'confined-run.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (settings, key, values = {}, status = 403) => Object.assign(new Error(fill(settings.words[key], values)), { status });
const quote = path => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const real = path => { try { return realpathSync(path); } catch { return path; } };

/** The Seatbelt profile text for a tier: { workspace, tmp, home } fill the roots. */
export function profileFor(tier, { workspace = null, tmp, home = homedir() }, settings = confinementSettings()) {
  const values = { workspace: workspace ?? '', tmp };
  const roots = [...tier.writable.map(root => fill(root, values)).filter(Boolean).map(real), ...settings.always_writable];
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  if (roots.length) lines.push(`(allow file-write* ${roots.map(root => root.startsWith('/dev/') ? `(literal ${quote(root)})` : `(subpath ${quote(root)})`).join(' ')})`);
  const credentials = settings.credential_folders.map(folder => real(folder.replace(/^~(?=\/|$)/, home)));
  if (credentials.length) lines.push(`(deny file-read* file-write* ${credentials.map(folder => `(subpath ${quote(folder)})`).join(' ')})`);
  if (tier.network !== true) lines.push('(deny network*)');
  return lines.join('\n');
}

const teamOf = async (program, settings) => {
  try {
    const { stderr } = await run(settings.codesign_program, ['-dv', '--verbose=2', program]);
    return /TeamIdentifier=(\S+)/.exec(String(stderr))?.[1] ?? null;
  } catch (error) { return /TeamIdentifier=(\S+)/.exec(String(error.stderr ?? ''))?.[1] ?? null; }
};

/** Refuses a program that does not match its pin ({ blake3?, team? }). */
export async function checkPin(program, pin, settings = confinementSettings()) {
  if (!pin) return;
  if (pin.blake3 && bytesToHex(blake3(readFileSync(program))) !== pin.blake3) throw refusal(settings, 'pin_blake3', { program });
  if (pin.team && await teamOf(program, settings) !== pin.team) throw refusal(settings, 'pin_team', { program, team: pin.team });
}

/**
 * Runs `command args` confined to `tier`. → { stdout, stderr, profile }. Rejects with the program's own error, or a refusal.
 * options: tier (id), workspace, scoped_env ({ NAME: value }), pin, timeout_ms, cwd, home, settings.
 */
export async function runConfined(command, args = [], { tier: tierId, workspace = null, scoped_env = {}, pin = null, timeout_ms = 60000, cwd = workspace ?? undefined, home = homedir(), settings = confinementSettings() } = {}) {
  const tier = settings.tiers.find(row => row.id === tierId);
  if (!tier) throw refusal(settings, 'unknown_tier', { tier: tierId }, 400);
  if (!existsSync(settings.sandbox_program)) throw refusal(settings, 'no_sandbox', {}, 501);
  await checkPin(command, pin, settings);
  const tmp = real(mkdtempSync(join(tmpdir(), 'trillion-confined-')));
  const profile = profileFor(tier, { workspace, tmp, home }, settings);
  const env = Object.fromEntries(settings.env_allow.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(env, scoped_env, { TMPDIR: tmp });
  const { stdout, stderr } = await run(settings.sandbox_program, ['-p', profile, command, ...args], { env, cwd, timeout: timeout_ms, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: String(stdout), stderr: String(stderr), profile };
}
