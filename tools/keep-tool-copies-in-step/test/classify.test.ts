// Unit: classifyFile over every shape of (base, project, upstream) — absent or present, equal or not — and classifyTool's
// renames and tool verdicts. Pure: no file, no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile, classifyTool } from '../read-data/classify.ts';

const [X, Y, Z] = ['x'.repeat(64), 'y'.repeat(64), 'z'.repeat(64)];

test('classifyFile gives each (b, l, u) shape its verdict', () => {
  const shapes: Array<[string | null, string | null, string | null, string]> = [
    [X, X, X, 'same'],
    [null, X, X, 'same'],
    [X, Y, Y, 'same'],
    [X, null, null, 'same'],
    [X, Y, X, 'project-only'],
    [null, X, null, 'project-only'],
    [X, null, X, 'deleted-project'],
    [X, X, Y, 'upstream-only'],
    [null, null, X, 'upstream-only'],
    [X, X, null, 'deleted-upstream'],
    [X, Y, Z, 'needs-merge'],
    [X, Y, null, 'conflict'],
    [X, null, Y, 'conflict'],
    [null, X, Y, 'conflict'],
  ];
  for (const [b, l, u, verdict] of shapes) assert.equal(classifyFile(b, l, u), verdict, `b=${b?.[0]} l=${l?.[0]} u=${u?.[0]}`);
});

test('a needs-merge file is both-clean only when git merged it; with no answer it is a conflict', () => {
  assert.equal(classifyTool({ a: X }, { a: Y }, { a: Z }, () => true).tool, 'both-clean');
  assert.equal(classifyTool({ a: X }, { a: Y }, { a: Z }).tool, 'both-conflict');
});

test('a rename on one side is reported on both paths; two different renames of one file are a conflict', () => {
  const moved = classifyTool({ old: X }, { new: X }, { old: X });
  assert.deepEqual(moved.renames, [{ from: 'old', to: 'new', side: 'project' }]);
  assert.deepEqual(moved.files, { new: 'renamed-project', old: 'renamed-project' });
  assert.equal(moved.tool, 'project-only');
  const split = classifyTool({ old: X }, { mine: X }, { theirs: X });
  assert.deepEqual(split.files, { mine: 'both-conflict', old: 'both-conflict', theirs: 'both-conflict' });
  assert.equal(split.tool, 'both-conflict');
});

test('two identical files of which one moved name no rename', () => {
  const moved = classifyTool({ a: X, b: X }, { c: X, d: X }, { a: X, b: X });
  assert.deepEqual(moved.renames, []);
});

test('the tool verdict is the strongest over its files', () => {
  assert.equal(classifyTool({ a: X }, { a: X }, { a: X }).tool, 'none-changed');
  assert.equal(classifyTool({ a: X, b: X }, { a: Y, b: X }, { a: X, b: Y }).tool, 'both-clean');
  assert.equal(classifyTool({ a: X, b: X }, { a: Y, b: Y }, { a: Z, b: X }, () => true).tool, 'both-clean');
  assert.equal(classifyTool({ a: X, b: X }, { a: Y }, { a: Z, b: Y }, () => true).tool, 'both-conflict');
  // the same change on both sides moves no file but advances the record
  assert.equal(classifyTool({ a: X }, { a: Y }, { a: Y }).tool, 'upstream-only');
});
