// tools/check-bundle-package-boundaries/do-work/check-my-bundle.mjs
//
// Run by the Workshop tool `tool:check-a-bundle-against-package-boundaries` on the person's computer, in the folder
// they granted:
//
//   node do-work/check-my-bundle.mjs <the granted folder> < { metafile_file, packages_root, declaration, bundle_root? }
//
// Every path is relative to the granted folder and may not leave it. `metafile_file` is the bundler's own report of what
// went into a finished bundle (esbuild's metafile). `packages_root` is the folder whose sub-folders are packages.
// `declaration` says how a package declares its public files; the tool has no default for it. `bundle_root` (default
// the granted folder) is what the metafile's relative paths are relative to. Prints { result } as the last line, with
// a non-zero status when any edge crosses a boundary.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { checkBundlePackageBoundaries, checkDeclaration, describeFinding } from './check-bundle-package-boundaries.mjs';

const folder = process.argv[2];
try {
  if (!folder || !path.isAbsolute(folder) || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('the granted folder was not given as an absolute path to a folder');
  }
  const granted = realpathSync(folder);
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const inside = (name, value) => {
    if (typeof value !== 'string' || value === '') throw new Error(`give ${name}: a path inside the granted folder`);
    let resolved;
    try { resolved = realpathSync(path.resolve(granted, value)); }
    catch { throw new Error(`${name} does not exist inside the granted folder`); }
    if (resolved !== granted && !resolved.startsWith(granted + path.sep)) throw new Error(`${name} is not a path inside the granted folder`);
    return resolved;
  };
  const declaration = checkDeclaration(input.declaration);
  const metafilePath = inside('metafile_file', input.metafile_file);
  const packagesRoot = inside('packages_root', input.packages_root);
  const bundleRoot = input.bundle_root === undefined ? granted : inside('bundle_root', input.bundle_root);
  const report = checkBundlePackageBoundaries({ metafile: JSON.parse(readFileSync(metafilePath, 'utf8')), bundleRoot, packagesRoot, declaration });
  const result = { ok: report.findings.length === 0, edges_checked: report.edges_checked, packages_reached: report.packages_reached, findings: report.findings.map(finding => ({ ...finding, said: describeFinding(finding, declaration) })) };
  console.log(JSON.stringify({ result }));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
