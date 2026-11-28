// tools/add-a-tool-to-a-project/read-data/fetch-folder.ts
//
// PURPOSE
//   Takes the files of one folder of a repository at one commit. When a local clone the caller names already holds the
//   commit (`git cat-file -e`), the run's own repository borrows that clone's objects (git alternates) and nothing goes
//   over the network. Otherwise, or when the clone lacks some of the folder's file contents, it makes a shallow (depth 1),
//   blob-less fetch of the commit and a sparse checkout of only the folder (or only its `paths`), which brings the file
//   contents in one batch. Either way a `git archive` of those files is read by the content-identity owner's tarFiles. The files are exactly what the pin of the
//   commit hashes (tools/workflows/do-work/pin-a-commit-by-its-files.mjs), so the identity computed here is the
//   registry's files_blake3 or it is refused. A commit id names its tree and every file in it, so the bytes are the same
//   whichever repository supplied the objects.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a full 40-hex commit is taken. Read from a clone, the run's repository must resolve it to that same commit;
//      fetched, FETCH_HEAD must be that commit.
//   2. Git checks every object id it receives; the folder identity is computed again from the archived bytes.
//   3. Links and submodules are left out (as the engine's unpack and the pin leave them out); a file path never climbs.
//   4. Everything is written under `scratch`, a folder the caller made and removes. A local clone is only read: it is
//      asked with lazy fetching off (GIT_NO_LAZY_FETCH), so a partial clone never fetches into itself, and its objects are
//      borrowed by path, never copied into it or changed.
//   5. One fetch per (repo, commit): a second folder of the same commit is read from the same objects. The network is
//      used only for a commit no named clone holds, or when the clone lacks some contents the folder needs.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tarFiles, fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { isInsidePath, type Hex64 } from './registry.ts';

export type FileMap = Record<string, Hex64>;
export type Fetched = { files: Array<[string, Buffer, boolean]>; digests: FileMap; files_blake3: Hex64 };

/** Refused because the folder (or one of its named paths) is not in the commit. */
export class NotAtCommit extends Error {}

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
/** One git call in `dir`; its output, or an error carrying what git said. */
const run = (dir: string, args: string[]): Buffer => {
  const done = spawnSync('git', ['-C', dir, ...args], { env: ENV, maxBuffer: 1 << 30 });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new GitRefused(`git ${args[0]} refused: ${done.stderr.toString('utf8').trim()}`);
  return done.stdout;
};

/** Git itself refused a step (an unknown repo, a commit the repo does not hold, no network). */
export class GitRefused extends Error {}

/** The absolute objects folder of `clone` when it holds `commit`; null when it does not, or is not a git folder. */
export function objectsHolding(clone: string, commit: string): string | null {
  const ask = (args: string[]) => spawnSync('git', ['-C', clone, ...args], { env: { ...ENV, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 1 << 20 });
  const held = ask(['cat-file', '-e', `${commit}^{commit}`]);
  if (held.error || held.status !== 0) return null;
  const objects = ask(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (objects.error || objects.status !== 0) return null;
  return realpathSync(objects.stdout.toString('utf8').trim());
}

/** One commit of one repo, kept under `scratch` for the run: borrowed from a local clone that holds it, or fetched. */
export class FetchedCommit {
  readonly dir: string;
  readonly commit: string;
  readonly repo: string;
  /** The local clone whose objects were borrowed, or null when the commit came over the network. */
  readonly clone: string | null = null;
  private fetched = false;
  constructor(scratch: string, repo: string, commit: string, index: number, clones: string[] = []) {
    this.dir = join(scratch, `commit-${index}`);
    this.commit = commit;
    this.repo = repo;
    mkdirSync(this.dir, { recursive: true });
    run(this.dir, ['init', '-q']);
    for (const clone of clones) {
      const objects = objectsHolding(clone, commit);
      if (!objects) continue;
      writeFileSync(join(this.dir, '.git', 'objects', 'info', 'alternates'), `${objects}\n`);
      const head = run(this.dir, ['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim();
      if (head !== commit) throw new NotAtCommit(`The clone ${clone} answered ${head} for the commit ${commit}.`);
      this.clone = clone;
      return;
    }
    this.fetch();
  }

  /** The depth-1, blob-less fetch of the commit from the repo; FETCH_HEAD must be the commit. */
  private fetch(): void {
    run(this.dir, ['remote', 'add', 'origin', this.repo]);
    run(this.dir, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', this.commit]);
    const head = run(this.dir, ['rev-parse', 'FETCH_HEAD']).toString('utf8').trim();
    if (head !== this.commit) throw new NotAtCommit(`The repo ${this.repo} answered ${head} for the commit ${this.commit}.`);
    this.fetched = true;
  }

  /** The regular files of `path` at the commit (only `paths` of it, when given), their digests and the folder identity.
   *  Read from a borrowed clone that lacks some contents, the commit is fetched once and the folder is read again. */
  folder(path: string, paths?: string[]): Fetched {
    try { return this.read(path, paths); } catch (error) {
      if (this.fetched || !(error instanceof GitRefused)) throw error;
      this.fetch();
      return this.read(path, paths);
    }
  }

  private read(path: string, paths?: string[]): Fetched {
    const listed = run(this.dir, ['ls-tree', '-r', '-z', this.commit, '--', `${path}/`]).toString('utf8').split('\0').filter(Boolean)
      .map(line => { const [meta, name] = line.split('\t'); const [mode, type] = meta.split(' '); return { mode, type, name }; });
    const regular = listed.filter(entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755'));
    if (regular.length === 0) throw new NotAtCommit(`${path} holds no files at ${this.commit}.`);
    const inside = (name: string) => name.slice(path.length + 1);
    const wanted = paths ? new Set(paths) : null;
    const chosen = wanted ? regular.filter(entry => wanted.has(inside(entry.name))) : regular;
    if (wanted && chosen.length !== wanted.size) {
      const missing = [...wanted].filter(p => !chosen.some(entry => inside(entry.name) === p));
      throw new NotAtCommit(`${path} at ${this.commit} does not hold ${missing.join(', ')}.`);
    }
    // Fetched blob-less, one sparse checkout brings every chosen file's object in one batch; the archive then reads them
    // locally. Borrowed from a clone, the objects are already on this computer and the archive reads them directly; a
    // missing one refuses the archive, and folder() fetches the commit and reads again.
    if (this.fetched) {
      const patterns = chosen.map(entry => `/${entry.name}`).join('\n') + '\n';
      run(this.dir, ['config', 'core.sparseCheckout', 'true']);
      writeFileSync(join(this.dir, '.git', 'info', 'sparse-checkout'), patterns);
      run(this.dir, ['checkout', '-q', '--detach', '--force', this.commit]);
    }
    const archive = run(this.dir, ['archive', '--format=tar', this.commit, '--', ...chosen.map(entry => entry.name)]);
    const modes = new Map(chosen.map(entry => [entry.name, entry.mode === '100755']));
    const files: Array<[string, Buffer, boolean]> = tarFiles(archive).map(([name, bytes]: [string, Buffer]) => {
      const relative = inside(name);
      if (!isInsidePath(relative)) throw new NotAtCommit(`The archive names ${JSON.stringify(name)}, which is not inside ${path}.`);
      return [relative, bytes, modes.get(name) ?? false];
    });
    const digests: FileMap = Object.fromEntries(files.map(([relative, bytes]) => [relative, fileDigest(bytes)]));
    return { files, digests, files_blake3: identityOfDigests(digests) };
  }
}
