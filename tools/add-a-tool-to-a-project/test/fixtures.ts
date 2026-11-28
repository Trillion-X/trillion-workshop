// tools/add-a-tool-to-a-project/test/fixtures.ts
//
// Stand-ins the add tests share: a git repository made from given files, a registry folder pointing at folders of it (each
// pointer's files_blake3 computed by the content-identity owner from `git archive`, as a real registry's pin is), and an
// empty project folder. Everything is made under the test process's own temp folder (test-helpers/own-tmpdir.mjs).
// Each stand-in repository and registry has a git origin address (example.invalid, never reached), because a project
// record names a registry or repo only by an address every computer can reach; the files are read from the folder.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { manifestIdentity, tarFiles } from '../../content-identity/read-data/manifest.mjs';

export const scratch = (name: string): string => tempFolder(join(tmpdir(), `add-a-tool-${name}-`));

/** Gives `folder` a git origin address of its own (making it a git folder when it is not) and returns that address. */
export function withOrigin(folder: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
  if (!existsSync(join(folder, '.git'))) git('init', '-q');
  const address = `https://example.invalid/${basename(folder)}.git`;
  git('remote', 'add', 'origin', address);
  return address;
}

/** The git origin address of a stand-in folder: what a project record names it by. */
export const originAddress = (folder: string): string =>
  execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();

/** A repository holding `files` (path -> text) in one commit; its folder and the commit. */
export function makeRepo(files: Record<string, string>): { repo: string; commit: string } {
  const repo = scratch('repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '-A');
  git('-c', 'user.name=Example', '-c', 'user.email=maker@example.com', 'commit', '-q', '-m', 'tools');
  withOrigin(repo);
  return { repo, commit: git('rev-parse', 'HEAD') };
}

/** The pin of one folder of a commit, as the registry's files_blake3 is made. */
export function pinOf(repo: string, commit: string, path: string): string {
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', commit, '--', path], { maxBuffer: 1 << 30 });
  return manifestIdentity(tarFiles(archive).map(([name, bytes]: [string, Buffer]) => [name.slice(path.length + 1), bytes]));
}

/** A registry folder pointing at `tools/<name>` of the repo for each name, with the given needs. */
export function makeRegistry(repo: string, commit: string, needs: Record<string, string[]>): string {
  const registry = scratch('registry');
  const tools = Object.fromEntries(Object.entries(needs).map(([name, needsTools]) => [name, {
    repo, path: `tools/${name}`, commit, files_blake3: pinOf(repo, commit, `tools/${name}`),
    what_it_does: `The stand-in ${name}.`, needs_tools: needsTools,
  }]));
  writeFileSync(join(registry, 'tools-in-this-registry.json'), `${JSON.stringify({ _what: 'A stand-in registry.', tools }, null, 2)}\n`);
  withOrigin(registry);
  return registry;
}

export const emptyProject = (): string => {
  const project = scratch('project');
  writeFileSync(join(project, 'package.json'), '{"name":"a-project","private":true}\n');
  return project;
};

/** A plain stand-in tool: a card with the given extra facts and one do-work file. */
export const standInTool = (name: string, card: Record<string, unknown> = {}): Record<string, string> => ({
  [`tools/${name}/what-this-tool-does-and-how-to-run-it.json`]: `${JSON.stringify({ records: [], ...card }, null, 2)}\n`,
  [`tools/${name}/do-work/x.mjs`]: `export const name = ${JSON.stringify(name)};\n`,
});
