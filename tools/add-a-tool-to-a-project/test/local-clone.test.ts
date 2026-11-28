// 13. A local clone named in clones that already holds the pinned commit is read instead of the network: the project gets
// the same files and the same record bytes as a fetch gives, the clone is left unchanged, and a clone that lacks the
// commit (or some of its contents) falls back to the fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { add } from '../do-work/add.ts';
import { objectsHolding } from '../read-data/fetch-folder.ts';
import { RECORD_FILE, recordPlace } from '../read-data/record.ts';
import { emptyProject, makeRegistry, makeRepo, pinOf, scratch, standInTool, withOrigin } from './fixtures.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
/** The folder of the project that holds its record (read-data/record.ts recordPlace). */
const toolsOf = (project: string) => join(project, recordPlace(project)!);
const recordOf = (project: string) => readFileSync(join(toolsOf(project), RECORD_FILE));

/** Every file under `dir` with its size and modification time, so a later read shows nothing in it changed. */
function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else lines.push(`${relative(dir, path)} ${info.size} ${info.mtimeMs}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

/** A copy of the registry whose every pointer names another repo address (same commit and identity). */
function registryNaming(registry: string, repo: string): string {
  const copy = scratch('registry-copy');
  const data = JSON.parse(readFileSync(join(registry, 'tools-in-this-registry.json'), 'utf8'));
  for (const pointer of Object.values(data.tools) as Array<{ repo: string }>) pointer.repo = repo;
  writeFileSync(join(copy, 'tools-in-this-registry.json'), `${JSON.stringify(data, null, 2)}\n`);
  withOrigin(copy);
  return copy;
}

test('a clone holding the commit gives the same files and record bytes as the fetch, and is left unchanged', async () => {
  const { repo, commit } = makeRepo({ ...standInTool('greet', { needs_tools: ['helper'] }), ...standInTool('helper') });
  const registry = makeRegistry(repo, commit, { greet: ['helper'], helper: [] });
  const clone = scratch('clone');
  execFileSync('git', ['clone', '-q', repo, clone]);
  const before = snapshot(clone);

  const fetchedProject = emptyProject();
  const fetched = await add({ project: fetchedProject, tool: 'greet', from: registry, prepare: false });
  const clonedProject = emptyProject();
  const cloned = await add({ project: clonedProject, tool: 'greet', from: registry, prepare: false, clones: [clone] });

  assert.deepEqual(cloned.refused, []);
  assert.deepEqual(cloned.added, fetched.added);
  assert.deepEqual(cloned.added.map(a => [a.tool, a.files_blake3]), [['greet', pinOf(repo, commit, 'tools/greet')], ['helper', pinOf(repo, commit, 'tools/helper')]]);
  assert.ok(recordOf(clonedProject).equals(recordOf(fetchedProject)), 'the record is the same bytes');
  for (const tool of ['greet', 'helper']) {
    assert.equal(readFileSync(join(toolsOf(clonedProject), tool, 'do-work/x.mjs'), 'utf8'), readFileSync(join(toolsOf(fetchedProject), tool, 'do-work/x.mjs'), 'utf8'));
  }
  assert.equal(snapshot(clone), before, 'nothing in the clone changed');
});

test('a clone holding the commit is read without reaching the repo the pointer names', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const unreachable = registryNaming(makeRegistry(repo, commit, { greet: [] }), join(scratch('gone'), 'no-such-repo.git'));
  const clone = scratch('clone');
  execFileSync('git', ['clone', '-q', repo, clone]);

  const without = await add({ project: emptyProject(), tool: 'greet', from: unreachable, prepare: false });
  assert.deepEqual(without.refused.map(r => r.why), ['fetch-refused']);
  const withClone = await add({ project: emptyProject(), tool: 'greet', from: unreachable, prepare: false, clones: [clone] });
  assert.deepEqual(withClone.refused, []);
  assert.deepEqual(withClone.added.map(a => [a.tool, a.commit, a.files_blake3]), [['greet', commit, pinOf(repo, commit, 'tools/greet')]]);
});

test('a clone without the commit is passed over and the commit is fetched', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const other = makeRepo(standInTool('other')).repo;
  assert.equal(objectsHolding(other, commit), null);
  assert.equal(objectsHolding(scratch('not-git'), commit), null);
  const output = await add({ project: emptyProject(), tool: 'greet', from: registry, prepare: false, clones: [scratch('not-git'), other] });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.files_blake3), [pinOf(repo, commit, 'tools/greet')]);
});

test('a partial clone that holds the commit but not its file contents falls back to the fetch and fetches nothing into itself', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  git(repo, 'config', 'uploadpack.allowFilter', 'true');
  const registry = makeRegistry(repo, commit, { greet: [] });
  const partial = scratch('partial');
  execFileSync('git', ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${repo}`, partial]);
  assert.ok(objectsHolding(partial, commit), 'the partial clone holds the commit');
  const before = snapshot(partial);
  const output = await add({ project: emptyProject(), tool: 'greet', from: registry, prepare: false, clones: [partial] });
  assert.deepEqual(output.refused, []);
  assert.deepEqual(output.added.map(a => a.files_blake3), [pinOf(repo, commit, 'tools/greet')]);
  assert.equal(snapshot(partial), before, 'nothing was fetched into the partial clone');
});

test('clones that is not a list of folders is refused and nothing is written', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const project = emptyProject();
  const output = await add({ project, tool: 'greet', from: registry, clones: 'here' as unknown as string[] });
  assert.deepEqual(output.refused.map(r => r.why), ['bad-from']);
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), ['package.json']);
  const gone = await add({ project, tool: 'greet', from: registry, clones: [join(scratch('gone'), 'no-such-clone')] });
  assert.deepEqual(gone.refused.map(r => r.why), ['bad-from']);
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), ['package.json']);
});
