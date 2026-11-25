// scripts/check-bundle-part-boundaries.mjs
//
// Purpose: judge a finished bundle's real import graph and report every edge where code outside a part (a folder
// under parts/) reaches a file that part has not declared public. The graph is the bundler's own (an esbuild
// metafile), so what is judged is exactly what ships: aliases, plugins and relative paths are already resolved by the
// time it is read. scripts/build-worker.mjs runs it on every build and stops before anything deploys.
//
// Non-negotiable invariants:
// - A part's public files are its DATA: the `public` list in its `part.json` (a file, or a folder meaning every file
//   under it), plus `part.json` itself.
// - The checker never names a part or a host. A part is any folder under the given parts root that carries a
//   part.json; a host is anything else in the bundle.
// - Edges inside one part are never judged. Edges to a file no part owns are never judged.
// - An unreadable or malformed part.json is a finding, never a silent pass.
// - A file the bundle reached because a build plugin turned an import of a part's index into an import of the file the
//   index takes that name from (scripts/barrel-imports.mjs) is judged as the source wrote it: `throughIndex(file)` names
//   the indexes that pass names on from that file, and the edge passes when one of them is public.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const BOUNDARY_FILE = 'part.json';

// Metafile paths are either plain (relative to the bundle root) or `namespace:<path>`. A namespaced path names a
// file only when what follows the namespace is absolute or starts ./ or ../ (from the bundle root, so the build's own
// folder is not in it); anything else is a virtual module and owns no file.
export function filePathOfBundleInput(inputPath, bundleRoot) {
  // esbuild includes import attributes in the metafile path for JSON modules.
  const path = inputPath.replace(/ with \{[^{}]*\}$/, '');
  const match = /^[a-z][a-z0-9-]+:(.*)$/i.exec(path);
  if (match) return isAbsolute(match[1]) ? match[1] : /^\.\.?\//.test(match[1]) ? resolve(bundleRoot, match[1]) : null;
  return resolve(bundleRoot, path);
}

function ownerOf(absolutePath, partsRoot) {
  if (!absolutePath) return null;
  const inside = relative(partsRoot, absolutePath);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  const [name, ...rest] = inside.split(sep);
  if (!rest.length) return null;
  return { name, path: rest.join('/') };
}

function readPublicRoots(partsRoot, name) {
  const boundaryPath = resolve(partsRoot, name, BOUNDARY_FILE);
  if (!existsSync(boundaryPath)) return { owned: false };
  let boundary;
  try { boundary = JSON.parse(readFileSync(boundaryPath, 'utf8')); }
  catch (error) { return { owned: true, error: `${BOUNDARY_FILE} is not readable JSON: ${error.message}` }; }
  if (!Array.isArray(boundary?.public)) return { owned: true, error: `${BOUNDARY_FILE} has no public list` };
  const roots = new Set([BOUNDARY_FILE]);
  for (const declared of boundary.public) {
    if (typeof declared !== 'string' || isAbsolute(declared)) continue;
    const segments = declared.split('/').filter(segment => segment && segment !== '.');
    if (!segments.length || segments.includes('..')) continue;
    roots.add(segments.join('/'));
  }
  return { owned: true, roots };
}

function isUnderRoot(path, roots) {
  for (const root of roots) if (path === root || path.startsWith(`${root}/`)) return true;
  return false;
}

/**
 * @param {{ metafile: { inputs: Record<string, { imports?: Array<{ path: string, external?: boolean }> }> },
 *           bundleRoot: string, partsRoot: string, throughIndex?: (absolutePath: string) => string[] }} input
 * @returns {{ findings: Array<{ rule: string, importer: string, target: string, part: string, target_path: string, reason?: string }>,
 *             edges_checked: number, parts_reached: string[] }}
 */
export function checkBundlePartBoundaries({ metafile, bundleRoot, partsRoot, throughIndex = () => [] }) {
  const parts = new Map();
  const publicRootsOf = name => {
    if (!parts.has(name)) parts.set(name, readPublicRoots(partsRoot, name));
    return parts.get(name);
  };
  const findings = [];
  let edgesChecked = 0;
  const reached = new Set();
  for (const [importer, input] of Object.entries(metafile?.inputs ?? {})) {
    const importerOwner = ownerOf(filePathOfBundleInput(importer, bundleRoot), partsRoot);
    for (const edge of input.imports ?? []) {
      if (edge.external) continue;
      const target = ownerOf(filePathOfBundleInput(edge.path, bundleRoot), partsRoot);
      if (!target) continue;
      const declared = publicRootsOf(target.name);
      if (!declared.owned) continue;
      if (importerOwner && importerOwner.name === target.name && publicRootsOf(importerOwner.name).owned) continue;
      edgesChecked += 1;
      reached.add(target.name);
      if (declared.error) {
        findings.push({ rule: 'part-boundary-unreadable', importer, target: edge.path, part: target.name, target_path: target.path, reason: declared.error });
      } else if (!isUnderRoot(target.path, declared.roots) && !throughIndex(filePathOfBundleInput(edge.path, bundleRoot)).some(index => { const owner = ownerOf(index, partsRoot); return owner?.name === target.name && isUnderRoot(owner.path, declared.roots); })) {
        findings.push({ rule: 'part-private-source-reached', importer, target: edge.path, part: target.name, target_path: target.path });
      }
    }
  }
  return { findings, edges_checked: edgesChecked, parts_reached: [...reached].sort() };
}

// One line per finding, in words a person fixing it can act on.
export function describeFinding(finding) {
  if (finding.rule === 'part-boundary-unreadable') {
    return `${finding.importer} uses ${finding.part}, whose ${BOUNDARY_FILE} cannot be read (${finding.reason}).`;
  }
  return `${finding.importer} reaches ${finding.part}/${finding.target_path}, which ${finding.part} has not declared public. `
    + `Import a declared public file instead, or add it to the public list in ${finding.part}/${BOUNDARY_FILE}.`;
}
