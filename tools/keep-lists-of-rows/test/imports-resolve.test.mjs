// Every relative import in tools/keep-lists-of-rows resolves to a file the Workshop holds, except the web shell's
// screens that source-data/answered-by-the-web-shell.json names (type imports from bundled files only), and the files
// node loads (lists.mjs) load with every file they reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import shell from '../source-data/answered-by-the-web-shell.json' with { type: 'json' };

const tool = resolve(import.meta.dirname, '..');
const workshop = resolve(tool, '../..');
const SPEC = /(?:import|export)\s(?:type\s)?[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.mts', '.d.ts', '/index.ts', '/index.mjs'];
const fileAt = path => EXTENSIONS.map(ext => path + ext).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
const code = path => /\.(m?[jt]sx?|mts)$/.test(path);

function relativeImports(file) {
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return [...text.matchAll(SPEC)].map(m => m[1] ?? m[2] ?? m[3]).filter(spec => spec.startsWith('.'));
}
function filesIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesIn(path) : code(entry.name) ? [path] : [];
  });
}
const answered = target => shell.prefixes.some(prefix => relative(workshop, target).startsWith(prefix.path));

test('every relative import in the tool resolves in the Workshop, or is a web shell screen the page answers', () => {
  const files = filesIn(tool);
  const unresolved = [], byShell = [];
  for (const file of files) for (const spec of relativeImports(file)) {
    const target = resolve(dirname(file), spec);
    if (fileAt(target)) continue;
    (answered(target) ? byShell : unresolved).push(`${relative(tool, file)} -> ${spec}`);
  }
  assert.deepEqual(unresolved, []);
  for (const line of byShell) assert.ok(!shell.node_entries.some(entry => line.startsWith(`${entry} `)), `${line}: node loads this file; no web shell answers it`);
  console.log(`${files.length} files, ${byShell.length} imports answered by the web shell`);
});

test('the files node loads reach only files the Workshop holds, and load', async () => {
  for (const entry of shell.node_entries) {
    const seen = new Set(), missing = [], stack = [join(tool, entry)];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      if (!code(file)) continue;
      for (const spec of relativeImports(file)) {
        const target = fileAt(resolve(dirname(file), spec));
        if (target) stack.push(target); else missing.push(`${relative(workshop, file)} -> ${spec}`);
      }
    }
    assert.deepEqual(missing, [], `${entry} reaches imports the Workshop does not hold`);
    const loaded = await import(join(tool, entry));
    assert.ok(Object.keys(loaded).length > 0, `${entry} exports nothing`);
    console.log(`${entry}: ${seen.size} files reached, all held, loaded`);
  }
});
