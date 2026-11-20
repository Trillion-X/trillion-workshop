// No row file may name a package with a `module` package_files item. The engine reads a package_files item as a copy of
// files (`package`, a shared package folder), or as a pinned package a run fetches (`packages`, the names the pinned-files
// manifest gives, e.g. node_modules/@noble/hashes). A `module` item is a kind it no longer reads, so the run it belongs to
// is refused before anything starts (trillion-rust src/tool_runs/tools/container.rs place_items).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');

// Every item of a `package_files` key, at any depth, that holds a `module` key.
function moduleItems(node, where, found) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => moduleItems(value, `${where}[${index}]`, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'package_files') {
        const items = Array.isArray(value) ? value : [value];
        items.forEach((item, index) => {
          if (item && typeof item === 'object' && 'module' in item) found.push(`${where}.package_files[${index}]`);
        });
      }
      moduleItems(value, `${where}.${key}`, found);
    }
  }
  return found;
}

test('no row file names a package with a module package_files item', () => {
  const files = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', '*.json'], { maxBuffer: 2 ** 30 })
    .toString().split('\0').filter(Boolean);
  const problems = [];
  for (const file of files) {
    const text = readFileSync(join(repo, file), 'utf8');
    if (!text.trim()) continue;
    for (const where of moduleItems(JSON.parse(text), '$', [])) problems.push(`${file} ${where}`);
  }
  assert.deepEqual(problems, [], `a module package_files item is a kind the engine no longer reads; use packages with the pinned name (node_modules/<name>):\n${problems.join('\n')}`);
});
