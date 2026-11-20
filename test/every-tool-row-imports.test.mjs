// Every tool row packs the files its entry program reaches through relative imports (test-helpers/tool-row-imports.mjs).
// A gap is a file the engine would start without: ERR_MODULE_NOT_FOUND on the installed snapshot. Read from HEAD, so the
// check judges the tree under test.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { packageFilesByRow, toolRowFindings } from '../test-helpers/tool-row-imports.mjs';
import { PINNED_FILES } from '../test-helpers/pinned-files.mjs';
import { judgedTree, withEnv } from '../test-helpers/judged-tree.mjs';

const repo = resolve(import.meta.dirname, '..');

test('every tool row packs every file its entry program reaches through a relative import, and names its entry program', () => {
  const { env, ref } = judgedTree(repo);
  const { results } = withEnv(env, () => toolRowFindings({ repo, ref }));
  const gaps = results.flatMap(row => (row.findings || [])
    .filter(f => f.kind === 'missing-relative-import' || f.kind === 'argv-not-declared')
    .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.spec ?? f.target ?? ''} ${f.needs ?? ''}`.trim()));
  assert.deepEqual(gaps, [], `\n${gaps.join('\n')}\n\nAdd each file to the row's invoke.files.package_files (its package's paths, at /opt/<package>).`);
});

test('every package a tool row\'s package_files names is one the Workshop\'s pinned files pin, and each is placed once under its lockfile folder', () => {
  const { env, ref } = judgedTree(repo);
  const byRow = withEnv(env, () => packageFilesByRow({ repo, ref }));
  const pinned = JSON.parse(readFileSync(join(repo, PINNED_FILES), 'utf8')).packages;
  const unpinned = [];
  for (const [id, items] of Object.entries(byRow)) {
    const placed = new Set();
    for (const item of items.filter(item => item.packages)) {
      for (const name of item.packages) {
        if (!pinned[name]) unpinned.push(`${id}: ${name}`);
        if (name.startsWith('node_modules/') && item.at !== `/opt/${name}`) unpinned.push(`${id}: ${name} is placed at ${item.at}`);
        if (placed.has(item.at + name)) unpinned.push(`${id}: ${name} is placed twice`);
        placed.add(item.at + name);
      }
    }
    assert.ok(items.every(item => !item.module && !item.module_tree), `${id} names an npm module item, which the engine does not read`);
  }
  assert.deepEqual(unpinned, [], `\n${unpinned.join('\n')}\n\nRun test-helpers/write-pinned-files.mjs after changing the lockfile, and name a package by its lockfile key.`);
});

test('a folder that is not the top of a git repository is refused, not judged by the repository around it', () => {
  const folder = tempFolder(join(tmpdir(), 'tool-row-imports-'));
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
  const folder = tempFolder(join(tmpdir(), 'tool-row-imports-fixture-'));
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

// The engine copies each path a row lays from the row's package into the run's folder before the program starts, and refuses the
// run when one is gone (container.rs copy_tree: NotRunnableHere). A file moved, renamed or kept once in another tool leaves the
// rows that laid it unable to start anything, so every laid path is one the tree holds.
test('every path a tool row lays is a file or folder of its package', () => {
  const gone = [];
  for (const tool of readdirSync(join(repo, 'tools'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = join(repo, 'tools', tool.name, 'tool-rows.json');
    if (!existsSync(file)) continue;
    for (const { payload } of JSON.parse(readFileSync(file, 'utf8')).records ?? []) {
      for (const entry of [payload?.invoke?.files?.package_files ?? []].flat()) {
        if (typeof entry?.package !== 'string') continue;
        for (const laid of entry.paths ?? []) if (!existsSync(join(repo, 'tools', entry.package, laid))) gone.push(`${payload.id}: tools/${entry.package}/${laid}`);
      }
    }
  }
  assert.deepEqual(gone, [], `\n${gone.join('\n')}\n\nLay the file where it is now (its kept copy, or its new folder), or take the path out of the row.`);
});

// A row may pin a package itself (invoke.packages: name, version and fetched archive). The engine fetches it, but a bare import
// finds it only where a package_files entry lays it, /opt/node_modules/<name>; a pinned package laid nowhere is a program that
// starts and then fails "Cannot find package" the first time it imports it.
test('every package a tool row pins in invoke.packages is laid at /opt/node_modules/<name>', () => {
  const unlaid = [];
  for (const tool of readdirSync(join(repo, 'tools'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = join(repo, 'tools', tool.name, 'tool-rows.json');
    if (!existsSync(file)) continue;
    for (const { payload } of JSON.parse(readFileSync(file, 'utf8')).records ?? []) {
      const invoke = payload?.invoke ?? {};
      const entries = [invoke.files?.package_files ?? []].flat();
      for (const name of Object.keys(invoke.packages ?? {})) {
        if (!entries.some(entry => (entry.packages ?? []).includes(name) && entry.at === `/opt/node_modules/${name}`)) unlaid.push(`${payload.id}: ${name}`);
      }
    }
  }
  assert.deepEqual(unlaid, [], `\n${unlaid.join('\n')}\n\nAdd { packages: [name], at: /opt/node_modules/<name> } to the row's invoke.files.package_files.`);
});

test('a bare import of a package the row pins counts as declared only where the row lays it', () => {
  const findings = laid => {
    const folder = tempFolder(join(tmpdir(), 'tool-row-imports-pinned-'));
    const write = (file, text) => { mkdirSync(dirname(join(folder, file)), { recursive: true }); writeFileSync(join(folder, file), text); };
    const files = [{ package: 'user', paths: ['do-work'], at: '/opt/user' }, ...(laid ? [{ packages: ['pg'], at: '/opt/node_modules/pg' }] : [])];
    const row = { kind: 'ai-tool-descriptor', id: 'tool:user', status: 'live', invoke: { argv: ['node', '/opt/user/do-work/run.mjs'], packages: { pg: { version: '8.23.1' } }, files: { package_files: files } } };
    write('tools/user/tool-rows.json', JSON.stringify({ records: [{ payload: row }] }));
    write('tools/user/do-work/run.mjs', "const { default: pg } = await import('pg');\nexport { pg };\n");
    write('test-helpers/tool-row-imports.json', JSON.stringify({ provided_by_the_system: [] }));
    write('package-lock.json', JSON.stringify({ packages: {} }));
    const git = args => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' } }).toString().trim();
    git(['init', '-q']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fixture']);
    return toolRowFindings({ repo: folder, ref: 'HEAD' }).results.flatMap(r => r.findings).filter(f => f.kind === 'bare-import-not-declared').map(f => f.spec);
  };
  assert.deepEqual(findings(true), []);
  assert.deepEqual(findings(false), ['pg']);
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

// A package a row lays imports, at run time, the packages its lockfile entry depends on; each of those its laid files import is
// laid beside it, or the program stops at module load ("Cannot find package 'tldts-core' imported from /opt/node_modules/tldts").
// tool:walk-a-new-person-through-first-setup failed every live run this way (Nov 18 2026). Only dependencies the package's laid
// code names count: a dependency kept for types (@babel/parser's @babel/types) is never loaded.
test('every package a tool row lays has each dependency its laid code imports laid beside it', () => {
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).packages;
  const named = /(?:\brequire\(\s*|\bfrom\s*|\bimport\(\s*|^\s*import\s+)['"]((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]*)?)['"]/gm;
  const top = spec => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const read = new Map();
  const importsOf = (name, laid) => {
    const key = `${name}|${laid}`;
    if (!read.has(key)) {
      const found = new Set();
      const walk = path => {
        if (!existsSync(path)) return;
        if (statSync(path).isDirectory()) { for (const entry of readdirSync(path)) walk(join(path, entry)); return; }
        if (/\.(c|m)?js$/.test(path)) for (const match of readFileSync(path, 'utf8').matchAll(named)) found.add(top(match[1]));
      };
      walk(join(repo, 'node_modules', name, laid));
      read.set(key, found);
    }
    return read.get(key);
  };
  const unlaid = [];
  for (const tool of readdirSync(join(repo, 'tools'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = join(repo, 'tools', tool.name, 'tool-rows.json');
    if (!existsSync(file)) continue;
    for (const { payload } of JSON.parse(readFileSync(file, 'utf8')).records ?? []) {
      const items = [payload?.invoke?.files?.package_files ?? []].flat().filter(item => item && typeof item === 'object');
      const laid = new Set(items.flatMap(item => item.packages ?? []));
      for (const item of items) for (const key of item.packages ?? []) {
        if (!key.startsWith('node_modules/')) continue;
        const name = key.slice('node_modules/'.length);
        const used = new Set((item.paths ?? ['.']).flatMap(path => [...importsOf(name, path)]));
        for (const dependency of Object.keys(lock[key]?.dependencies ?? {})) {
          if (used.has(dependency) && !laid.has(`node_modules/${dependency}`)) unlaid.push(`${payload.id}: ${name} needs ${dependency}`);
        }
      }
    }
  }
  assert.deepEqual(unlaid, [], `\n${unlaid.join('\n')}\n\nAdd { packages: ["node_modules/<dependency>"], paths, at: "/opt/node_modules/<dependency>" } to the row's invoke.files.package_files.`);
});
