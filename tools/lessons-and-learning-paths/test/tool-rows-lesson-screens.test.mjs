// The two lesson screens are rows: each screen module entry is a file in this folder, and each row packs the files its
// tool container runs. The course list reads the same function as the do-work script (one copy, in read-data).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(FOLDER, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const byTool = id => rows.find(row => row.id === id);

test('the lesson screen and the course list are both screen modules whose entries exist', () => {
  for (const id of ['tool:show-the-courses-a-learner-is-on', 'tool:list-the-courses-a-learner-is-on']) {
    const row = byTool(id);
    assert.equal(row.screen.kind, 'module', id);
    assert.equal(row.screen.module.package, 'lessons-and-learning-paths', id);
    assert.ok(existsSync(join(FOLDER, row.screen.module.entry)), row.screen.module.entry);
  }
});

test('the course list row packs the function it reads, and the lesson row packs it too', () => {
  for (const id of ['tool:show-the-courses-a-learner-is-on', 'tool:list-the-courses-a-learner-is-on']) {
    const paths = byTool(id).invoke.files.package_files.paths;
    assert.ok(paths.includes('read-data/courses-of-a-learner.mjs'), id);
    for (const path of paths) assert.ok(existsSync(join(FOLDER, path)), `${id} packs ${path}`);
  }
});

test('the do-work script and the course list run the same function', () => {
  const script = readFileSync(join(FOLDER, 'do-work/show-the-courses-a-learner-is-on.mjs'), 'utf8');
  const list = readFileSync(join(FOLDER, 'web/course-list-screen-mount.tsx'), 'utf8');
  assert.match(script, /from '\.\.\/read-data\/courses-of-a-learner\.mjs'/);
  assert.match(list, /from '\.\.\/read-data\/courses-of-a-learner\.mjs'/);
});
