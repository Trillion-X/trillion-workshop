// harness/wake-handlers/run-tools-here.mjs
//
// Purpose
//   A handler for harness/wake-sessions.mjs: runs a Workshop tool whose placement puts it on the person's own computer
//   (a run Trillion answered for_you_to_run and announced as tool.run.requested), exactly as the hosted container road
//   runs one, and hands the result back on the same road run_tool and read_task read (/tasks/<id>/answer).
//
// How
//   1. Reads the run (/tasks/<id>) and claims it; the claim answers with the tool as saved: its descriptor, who made it
//      and its code archive (a gzipped tar).
//   2. Checks the archive's BLAKE3 fingerprint is the one the Workshop saved, and puts its files side by side in a folder
//      this handler makes, keeping their paths under invoke's `at`.
//   3. Fills invoke.argv from the run's input with the service's own buildInvocation (src/workshop.mjs) and turns it into
//      text with the container road's argvText (src/repo-explorer.mjs): a JSON value becomes its JSON text.
//   4. Runs it under a macOS sandbox built from the reach the tool declares (tool-reach.mjs): its own folder and the
//      system, and nothing of the person's (files, other disks, network, microphone, camera) it did not declare. A tool
//      from another maker whose reach needs the person's approval runs only once they approved that reach for that code.
//      In the tool's workdir inside that folder; with stdout "json" the last line is the result (lastJson), in
//      the container road's shape { stdout, stderr, exit_code, result }, and the tool's result_selector picks from it.
//   5. Deletes the folder.
//
// Non-negotiable invariants
//   1. It names no tool: which runs it takes is the placement the computer's agent says it runs (helper_agent.runs).
//   2. A run already answered is left as it is.
//   3. A run is claimed (/tasks/<id>/claim) before its command runs; a run another computer claimed is left to it, so two
//      computers that both heard it never both run it.
//   4. No code runs unless its bytes hash to the saved fingerprint, and nothing runs outside the sandbox.
//
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { buildInvocation } from '../../src/workshop.mjs';
import { argvText, lastJson } from '../../src/repo-explorer.mjs';
import { untarGz } from '../../src/tar-gz.mjs';
import { approvalOf, argumentRefusal, declaredReach, fingerprintOf, interpreterRoot, sandboxProfile, sandboxed, trillionProxy } from './tool-reach.mjs';
import { egressProxy } from './egress-proxy.mjs';

const which = name => (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name)).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }) ?? null;

export const wants = ({ event, helper }) => Boolean(helper) && event.type === 'tool.run.requested' && Boolean(event.refs?.task_id);

// Where one of the tool's files goes in the private folder: its path under the invoke's `at`, never outside.
const placeIn = (folder, at, name) => {
  const inside = name.startsWith(`${at.replace(/\/$/, '')}/`) ? name.slice(at.replace(/\/$/, '').length + 1) : name.replace(/^\/+/, '');
  const path = resolve(folder, inside);
  if (!path.startsWith(`${folder}/`)) throw new Error(`The tool's file ${name} would land outside its folder.`);
  return path;
};

export async function handle({ event, helper, call, read, run, workFolder, rules, key, origin, home = homedir() }) {
  const task_id = event.refs.task_id;
  const task = await read(`/tasks/${encodeURIComponent(task_id)}`);
  if (task.state !== 'for_you_to_run') return { skipped: `the run is ${task.state}` };
  if (!helper.runs.includes(task.placement)) return { skipped: `this computer does not run ${task.placement}` };
  const claim = await call(`/tasks/${encodeURIComponent(task_id)}/claim`, { by: helper.agent_id, lease_seconds: rules.wake_timeout_seconds });
  if (!claim?.claimed) return { skipped: claim?.claimed_by ? 'another computer is running it' : `the run is ${claim?.state ?? 'not claimable'}` };
  const answer = body => call(`/tasks/${encodeURIComponent(task_id)}/answer`, body);
  const { descriptor, made_by, bytes_base64 } = claim;
  const invoke = descriptor?.invoke;
  if (invoke?.kind !== 'container' || !Array.isArray(invoke.argv)) return answer({ error: `${task.tool_id} is not a command this computer can run.` });
  const saved = typeof invoke.files === 'string' ? invoke.files : descriptor.bytes_fingerprint;
  let files = [];
  if (saved) {
    if (typeof bytes_base64 !== 'string') return answer({ error: `Trillion did not send ${task.tool_id}'s saved code with the run, so this computer runs none of it.` });
    const archive = Uint8Array.from(Buffer.from(bytes_base64, 'base64'));
    if (fingerprintOf(archive) !== saved) return answer({ error: `${task.tool_id}'s code is not the code its maker saved (${saved}), so this computer runs none of it.` });
    files = untarGz(archive, { withBytes: true });
  }
  let reach;
  try { reach = declaredReach(descriptor, { home }); } catch (error) { return answer({ error: error.message }); }
  const approval = approvalOf({ toolId: task.tool_id, madeBy: made_by, fingerprint: saved ?? null, reach, folder: resolve(home, (rules.folder ?? '~/.trillion/wake-sessions').replace(/^~\/?/, '')) });
  if (!approval.approved) return answer({ error: `${task.tool_id} asks to ${approval.asks.join(', ')}. It runs on this computer once you allow that for this tool.` });
  const folder = workFolder('tool');
  let proxy = null;
  let egress = null;
  try {
    const at = invoke.files?.package_files?.at ?? '/';
    for (const file of files) {
      const path = placeIn(folder, at, file.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes);
    }
    const workdir = invoke.workdir ? resolve(folder, relative(at, invoke.workdir)) : folder;
    if (workdir !== folder && !workdir.startsWith(`${folder}/`)) return answer({ error: `${task.tool_id}'s workdir is outside its files.` });
    const built = await buildInvocation(invoke, { input: task.input, task: { task_id, request_key: task_id }, request: true });
    const seconds = Math.max(60, (descriptor.needs?.expected_seconds ?? 60) * 10);
    const argv = argvText(built.argv);
    const refusedArgs = argumentRefusal(argv);
    if (refusedArgs) return answer({ error: refusedArgs });
    let command;
    try {
      if (reach.some(row => row.proxy === 'trillion')) proxy = await trillionProxy({ folder, origin, key });
      // The hosts every network-hosts row names go through one proxy that records each decision.
      if (reach.some(row => row.proxy === 'egress')) egress = await egressProxy({ hosts: reach.filter(row => row.proxy === 'egress').map(row => row.values.hosts) });
      const profile = sandboxProfile({ folder, reach, home, program: argv[0].includes('/') ? argv[0] : which(argv[0]), interpreter: interpreterRoot(argv[0], { home, which }) }).replaceAll('{proxy_port}', String(egress?.port ?? ''));
      command = sandboxed(argv, { folder, profile, reach, values: { socket: proxy?.socket, proxy_port: egress ? String(egress.port) : undefined } });
    } catch (error) { return answer({ error: error.message }); }
    const ran = await run(command, { cwd: workdir, timeout_ms: Math.min(seconds, rules.wake_timeout_seconds) * 1000 });
    if (ran.code !== 0) return answer({ error: `The tool exited with ${ran.code}: ${(ran.stderr || ran.stdout).trim().slice(-600)}` });
    let raw;
    try { raw = { stdout: ran.stdout, stderr: ran.stderr, exit_code: 0, ...(egress ? { egress: egress.decisions() } : {}), ...(invoke.stdout === 'json' ? { result: lastJson(ran.stdout) } : {}) }; }
    catch (error) { return answer({ error: error.message }); }
    const answered = await answer({ raw });
    return { task_id, state: answered.state, contract: answered.contract?.passed ?? null };
  } finally {
    await proxy?.close();
    await egress?.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
