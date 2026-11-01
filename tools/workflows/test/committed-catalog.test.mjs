import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedTree } from '../read-data/committed-tree.mjs';
import { catalogDocument } from '../read-data/tool-catalog.mjs';

test('a committed catalogue ignores working changes and leaves them intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'workshop-catalog-'));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 });
  const tools = join(root, 'tools');
  const source = join(tools, 'sample', 'tool-rows.json');
  const row = id => JSON.stringify({ records: [{ payload: { kind: 'ai-tool-descriptor', id, label: id, job: 'Read the sample' } }] });
  try {
    git(['init', '-q']);
    mkdirSync(join(tools, 'sample'), { recursive: true });
    writeFileSync(source, row('committed'));
    git(['add', 'tools']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(source, row('edited'));
    mkdirSync(join(tools, 'unfinished'));
    writeFileSync(join(tools, 'unfinished', 'tool-rows.json'), row('untracked'));
    assert.deepEqual(catalogDocument(tools, committedTree(root, commit)).rows.map(item => item.id), ['committed']);
    assert.match(readFileSync(source, 'utf8'), /edited/);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), commit);
    assert.throws(() => committedTree(root, 'missing-ref'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
