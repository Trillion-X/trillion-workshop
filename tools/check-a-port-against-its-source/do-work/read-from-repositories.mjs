// tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs
//
// What the contract validator reads when a contract names its source by repository, commit and path instead of by a
// path on disk, and what it searches when a contract says nothing older did the job. Everything goes through git in a
// checkout of the named repository, so the bytes judged are the committed bytes, never a half-edited file.
//
// A repository is named by its folder name (`tools-repo`, not a URL). Its checkout is `repositories[name]` when the
// caller names it, else the folder of that name beside the checkout that owns `root`'s history (the checkouts live
// side by side; a temporary worktree of `root` finds the same neighbours as `root` itself). A repository with no
// readable checkout here answers null, which the validator reports as deferred, never as a pass or a refusal.
//
//   gitReaders({ root, repositories?, tree? }) -> {
//     self                          the repository's name: its main checkout's folder name
//     readSource(source)            Buffer | null   the bytes of source.path at source.commit
//     readTarget(path)              Buffer | null   the bytes of a path of `root` in `tree` (a commit, ':' for the staged
//                                                   index, or undefined for the file on disk)
//     targetAtCommit(commit, path)  Buffer | null   the bytes of a path of `root` at a commit
//     lives(repository, path)       boolean | null  whether the path is in that repository's main line now
//     searchCode(repository, pattern)  string[] | null  paths in that repository's main line whose text or path matches
//     mainOf(repository)            string | null   the commit searched
//   }
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_BUFFER = 1 << 28;

function git(root, args, { bytes = false } = {}) {
  try {
    const out = execFileSync('git', ['-C', root, ...args], { maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
    return bytes ? out : out.toString('utf8');
  } catch (error) {
    // git grep answers 1 when nothing matched; every other failure is "not readable here".
    if (error.status === 1 && args[0] === 'grep') return bytes ? Buffer.alloc(0) : '';
    return null;
  }
}

export function gitReaders({ root, repositories = {}, tree } = {}) {
  const here = resolve(root ?? process.cwd());
  const common = git(here, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  const owner = common && basename(common) === '.git' ? dirname(common) : here;
  const self = basename(owner);
  const checkout = (name) => {
    const named = repositories[name] ?? (name === self ? here : join(dirname(owner), name));
    const folder = isAbsolute(named) ? named : resolve(here, named);
    return existsSync(join(folder, '.git')) ? folder : null;
  };
  const mains = new Map();
  const mainOf = (name) => {
    if (mains.has(name)) return mains.get(name);
    const folder = checkout(name);
    const main = folder && (['refs/remotes/origin/main', 'refs/heads/main', 'HEAD']
      .map((ref) => git(folder, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])?.trim())
      .find(Boolean) ?? null);
    mains.set(name, main);
    return main;
  };
  const show = (folder, spec) => (folder ? git(folder, ['show', spec], { bytes: true }) : null);
  return {
    self,
    checkout,
    mainOf,
    readSource(source) {
      if (!source?.repository || !source?.commit || !source?.path) return null;
      return show(checkout(source.repository), `${source.commit}:${source.path}`);
    },
    readTarget(path) {
      if (tree === undefined) {
        const file = resolve(here, path);
        return existsSync(file) ? readFileSync(file) : null;
      }
      return show(here, tree === ':' ? `:${path}` : `${tree}:${path}`);
    },
    targetAtCommit(commit, path) {
      return show(here, `${commit}:${path}`);
    },
    lives(repository, path) {
      const folder = checkout(repository);
      const main = mainOf(repository);
      if (!folder || !main) return null;
      return git(folder, ['cat-file', '-e', `${main}:${path}`]) !== null;
    },
    searchCode(repository, pattern) {
      const folder = checkout(repository);
      const main = mainOf(repository);
      if (!folder || !main) return null;
      const byText = git(folder, ['grep', '-l', '-i', '-I', '-E', '-e', pattern, main, '--']);
      const byPath = git(folder, ['ls-tree', '-r', '--name-only', main]);
      if (byText === null || byPath === null) return null;
      const found = new Set(byText.split('\n').filter(Boolean).map((line) => line.slice(main.length + 1)));
      const matcher = new RegExp(pattern, 'i');
      for (const path of byPath.split('\n')) if (path && matcher.test(path)) found.add(path);
      return [...found].sort();
    },
  };
}
