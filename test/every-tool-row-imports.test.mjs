// Every tool row packs the files its entry program reaches through relative imports (test-helpers/tool-row-imports.mjs).
// A gap is a file the engine would start without: ERR_MODULE_NOT_FOUND on the installed snapshot. Read from HEAD, so the
// check judges the tree under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { toolRowFindings } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');

// The check tree of a landing is an export with no .git of its own. The gate reads git objects, so such a tree is committed into
// a throwaway git folder (its work tree is the export) and judged there; a checkout is judged at its own HEAD.
function judgedTree() {
  if (existsSync(join(repo, '.git'))) return { env: {}, ref: 'HEAD' };
  const gitDir = mkdtempSync(join(tmpdir(), 'tool-row-imports-git-'));
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(gitDir, 'index'), GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' };
  const git = args => execFileSync('git', args, { env: { ...process.env, ...env }, maxBuffer: 2 ** 30 }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A', '-f', '.']);
  return { env, ref: git(['commit-tree', git(['write-tree']), '-m', 'check tree']) };
}

test('every tool row packs every file its entry program reaches through a relative import, and names its entry program', () => {
  const { env, ref } = judgedTree();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let results;
  try { ({ results } = toolRowFindings({ repo, ref })); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
  const gaps = results.flatMap(row => (row.findings || [])
    .filter(f => f.kind === 'missing-relative-import' || f.kind === 'argv-not-declared')
    .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.spec ?? f.target ?? ''} ${f.needs ?? ''}`.trim()));
  assert.deepEqual(gaps, [], `\n${gaps.join('\n')}\n\nAdd each file to the row's invoke.files.package_files (its package's paths, at /opt/<package>).`);
});

test('a folder that is not the top of a git repository is refused, not judged by the repository around it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tool-row-imports-'));
  assert.throws(() => toolRowFindings({ repo: folder, ref: 'HEAD' }), /is not the top of a git repository/);
});

test('reading the imports of a long file takes time in proportion to its size', async () => {
  const { specsOf } = await import('../test-helpers/tool-row-imports.mjs');
  const word = 'export a b c d e f g h i j ';
  // The fastest of five reads: on a loaded computer one read can be paused by other work, which says nothing about the scan,
  // and the fastest is the time the scan itself takes.
  const once = text => { const start = process.hrtime.bigint(); specsOf(text); return Number(process.hrtime.bigint() - start) / 1e6; };
  const clock = reps => { const text = word.repeat(reps) + "import x from './x.mjs';"; return Math.min(...Array.from({ length: 5 }, () => once(text))); };
  clock(200);
  const small = Math.max(clock(2000), 1);
  const large = clock(8000);
  assert.ok(large < small * 10, `4x the text took ${(large / small).toFixed(1)}x the time`);
  assert.deepEqual(specsOf("import { a,\n b } from './y.mjs';\nexport * from './z.mjs';\nconst m = await import('./w.mjs');"), ['./y.mjs', './z.mjs', './w.mjs']);
});

test('type-only imports are not followed, because they are erased before the program runs', async () => {
  const { specsOf } = await import('../test-helpers/tool-row-imports.mjs');
  assert.deepEqual(specsOf("import type { A } from './types.ts';\nexport type { B } from './more.ts';\nimport { c } from './real.ts';"), ['./real.ts']);
});

// A tree of two tools committed into a throwaway repository: `user` reaches `shared` through a .ts program and a relative import.
function fixtureFindings(sharedEntry) {
  const folder = mkdtempSync(join(tmpdir(), 'tool-row-imports-fixture-'));
  const write = (file, text) => { mkdirSync(dirname(join(folder, file)), { recursive: true }); writeFileSync(join(folder, file), text); };
  const row = { kind: 'ai-tool-descriptor', id: 'tool:user', status: 'live', invoke: { argv: ['node', '/opt/user/do-work/run.mjs'], files: { package_files: [{ package: 'user', paths: ['do-work'], at: '/opt/user' }, sharedEntry] } } };
  write('tools/user/tool-rows.json', JSON.stringify({ records: [{ payload: row }] }));
  write('tools/user/do-work/run.mjs', "import { go } from './via.ts';\ngo();\n");
  write('tools/user/do-work/via.ts', "import type { T } from './types.ts';\nexport { go } from '../../shared/read-data/go.mjs';\n");
  write('tools/shared/read-data/go.mjs', 'export const go = () => 1;\n');
  write('test-helpers/tool-row-imports.json', JSON.stringify({ provided_by_the_system: [] }));
  write('package-lock.json', JSON.stringify({ packages: {} }));
  const git = args => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' } }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  return toolRowFindings({ repo: folder, ref: 'HEAD' }).results.flatMap(r => r.findings).map(f => `${f.kind} ${f.needs ?? ''}`.trim());
}

test('a file reached through a .ts program is packed, and only where a relative import finds it', () => {
  assert.deepEqual(fixtureFindings({ package: 'shared', paths: ['read-data'], at: '/opt/shared' }), []);
  assert.deepEqual(fixtureFindings({ package: 'shared', paths: ['read-data'], at: '/opt/node_modules/trillion-workshop/tools/shared' }), ['missing-relative-import tools/shared/read-data/go.mjs']);
  assert.deepEqual(fixtureFindings({ package: 'other', paths: ['read-data'], at: '/opt/other' }), ['missing-relative-import tools/shared/read-data/go.mjs']);
});

// The same shape one place over: a tool's part.json names the files other code reaches, `exports` by name and `public` as a list, and
// an entry whose file is gone names something that loads nothing. Every entry names a file (or, for `<name>/*`, a folder) the tool holds.
test('every part.json export and public entry names a file or folder its tool holds', () => {
  const gone = [];
  const holds = (tool, target) => existsSync(join(repo, 'tools', tool, target.replace(/\/\*$/, '')));
  for (const tool of readdirSync(join(repo, 'tools'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = join(repo, 'tools', tool.name, 'part.json');
    if (!existsSync(file)) continue;
    const part = JSON.parse(readFileSync(file, 'utf8'));
    for (const [name, target] of Object.entries(part.exports ?? {})) if (!holds(tool.name, target)) gone.push(`tools/${tool.name}/part.json exports ${name}: ${target}`);
    for (const target of part.public ?? []) if (typeof target === 'string' && !target.includes('*') && !holds(tool.name, target)) gone.push(`tools/${tool.name}/part.json public: ${target}`);
  }
  assert.deepEqual(gone, [], `\n${gone.join('\n')}\n\nPoint each entry at a file the tool holds, or remove it.`);
});
