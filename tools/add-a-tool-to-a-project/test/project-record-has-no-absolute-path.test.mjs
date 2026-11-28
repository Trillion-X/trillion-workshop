// The project record (where-each-tool-comes-from.json) travels in the project's git, so it holds no path of the computer
// that wrote it: a registry and a direct pointer's repo are recorded by an address every computer can reach (a local
// folder given as from is recorded as its git origin address), each copy's locator is its `at`, relative to the project's
// top, and a local registry with no origin address is refused with nothing written. The absolute anchor of the project
// lives only in each computer's own settings.
//
//   node --test test/project-record-has-no-absolute-path.test.mjs   (from the tool's folder, or with the path from the root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { add } from '../do-work/add.ts';
import { RECORD_FILE, recordPlace } from '../read-data/record.ts';
import { isReachableAddress } from '../read-data/registry.ts';
import { emptyProject, makeRegistry, makeRepo, originAddress, scratch, standInTool } from './fixtures.ts';

/** The folder of the project that holds its record (read-data/record.ts recordPlace). */
const toolsOf = project => join(project, recordPlace(project));

/** Every string in a JSON value, with the path of keys that reaches it (object keys are checked too). */
function strings(value, at = '$') {
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [[`${at} key`, key], ...strings(item, `${at}.${key}`)]);
  }
  return [];
}

/** True when the text is a path of this computer: absolute, home-relative, a drive path or a file: address. */
const isLocalPath = text => text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('file:') || text.includes('\\');

test('the record names registries and repos by reachable addresses and holds no path of this computer', async () => {
  const { repo, commit } = makeRepo({ ...standInTool('greet', { needs_tools: ['helper'] }), ...standInTool('helper'), ...standInTool('wave') });
  const registry = makeRegistry(repo, commit, { greet: ['helper'], helper: [] });
  const project = emptyProject();

  const fromRegistry = await add({ project, tool: 'greet', from: registry, prepare: false });
  assert.deepEqual(fromRegistry.refused, []);
  const direct = await add({ project, tool: 'wave', from: { repo, path: 'tools/wave', commit }, prepare: false });
  assert.deepEqual(direct.refused, []);

  const tools = toolsOf(project);
  const text = readFileSync(join(tools, RECORD_FILE), 'utf8');
  const record = JSON.parse(text);
  const local = strings(record).filter(([, value]) => isLocalPath(value));
  assert.deepEqual(local, [], 'no value or key of the record is a path of this computer');
  for (const folder of [project, tools, registry, repo]) assert.ok(!text.includes(folder), `the record does not name ${folder}`);

  assert.equal(record.registry, originAddress(registry));
  assert.ok(isReachableAddress(record.registry));
  for (const [name, line] of Object.entries(record.tools)) {
    assert.ok(existsSync(join(project, line.at)), `${name} is at its line's at, relative to the project's top`);
    if ('registry' in line.from) assert.ok(isReachableAddress(line.from.registry), `${name}'s registry is an address`);
    if ('repo' in line.from) assert.equal(line.from.repo, originAddress(repo), `${name}'s repo is its origin address`);
  }
  assert.deepEqual(Object.keys(record.tools).sort(), ['greet', 'helper', 'wave']);
});

test('a local registry or repo with no origin address is refused and nothing is written', async () => {
  const { repo, commit } = makeRepo(standInTool('greet'));
  const registry = makeRegistry(repo, commit, { greet: [] });
  const bare = scratch('registry-without-origin');
  writeFileSync(join(bare, 'tools-in-this-registry.json'), readFileSync(join(registry, 'tools-in-this-registry.json')));
  const repoWithoutOrigin = scratch('repo-without-origin');
  execFileSync('git', ['clone', '-q', '--no-local', repo, repoWithoutOrigin]);
  execFileSync('git', ['-C', repoWithoutOrigin, 'remote', 'remove', 'origin']);
  const project = emptyProject();
  for (const from of [bare, { repo: repoWithoutOrigin, path: 'tools/greet', commit }]) {
    const output = await add({ project, tool: 'greet', from, prepare: false });
    assert.deepEqual(output.refused.map(r => r.why), ['bad-from'], JSON.stringify(from));
  }
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), ['package.json']);
});

test('an https address carrying a user or password is refused, so no key is ever recorded', async () => {
  const project = emptyProject();
  for (const from of ['https://someone:secret@example.invalid/registry.git', 'https://token@example.invalid/registry.git']) {
    const output = await add({ project, tool: 'greet', from, prepare: false });
    assert.deepEqual(output.refused.map(r => r.why), ['bad-from'], from);
  }
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), ['package.json']);
});
