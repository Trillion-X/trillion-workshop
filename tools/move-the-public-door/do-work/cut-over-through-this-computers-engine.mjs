// tools/move-the-public-door/do-work/cut-over-through-this-computers-engine.mjs
//
// Runs tool:cut-a-hostname-over-to-a-new-address's own function (door-tools.mjs cutAHostnameOver) on the person's computer
// for a DNS description reached through the engine (transport "engine", e.g. tools/start-a-computer/providers/namecheap.json):
// such a description holds no key, and each of its requests is one engine tools:run of a remote MCP tool, which a tool
// container has no way to ask for. Here the engine call is this computer's own engine command (`<ENGINE_COMMAND> op tools:run`), so the engine signs in
// to the person's connection and nothing here holds a credential.
//
// usage: ENGINE_COMMAND=<the engine's command on this computer> node cut-over-through-this-computers-engine.mjs < request.json
//   request: the tool's own input ({ action, hostname, address, dns, receipt? }); the answer is the tool's own answer, one line
//   of JSON on standard output. Keep the answer's receipt and hand it back as `receipt` for activate, rollback and status.
//
// Invariants:
// - A description with no `transport: "engine"` is refused: a keyed description runs as the tool itself, whose row mounts its key.
// - Each engine run goes to the engine command on standard input, never on its command line, and only the tools the description
//   declares are sent (portable-dns-cutover.mjs engineClient).
// - The command waits less than the CLI's own 120 s try, so a run is never asked twice by this runner.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cutAHostnameOver } from './door-tools.mjs';

/** One engine tools:run through this computer's engine command (ENGINE_COMMAND): `run` is { address, tool, input }, sent on standard input. */
export function engineCall(run, { spawn = spawnSync, command = process.env.ENGINE_COMMAND } = {}) {
  if (!command) throw new Error('Name the engine\'s command on this computer in ENGINE_COMMAND.');
  const done = spawn(command, ['op', 'tools:run', '-'], { input: JSON.stringify(run), encoding: 'utf8', maxBuffer: 16 << 20, timeout: 110000 });
  if (done.error || done.status !== 0) throw new Error(`The engine's tools:run of ${run.tool} did not finish (${done.error?.code ?? done.status ?? done.signal}).`);
  return JSON.parse(done.stdout);
}

/** The tool's answer for `input`, its engine requests sent through `call`. */
export async function cutOverThroughThisComputersEngine(input, { call = async run => engineCall(run) } = {}) {
  if (input?.dns?.transport !== 'engine') throw new Error('This runner is for a DNS description reached through the engine (transport "engine"); a keyed description runs as tool:cut-a-hostname-over-to-a-new-address.');
  return cutAHostnameOver(input, { call });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const answer = await cutOverThroughThisComputersEngine(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
