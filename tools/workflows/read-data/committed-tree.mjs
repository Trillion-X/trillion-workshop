// A bounded read-only view of one committed tree. This never checks out or edits source.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const gitIn = repository => args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

// Why a generated file must not be written from this checkout's working tree, or null when it may: the checkout's HEAD
// is not origin/main, so what it holds can be older than what is published and a write would undo newer work. A
// repository with no origin/main has nothing newer to undo.
export function staleCheckout(repository) {
  const git = gitIn(repository);
  let upstream;
  try { upstream = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).trim(); } catch { return null; }
  if (!upstream) return null;
  const head = git(['rev-parse', '--verify', 'HEAD']).trim();
  return head === upstream ? null
    : `This checkout is at ${head.slice(0, 10)}, not origin/main ${upstream.slice(0, 10)}: a file generated from its working tree can undo newer work. Bring it to origin/main first, or generate from a commit with --git-ref.`;
}

export function committedTree(repository, ref) {
  const git = gitIn(repository);
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('An exact committed Git tree is required.');
  return treeReader(repository, git, commit, { commit });
}

// Candidate preparation already has a Git tree, before it has any commit. Require its full immutable identity,
// rather than accepting a branch, revision expression, abbreviation, commit or working/index projection.
export function immutableTree(repository, tree) {
  if (typeof tree !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new Error('Give the full immutable Git tree identity.');
  const git = gitIn(repository);
  if (git(['cat-file', '-t', tree]).trim() !== 'tree') throw new Error('The immutable Git object must be a tree.');
  return treeReader(repository, git, tree, { tree });
}

function treeReader(repository, git, object, identity) {
  const files = new Map();
  const children = new Map();
  for (const line of git(['ls-tree', '-r', '-t', '-z', object]).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [, type, identity] = line.slice(0, tab).split(' ');
    const name = line.slice(tab + 1);
    if (tab < 0 || !['tree', 'blob', 'commit'].includes(type) || !/^[a-f0-9]{40,64}$/.test(identity)) throw new Error('Malformed committed tree entry.');
    files.set(name, { type, identity });
    const parent = path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name);
    const entries = children.get(parent) ?? [];
    entries.push({ name: path.posix.basename(name), isDirectory: () => type === 'tree' });
    children.set(parent, entries);
  }
  const relative = file => {
    const name = path.relative(repository, path.resolve(file)).split(path.sep).join('/');
    if (name === '..' || name.startsWith('../') || path.isAbsolute(name)) throw new Error('A committed source must be inside its repository.');
    return name;
  };
  return {
    ...identity,
    exists: file => files.has(relative(file)),
    directory: file => files.get(relative(file))?.type === 'tree',
    entries: file => children.get(relative(file)) ?? [],
    json(file) {
      const entry = files.get(relative(file));
      if (!entry || entry.type !== 'blob') throw new Error('A committed JSON source file is required.');
      return JSON.parse(git(['cat-file', 'blob', entry.identity]));
    },
  };
}
