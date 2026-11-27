// tools/add-a-tool-to-a-project/read-data/fetch-folder.ts
//
// PURPOSE
//   Takes the files of one folder of a repository at one commit: a shallow (depth 1), blob-less fetch of the commit, a
//   sparse checkout of only the folder (or only its `paths`), then `git archive` of those files read by the content-identity
//   owner's tarFiles. The files are exactly what the pin of the commit hashes (tools/workflows/do-work/
//   pin-a-commit-by-its-files.mjs), so the identity computed here is the registry's files_blake3 or it is refused.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a full 40-hex commit is fetched, and FETCH_HEAD must be that commit.
//   2. Git checks every object id it receives; the folder identity is computed again from the archived bytes.
//   3. Links and submodules are left out (as the engine's unpack and the pin leave them out); a file path never climbs.
//   4. Everything is written under `scratch`, a folder the caller made and removes; nothing outside it is touched.
//   5. One fetch per (repo, commit): a second folder of the same commit is read from the same fetched objects.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/** One fetched commit of one repo, kept under `scratch` for the run. */
export class FetchedCommit {
  readonly dir: string;
  readonly commit: string;
  constructor(scratch: string, repo: string, commit: string, index: number) {
    this.dir = join(scratch, `commit-${index}`);
    this.commit = commit;
    mkdirSync(this.dir, { recursive: true });
    run(this.dir, ['init', '-q']);
    run(this.dir, ['remote', 'add', 'origin', repo]);
    run(this.dir, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', commit]);
    const head = run(this.dir, ['rev-parse', 'FETCH_HEAD']).toString('utf8').trim();
    if (head !== commit) throw new NotAtCommit(`The repo ${repo} answered ${head} for the commit ${commit}.`);
  }

  /** The regular files of `path` at the commit (only `paths` of it, when given), their digests and the folder identity. */
  folder(path: string, paths?: string[]): Fetched {
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
    // One sparse checkout brings every chosen file's object in one batch; the archive then reads them locally.
    const patterns = chosen.map(entry => `/${entry.name}`).join('\n') + '\n';
    run(this.dir, ['config', 'core.sparseCheckout', 'true']);
    writeFileSync(join(this.dir, '.git', 'info', 'sparse-checkout'), patterns);
    run(this.dir, ['checkout', '-q', '--detach', '--force', this.commit]);
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
