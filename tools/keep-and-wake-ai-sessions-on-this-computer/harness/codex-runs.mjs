// harness/codex-runs.mjs
//
// A fresh Codex run on this computer, started, read and cancelled by the keep-and-wake helper. It is the Codex side of
// the served session contract (the engine's src/tool_runs/tools/sessions.rs: start, read {run, after}, cancel); the
// Claude path stays in wake-sessions.mjs and is not changed here.
//   startCodexRun({ folder, message })         -> { run, folder, state: 'running' }
//   readCodexRun({ run, after?, most? })        -> { run, state, exit_code?, written, from, next, output }
//   await cancelCodexRun({ run })               -> { run, state, cancelled }
//
// The CLI form is codex-cli 0.167.1's own `codex exec --help`: `codex exec --json --skip-git-repo-check -C <folder>
// -o <reply file> -`, where `-` reads the instructions from standard input and `--json` prints one event per line
// (the same stream harness/wake-sessions.json reads for a resumed run). The message goes in a file in the run's own
// folder, never on the command line. Codex uses the person's own login from its own home folder; nothing here reads,
// writes or copies a credential.
//
// Each run is one detached `sh` (the process group leader) that runs codex, writes its exit code to exit.txt, and is
// the only process a cancel signals. A run is `running` only while that shell is alive and is the same process that
// was started (its start time is kept); a shell that ends without exit.txt is `cancelled` after a cancel, else `ended`.
// Runs live under `root`: a codex-runs folder in the helper's folder (wake-sessions.json `folder`); tests pass their own root.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The helper's folder is the `folder` row of wake-sessions.json (read there, never named in code).
const helperFolder = JSON.parse(readFileSync(new URL('./wake-sessions.json', import.meta.url), 'utf8')).folder;
export const defaultRoot = join(helperFolder.replace(/^~(?=\/|$)/, homedir()), 'codex-runs');
const RUN = /^codex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MOST_BYTES = 8 * 1024 * 1024;
// $1 folder, $2 reply file, $3 message file, $4 output file, $5 exit file. The exit code is written by rename, so a
// reader never sees half of it.
const WRAPPER = 'codex exec --json --skip-git-repo-check -C "$1" -o "$2" - < "$3" >> "$4" 2>&1; status=$?; echo $status > "$5.part" && mv "$5.part" "$5"';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const runFolder = (root, run) => {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('A run id is codex- followed by a UUID.');
  return join(root, run);
};
const readRecord = folder => {
  const path = join(folder, 'state.json');
  if (!existsSync(path)) throw new Error('No such run.');
  return JSON.parse(readFileSync(path, 'utf8'));
};
const writeRecord = (folder, record) => {
  const part = join(folder, `state.json.${process.pid}.part`);
  writeFileSync(part, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(part, join(folder, 'state.json'));
};
const startTimeOf = pid => {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; } catch { return null; }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The state of a run from its files and its shell process, never from a remembered guess.
function stateOf(folder) {
  const record = readRecord(folder);
  const exit = join(folder, 'exit.txt');
  if (existsSync(exit)) return { state: 'exited', exit_code: Number(readFileSync(exit, 'utf8').trim()) };
  if (alive(record.pid) && startTimeOf(record.pid) === record.started) return { state: 'running' };
  return { state: record.cancel_requested_at ? 'cancelled' : 'ended' };
}

export function startCodexRun({ folder, message, root = defaultRoot }) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('The message is needed.');
  let here;
  try { here = realpathSync(folder); } catch { throw new Error(`The folder ${folder} does not exist.`); }
  if (!statSync(here).isDirectory()) throw new Error(`${folder} is not a folder.`);
  const run = `codex-${randomUUID()}`;
  const dir = join(root, run);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'message.txt'), message, { mode: 0o600 });
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'sh', here, join(dir, 'reply.txt'), join(dir, 'message.txt'), join(dir, 'output.jsonl'), join(dir, 'exit.txt')], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
  if (!child.pid) throw new Error('Codex did not start.');
  writeRecord(dir, { run, folder: here, pid: child.pid, started: startTimeOf(child.pid), started_at: new Date().toISOString() });
  return { run, folder: here, state: 'running' };
}

// The longest prefix of `bytes` that ends on a whole UTF-8 character (a window may end inside one).
function wholeUtf8Length(bytes) {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

export function readCodexRun({ run, after = 0, most = 65536, root = defaultRoot }) {
  const dir = runFolder(root, run);
  const status = stateOf(dir);
  const output = join(dir, 'output.jsonl');
  const written = existsSync(output) ? statSync(output).size : 0;
  const from = Math.min(Math.max(0, Math.floor(after) || 0), written);
  const want = Math.min(Math.max(1, Math.floor(most) || 1), MOST_BYTES, written - from);
  const bytes = Buffer.alloc(want);
  let got = 0;
  if (want > 0) {
    const fd = openSync(output, 'r');
    try {
      while (got < want) {
        const count = readSync(fd, bytes, got, want - got, from + got);
        if (count === 0) break;
        got += count;
      }
    } finally { closeSync(fd); }
  }
  const whole = wholeUtf8Length(bytes.subarray(0, got));
  return { run, ...status, written, from, next: from + whole, output: bytes.subarray(0, whole).toString('utf8') };
}

const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export async function cancelCodexRun({ run, root = defaultRoot, grace_ms = 3000 }) {
  const dir = runFolder(root, run);
  const record = readRecord(dir);
  const before = stateOf(dir);
  if (before.state !== 'running') return { run, ...before, cancelled: false };
  writeRecord(dir, { ...record, cancel_requested_at: new Date().toISOString() });
  try { process.kill(-record.pid, 'SIGTERM'); } catch { /* already gone */ }
  const until = Date.now() + grace_ms;
  while (groupAlive(record.pid) && Date.now() < until) await sleep(50);
  if (groupAlive(record.pid)) { try { process.kill(-record.pid, 'SIGKILL'); } catch { /* already gone */ } }
  return { run, ...stateOf(dir), cancelled: true };
}

// The command line the three keep-and-wake tool rows run (tool-rows.json, `invoke.run`):
//   node harness/codex-runs.mjs start --folder <folder> --message-file <file>   the prompt is read from <file>, never argv
//   node harness/codex-runs.mjs read --run <codex-run-id> --after <bytes>
//   node harness/codex-runs.mjs cancel --run <codex-run-id>
// Each prints one JSON answer on standard output. A refusal prints { error } on standard error and exits 1.
export async function main(argv, out = process.stdout) {
  const [action, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z-]+$/.test(rest[i] ?? '') || i + 1 >= rest.length) throw new Error(`Bad flag ${rest[i]}.`);
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  let answer;
  if (action === 'start') {
    if (!flags.folder || !flags.folder.trim()) throw new Error('The folder is needed.');
    if (!flags['message-file']) throw new Error('The message file is needed.');
    answer = startCodexRun({ folder: flags.folder, message: readFileSync(flags['message-file'], 'utf8') });
  } else if (action === 'read') {
    if (!/^[0-9]+$/.test(flags.after ?? '')) throw new Error('The byte position after is needed.');
    answer = readCodexRun({ run: flags.run, after: Number(flags.after) });
  } else if (action === 'cancel') {
    answer = await cancelCodexRun({ run: flags.run });
  } else {
    throw new Error('The action is start, read or cancel.');
  }
  out.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
