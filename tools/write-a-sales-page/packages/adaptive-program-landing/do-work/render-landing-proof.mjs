#!/usr/bin/env node
// packages/adaptive-program-landing/do-work/render-landing-proof.mjs
//
// PURPOSE: produce a loadable copy of this package's landing surface, from this
// package's real source and a named package set's real DATA, so the result can
// be opened in a browser and LOOKED AT.
//
// WHY IT LIVES HERE: producing the render is WORK, so it lives in do-work/;
// the render it produces is PROOF, so it lands in proof/rendered-screens/.
// The shared commit judge refused it under proof/ and was right: a file sitting
// among a package's checks that the package does not declare as a check reads
// as coverage while reporting nothing. An earlier attempt built the
// same thing under /tmp, where the output belonged to nobody, was invisible to
// every source and content guard, and survived as a ghost nothing tracked. An
// owner makes its own workspace; a caller never picks a temp root.
//
// NON-NEGOTIABLE INVARIANTS
// 1. The package set is an ARGUMENT. A default would build somebody's set by
//    accident the first time there are two.
// 2. Output goes under this file's own directory and nowhere else.
// 3. It renders; it does not deploy, and it is not the shipped artifact. The
//    hosted bundle is built by the publication owner. This exists so a change
//    can be SEEN before it is shipped, which is the step that was missing.
// 4. The entry is fed to the bundler IN MEMORY, and the page shell is a
//    separate `.html` file. A scratch entry written next to real source is how
//    a harness becomes something a future reader mistakes for product code,
//    and a build script carrying page markup is a source file authoring
//    markup, which the shared UI guard refuses on sight — correctly.

import esbuild from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const packagesRoot = path.dirname(path.dirname(packageRoot));

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
}

// No package set named means EVERY set that uses this package, which is what a
// declared check has to do: it runs with no arguments, and "pick a default set"
// would build somebody's set by accident the first time there are two. Naming
// one renders only that one.
//
// A generic package with no consumer is not a failure. It renders nothing and
// says so, because exiting non-zero there would make every new package start
// life red for the crime of being new.
function packageSetsUsingThisPackage() {
  const setsRoot = path.join(packagesRoot, 'package-sets');
  if (!existsSync(setsRoot)) return [];
  return readdirSync(setsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(setsRoot, name, 'package-set-records', 'adaptive-program-landing.json')));
}

const named = argument('package-set');
const packageSets = named ? [named] : packageSetsUsingThisPackage();
if (packageSets.length === 0) {
  console.log('no package set carries adaptive-program-landing DATA; nothing to render');
  process.exit(0);
}
const [packageSet, ...notRendered] = packageSets;
if (notRendered.length > 0) console.log(`rendering ${packageSet}; name a set to render one of: ${notRendered.join(', ')}`);

const dataPath = path.join(packagesRoot, 'package-sets', packageSet, 'package-set-records', 'adaptive-program-landing.json');
const outDir = argument('out') ?? path.join(packageRoot, 'proof', 'rendered-screens', packageSet);
mkdirSync(outDir, { recursive: true });

// The page's media is served by the live host. The FIRST attempt pointed at it
// with a document `<base href>`, which also re-pointed the proof's own `app.js`
// and `app.css` at that origin, so the page loaded, titled itself correctly,
// and rendered NOTHING — a 200 that looks structurally fine and is blank.
//
// A document base is the wrong layer: the thing that needs an origin is the
// DATA's media paths, not the document. So the origin is applied to the DATA,
// and the shell keeps its own relative bundle URLs.
const assetOrigin = argument('asset-origin');
const withAssetOrigin = (value) => {
  if (typeof value === 'string') return assetOrigin && value.startsWith('/assets/') ? `${assetOrigin.replace(/\/$/, '')}${value}` : value;
  if (Array.isArray(value)) return value.map(withAssetOrigin);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withAssetOrigin(item)]));
  return value;
};
const landingData = withAssetOrigin(JSON.parse(readFileSync(dataPath, 'utf8')));

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProgramLanding } from ${JSON.stringify(path.join(packageRoot, 'show', 'ProgramLanding.tsx'))};
const data = ${JSON.stringify(landingData)};
createRoot(document.getElementById('root')).render(React.createElement(ProgramLanding, { data }));
`;

const result = await esbuild.build({
  absWorkingDir: packagesRoot,
  alias: { '@': packagesRoot },
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'esm',
  jsx: 'automatic',
  loader: {
    '.js': 'jsx', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.json': 'json',
    '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl',
    '.woff2': 'file', '.ttf': 'file', '.otf': 'file',
  },
  logLevel: 'warning',
  outfile: path.join(outDir, 'app.js'),
  platform: 'browser',
  stdin: { contents: entry, loader: 'tsx', resolveDir: packageRoot, sourcefile: 'landing-proof-entry.tsx' },
});

writeFileSync(
  path.join(outDir, 'index.html'),
  readFileSync(path.join(here, 'landing-proof-shell.html'), 'utf8').replace('<!--ASSET-BASE-->', ''),
);

console.log(`rendered ${packageSet} -> ${outDir}`);
console.log(`errors=${result.errors.length} warnings=${result.warnings.length}`);
process.exit(result.errors.length === 0 ? 0 : 1);
