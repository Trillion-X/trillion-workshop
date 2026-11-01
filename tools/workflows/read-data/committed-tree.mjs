// A bounded read-only view of one committed tree. This never checks out or edits source.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function committedTree(repository, ref) {
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('An exact committed Git tree is required.');
  const files = new Map();
  const children = new Map();
  for (const line of git(['ls-tree', '-r', '-t', '-z', commit]).split('\0').filter(Boolean)) {
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
    commit,
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
