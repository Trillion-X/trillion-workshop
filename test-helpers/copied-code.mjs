// test-helpers/copied-code.mjs
//
// Purpose: find code one tool holds that another tool holds too. A tool reaches another tool's code by importing it (the
// owner names it in its part.json); a copy is a second owner that drifts from the first: a fix lands in one and the other
// keeps the bug, and the Workshop carries the same lines twice. Two files are copies when their code is the same once
// their import lines (which differ only because the folders differ) and a leading path comment are set aside.
//
// Non-Negotiable Invariants:
//   1. Read from git objects at `ref`, never the working tree, so a gate judges the commit being pushed.
//   2. No tool, file or extension list of a kind of tool is named here: every code file under tools/ is read.
//   3. Text under a folder's `test/` (test code may repeat on purpose) and `from-an-older-version/` (kept copies of old
//      code) is evidence, not shipped code, and is not read; nor is a file whose code is empty once imports are set aside.
//
//   copiedCode({ repo, ref }) → { groups: [[paths holding the same code, in more than one tool]], total }
//   total counts each file past the first of its group: the files to delete.
//
// Run `node test-helpers/copied-code.mjs [ref] [--write]` to print the count and the largest groups, or (--write) to
// rewrite test/copied-code.json from it.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SET_ASIDE = /(?:^|\/)(?:test|tests|__tests__|from-an-older-version|node_modules)\//;
// A line that only names where code comes from: an import, a re-export, the tail of a multi-line one, or a path comment.
const WHERE_FROM = /^\s*(?:import\s|export\s+(?:\*|\{[^}]*\})\s+from\s|\}\s+from\s|\/\/\s*(?:tools|packages)\/\S+\s*$)/;
const toolOf = path => path.split('/')[1];

export function codeOf(text) {
  const kept = [];
  let open = false; // inside a multi-line import list, up to its `} from` line
  for (const line of text.split('\n')) {
    if (open) { if (/\}/.test(line)) open = false; continue; }
    if (/^\s*import(?:\s+type)?\s*\{[^}]*$/.test(line)) { open = true; continue; }
    if (!WHERE_FROM.test(line)) kept.push(line);
  }
  return kept.join('\n').trim();
}

export function copiedCode({ repo, ref }) {
  const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', ref, '--', 'tools'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = [];
  for (const line of listing.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match && CODE.test(match[2]) && !SET_ASIDE.test(match[2]) && !/\.test\.[cm]?[jt]sx?$/.test(match[2])) files.push({ blob: match[1], path: match[2] });
  }
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: files.map(file => file.blob).join('\n') + '\n', maxBuffer: 1 << 30 });
  const byCode = new Map();
  let at = 0;
  for (const file of files) {
    const header = out.indexOf(10, at);
    const size = Number(out.subarray(at, header).toString().split(' ')[2]);
    const code = codeOf(out.subarray(header + 1, header + 1 + size).toString('utf8'));
    at = header + 1 + size + 1;
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(file.path);
  }
  const groups = [...byCode.values()].filter(paths => new Set(paths.map(toolOf)).size > 1).map(paths => paths.sort()).sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  return { groups, total: groups.reduce((sum, paths) => sum + paths.length - 1, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const { groups, total } = copiedCode({ repo, ref: args.find(arg => !arg.startsWith('--')) ?? 'HEAD' });
  if (args.includes('--write')) {
    writeFileSync(new URL('../test/copied-code.json', import.meta.url), `${JSON.stringify({
      _what: 'How many code files under tools/ are copies of code another tool holds (test-helpers/copied-code.mjs): each file past the first of a group whose code, imports set aside, is the same. It may only go down: test/one-owner-for-each-piece-of-code.test.mjs fails when it is higher and names the groups the files changed since this was written are in. Delete a copy and import the owner (named in its part.json), then rewrite this with `node test-helpers/copied-code.mjs <ref> --write`; the outcome is 0.',
      total }, null, 1)}\n`);
  }
  const pairs = new Map();
  for (const paths of groups) { const key = [...new Set(paths.map(toolOf))].join(' + '); pairs.set(key, (pairs.get(key) ?? 0) + paths.length - 1); }
  console.log(JSON.stringify({ total, groups: groups.length, most: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 12) }, null, 1));
}
