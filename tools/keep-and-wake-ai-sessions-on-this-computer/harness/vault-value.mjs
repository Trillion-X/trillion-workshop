// harness/vault-value.mjs
//
// Purpose
//   Reads and writes one value of this computer's vault through the command the computer's own config names (`vault.command`:
//   the engine's `secrets --computer CONFIG PERSON`, whose `read` writes the value on descriptor 3 and whose `put` takes a
//   value file). Nothing here names a computer.
//
// Non-negotiable invariants
//   1. A value is read only from the descriptor the engine writes it on (3), into memory, and returned to the caller.
//   2. A value is written only from a file the caller names (the engine's `put NAME VALUE_FILE`), never argv or stdin.
//   3. A failure names the command's status and its first stderr line only; the value is never in an error.
import { spawnSync } from 'node:child_process';

const run = (vault, args, stdio) => {
  const [program, ...lead] = vault?.command ?? [];
  if (typeof program !== 'string' || !program) throw new Error('The vault names no command.');
  return spawnSync(program, [...lead, ...args], { env: { ...process.env, ...(vault.env ?? {}) }, stdio });
};

const firstLine = result => String(result.stderr ?? '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? '';

/** The text of one vault value. Throws, naming the status and the first stderr line, when the vault does not answer. */
export function readVaultValue(vault, name) {
  const result = run(vault, ['read', name], ['ignore', 'pipe', 'pipe', 'pipe']);
  if (result.status !== 0 || !result.output?.[3]) throw new Error(`The vault did not give ${name} (exit ${result.status}${firstLine(result) ? `: ${firstLine(result)}` : ''}).`);
  return result.output[3].toString('utf8');
}

/** Keeps the file at `path` as the vault value `name` (the engine's put, which replaces the value it holds). */
export function writeVaultValue(vault, name, path) {
  const result = run(vault, ['put', name, path], ['ignore', 'ignore', 'pipe']);
  if (result.status !== 0) throw new Error(`The vault did not keep ${name} (exit ${result.status}${firstLine(result) ? `: ${firstLine(result)}` : ''}).`);
}
