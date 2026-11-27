// Every program a tool row starts (invoke.run) must test whether it is the entry point with the one idiom: the real path of
// argv[1] against the real path of the module. A guard that compares a file URL built from a raw path, or the raw argv
// with the module URL, misses on a symlinked folder or a path with a space, and the program then exits 0 having done
// nothing. This test keeps that from coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Only committed files are checked: an untracked file is someone's work in progress, and it is checked once it is committed.
let committedSet;
function committed() {
  if (!committedSet) committedSet = new Set(execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean));
  return committedSet;
}

function toolRowFiles(dir = join(root, 'tools')) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...toolRowFiles(path));
    else if (name === 'what-this-tool-does-and-how-to-run-it.json') found.push(path);
  }
  return found;
}

// A program the engine runs from an installed package (/opt/<package>/<path>) is the committed file with that path under
// the package's tool folder.
function resolveInstalled(program) {
  const [, , pkg, ...rest] = program.split('/');
  const tail = rest.join('/');
  const hits = [...committed()].filter(file => file.startsWith('tools/') && (file === tail || file.endsWith(`/${tail}`)));
  return hits.find(file => file.includes(`/${pkg}/`)) ?? hits[0] ?? null;
}

function resolveProgram(program, rowFile) {
  if (program.startsWith('/opt/')) return resolveInstalled(program);
  const relPath = program.startsWith('trillion-workshop/')
    ? program.slice('trillion-workshop/'.length)
    : relative(root, resolve(dirname(rowFile), program));
  return committed().has(relPath) && existsSync(join(root, relPath)) ? relPath : null;
}

// The programs the tool rows start: the .mjs or .js entry of each invoke.run, resolved to a committed file of this checkout.
function rowPrograms() {
  const programs = new Set();
  const visit = (node, file) => {
    if (Array.isArray(node)) return node.forEach(child => visit(child, file));
    if (!node || typeof node !== 'object') return;
    if (node.invoke && Array.isArray(node.invoke.run)) {
      const program = node.invoke.run.find(arg => /\.(mjs|js)$/.test(arg));
      if (program) {
        const path = resolveProgram(program, file);
        if (path && existsSync(join(root, path))) programs.add(path);
      }
    }
    for (const value of Object.values(node)) visit(value, file);
  };
  for (const file of toolRowFiles()) visit(JSON.parse(readFileSync(file, 'utf8')), file);
  return [...programs].sort();
}

const idiom = /realpathSync\(process\.argv\[1\]\)/;
const guardOf = text => text.split('\n').filter(line => /process\.argv\[1\]/.test(line) && /import\.meta\.url|fileURLToPath|metaUrl|file:\/\//.test(line));

test('every program a tool row starts guards its entry point with the realpath idiom', () => {
  const programs = rowPrograms();
  assert.ok(programs.length > 100, `expected the row programs, found ${programs.length}`);
  const bad = [];
  for (const file of programs) {
    for (const line of guardOf(readFileSync(join(root, file), 'utf8'))) {
      const direct = idiom.test(line) && !/file:\/\/\$\{/.test(line) && !/resolve\(process\.argv/.test(line);
      if (!direct) bad.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(bad, [], 'these entry guards miss on a symlinked folder or a path with a space');
});

test('the realpath idiom runs a program through a symlinked folder with a space in its name', () => {
  const base = mkdtempSync(join(tmpdir(), 'entry guard '));
  const real = join(base, 'real folder');
  mkdirSync(real);
  writeFileSync(join(real, 'entry.mjs'), [
    "import { realpathSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {",
    "  console.log('ran');",
    '}',
    '',
  ].join('\n'));
  const link = join(base, 'linked folder');
  symlinkSync(real, link);
  const out = execFileSync(process.execPath, [join(link, 'entry.mjs')], { encoding: 'utf8' });
  assert.equal(out.trim(), 'ran');
});
