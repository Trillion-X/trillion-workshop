// tools/check-bundle-package-boundaries/do-work/check-bundle-package-boundaries.mjs
//
// Purpose: judge a finished bundle's real import graph and report every edge where code outside a package reaches a
// file that package has not declared public. The graph is the bundler's own (an esbuild-shaped metafile), so what is
// judged is exactly what ships: aliases, plugins and relative paths are already resolved by the time it is read.
//
// Invariants:
// - A package's public files are its DATA: the entries of its own declaration file that the declaration describes
//   (`declaration`: the file's name, the list in it, where each entry says what it is and where it names a path),
//   plus that declaration file itself, which is every package's boundary. The checker holds no default for any of it.
// - The checker names no package, host, bundler plugin or product. A package is any folder under the given packages
//   root that carries a declaration file; a host is anything else in the bundle.
// - Edges inside one package are never judged. Edges to a file no package owns are never judged.
// - An unreadable or malformed declaration file is a finding, never a silent pass.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Metafile paths are either plain (relative to the bundle root) or `namespace:<path>`. A namespaced path names a
// file only when what follows the namespace is absolute; anything else is a virtual module and owns no file.
export function filePathOfBundleInput(inputPath, bundleRoot) {
  const match = /^[a-z][a-z0-9-]+:(.*)$/i.exec(inputPath);
  if (match) return isAbsolute(match[1]) ? match[1] : null;
  return resolve(bundleRoot, inputPath);
}

function valueAt(value, dottedPath) {
  let here = value;
  for (const key of dottedPath.split('.')) here = here !== null && typeof here === 'object' ? here[key] : undefined;
  return here;
}

export function checkDeclaration(declaration) {
  const text = key => typeof declaration?.[key] === 'string' && declaration[key] !== '';
  for (const key of ['file', 'entries_at', 'kind_at', 'kind', 'path_at']) {
    if (!text(key)) throw new Error(`declaration.${key} is required: say where a package declares its public files`);
  }
  if (declaration.file.includes('/') || declaration.file.includes('\\') || declaration.file === '..') {
    throw new Error('declaration.file is a file name that sits in the package folder, not a path');
  }
  return declaration;
}

function ownerOf(absolutePath, packagesRoot) {
  if (!absolutePath) return null;
  const inside = relative(packagesRoot, absolutePath);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  const [name, ...rest] = inside.split(sep);
  if (!rest.length) return null;
  return { name, path: rest.join('/') };
}

function readPublicRoots(packagesRoot, name, declaration) {
  const declarationPath = resolve(packagesRoot, name, declaration.file);
  if (!existsSync(declarationPath)) return { owned: false };
  let parsed;
  try { parsed = JSON.parse(readFileSync(declarationPath, 'utf8')); }
  catch (error) { return { owned: true, error: `${declaration.file} is not readable JSON: ${error.message}` }; }
  const entries = valueAt(parsed, declaration.entries_at);
  if (!Array.isArray(entries)) return { owned: true, error: `${declaration.file} has no list at ${declaration.entries_at}` };
  const roots = new Set([declaration.file]);
  for (const entry of entries) {
    const declared = valueAt(entry, declaration.path_at);
    if (valueAt(entry, declaration.kind_at) !== declaration.kind || typeof declared !== 'string') continue;
    const parts = declared.split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..') || isAbsolute(declared)) continue;
    roots.add(parts.join('/'));
  }
  return { owned: true, roots };
}

function isUnderRoot(path, roots) {
  for (const root of roots) if (path === root || path.startsWith(`${root}/`)) return true;
  return false;
}

/**
 * @param {{ metafile: { inputs: Record<string, { imports?: Array<{ path: string, external?: boolean }> }> },
 *           bundleRoot: string, packagesRoot: string,
 *           declaration: { file: string, entries_at: string, kind_at: string, kind: string, path_at: string } }} input
 * @returns {{ findings: Array<{ rule: string, importer: string, target: string, package: string, target_path: string, reason?: string }>,
 *             edges_checked: number, packages_reached: string[] }}
 */
export function checkBundlePackageBoundaries({ metafile, bundleRoot, packagesRoot, declaration }) {
  checkDeclaration(declaration);
  const packages = new Map();
  const publicRootsOf = name => {
    if (!packages.has(name)) packages.set(name, readPublicRoots(packagesRoot, name, declaration));
    return packages.get(name);
  };
  const findings = [];
  let edgesChecked = 0;
  const reached = new Set();
  for (const [importer, input] of Object.entries(metafile?.inputs ?? {})) {
    const importerOwner = ownerOf(filePathOfBundleInput(importer, bundleRoot), packagesRoot);
    for (const edge of input.imports ?? []) {
      if (edge.external) continue;
      const target = ownerOf(filePathOfBundleInput(edge.path, bundleRoot), packagesRoot);
      if (!target) continue;
      const declared = publicRootsOf(target.name);
      if (!declared.owned) continue;
      if (importerOwner && importerOwner.name === target.name && publicRootsOf(importerOwner.name).owned) continue;
      edgesChecked += 1;
      reached.add(target.name);
      if (declared.error) {
        findings.push({ rule: 'package-boundary-unreadable', importer, target: edge.path, package: target.name, target_path: target.path, reason: declared.error });
      } else if (!isUnderRoot(target.path, declared.roots)) {
        findings.push({ rule: 'package-private-source-reached', importer, target: edge.path, package: target.name, target_path: target.path });
      }
    }
  }
  return { findings, edges_checked: edgesChecked, packages_reached: [...reached].sort() };
}

// One line per finding, in words a person fixing it can act on.
export function describeFinding(finding, declaration) {
  if (finding.rule === 'package-boundary-unreadable') {
    return `${finding.importer} uses ${finding.package}, whose ${declaration.file} cannot be read (${finding.reason}).`;
  }
  return `${finding.importer} reaches ${finding.package}/${finding.target_path}, which ${finding.package} has not declared public. `
    + `Import a declared public file instead, or declare that file in ${finding.package}/${declaration.file}.`;
}
