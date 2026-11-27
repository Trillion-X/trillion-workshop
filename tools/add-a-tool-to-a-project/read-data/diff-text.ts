// tools/add-a-tool-to-a-project/read-data/diff-text.ts
//
// PURPOSE
//   The unified diff a refusal carries when a project's copy of a tool was edited: for each file that differs, what the
//   pointer's files hold against what the project's folder holds, written by `git diff --no-index` (the diff people read).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only: both sides are read, nothing is written.
//   2. A file on one side only is diffed against the empty side (/dev/null), so an added or removed file shows whole.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The unified diff of `paths` between folder `from` (the pointer's files) and folder `to` (the project's copy). */
export function unifiedDiff(from: string, to: string, paths: string[]): string {
  return paths.map(path => {
    const a = existsSync(join(from, path)) ? join(from, path) : '/dev/null';
    const b = existsSync(join(to, path)) ? join(to, path) : '/dev/null';
    const done = spawnSync('git', ['diff', '--no-index', '--no-color', `--src-prefix=pointer/`, `--dst-prefix=project/`, '--', a, b], { maxBuffer: 1 << 28 });
    if (done.status !== 0 && done.status !== 1) throw new Error(`git diff refused: ${done.stderr.toString('utf8').trim()}`);
    return done.stdout.toString('utf8').split(from).join('').split(to).join('');
  }).join('');
}
