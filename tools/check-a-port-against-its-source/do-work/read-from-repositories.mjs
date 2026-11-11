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
//     pathOf(source)                string | null   source.path, or the path at source.commit whose BLAKE3 identity is
//                                                   source.path_multihash (a source in a private repository, named
//                                                   without printing its path into a public one)
//     readSource(source)            Buffer | null   the bytes of that path at source.commit
//     readTarget(path)              Buffer | null   the bytes of a path of `root` in `tree` (a commit, ':' for the staged
//                                                   index, or undefined for the file on disk)
//     targetAtCommit(commit, path)  Buffer | null   the bytes of a path of `root` at a commit
//     lives(repository, path)       boolean | null  whether the path is in that repository's main line now
//     searchCode(repository, pattern)  string[] | null  paths in that repository's main line whose text or path matches
//     mainOf(repository)            string | null   the commit searched
//   }
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

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
  const pathOf = (source) => {
    if (source?.path) return source.path;
    const folder = source?.repository && source?.commit && source?.path_multihash ? checkout(source.repository) : null;
    const listed = folder ? git(folder, ['ls-tree', '-r', '--name-only', source.commit]) : null;
    return listed?.split('\n').find((path) => path && makeHashCodeHexFromBytes(Buffer.from(path)) === source.path_multihash) ?? null;
  };
  // A blob's text matches depend only on its bytes, the pattern set and the flags, so they are kept per blob id under the
  // judged repository's git directory, keyed by the pattern set. A repository's text answers are its tree's blobs looked
  // up there; only blobs not yet known are grepped, per pattern and only on their own paths, with Git's expression.
  const MATCH_FLAGS = ['-i', '-I', '-E'];
  const prepared = new Map();
  const blobMatchesFile = (unique) => {
    const dir = git(here, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
    const key = makeHashCodeHexFromBytes(Buffer.from(JSON.stringify([MATCH_FLAGS, unique]))).replace(':', '-');
    return dir && existsSync(dir) ? join(dir, 'port-search-blobs', `${key}.json`) : null;
  };
  const readBlobMatches = (file) => {
    let stored;
    try { stored = file && JSON.parse(readFileSync(file, 'utf8')); } catch { return new Map(); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Map();
    return new Map(Object.entries(stored).filter(([blob, indices]) => /^[0-9a-f]+$/.test(blob)
      && Array.isArray(indices) && indices.every((index) => Number.isSafeInteger(index))));
  };
  const writeBlobMatches = (file, matches) => {
    if (!file) return;
    // A cache that cannot be written only loses reuse: the matches were judged above, so the judgement still stands.
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(Object.fromEntries(matches)));
      renameSync(`${file}.${process.pid}.tmp`, file);
    } catch {}
  };
  // The paths of this tree, in the order git grep reports them, that match any of the patterns (null when git cannot say).
  const pathsMatching = (folder, main, patterns, pathspec) => {
    const found = git(folder, ['grep', '-z', '-l', ...MATCH_FLAGS, ...patterns.flatMap((pattern) => ['-e', pattern]), main, '--', ...pathspec]);
    return found === null ? null : new Set(found.split('\0').filter(Boolean).map((line) => line.slice(main.length + 1)));
  };
  const textAnswers = (folder, main, unique, file) => {
    const listed = git(folder, ['ls-tree', '-r', '-z', main]);
    if (listed === null) return null;
    const rows = [];
    for (const record of listed.split('\0').filter(Boolean)) {
      const row = /^(\d{6}) (\S+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
      if (!row) return null;
      if (row[2] === 'blob') rows.push({ object: row[3], path: row[4] });
    }
    const matches = readBlobMatches(file);
    const unknown = rows.filter((row) => !matches.has(row.object));
    const unknownPaths = [...new Set(unknown.map((row) => `:(literal)${row.path}`))];
    // Every path is named when only some are unknown; a whole-tree grep is one call per pattern otherwise.
    const pathspecs = unknown.length === rows.length ? [[]] : Array.from({ length: Math.ceil(unknownPaths.length / 500) },
      (_, at) => unknownPaths.slice(at * 500, at * 500 + 500));
    // One grep over every pattern finds the unknown paths that match any of them; each pattern is then asked only about those.
    const candidates = new Set();
    for (const pathspec of pathspecs) {
      const paths = pathsMatching(folder, main, unique, pathspec);
      if (paths === null) return null;
      for (const path of paths) candidates.add(path);
    }
    const named = [...candidates].map((path) => `:(literal)${path}`);
    const fresh = new Map(unknown.map((row) => [row.object, new Set()]));
    for (const [index, pattern] of unique.entries()) {
      const found = new Set();
      for (let at = 0; at < named.length; at += 500) {
        const paths = pathsMatching(folder, main, [pattern], named.slice(at, at + 500));
        if (paths === null) return null;
        for (const path of paths) found.add(path);
      }
      for (const row of unknown) if (found.has(row.path)) fresh.get(row.object).add(index);
    }
    for (const [object, indices] of fresh) matches.set(object, [...indices].sort((a, b) => a - b));
    writeBlobMatches(file, matches);
    const answers = new Map(unique.map((pattern) => [pattern, []]));
    for (const row of rows) for (const index of matches.get(row.object)) answers.get(unique[index]).push(row.path);
    return answers;
  };
  // The paths of a repository's main line, read once for all the searches of one judgement.
  const names = new Map();
  const treeNames = (folder, main) => {
    const key = `${folder}\0${main}`;
    if (!names.has(key)) names.set(key, git(folder, ['ls-tree', '-r', '--name-only', main]));
    return names.get(key);
  };
  // Answers the code searches of the named repositories for these patterns in one pass, so searchCode reads them back.
  const prepareCodeSearch = (references, patterns) => {
    const unique = [...new Set(patterns.filter((pattern) => typeof pattern === 'string' && pattern.length))];
    if (!unique.length) return;
    for (const reference of new Set(references)) {
      const folder = checkout(reference);
      const main = folder ? mainOf(reference) : null;
      if (!main) continue;
      const answers = textAnswers(folder, main, unique, blobMatchesFile(unique));
      if (answers) prepared.set(`${folder}\0${main}`, answers);
    }
  };
  return {
    prepareCodeSearch,
    self,
    checkout,
    mainOf,
    pathOf,
    readSource(source) {
      const path = source?.repository && source?.commit ? pathOf(source) : null;
      return path ? show(checkout(source.repository), `${source.commit}:${path}`) : null;
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
      const answers = prepared.get(`${folder}\0${main}`);
      const byText = answers?.has(pattern) ? answers.get(pattern) : (() => {
        const text = git(folder, ['grep', '-l', '-i', '-I', '-E', '-e', pattern, main, '--']);
        return text === null ? null : text.split('\n').filter(Boolean).map((line) => line.slice(main.length + 1));
      })();
      const byPath = treeNames(folder, main);
      if (byText === null || byPath === null) return null;
      const found = new Set(byText);
      const matcher = new RegExp(pattern, 'i');
      for (const path of byPath.split('\n')) if (path && matcher.test(path)) found.add(path);
      return [...found].sort();
    },
  };
}
