// harness/hook-run-receipt.mjs
//
// PURPOSE
//   Every payload hook script leaves one receipt of its own run, so setup (harness/setup.mjs) sees a hook that runs from
//   any hook runner: the host's own settings, setup's dispatcher, or a runner of the person's own that setup cannot read
//   (a chain of guards in another repository, say). Setup then counts a hook another runner already runs as installed
//   and never writes it a second time, so no hook fires twice. A receipt names the event, the script, its arguments
//   (the harness written as {harness}), the hash of the script that ran, when, its exit code and whether setup's own
//   dispatcher ran it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A receipt never holds the hook's input, a transcript, a prompt or the person's words: only the fields above.
//   2. Keeping a receipt never changes what the hook does or answers; a failure to keep one is ignored.
//   3. Nothing here names a harness: it is the --harness argument when that names a host of setup.json, else the host of
//      setup.json whose folder holds the event's transcript; a run whose harness is unknown leaves no receipt.
//   4. One receipt per event, script, arguments and route, replaced by its next run, so receipts never grow.
//

import { randomUUID } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const setup = JSON.parse(readFileSync(join(HERE, 'setup.json'), 'utf8'));
const hash = value => bytesToHex(blake3(typeof value === 'string' ? new TextEncoder().encode(value) : value));
const expand = (path, home) => path.replace(/^~(?=\/|$)/, home);

/** Set by setup's dispatcher on the hook it runs, so its runs are told apart from every other runner's. */
export const SETUP_ROUTE = 'TRILLION_SETUP_HOOK';
export const RECEIPT_SCHEMA = 'trillion.harness-hook-run/v1';

/** The host of setup.json this hook ran under (invariant 3), or null. */
export function hookHarness(event, argv, { home = homedir(), env = process.env, rules = setup } = {}) {
  const at = argv.indexOf('--harness');
  const named = at === -1 ? null : argv[at + 1];
  if (named && rules.hosts.some(host => host.id === named)) return named;
  const path = event?.transcript_path ?? event?.transcriptPath;
  if (typeof path !== 'string' || !path.trim()) return null;
  const file = resolve(expand(path, home));
  return rules.hosts.find(host => {
    const folder = env[host.home_variable] ? resolve(expand(env[host.home_variable], home)) : join(home, host.folder);
    return file.startsWith(folder + sep);
  })?.id ?? null;
}

/** Where the receipt of one event, script, argument list and route is kept (invariant 4). */
export function runPath({ home = homedir(), rules = setup, harness, event, script, args, route }) {
  const key = hash(JSON.stringify([event, script, args])).slice(0, 32);
  return join(home, rules.state_folder, 'observed', harness, 'runs', `${key}${route === 'setup' ? '.setup' : ''}.json`);
}

/** The hash a receipt names for a script's text, the same one setup compares with the payload it inspects. */
export const scriptHash = text => hash(text);

/** Keeps this run's receipt when the process exits. scriptUrl is the hook script's own import.meta.url. */
export function keepHookRunOnExit(scriptUrl, event, { argv = process.argv.slice(2), home = homedir(), env = process.env, rules = setup, now = () => new Date().toISOString(), on = process } = {}) {
  try {
    const name = event?.hook_event_name ?? event?.hookEventName;
    if (typeof name !== 'string' || !name) return false;
    const harness = hookHarness(event, argv, { home, env, rules });
    if (!harness) return false;
    const file = fileURLToPath(scriptUrl);
    const script = basename(file);
    const script_hash = scriptHash(readFileSync(file, 'utf8'));
    const args = argv.map(arg => (arg === harness ? '{harness}' : arg));
    const route = env[SETUP_ROUTE] ? 'setup' : 'other';
    const path = runPath({ home, rules, harness, event: name, script, args, route });
    on.once('exit', code => {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const part = `${path}.${randomUUID()}.part`;
        writeFileSync(part, `${JSON.stringify({ schema: RECEIPT_SCHEMA, event: name, script, args, script_hash, route, at: now(), exit_code: typeof code === 'number' ? code : 0 })}\n`, { mode: 0o600 });
        renameSync(part, path);
      } catch { /* invariant 2 */ }
    });
    return true;
  } catch { return false; }
}
