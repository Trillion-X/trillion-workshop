// scripts/check-entry-exports.mjs
//
// Purpose: fail a bundle when a module names something a local file does not export. esbuild treats every name in a
// TypeScript `export {a, b} from './x'` as possibly a type, so a name `./x` no longer exports is dropped from the
// bundle without an error or a warning: the Mac app's controls entry re-exported two functions its shared copy had
// lost, the build passed, and every screen that called them threw at runtime. This check reads the bundle's own
// import graph (an esbuild metafile), so what is judged is exactly what ships, with the build's aliases and paths
// already resolved.
//
// Non-negotiable invariants:
// - Every module in the bundle is judged, not only the entry: `export {…} from` and `import {…} from` naming a file
//   in the graph must name things that file exports. Names marked `type` (and whole `import type`/`export type`
//   statements) are skipped: they are erased and cannot go missing at runtime.
// - A target's exports are its own declarations plus its `export {…}` lists, followed through `export * from`, and a
//   JSON file's top-level keys. A target with no export syntax (a CommonJS file) is never judged.
// - Packages (anything the bundle resolved into node_modules or left external) are never judged; they are not ours.
// - Reading exports is textual and errs toward finding MORE exports than exist, so a finding is always real.
//
// Usage:
//   import { assertBundleExports } from '<trillion>/scripts/check-entry-exports.mjs';
//   assertBundleExports({ metafile: result.metafile, bundleRoot: absWorkingDir });   // after any esbuild build
//   node scripts/check-entry-exports.mjs <entry> [<entry>…]                           // builds each entry to judge it
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { filePathOfBundleInput } from 'trillion-workshop/tools/check-bundle-package-boundaries/scripts/check-bundle-part-boundaries.mjs';

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
// Statements whose names are checked: `import {…} from`, `import D, {…} from`, `import D from`, `export {…} from`.
const IMPORT_STATEMENT = new RegExp(String.raw`^[ \t]*import\s+(type\s+)?(?:(${NAME})\s*(?:,\s*)?)?(?:\{([^}]*)\})?\s*from\s*(['"])([^'"\n]+)\4`, 'gm');
const REEXPORT_STATEMENT = new RegExp(String.raw`^[ \t]*export\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\3`, 'gm');

function namesInList(list) {
  return list.split(',').map(part => part.trim()).filter(Boolean).flatMap(part => {
    if (/^type\s/.test(part)) return [];
    const [imported] = part.split(/\s+as\s+/);
    return [imported.trim().replace(/^(['"])(.*)\1$/, '$2')];
  });
}

function exportedNamesInList(list) {
  return list.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const pieces = part.replace(/^type\s+/, '').split(/\s+as\s+/);
    return pieces[pieces.length - 1].trim().replace(/^(['"])(.*)\1$/, '$2');
  });
}

// What one module asks of each local specifier it names.
export function requestedNames(source) {
  const requests = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (match[1]) continue;
    const names = [...(match[2] ? ['default'] : []), ...(match[3] !== undefined ? namesInList(match[3]) : [])];
    if (names.length) requests.push({ specifier: match[5], names, statement: match[0].trim() });
  }
  for (const match of source.matchAll(REEXPORT_STATEMENT)) {
    if (match[1]) continue;
    const names = namesInList(match[2]);
    if (names.length) requests.push({ specifier: match[4], names, statement: match[0].trim() });
  }
  return requests;
}

// What one module declares it exports, plus the specifiers it re-exports wholesale.
export function declaredExports(source) {
  const names = new Set();
  const star = [];
  const add = name => name && names.add(name);
  for (const match of source.matchAll(new RegExp(String.raw`\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|type|interface|enum|namespace|module|abstract\s+class|const\s+enum)\s+(${NAME})`, 'g'))) add(match[1]);
  for (const match of source.matchAll(new RegExp(String.raw`\bexport\s+(?:const|let|var)\s*[{[]([^}\]]*)[}\]]`, 'g'))) {
    for (const part of match[1].split(',')) add(part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, ''));
  }
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) for (const name of exportedNamesInList(match[1])) add(name);
  for (const match of source.matchAll(new RegExp(String.raw`\bexport\s+(?:type\s+)?\*\s+as\s+(${NAME})\s+from`, 'g'))) add(match[1]);
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\*\s+from\s*(['"])([^'"\n]+)\1/g)) star.push(match[2]);
  const hasModuleSyntax = names.size > 0 || star.length > 0 || /\bexport\s*=/.test(source);
  return { names, star, hasModuleSyntax };
}

function importsByOriginal(metafile, bundleRoot) {
  const table = new Map();
  for (const [input, entry] of Object.entries(metafile.inputs)) {
    const file = filePathOfBundleInput(input, bundleRoot);
    if (!file) continue;
    const bySpecifier = new Map();
    for (const item of entry.imports ?? []) {
      if (item.original === undefined) continue;
      bySpecifier.set(item.original, item.external ? null : filePathOfBundleInput(item.path, bundleRoot));
    }
    table.set(file, bySpecifier);
  }
  return table;
}

const isPackage = file => !file || file.split(/[\\/]/).includes('node_modules');

export function findMissingExports({ metafile, bundleRoot, readSource = file => (existsSync(file) ? readFileSync(file, 'utf8') : null) }) {
  const resolved = importsByOriginal(metafile, bundleRoot);
  const sources = new Map();
  const read = file => {
    if (!sources.has(file)) sources.set(file, readSource(file));
    return sources.get(file);
  };
  const exportCache = new Map();
  // null means "cannot be known" (no module syntax, or a wholesale re-export of a package): never judged.
  const exportsOf = (file, seen = new Set()) => {
    if (exportCache.has(file)) return exportCache.get(file);
    if (seen.has(file)) return new Set();
    seen.add(file);
    const text = read(file);
    let result;
    if (text === null || isPackage(file)) result = null;
    else if (file.endsWith('.json')) {
      let value;
      try { value = JSON.parse(text); } catch { value = null; }
      result = new Set(['default', ...(value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [])]);
    } else if (!SCRIPT.test(file)) result = null;
    else {
      const declared = declaredExports(text);
      if (!declared.hasModuleSyntax) result = null;
      else {
        result = new Set(declared.names);
        for (const specifier of declared.star) {
          const target = resolved.get(file)?.get(specifier);
          const more = target ? exportsOf(target, seen) : null;
          if (more === null) { result = null; break; }
          for (const name of more) if (name !== 'default') result.add(name);
        }
      }
    }
    exportCache.set(file, result);
    return result;
  };
  const findings = [];
  for (const [importer, bySpecifier] of resolved) {
    if (isPackage(importer) || !SCRIPT.test(importer)) continue;
    const text = read(importer);
    if (text === null) continue;
    for (const request of requestedNames(text)) {
      const target = bySpecifier.get(request.specifier);
      if (!target || isPackage(target)) continue;
      const available = exportsOf(target);
      if (available === null) continue;
      const missing = request.names.filter(name => !available.has(name));
      if (missing.length) findings.push({ importer, specifier: request.specifier, target, missing });
    }
  }
  return findings;
}

export function describeMissingExport(finding, bundleRoot = process.cwd()) {
  return `${relative(bundleRoot, finding.importer)} names ${finding.missing.join(', ')} from '${finding.specifier}', which ${relative(bundleRoot, finding.target)} does not export`;
}

export function assertBundleExports({ metafile, bundleRoot = process.cwd() }) {
  const findings = findMissingExports({ metafile, bundleRoot });
  if (findings.length) throw new Error(`Names missing from their modules (the bundle would drop them silently):\n${findings.map(finding => `  ${describeMissingExport(finding, bundleRoot)}`).join('\n')}`);
  return findings;
}

// Builds each entry only to read its graph: packages and non-script files stay outside, nothing is written.
export async function checkEntryExports(entryPoints, { esbuild, readSource } = {}) {
  const { build } = esbuild ?? await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/esbuild/lib/main.js')).href);
  const findings = [];
  for (const entry of entryPoints) {
    const absolute = resolve(entry);
    const bundleRoot = dirname(absolute);
    const result = await build({
      entryPoints: [absolute], absWorkingDir: bundleRoot, bundle: true, write: false, metafile: true, format: 'esm',
      logLevel: 'silent', jsx: 'automatic',
      plugins: [{ name: 'judge-own-files-only', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return undefined;
          const packagePath = !/^[./#]/.test(args.path);
          const extension = /\.([^./\\]+)$/.exec(args.path)?.[1];
          const notScript = extension !== undefined && !/^(?:[cm]?[jt]sx?|json)$/.test(extension);
          return packagePath || notScript ? { path: args.path, external: true } : undefined;
        });
      } }],
    });
    findings.push(...findMissingExports({ metafile: result.metafile, bundleRoot, ...(readSource ? { readSource } : {}) }).map(finding => ({ ...finding, bundleRoot })));
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.slice(2);
  if (!entries.length) { process.stderr.write('usage: node scripts/check-entry-exports.mjs <entry> [<entry>…]\n'); process.exit(2); }
  const findings = await checkEntryExports(entries);
  for (const finding of findings) process.stderr.write(`${describeMissingExport(finding, finding.bundleRoot)}\n`);
  process.stdout.write(findings.length ? `${findings.length} missing export${findings.length === 1 ? '' : 's'}\n` : `every named export exists (${entries.join(', ')})\n`);
  process.exit(findings.length ? 1 : 0);
}
