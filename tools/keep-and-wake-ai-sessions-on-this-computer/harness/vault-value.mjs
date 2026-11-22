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
//   3. A failure names the command's status and the stderr line that says why (not a startup event line); the value is
//      never in an error.
//   4. Descriptor 3 is a real pipe. Node's 'pipe' stdio is a socket pair, which the engine refuses ("descriptor 3 is not a
//      pipe"): the always-on's taker could not read its account key from 11:37 PM CST Nov 21 2026 while the same read
//      from a shell worked. The read runs as `COMMAND 3>&1 | cat` under bash with pipefail, so the shell makes the pipe.
import { spawnSync } from 'node:child_process';

const commandOf = vault => {
  const [program, ...lead] = vault?.command ?? [];
  if (typeof program !== 'string' || !program) throw new Error('The vault names no command.');
  return [program, ...lead];
};
const envOf = vault => ({ ...process.env, ...(vault.env ?? {}) });
const run = (vault, args, stdio) => {
  const [program, ...lead] = commandOf(vault);
  return spawnSync(program, [...lead, ...args], { env: envOf(vault), stdio });
};

// The line that says why: the last stderr line that is not a `<area> event=` line (an engine writes its startup events
// first), else the first line.
const whyLine = result => {
  const lines = String(result.stderr ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  return (lines.filter(line => !/^\S+ event=/.test(line)).at(-1) ?? lines[0] ?? '').slice(0, 200);
};

/** The text of one vault value. Throws, naming the status and the line that says why, when the vault does not answer. */
export function readVaultValue(vault, name) {
  const result = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', '"$@" 3>&1 1>/dev/null | cat', 'vault-read', ...commandOf(vault), 'read', name],
    { env: envOf(vault), stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || !result.stdout?.length) throw new Error(`The vault did not give ${name} (exit ${result.status}${whyLine(result) ? `: ${whyLine(result)}` : ''}).`);
  return result.stdout.toString('utf8');
}

/** Keeps the file at `path` as the vault value `name` (the engine's put, which replaces the value it holds). */
export function writeVaultValue(vault, name, path) {
  const result = run(vault, ['put', name, path], ['ignore', 'ignore', 'pipe']);
  if (result.status !== 0) throw new Error(`The vault did not keep ${name} (exit ${result.status}${whyLine(result) ? `: ${whyLine(result)}` : ''}).`);
}
