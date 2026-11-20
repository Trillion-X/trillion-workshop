// test-helpers/judged-tree.mjs
//
// The git view a tool-row check judges. A checkout is judged at its own HEAD. An export with no .git of its own (a landing's
// check tree) is committed into a throwaway git folder, whose work tree is the export, and judged at that commit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function judgedTree(repo) {
  if (existsSync(join(repo, '.git'))) return { env: {}, ref: 'HEAD' };
  const gitDir = mkdtempSync(join(tmpdir(), 'tool-row-imports-git-'));
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(gitDir, 'index'), GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' };
  const git = args => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, maxBuffer: 2 ** 30 }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A', '-f', '.']);
  return { env, ref: git(['commit-tree', git(['write-tree']), '-m', 'check tree']) };
}

// Runs `fn` with the git variables of `env` set, and restores the variables it found.
export function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
}
