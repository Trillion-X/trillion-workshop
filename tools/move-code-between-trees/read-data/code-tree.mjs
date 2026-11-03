// tools/move-code-between-trees/read-data/code-tree.mjs
//
// A code tree read at one commit, from git's own objects, so a move reads exactly the bytes that commit holds whatever
// the working copy has in it. Owner globs (`*` any characters but /, `**` any characters, `?` one character but /, and a
// match covers everything under a matched folder) are answered against the same commit's file list.
import { execFileSync, spawnSync } from 'node:child_process';

const git = (folder, args, options = {}) => execFileSync('git', ['-C', folder, ...args], { maxBuffer: 1 << 30, ...options });

export class MoveRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The tree at `commit` in the repository at `folder`: { commit, files: Set, exists(path), read(path) -> Buffer }. */
export function openTreeAt(folder, commit) {
  let full;
  try { full = git(folder, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim(); }
  catch { throw new MoveRefusal('commit_missing', `${folder} has no commit ${commit}: fetch it first (git fetch origin ${commit}).`); }
  const listing = git(folder, ['ls-tree', '-r', '-z', '--full-tree', full], { encoding: 'utf8' });
  const files = new Map();
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    if (type === 'blob') files.set(entry.slice(tab + 1), { mode, object });
  }
  const cache = new Map();
  const read = path => {
    const entry = files.get(path);
    if (!entry) throw new MoveRefusal('file_missing', `${path} is not in ${folder} at ${full.slice(0, 10)}.`);
    if (!cache.has(entry.object)) cache.set(entry.object, git(folder, ['cat-file', 'blob', entry.object]));
    return cache.get(entry.object);
  };
  // Many reads at once go through one cat-file process.
  const readMany = paths => {
    const wanted = [...new Set(paths)].filter(path => files.has(path) && !cache.has(files.get(path).object));
    if (!wanted.length) return;
    const run = spawnSync('git', ['-C', folder, 'cat-file', '--batch'], { input: wanted.map(path => files.get(path).object).join('\n') + '\n', maxBuffer: 2 ** 32 });
    const out = run.stdout;
    let at = 0;
    for (const path of wanted) {
      const header = out.indexOf(0x0a, at);
      const size = Number(out.subarray(at, header).toString().split(' ')[2]);
      cache.set(files.get(path).object, out.subarray(header + 1, header + 1 + size));
      at = header + 1 + size + 1;
    }
  };
  return { folder, commit: full, files: new Set(files.keys()), mode: path => files.get(path)?.mode, exists: path => files.has(path), read, readMany };
}

/** The repository's current commit and whether its working copy has changes under any of `paths`. */
export function headOf(folder) {
  return git(folder, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

const globText = glob => glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');

/** Whether `path` is matched by `glob`, or lies under a folder it matches. */
export function globMatches(path, glob) {
  const clean = glob.replace(/\/+$/, '');
  return new RegExp(`^${globText(clean)}(?:/.*)?$`).test(path);
}

/** Every file of the tree an owner list names. */
export function filesOf(tree, globs) {
  const plain = globs.filter(glob => !/[*?]/.test(glob));
  const found = new Set();
  for (const glob of plain) {
    const clean = glob.replace(/\/+$/, '');
    if (tree.exists(clean)) found.add(clean);
  }
  const patterned = globs.filter(glob => /[*?]/.test(glob) || !tree.exists(glob.replace(/\/+$/, '')));
  if (patterned.length) for (const path of tree.files) if (patterned.some(glob => globMatches(path, glob))) found.add(path);
  return [...found].sort();
}
