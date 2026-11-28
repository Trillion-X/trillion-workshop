// tools/keep-tool-copies-in-step/test/fixtures.ts
//
// Stand-ins the sync tests share, built on the add tool's own (tools/add-a-tool-to-a-project/test/fixtures.ts): an upstream
// that is a local BARE repository (made from a work repository the test commits to and pushes from), a registry pointing
// at it (its origin an example.invalid address the record names), and a project with one tool copied in by
// tool:add-a-tool-to-a-project itself, so every record line is the add tool's real output. Nothing reaches a network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { RECORD_FILE, TOOLS_FOLDER } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
export async function projectWith(up: Upstream, names: string[]): Promise<{ project: string; registry: string; clones: string[] }> {
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
  return { project, registry, clones: [registry] };
}

export const TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\n';
export const toolFiles = (name: string, text = TEXT): Record<string, string> => ({
  [`tools/${name}/what-this-tool-does-and-how-to-run-it.json`]: '{"records":[]}\n',
  [`tools/${name}/do-work/run.mjs`]: text,
});
export { git };

/** Sets top-level fields of the project's record (trust, test) and commits it, as the project's owner would. */
export function setRecord(project: string, fields: Record<string, unknown>): void {
  const file = join(project, TOOLS_FOLDER, RECORD_FILE);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify({ ...record, ...fields }, null, 2)}\n`);
  git(project, '-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-am', 'record fields');
}

/** An owner's address for the stand-in upstream: its commits are read from the work clone given in `clones`. */
export const OWNED = 'https://github.com/example-owner/stand-in-tools.git';
/** Test words that pass and fail. */
export const GREEN = ['node', '-e', 'process.exit(0)'];
export const RED = ['node', '-e', 'console.error("one test failed"); process.exit(1)'];

/** A stand-in landing owner (test/stand-in-landing.mjs): it keeps what it was asked to land in `log` and answers as
 *  land_paths does. */
export const standInLanding = (log: string): string[] => [process.execPath, fileURLToPath(new URL('./stand-in-landing.mjs', import.meta.url)), log, '--repo', '/the/landing/checkout'];
