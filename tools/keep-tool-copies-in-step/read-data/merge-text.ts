// tools/keep-tool-copies-in-step/read-data/merge-text.ts
//
// PURPOSE
//   The three-way text merge of one file changed on both sides, done by its real owner, git: `git merge-file -p ours base
//   theirs` over three files in a temp folder of this run's own. And the unified diff a refusal carries: what each side
//   changed from the base, written by `git diff --no-index` (the diff people read).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Any non-zero exit of git merge-file is a conflict (it answers the number of conflicts, or -1 on an error), and its
//      stdout, which then holds conflict markers, is never returned or written.
//   2. A file holding a NUL byte on any side is binary: it is never merged, only refused with a diff.
//   3. The temp folder is made under the process's temp folder and removed before the answer returns.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Merged = { ok: true; bytes: Uint8Array } | { ok: false; diff: string };

const hasNul = (bytes: Uint8Array): boolean => bytes.includes(0);

/** Runs `work` in a fresh temp folder that is removed afterwards. */
function inTempFolder<T>(work: (folder: string) => T): T {
  const folder = mkdtempSync(join(tmpdir(), 'keep-tool-copies-merge-'));
  try { return work(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** The unified diff of one side against the base, labelled base/ and side/; an absent file is diffed against /dev/null. */
function sideDiff(folder: string, path: string, base: Uint8Array | null, side: Uint8Array | null, label: 'project' | 'upstream'): string {
  // Each version is written under a folder named for its side, and diffed from inside the temp folder, so the diff names
  // base/PATH and project/PATH (or upstream/PATH), never a temp path.
  const write = (top: string, bytes: Uint8Array | null): string => {
    if (bytes === null) return '/dev/null';
    const at = join(folder, top, ...path.split('/'));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
    return `${top}/${path}`;
  };
  const from = write(`base-for-${label}`, base);
  const to = write(label, side);
  const done = spawnSync('git', ['diff', '--no-index', '--no-color', '--text', '--no-prefix', '--', from, to], { cwd: folder, maxBuffer: 1 << 28 });
  if (done.status !== 0 && done.status !== 1) throw new Error(`git diff refused: ${done.stderr.toString('utf8').trim()}`);
  return done.stdout.toString('utf8').split(`base-for-${label}/`).join('base/');
}

/** What each side changed in `path` since the base, as two unified diffs (project first, then upstream). */
export function threeWayDiff(path: string, base: Uint8Array | null, ours: Uint8Array | null, theirs: Uint8Array | null): string {
  return inTempFolder(folder => sideDiff(folder, path, base, ours, 'project') + sideDiff(folder, path, base, theirs, 'upstream'));
}

/** The merge of `ours` (the project) and `theirs` (upstream) from `base`; ok:false with the diff when git does not merge it cleanly. */
export function mergeText(ours: Uint8Array, base: Uint8Array, theirs: Uint8Array, path = 'file'): Merged {
  if (hasNul(ours) || hasNul(base) || hasNul(theirs)) return { ok: false, diff: threeWayDiff(path, base, ours, theirs) };
  return inTempFolder(folder => {
    const names = (['ours', 'base', 'theirs'] as const).map((name, index) => {
      const at = join(folder, name);
      writeFileSync(at, [ours, base, theirs][index]);
      return at;
    });
    const done = spawnSync('git', ['merge-file', '-p', ...names], { maxBuffer: 1 << 28 });
    if (done.error) throw done.error;
    if (done.status !== 0) return { ok: false, diff: threeWayDiff(path, base, ours, theirs) };
    return { ok: true, bytes: new Uint8Array(done.stdout) };
  });
}
