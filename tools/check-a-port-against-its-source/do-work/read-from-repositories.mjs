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
//     baselineHistory(commit, paths) object | null ancestry and each active path's history before the byte copy
//     retirementOf(source)          { state: 'absent' | 'regular' | 'unreadable', bytes? } candidate for self, else published main
//     lives(repository, path)       boolean | null  whether the path is in that repository's main line now
//     searchCode(repository, pattern)  string[] | null  paths in that repository's main line whose text or path matches
//     mainOf(repository)            string | null   the commit searched
//   }
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const MAX_BUFFER = 1 << 28;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Caches belong to one reader/rights scope, with both entry and byte bounds. Returned bytes are copied below.
function boundedMemo(entries, bytes, sizeOf = (value) => value?.length ?? 0) {
  const values = new Map();
  let used = 0;
  return (key, read) => {
    if (values.has(key)) {
      const hit = values.get(key);
      values.delete(key); values.set(key, hit);
      return hit.value;
    }
    const value = read();
    if (value === null || value === undefined) return value;
    const size = sizeOf(value);
    if (size > bytes) return value;
    while (values.size && (values.size >= entries || used + size > bytes)) {
      const oldest = values.keys().next().value;
      used -= values.get(oldest).size; values.delete(oldest);
    }
    values.set(key, { value, size }); used += size;
    return value;
  };
}

function indexHistory(text) {
  const parents = new Map(), paths = new Map(), renames = [], outputs = new Map();
  const fields = text.split('\0');
  let revision = null;
  const remember = (path, content, introduced, object) => {
    if (!paths.has(path)) paths.set(path, new Map());
    const events = paths.get(path);
    const old = events.get(revision);
    events.set(revision, { revision, content: content || old?.content, introduced: introduced || old?.introduced });
    if (introduced) {
      const key = `${revision}\0${object}`;
      if (!outputs.has(key)) outputs.set(key, new Set());
      outputs.get(key).add(path);
    }
  };
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index].trim();
    if (/^@[0-9a-f]+(?: [0-9a-f ]*)?$/.test(field)) {
      const [one, ...older] = field.slice(1).split(' ');
      revision = one; parents.set(one, older.filter(Boolean));
    } else if (revision && /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ [AMDTURC]\d*$/.test(field)) {
      const [, , , object, status] = field.split(' ');
      const from = fields[++index];
      if (/^[RC]/.test(status)) {
        const to = fields[++index];
        remember(to, true, true, object);
        if (status.startsWith('R')) renames.push({ revision, from, to, object });
      } else remember(from, status !== 'D', status === 'A', object);
    }
  }
  // Git can assign a rename to the archive when the active output has identical bytes in that same commit.
  // Share candidate groups instead of expanding a quadratic set of edges for identical boilerplate files.
  const groups = new Map(), incoming = new Map();
  for (const edge of renames) {
    const key = `${edge.revision}\0${edge.object}`;
    if (!groups.has(key)) groups.set(key, { from: new Set(), outputs: outputs.get(key) });
    groups.get(key).from.add(edge.from);
  }
  for (const group of groups.values()) for (const path of group.outputs ?? []) {
    if (!incoming.has(path)) incoming.set(path, []);
    incoming.get(path).push(group);
  }
  return { parents, paths, incoming };
}

function repositoryGit(root, args, { bytes = false, index = false, history = false, environment } = {}) {
  try {
    // -C does not override Git's inherited repository/object/namespace selectors. Bind every read to its declared
    // checkout; only self staged operations use the caller's private index. Keep self history overrides visible to
    // the fresh shallow/graft guards, but never carry them into another repository's published source view.
    const env = { ...environment };
    for (const key of Object.keys(env)) {
      if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'].includes(key)
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
        || (key === 'GIT_INDEX_FILE' && !index)
        || (['GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE'].includes(key) && !history)) delete env[key];
    }
    const out = execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { env, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
    return bytes ? out : out.toString('utf8');
  } catch (error) {
    // git grep answers 1 when nothing matched; every other failure is "not readable here".
    if (error.status === 1 && args[0] === 'grep') return bytes ? Buffer.alloc(0) : '';
    return null;
  }
}

export function gitReaders({ root, repositories = {}, tree } = {}) {
  const here = resolve(root ?? process.cwd());
  const environment = { ...process.env };
  const git = (folder, args, options = {}) => repositoryGit(folder, args, { ...options, environment, history: folder === here });
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
  const commits = boundedMemo(4096, 1 << 20), blobs = boundedMemo(8192, 1 << 26);
  const trees = boundedMemo(8, 1 << 26, (value) => value.size);
  const lineages = boundedMemo(4096, 1 << 24, (value) => value.names.reduce((sum, name) => sum + name.length * 2 + 32, 0));
  const ancestors = boundedMemo(8192, 1 << 20, () => 128);
  const searches = boundedMemo(4096, 1 << 24, (value) => value.reduce((sum, path) => sum + path.length * 2 + 32, 0));
  const resolveCommit = (folder, commit) => folder ? commits(`${folder}\0${commit}`, () => git(folder, ['rev-parse', '--verify', `${commit}^{commit}`])?.trim() ?? null) : null;
  let judgedRead = false, judged = null, historyRead = false, history = null;
  const judgedCommit = () => {
    if (!judgedRead) { judged = resolveCommit(here, tree === undefined || tree === ':' ? 'HEAD' : tree); judgedRead = true; }
    return judged;
  };
  const grafts = git(here, ['rev-parse', '--git-path', 'info/grafts'])?.trim();
  const shallow = git(here, ['rev-parse', '--git-path', 'shallow'])?.trim();
  const completeHistory = () => {
    try {
      return Boolean(grafts && shallow) && ![grafts, shallow].some((path) => existsSync(resolve(here, path)) && readFileSync(resolve(here, path), 'utf8').trim());
    } catch { return false; }
  };
  const historyIndex = () => {
    if (!completeHistory()) return null;
    if (!historyRead) {
      historyRead = true;
      const tip = judgedCommit();
      const text = tip && git(here, ['log', '--topo-order', '--full-history', '--always', '-m', '--find-renames', '-l0', '--raw', '--no-abbrev', '-z', '--format=%x00@%H %P%x00', tip]);
      history = text === null || !tip ? null : indexHistory(text);
    }
    return history;
  };
  const treeAt = (folder, commit) => {
    const id = resolveCommit(folder, commit);
    if (!id) return null;
    return trees(`${folder}\0${id}`, () => {
      const listed = git(folder, ['ls-tree', '-r', '-t', '-z', id]);
      if (listed === null) return null;
      const entries = new Map(), identities = new Map();
      let size = 0;
      for (const row of listed.split('\0').filter(Boolean)) {
        const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t([\s\S]*)$/.exec(row);
        if (!match) return null;
        const [, mode, type, object, path] = match;
        entries.set(path, { mode, type, object });
        identities.set(makeHashCodeHexFromBytes(Buffer.from(path)), path);
        size += path.length * 2 + object.length * 2 + 256;
      }
      return { entries, identities, size };
    });
  };
  const blobAt = (folder, object) => blobs(`${folder}\0${object}`, () => git(folder, ['cat-file', 'blob', object], { bytes: true }));
  const regularAtCommit = (commit, path, folder = here) => {
    const entry = folder && treeAt(folder, commit)?.entries.get(path);
    return entry && /^100(?:644|755)$/.test(entry.mode) && entry.type === 'blob' ? blobAt(folder, entry.object) : null;
  };
  const copiedBytes = (bytes) => bytes === null ? null : Buffer.from(bytes);
  const ancestor = (before, after) => {
    if (!completeHistory()) return false;
    before = resolveCommit(here, before); after = resolveCommit(here, after);
    if (!before || !after) return false;
    return ancestors(`${before}\0${after}`, () => {
      const index = historyIndex();
      if (!index?.parents.has(after)) return git(here, ['merge-base', '--is-ancestor', before, after]) !== null;
      const pending = [after], seen = new Set();
      while (pending.length) {
        const one = pending.pop();
        if (one === before) return true;
        if (seen.has(one)) continue;
        seen.add(one); pending.push(...(index.parents.get(one) ?? []));
      }
      return false;
    });
  };
  const renameLineage = (commit, path) => {
    commit = resolveCommit(here, commit);
    return lineages(`${commit}\0${path}`, () => {
      const index = historyIndex(), tip = judgedCommit();
      if (!index || !tip || !ancestor(commit, tip)) return null;
      const names = new Set([path]), pending = [path];
      // Close over every historical name first, including merge parents and delete/reintroduce histories.
      while (pending.length) {
        for (const group of index.incoming.get(pending.pop()) ?? []) for (const from of group.from) {
          if (!names.has(from)) { names.add(from); pending.push(from); }
        }
      }
      const entries = treeAt(here, commit)?.entries;
      const regular = (name) => /^100(?:644|755)$/.test(entries?.get(name)?.mode ?? '');
      let then = path;
      if (!regular(path)) {
        const candidates = [...names].filter(regular);
        if (new Set(candidates.map((name) => entries.get(name).object)).size > 1) return null;
        then = candidates[0] ?? path;
      }
      return { then, names: [...names] };
    });
  };
  const targetAtCommit = (commit, path, { followRenames = true } = {}) => {
    const exact = regularAtCommit(commit, path);
    if (exact !== null || !followRenames) return copiedBytes(exact);
    const lineage = renameLineage(commit, path);
    return lineage ? copiedBytes(regularAtCommit(commit, lineage.then)) : null;
  };
  const pathOf = (source) => {
    if (source?.path) return source.path;
    const folder = source?.repository && source?.commit && source?.path_multihash ? checkout(source.repository) : null;
    return folder ? treeAt(folder, source.commit)?.identities.get(source.path_multihash) ?? null : null;
  };
  const relativeParts = (path) => typeof path === 'string' && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every((part) => part && part !== '.' && part !== '..') ? path.split('/') : null;
  const parentPaths = (parts) => parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  const inspectAtCommit = (folder, commit, path) => {
    const parts = relativeParts(path);
    if (!parts) return { state: 'unreadable' };
    const metadata = treeAt(folder, commit);
    if (!metadata) return { state: 'unreadable' };
    for (const parent of parentPaths(parts)) {
      const entry = metadata.entries.get(parent);
      if (entry && (entry.mode !== '040000' || entry.type !== 'tree')) return { state: 'unreadable' };
    }
    const entry = metadata.entries.get(path);
    if (!entry) return { state: 'absent' };
    if (!/^100(?:644|755)$/.test(entry.mode) || entry.type !== 'blob') return { state: 'unreadable' };
    const bytes = blobAt(folder, entry.object);
    return bytes === null ? { state: 'unreadable' } : { state: 'regular', bytes };
  };
  let indexLocation, indexStamp, indexMetadata, judgedIndexStamp;
  const indexGeneration = () => {
    if (!indexLocation) {
      const location = git(here, ['rev-parse', '--git-path', 'index'], { index: true })?.trim();
      if (!location) return null;
      indexLocation = resolve(here, location);
    }
    try {
      const stat = statSync(indexLocation, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) { return error.code === 'ENOENT' ? 'absent-index' : null; }
  };
  const assertScope = () => {
    if (judgedIndexStamp !== undefined && indexGeneration() !== judgedIndexStamp) throw new Error('the staged index changed during the repository judgment');
  };
  const snapshotSpan = (span) => {
    if (span.staged) {
      assertScope();
      const generation = indexGeneration();
      if (generation === null) throw new Error('the staged index generation could not be read');
      judgedIndexStamp = generation;
      return { ...span, head: judgedCommit() ?? EMPTY_TREE };
    }
    return { ...span, to: judgedCommit(), ...(span.from === undefined ? {} : { from: resolveCommit(here, span.from) ?? (span.from === EMPTY_TREE ? EMPTY_TREE : null) }) };
  };
  const stagedIndex = () => {
    assertScope();
    const before = indexGeneration();
    if (before === null) return null;
    if (before === indexStamp) return indexMetadata;
    const listed = git(here, ['ls-files', '--stage', '-z'], { index: true });
    assertScope();
    if (listed === null || before !== indexGeneration()) return null;
    const entries = new Map(), directories = new Set();
    for (const record of listed.split('\0').filter(Boolean)) {
      const row = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record);
      if (!row) return null;
      const [, mode, object, stage, path] = row;
      const parts = path.split('/');
      if (!path || isAbsolute(path) || parts.some((part) => !part || part === '.' || part === '..')) return null;
      if (!entries.has(path)) entries.set(path, []);
      entries.get(path).push({ mode, object, stage });
      for (const parent of parentPaths(parts)) directories.add(parent);
    }
    indexStamp = before; indexMetadata = { entries, directories };
    return indexMetadata;
  };
  const inspectTarget = (path) => {
    const parts = relativeParts(path);
    if (!parts) return { state: 'unreadable' };
    if (tree === undefined) {
      let file = here;
      try {
        for (let index = 0; index < parts.length; index += 1) {
          file = join(file, parts[index]);
          const stat = lstatSync(file);
          if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return { state: 'unreadable' };
        }
        return { state: 'regular', bytes: readFileSync(file) };
      } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
    }
    if (tree !== ':') return inspectAtCommit(here, judgedCommit(), path);
    const metadata = stagedIndex();
    if (!metadata) return { state: 'unreadable' };
    if (parentPaths(parts).some((parent) => metadata.entries.has(parent))) return { state: 'unreadable' };
    const rows = metadata.entries.get(path);
    if (!rows) return { state: metadata.directories.has(path) ? 'unreadable' : 'absent' };
    if (rows.length !== 1 || rows[0].stage !== '0' || !/^100(?:644|755)$/.test(rows[0].mode)) return { state: 'unreadable' };
    const bytes = blobAt(here, rows[0].object);
    return bytes === null ? { state: 'unreadable' } : { state: 'regular', bytes };
  };
  return {
    self,
    checkout,
    mainOf,
    pathOf,
    snapshotSpan,
    assertScope,
    isAncestor: ancestor,
    hasCommit(ref) { return Boolean(resolveCommit(here, ref)); },
    mergeBase(before, after) { return git(here, ['merge-base', before, after])?.trim() ?? null; },
    commitIsAncestor(before, after) { return git(here, ['merge-base', '--is-ancestor', before, after]) !== null; },
    listPaths({ untracked = false } = {}) {
      assertScope();
      const args = tree === undefined ? ['ls-files', '-z', '--cached', ...(untracked ? ['--others', '--exclude-standard'] : [])]
        : tree === ':' ? ['ls-files', '-z'] : ['ls-tree', '-r', '-z', '--name-only', judgedCommit()];
      const listed = git(here, args, { index: tree === ':' });
      assertScope();
      if (listed === null) throw new Error('the declared repository paths could not be read');
      return listed.split('\0').filter(Boolean);
    },
    changesOf(span) {
      span = snapshotSpan(span);
      const diff = span.staged
        ? ['diff', '--cached', '--no-renames', '--numstat', '-z', '--diff-filter=AM', span.head]
        : ['diff', '--no-renames', '--numstat', '-z', '--diff-filter=AM', span.from, span.to];
      const read = (args) => {
        assertScope();
        const listed = git(here, args, { index: Boolean(span.staged) });
        assertScope();
        if (listed === null) throw new Error('the declared repository changes could not be read');
        return listed.split('\0').filter(Boolean);
      };
      const added = new Set(read([...diff.filter((one) => one !== '--numstat' && one !== '--diff-filter=AM'), '--name-only', '--diff-filter=A']));
      return read(diff).map((line) => {
        const [plus, , ...rest] = line.split('\t');
        const path = rest.join('\t');
        return { path, added: added.has(path), lines_added: plus === '-' ? 0 : Number(plus) };
      });
    },
    readSource(source) {
      const path = source?.repository && source?.commit ? pathOf(source) : null;
      return path ? copiedBytes(regularAtCommit(source.commit, path, checkout(source.repository))) : null;
    },
    readTarget(path) {
      const state = inspectTarget(path);
      return state.state === 'regular' ? copiedBytes(state.bytes) : null;
    },
    retirementOf(source) {
      const path = pathOf(source);
      if (!path) return { state: 'unreadable' };
      const state = source.repository === self ? inspectTarget(path)
        : inspectAtCommit(checkout(source.repository), mainOf(source.repository), path);
      return state.state === 'regular' ? { state: 'regular', bytes: copiedBytes(state.bytes) } : state;
    },
    targetAtCommit,
    baselineHistory(commit, paths) {
      if (!completeHistory()) return null;
      const base = resolveCommit(here, commit);
      const judged = judgedCommit();
      if (!base && !judged && commit === 'HEAD' && (tree === undefined || tree === ':') && git(here, ['symbolic-ref', '--quiet', 'HEAD'])) {
        return { ancestor: true, targets: paths.map((path) => ({ path, atBaseline: null, before: [], introductionsOrdered: true })) };
      }
      if (!base || !judged) return null;
      const index = historyIndex();
      if (!index) return null;
      if (!ancestor(base, judged)) return { ancestor: false, targets: [] };
      const targets = paths.map((path) => {
        const lineage = renameLineage(base, path);
        if (!lineage) return null;
        const { then, names } = lineage;
        const events = names.flatMap((name) => [...(index.paths.get(name)?.values() ?? [])].map((event) => ({ ...event, name })));
        return {
          path,
          atBaseline: copiedBytes(regularAtCommit(base, then)),
          before: events.filter((one) => one.content && ancestor(one.revision, base)).map((one) => copiedBytes(regularAtCommit(one.revision, one.name))),
          introductionsOrdered: events.filter((one) => one.introduced).every((one) => ancestor(one.revision, base) || ancestor(base, one.revision)),
        };
      });
      return targets.some((one) => one === null) ? null : { ancestor: ancestor(base, judged), targets };
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
      const found = searches(`${folder}\0${main}\0${pattern}`, () => {
        const byText = git(folder, ['grep', '-z', '-l', '-i', '-I', '-E', '-e', pattern, main, '--']);
        const metadata = treeAt(folder, main);
        if (byText === null || metadata === null) return null;
        const hits = new Set(byText.split('\0').filter(Boolean).map((line) => line.slice(main.length + 1)));
        const matcher = new RegExp(pattern, 'i');
        for (const [path, entry] of metadata.entries) if (entry.type !== 'tree' && matcher.test(path)) hits.add(path);
        return [...hits].sort();
      });
      return found === null ? null : [...found];
    },
  };
}
