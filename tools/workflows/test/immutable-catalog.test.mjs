import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { committedTree, immutableTree } from '../read-data/committed-tree.mjs';
import { catalogText } from '../read-data/tool-catalog.mjs';

const command = fileURLToPath(new URL('../do-work/publish-tool-catalog.mjs', import.meta.url));
const published = new URL('../published/tools.json', import.meta.url);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'immutable-catalog-'));
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  const row = id => JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', id, label: id, job: 'Read the sample' } }] });
  const blob = git(['hash-object', '-w', '--stdin'], row('immutable'));
  const folder = git(['mktree'], `100644 blob ${blob}\ttool-rows.json\n`);
  const toolsTree = git(['mktree'], `040000 tree ${folder}\tsample\n`);
  const tree = git(['mktree'], `040000 tree ${toolsTree}\ttools\n`);
  git(['read-tree', tree]);
  const tools = join(root, 'tools');
  mkdirSync(join(tools, 'sample'), { recursive: true });
  writeFileSync(join(tools, 'sample', 'tool-rows.json'), row('dirty'));
  mkdirSync(join(tools, 'unfinished'));
  writeFileSync(join(tools, 'unfinished', 'tool-rows.json'), row('untracked'));
  return { root, tools, tree, blob, git, close: () => rmSync(root, { recursive: true, force: true }) };
}

const run = (f, ...args) => spawnSync(process.execPath, [command, f.tools, ...args], { encoding: 'utf8', timeout: 30_000 });

test('an explicit immutable tree ignores working and index changes without moving HEAD or writing files', () => {
  const f = fixture();
  try {
    const head = readFileSync(join(f.root, '.git', 'HEAD'));
    const index = readFileSync(join(f.root, '.git', 'index'));
    const output = readFileSync(published);
    const reader = immutableTree(f.root, f.tree);
    assert.equal(reader.tree, f.tree);
    assert.equal(Object.hasOwn(reader, 'commit'), false, 'an uncommitted tree is never represented as a source commit');
    const expected = catalogText(f.tools, reader);
    assert.deepEqual(JSON.parse(expected).rows.map(row => row.id), ['immutable']);
    const result = run(f, '--git-tree', f.tree, '--stdout');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, 'stdout is exactly the existing catalogue serializer output');
    assert.equal(result.stderr, '');
    assert.deepEqual(readFileSync(published), output);
    assert.deepEqual(readFileSync(join(f.root, '.git', 'HEAD')), head);
    assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), index);
    assert.match(readFileSync(join(f.tools, 'sample', 'tool-rows.json'), 'utf8'), /dirty/);
    assert.match(readFileSync(join(f.tools, 'unfinished', 'tool-rows.json'), 'utf8'), /untracked/);
    // Changing only the fixture index does not change an already-bound tree or the command's explicit tree input.
    f.git(['read-tree', '--empty']);
    assert.equal(catalogText(f.tools, reader), expected);
    const changedIndex = readFileSync(join(f.root, '.git', 'index'));
    assert.equal(run(f, '--git-tree', f.tree, '--stdout').stdout, expected);
    assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), changedIndex);
  } finally { f.close(); }
});

test('immutable tree input refuses refs, abbreviations, expressions, non-tree objects and unknown objects', () => {
  const f = fixture();
  try {
    for (const value of ['HEAD', f.tree.slice(0, 12), `${f.tree}^{tree}`, '-invalid', f.blob, '0'.repeat(40)]) {
      assert.throws(() => immutableTree(f.root, value), value);
      const result = run(f, '--git-tree', value, '--stdout');
      assert.notEqual(result.status, 0, value);
      assert.equal(result.stdout, '', 'a refused tree emits no catalogue prefix');
    }
    assert.throws(() => committedTree(f.root, f.tree), 'the commit reader still refuses a bare uncommitted tree');
  } finally { f.close(); }
});

test('candidate catalogue CLI refuses conflicting or incomplete modes before any output file changes', () => {
  const f = fixture();
  try {
    const before = readFileSync(published);
    for (const args of [
      ['--git-tree', f.tree],
      ['--git-tree'],
      ['--git-tree', '--stdout'],
      ['--git-tree', f.tree, '--git-ref', 'HEAD', '--stdout'],
      ['--git-tree', f.tree, '--stdout', '--check'],
      ['--git-ref', '--stdout'],
    ]) {
      const result = run(f, ...args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.stdout, '');
      assert.deepEqual(readFileSync(published), before);
    }
  } finally { f.close(); }
});
