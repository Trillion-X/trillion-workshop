// Every tool row packs the files its entry program reaches through relative imports and through relative file reads
// (readFileSync(new URL('<relative>', import.meta.url))) (test-helpers/tool-row-imports.mjs). A gap is a file the engine
// would start without: ERR_MODULE_NOT_FOUND or ENOENT on the installed snapshot. Read from HEAD, so the check judges the
// tree under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toolRowFindings, GATE_KINDS } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');
const gapsOf = results => results.flatMap(row => (row.findings || [])
  .filter(f => GATE_KINDS.includes(f.kind) && f.kind !== 'door-without-records')
  .map(f => `${row.row_file} ${row.id}: ${f.kind} ${f.spec ?? f.target ?? ''} ${f.needs ?? ''}`.trim()));

test('every tool row packs every file its entry program reaches through a relative import or a relative file read, and names its entry program', () => {
  const gaps = gapsOf(toolRowFindings({ repo, ref: 'HEAD' }).results);
  assert.deepEqual(gaps, [], `\n${gaps.join('\n')}\n\nAdd each file to the row's invoke.files.package_files (its package's paths, at /opt/<package>).`);
});

// A tree of one tool whose program reads ../tool-rows.json and ./settings.json through new URL(..., import.meta.url), the
// shape that broke every decision tool when decisions.mjs began reading its own rows (packed: read-data only).
function treeWith(paths) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-row-reads-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(join(dir, 'test-helpers'));
  mkdirSync(join(dir, 'tools/a-tool/read-data'), { recursive: true });
  copyFileSync(join(repo, 'test-helpers/tool-row-imports.json'), join(dir, 'test-helpers/tool-row-imports.json'));
  writeFileSync(join(dir, 'package-lock.json'), '{"packages":{}}');
  writeFileSync(join(dir, 'tools/a-tool/read-data/settings.json'), '{}');
  writeFileSync(join(dir, 'tools/a-tool/read-data/program.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));",
    "const rows = JSON.parse(readFileSync(new URL( \"../tool-rows.json\" ,import.meta.url), 'utf8'));",
    'export const run = () => ({ settings, rows });',
  ].join('\n'));
  const row = { id: 'tool:a-tool', kind: 'ai-tool-descriptor', invoke: { argv: ['node', '/opt/a-tool/read-data/program.mjs'], files: { package_files: [{ package: 'a-tool', paths, at: '/opt/a-tool' }] } } };
  writeFileSync(join(dir, 'tools/a-tool/tool-rows.json'), JSON.stringify({ records: [{ payload: row }] }));
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tree');
  return dir;
}

test('a file a program reads through new URL(<relative>, import.meta.url) and its row does not pack is a gap', () => {
  const dir = treeWith(['read-data']);
  const { results, byRow } = toolRowFindings({ repo: dir, ref: 'HEAD' });
  assert.deepEqual(gapsOf(results), ['tools/a-tool/tool-rows.json tool:a-tool: missing-relative-read ../tool-rows.json tools/a-tool/tool-rows.json']);
  assert.deepEqual(byRow['tool:a-tool'].at(-1), { package: 'a-tool', paths: ['tool-rows.json'], at: '/opt/a-tool' }, 'the publish step packs the read file too');
});

test('a row that packs the file it reads has no gap', () => {
  const dir = treeWith(['read-data', 'tool-rows.json']);
  assert.deepEqual(gapsOf(toolRowFindings({ repo: dir, ref: 'HEAD' }).results), []);
});
