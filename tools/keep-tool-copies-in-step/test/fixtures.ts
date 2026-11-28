// tools/keep-tool-copies-in-step/test/fixtures.ts
//
// Stand-ins the sync tests share, built on the add tool's own (tools/add-a-tool-to-a-project/test/fixtures.ts): an upstream
// that is a local BARE repository (made from a work repository the test commits to and pushes from), a registry pointing
// at it (its origin an example.invalid address the record names), and a project with one tool copied in by
// tool:add-a-tool-to-a-project itself, so every record line is the add tool's real output. The project's own repository
// is a local BARE repository standing in for its GitHub remote (the sync reads and pushes only there), published to from
// the author's working repository. Nothing reaches a network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { emptyProject, makeRepo, pinOf, scratch, withOrigin } from '../../add-a-tool-to-a-project/test/fixtures.ts';

export type Upstream = { work: string; bare: string; commit: string };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A bare upstream holding `files` in one commit on main, which may be fetched at any commit it holds. */
export function makeUpstream(files: Record<string, string>): Upstream {
  const { repo: work, commit } = makeRepo(files);
  git(work, 'branch', '-M', 'main');
  const bare = scratch('upstream');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(work, 'remote', 'add', 'upstream', bare);
  return { work, bare, commit };
}

/** One more commit on upstream main: `files` written (null deletes), pushed to the bare repo; its commit. */
export function commitUpstream(up: Upstream, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    const at = join(up.work, path);
    if (text === null) { rmSync(at); continue; }
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, text);
  }
  git(up.work, 'add', '-A');
  git(up.work, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'upstream change');
  git(up.work, 'push', '-q', 'upstream', 'main');
  up.commit = git(up.work, 'rev-parse', 'HEAD');
  return up.commit;
}

/** A registry folder pointing `tools/<name>` of the upstream at `commit`; `repo` is the address the pointer names (the bare
 *  folder by default, or an owner's address whose commits the work clone holds, read through `clones`). */
export function writeRegistry(registry: string, up: Upstream, names: string[], commit = up.commit, repo = up.bare): void {
  const tools = Object.fromEntries(names.map(name => [name, { repo, path: `tools/${name}`, commit,
    files_blake3: pinOf(up.work, commit, `tools/${name}`), what_it_does: `The stand-in ${name}.`, needs_tools: [] }]));
  writeFileSync(join(registry, 'tools-in-this-registry.json'), `${JSON.stringify({ _what: 'A stand-in registry.', tools }, null, 2)}\n`);
}

/** A git project with `names` copied in from a registry of the upstream by the add tool, committed. The registry has an
 *  origin address (example.invalid, never reached), which is what the record names; `clones` holds the registry folder, so
 *  the sync reads it from there, as a computer holding a clone of the registry does. */
export async function projectWith(up: Upstream, names: string[]): Promise<{ project: string; registry: string; clones: string[]; at: Remote }> {
  const registry = scratch('registry');
  writeRegistry(registry, up, names);
  withOrigin(registry);
  const project = emptyProject();
  for (const name of names) {
    const added = await add({ project, tool: name, from: registry, prepare: false });
    if (added.refused.length) throw new Error(JSON.stringify(added.refused));
  }
  git(project, 'init', '-q');
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'tools copied');
  return { project, registry, clones: [registry], at: remoteOf(project) };
}

/** Where the sync finds a project: the bare repository standing in for its remote, and the tool's own state folder. */
export type Remote = { repo: string; state: string };

/** A bare repository made from the author's committed `project` (its branch main), set as the project's origin, and an
 *  empty state folder for the tool. */
export function remoteOf(project: string): Remote {
  git(project, 'branch', '-M', 'main');
  const repo = scratch('project-remote');
  execFileSync('git', ['clone', '-q', '--bare', project, repo]);
  git(repo, 'config', 'uploadpack.allowFilter', 'true');
  git(repo, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(project, 'remote', 'add', 'origin', repo);
  return { repo, state: scratch('state') };
}

/** Commits every change of the author's `project` (when there is one) and pushes its main to the remote. */
export function publish(project: string, message = 'project edit'): void {
  git(project, 'add', '-A');
  if (git(project, 'status', '--porcelain')) git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', message);
  git(project, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
}

/** Every branch of a repository with the commit it names. */
export const refsOf = (repo: string): Record<string, string> => Object.fromEntries(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
  .split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]));

export const TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\n';
export const toolFiles = (name: string, text = TEXT): Record<string, string> => ({
  [`tools/${name}/what-this-tool-does-and-how-to-run-it.json`]: '{"records":[]}\n',
  [`tools/${name}/do-work/run.mjs`]: text,
});
export { git };
