// tools/git-changes/read-data/git-changes.mjs
//
// See and commit the changes in a project folder on the person's computer: which files changed and where each stands
// (staged, unstaged, untracked), one file's difference, staging and unstaging files, and committing what is staged.
// Every function runs git in the one folder the person granted and answers the project's changes after it.
//
// Ported from bitfield-packages packages/git-worktree: the two process scripts (render a command from a template;
// read `git status --porcelain --branch`) are `renderArgv` and `parsePorcelain` here, and the git commands stay DATA
// (git-commands.json). Git is started with an argument list and never through a shell.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const commands = JSON.parse(readFileSync(new URL('./git-commands.json', import.meta.url), 'utf8'));

const asString = (value) => (typeof value === 'string' && value ? value : null);

function fail(message) { throw new Error(message); }

function readPath(value, dotted) {
  let current = value;
  for (const part of dotted.split('.')) {
    if (!part) continue;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    current = current[part];
  }
  return current ?? null;
}

function resolveTemplateValue(part, project, input) {
  if (typeof part === 'string') return [part];
  if (part === null || typeof part !== 'object') return [];
  const where = asString(part.path);
  let value;
  if (part.from === 'project' && where) value = readPath(project, where);
  else if (part.from === 'input' && where) value = readPath(input, where);
  else value = part.literal;
  if (part.spread === true && Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  return typeof value === 'string' && value ? [value] : [];
}

/** A command template ("git", "-C", {from: project, path: path}, ...) as the list of arguments it stands for. */
export function renderArgv(template, project, input) {
  if (!Array.isArray(template)) fail('Git command template must provide an argv array');
  const argv = template.flatMap((part) => resolveTemplateValue(part, project, input));
  if (argv.length === 0) fail('Git command template rendered an empty argv');
  return argv;
}

/** The branch line of `git status --porcelain --branch`: its name and how far ahead of and behind its upstream it is. */
export function parseBranchHeader(line) {
  let text = line.slice(3).trim();
  let ahead = 0;
  let behind = 0;
  const bracket = /\[(.+)\]$/.exec(text);
  if (bracket) {
    const aheadMatch = /ahead\s+(\d+)/.exec(bracket[1]);
    const behindMatch = /behind\s+(\d+)/.exec(bracket[1]);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
    text = text.slice(0, bracket.index).trim();
  }
  return { branch: text.split('...')[0].trim() || 'HEAD', ahead, behind };
}

/** What `git status --porcelain --branch` printed, as the branch and one row per file per bucket it is in. */
export function parsePorcelain(stdout) {
  let header = { branch: 'HEAD', ahead: 0, behind: 0 };
  const changes = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('## ')) { header = parseBranchHeader(line); continue; }
    if (line.length < 3) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const file = line.slice(3).split(' -> ').at(-1);
    if (!file) continue;
    if (indexStatus === '?' && worktreeStatus === '?') { changes.push({ file_path: file, bucket: 'untracked', status: '?' }); continue; }
    if (indexStatus !== ' ' && indexStatus !== '?') changes.push({ file_path: file, bucket: 'staged', status: indexStatus });
    if (worktreeStatus !== ' ' && worktreeStatus !== '?') changes.push({ file_path: file, bucket: 'unstaged', status: worktreeStatus });
  }
  const order = { staged: 0, unstaged: 1, untracked: 2 };
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  changes.sort((left, right) => (order[left.bucket] ?? 99) - (order[right.bucket] ?? 99)
    || compare(left.file_path, right.file_path) || compare(left.status, right.status));
  return { ...header, changes };
}

/** Starts git with a list of arguments and answers { code, stdout, stderr }. Output past the bound ends it. */
export function startGit(argv, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    // The folder is named by `-C` alone: a repository, work tree or index the caller's own environment names is not used.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !commands.drop_env.includes(name)));
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, ...commands.env, ...env }, timeout: commands.timeout_ms });
    let stdout = '';
    let stderr = '';
    let tooLarge = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > commands.most_bytes) { tooLarge = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < commands.most_bytes) stderr += chunk; });
    child.on('error', (error) => reject(new Error(`git could not start: ${error.message}`)));
    child.on('close', (code) => {
      if (tooLarge) reject(new Error(`git printed more than ${commands.most_bytes} characters, which is too much to return.`));
      else resolve({ code, stdout, stderr });
    });
  });
}

function projectOf({ folder } = {}) {
  if (!asString(folder) || !path.isAbsolute(folder)) fail('Give folder: the full path of the project, as it was granted.');
  return { path: folder };
}

async function runCommand(name, project, input, deps) {
  const argv = renderArgv(commands[name].argv, project, input);
  const result = await (deps.git ?? startGit)(argv);
  if (result.code !== 0) fail((result.stderr || result.stdout || `git ${name} exited with code ${result.code}`).trim().slice(-commands.most_message));
  return result.stdout;
}

async function changesOf(project, deps) {
  return { folder: project.path, ...parsePorcelain(await runCommand('status', project, {}, deps)) };
}

/** `tool:see-changes-in-a-project`: the branch and every changed file, in staged, unstaged and untracked. */
export async function seeChangesInAProject(input = {}, _context, deps = {}) {
  return changesOf(projectOf(input), deps);
}

/** `tool:see-a-files-change`: the difference between one file and the last commit. */
export async function seeAFilesChange(input = {}, _context, deps = {}) {
  const project = projectOf(input);
  const filePath = asString(input.file_path) ?? fail('Give file_path: the file, relative to the project folder.');
  return { folder: project.path, file_path: filePath, diff: await runCommand('diff', project, { file_path: filePath }, deps) };
}

function pathsOf(input) {
  if (!Array.isArray(input.paths) || input.paths.length === 0 || !input.paths.every((item) => asString(item))) fail('Give paths: the files to change, relative to the project folder.');
  return input.paths;
}

/** `tool:stage-changes`: add files to the next commit. Answers the project's changes after it. */
export async function stageChanges(input = {}, _context, deps = {}) {
  const project = projectOf(input);
  await runCommand('stage', project, { paths: pathsOf(input) }, deps);
  return changesOf(project, deps);
}

/** `tool:unstage-changes`: take files out of the next commit, leaving the files as they are. */
export async function unstageChanges(input = {}, _context, deps = {}) {
  const project = projectOf(input);
  await runCommand('unstage', project, { paths: pathsOf(input) }, deps);
  return changesOf(project, deps);
}

/** `tool:commit-changes`: commit what is staged with the message given. */
export async function commitChanges(input = {}, _context, deps = {}) {
  const project = projectOf(input);
  const message = asString(input.message) ?? fail('Give message: what this commit says.');
  await runCommand('commit', project, { message }, deps);
  return changesOf(project, deps);
}
