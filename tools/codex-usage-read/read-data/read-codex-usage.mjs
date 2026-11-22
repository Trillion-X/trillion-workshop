// tools/codex-usage-read/read-data/read-codex-usage.mjs
//
// Purpose
//   tool:read-codex-usage: reads the Codex accounts' weekly usage from this computer's codex-lb door and returns the
//   provider_limits rows for them (account labels, percentages, reset times, read time). Names and numbers only: no
//   key, no token, no email. Runs as a computer row through run-a-function.mjs, with local_ports from the computer.
//
// Non-negotiable invariants
//   1. The door is named (codex-lb); its port is the one this computer reports, never guessed. No port, no read: the
//      answer says so in words.
//   2. Only GET /api/accounts is called. /v1/usage is not used; no vault value is read.

import { readCodexLimits } from './codex-limits.mjs';

/** tool:read-codex-usage: { local_ports } in, { rows } or { error } out. */
export async function readCodexUsage(handed = {}) {
  const port = handed?.local_ports?.['codex-lb'];
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'This computer does not report a codex-lb door, so no usage was read.' };
  try {
    return { rows: await readCodexLimits(`http://127.0.0.1:${port}`) };
  } catch (error) {
    return { error: `codex-lb did not answer usage (${error.message}).` };
  }
}
