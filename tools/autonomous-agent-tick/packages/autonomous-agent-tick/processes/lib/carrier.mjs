/**
 * lib/carrier.mjs: the ONE carrier-address and partition resolution chain (SSOT).
 *
 * Extracted from FIFTEEN hand-copied resolvers across this package's process scripts. This is the
 * same extraction lib/template.mjs records in its own header, for the same reason: a pure function
 * duplicated across process scripts drifts. Here it already had. The copies disagreed about how
 * many links the chain has, and shipped DATA compensated for the drift by freezing an absolute host
 * path into the manifest eight times, which the package-set build forbids outright
 * (--forbidden-text "$HOME").
 *
 * WHY THIS FILE EXISTS NOW AND NOT EARLIER. Every inlined copy carries a comment saying a shared
 * import cannot resolve because the script "runs as a stored-bytes compute.process (a SINGLE
 * mounted file)". That is stale, and it blocked this extraction twice. The engine's
 * materialize_input_create_only (architect/crates/process-engine/src/native_process.rs:557) splits
 * a mount_path into components and mkdirat's every component except the last, tolerating EEXIST,
 * then descends with openat. So a mount_path of "lib/carrier.mjs" creates a real lib/ directory in
 * the job root and writes this file beside the process. A relative import resolves.
 *
 * A source comment is evidence about what its author believed, never evidence about what the
 * engine does. Anything asserting engine behaviour is a question to go answer, not an answer.
 *
 * PRECEDENCE, and the order is the whole point:
 *   1. BITFIELD_TARGET_CARRIER_URL           an explicit address the installer chose
 *   2. BITFIELD_TARGET_CARRIER_URL_FILE      the PATH of the file the runtime publishes into
 *   3. BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS the ambient address the runtime supplies
 *   4. PORT                                  last resort, loopback on a port we were handed
 *
 * Link 2 exists because a supervisor entry is written once and frozen, while a runtime that picks
 * its port at startup has an address that changes every time it starts. The supervisor is given the
 * PATH, which does not change, rather than the address, which does. Nothing is searched for: the
 * path arrives as DATA exactly as the URL does. Freezing WHICH file is the defect; naming the
 * variable is correct.
 *
 * Zero package awareness, zero domain vocabulary. Reads the environment and one file.
 */
import { readFileSync } from 'node:fs';

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/** Link 2 alone. An absent or unreadable file is not an error: the runtime is not up yet. */
export function currentAddressFromFile(env = process.env, options = {}) {
  const file = nonEmpty(env.BITFIELD_TARGET_CARRIER_URL_FILE);
  if (!file) return null;
  const read = options.readFileSync ?? readFileSync;
  try {
    return nonEmpty(read(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The full chain. Returns null rather than a default, so each caller states its own consequence. */
export function resolveCarrier(env = process.env, options = {}) {
  const port = nonEmpty(env.PORT);
  return nonEmpty(env.BITFIELD_TARGET_CARRIER_URL)
    || currentAddressFromFile(env, options)
    || nonEmpty(env.BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS)
    || (port ? `http://127.0.0.1:${port}` : null);
}

/** Which partition these processes read and write. Same shape, same null-not-default rule. */
export function resolvePartition(env = process.env) {
  return nonEmpty(env.BITFIELD_DISPATCH_PARTITION) || nonEmpty(env.BITFIELD_PARTITION);
}

/**
 * The ONE fail-closed message. It was duplicated eleven times, and every copy named
 * BITFIELD_TARGET_CARRIER_URL as if it were the only source, which sends a reader to set a variable
 * they do not need while the one the runtime already supplies sits unread. A diagnostic that names
 * one of four inputs is worse than none.
 */
export const CARRIER_AND_PARTITION_REQUIRED =
  'A carrier address and a partition are required. The address comes from '
  + 'BITFIELD_TARGET_CARRIER_URL, or the file named by BITFIELD_TARGET_CARRIER_URL_FILE, or the '
  + 'runtime ambient BITFIELD_SHELL_PUBLISHED_HTTP_ADDRESS, or PORT. The partition comes from '
  + 'BITFIELD_DISPATCH_PARTITION or BITFIELD_PARTITION.';
