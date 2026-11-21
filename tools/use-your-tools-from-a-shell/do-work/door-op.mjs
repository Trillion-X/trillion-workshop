#!/usr/bin/env node
// tools/use-your-tools-from-a-shell/do-work/door-op.mjs
//
// One engine call for a program on this computer (wf, a script) that is not a person typing `{cli} op`: it reads one JSON
// request on standard input and prints the answer as JSON on standard output.
//
//   {"cli":"NAME","kind":"op","method":"tools:run","input":{"tool":"tool:x","input":{}},"pins":["ID"],"request_key":"k"}
//   {"cli":"NAME","kind":"call","tool":"tool:x","input":{}}     the same as `{cli} call TOOL JSON`
//   "upload":"/full/path" (either kind) sends that file's bytes as the call's raw body, as `--upload` does
//
// `cli` is the command the person installed (its site file, written by `{cli} login`, names the door and the key this
// computer keeps for it). It is the same door, credential, retry and whole-answer path as `op` and `call` (command.mjs), run
// under the same Mac app node the installed command runs under. A refusal is written to standard error in the command's own
// words, and the exit status is the command's status. Nothing here names a store, a pin or a path of a person's own: each one
// comes in the request.
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CommandError, appNodeToRunUnder, credentialFor, doorFor, engineClient, opWhole, pinRouteOf, routeOf, siteOf, speakFor, uploadOf } from './command.mjs';

// The mark a run started again under the app's node carries (command.json env.rerun), so it never starts another.
const RERUN = JSON.parse(readFileSync(new URL('./command.json', import.meta.url), 'utf8')).env.rerun;

/** One request as the JSON object it is, or a refusal naming what it should hold. */
export function requestOf(text) {
  let request;
  try { request = JSON.parse(text); } catch (error) { throw new CommandError(`The request is not JSON: ${error.message}`, { status: 2 }); }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new CommandError('The request is one JSON object.', { status: 2 });
  if (typeof request.cli !== 'string' || !request.cli) throw new CommandError('A request names the command it runs as (its "cli").', { status: 2 });
  if (request.kind !== 'op' && request.kind !== 'call') throw new CommandError('The request kind is "op" or "call".', { status: 2 });
  if (request.kind === 'op' && (typeof request.method !== 'string' || !request.method)) throw new CommandError('An "op" request names its method.', { status: 2 });
  if (request.kind === 'call' && (typeof request.tool !== 'string' || !request.tool)) throw new CommandError('A "call" request names its tool.', { status: 2 });
  return request;
}

/** The answer of one request, as `op` or `call` would print it: a string as it is, anything else as indented JSON. */
export async function doorAnswer(request, { fetchImpl = fetch } = {}) {
  speakFor(siteOf({ invoked: request.cli }));
  const credential = await credentialFor({ fetchImpl });
  if (!credential) throw new CommandError('No sign-in or key is kept on this computer for this command: run its login first.', { status: 3 });
  const door = doorFor({ credential });
  const client = engineClient({ door, credential, fetchImpl });
  const requestKey = request.request_key ?? randomUUID();
  const upload = uploadOf(request.upload);
  const answer = request.kind === 'call'
    ? await opWhole(client, null, 'tools:run', { tool: request.tool, input: request.input ?? {} }, { requestKey, route: await routeOf(client, request.tool), upload })
    : await opWhole(client, request.address ?? null, request.method, request.input ?? {}, { requestKey, route: pinRouteOf({ pin: request.pins }), upload });
  return typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2);
}

const startedAsProgram = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (startedAsProgram) {
  const request = readFileSync(0, 'utf8');
  // The engine on this computer admits only code the Mac app signed, so a shell's own node runs this program again under the app's.
  const appNode = appNodeToRunUnder();
  if (appNode !== null) {
    const again = spawnSync(appNode, process.argv.slice(1), { input: request, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, [RERUN]: '1' } });
    process.exit(again.status ?? 1);
  }
  doorAnswer(requestOf(request)).then(text => { process.stdout.write(`${text}\n`); }, error => {
    const known = error instanceof CommandError;
    process.stderr.write(`${known ? error.message : `door-op: ${error.stack ?? error}`}\n`);
    process.exitCode = known ? error.status : 1;
  });
}
