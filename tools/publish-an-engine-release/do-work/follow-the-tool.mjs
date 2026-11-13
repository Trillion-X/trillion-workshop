// tools/publish-an-engine-release/do-work/follow-the-tool.mjs
//
// The builder's own tool update road. install-an-engine-builder ships this tool once (install-a-builder.mjs `installBuilder`);
// after that this file keeps it at trillion-workshop main by itself, so the tool that publishes engine releases is never a
// hand copy. A timer on the builder runs `follow-the-tool.mjs CONFIG_FILE`: it reads the branch tip, and when that is not the
// tool's installed commit, it fetches that one commit, stages the shipped files in a new folder beside the tool, moves the
// tool aside as `<tool>.old` and the staged folder into its place, and restarts the receiver so the new code runs. The status
// file names the installed commit and the one it replaced, so a rollback is a rename back. The commit is the one git fetched
// and its checkout is checked to be that commit, so nothing is installed that the branch did not name.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED } from './install-a-builder.mjs';
import { runInProgress } from './publish-an-engine-release.mjs';

const refuse = (message, exit = 1) => Object.assign(new Error(message), { exit });
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (args, cwd) => execFileSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The commit the branch names on `source` (its tip), as 40 lowercase hex; a branch that is gone is refused. */
export function tipOf({ source, branch }) {
  const line = git(['ls-remote', source, `refs/heads/${branch}`]);
  const commit = line.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw refuse(`${source} names no ${branch} branch: the tool stays as it is.`);
  return commit;
}

/** The status file: the commit installed, and the one it replaced (the rollback). Missing means nothing is installed yet. */
export function readStatus(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { commit: null, previous: null };
}

/**
 * Stage `commit` in `staged` (a new folder): fetch that one commit into a scratch checkout, check it is that commit, and copy
 * the shipped files out of it. The one shipped path git does not hold, node_modules (a package's files), is copied from the
 * installed tool when there is one; any other shipped path the commit lacks is refused.
 */
export function stage({ source, commit, staged, installed, work }) {
  const checkout = join(work, 'checkout');
  mkdirSync(checkout, { recursive: true });
  git(['init', '-q'], checkout);
  git(['fetch', '-q', '--depth', '1', source, commit], checkout);
  git(['checkout', '-q', '--detach', 'FETCH_HEAD'], checkout);
  if (git(['rev-parse', 'HEAD'], checkout) !== commit) throw refuse(`The fetched checkout is not ${commit}: nothing is installed.`);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true, mode: 0o755 });
  for (const path of SHIPPED) {
    const from = join(checkout, path), fallback = installed ? join(installed, path) : null;
    const origin = existsSync(from) ? from : path.startsWith('node_modules/') && fallback && existsSync(fallback) ? fallback : null;
    if (!origin) throw refuse(`${path} is in neither ${commit} nor the installed tool: nothing is installed.`);
    cpSync(origin, join(staged, path), { recursive: true });
  }
  return staged;
}

/** One pass of the road: install the branch tip when it is not the installed commit. Answers what it did. */
export async function followTheTool({ source, branch, tool, status: statusFile, restart, log = () => {} }) {
  const tip = tipOf({ source, branch });
  const status = readStatus(statusFile);
  if (status.commit === tip && existsSync(tool)) return { changed: false, commit: tip };
  // A restart kills a build in progress (its commit starts over): the update waits for the next pass instead.
  const running = existsSync(tool) ? runInProgress(dirname(statusFile)) : null;
  if (running) { log(`tool: ${tip} waits for the build of ${running.commit} to finish`); return { changed: false, commit: status.commit, waiting: tip, building: running.commit }; }
  const staged = `${tool}.new`, work = mkdtempSync(join(dirname(tool), '.follow-the-tool-'));
  try {
    stage({ source, commit: tip, staged, installed: existsSync(tool) ? tool : null, work });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  rmSync(`${tool}.old`, { recursive: true, force: true });
  if (existsSync(tool)) renameSync(tool, `${tool}.old`);
  renameSync(staged, tool);
  writeFileSync(statusFile, `${JSON.stringify({ commit: tip, previous: status.commit, installed_at: new Date().toISOString() }, null, 1)}\n`, { mode: 0o644 });
  log(`tool: installed ${tip} (it replaced ${status.commit ?? 'nothing'}); restarting the receiver`);
  restart();
  return { changed: true, commit: tip, previous: status.commit };
}

// usage: follow-the-tool.mjs CONFIG_FILE — the timer's run: { source, branch, tool_folder, status_file, restart_command }.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length) { process.stderr.write('usage: follow-the-tool.mjs CONFIG_FILE\n'); process.exit(2); }
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const restart = () => execFileSync(config.restart_command[0], config.restart_command.slice(1), { stdio: 'inherit' });
  followTheTool({ source: config.source, branch: config.branch, tool: config.tool_folder, status: config.status_file, restart, log: line => process.stdout.write(`${line}\n`) })
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(error.exit ?? 1); });
}
