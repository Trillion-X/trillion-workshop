/**
 * W7 grid render-matrix harness: renders the REAL VisualDatabaseSurface (grid
 * view-role + derive seam) over fixture DATA and writes date-prefixed PNGs
 * into the W7 plan's proof folder. Never touches other harnesses' outputs.
 *
 * The runtime-kit transport is aliased to a deterministic stub (formula cells
 * show arithmetic; cycle columns show the honest error chip; AI errors honest).
 * react-single-copy law: everything resolves through the repo root, one React.
 *
 * Run from the bitfield-packages repo root:
 *   node packages/visual-database/proof/harness/w7-grid-2026-07-18/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const sharedHarness = resolve(here, '../../../../customer-support/proof/harness');
const repoRoot = resolve(here, '../../../../..');
const outDir = join(here, 'out');
const stateDir = join(here, 'state');
mkdirSync(outDir, { recursive: true });

const SHELL = '/Users/example/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const PROOF = resolve('/Users/example/dev/ai-command-center/notes/projects/packages-and-package-sets/visual-database/plans/2026-07-18-editable-grid-and-formula-columns/proof');
mkdirSync(PROOF, { recursive: true });

const surfaces = [
  { state: 'dense-desktop', base: '2026-07-18-w7-grid-dense-desktop', w: 1280, h: 1600 },
  { state: 'sparse-desktop', base: '2026-07-18-w7-grid-sparse-desktop', w: 1280, h: 700 },
  { state: 'empty-desktop', base: '2026-07-18-w7-grid-empty-desktop', w: 1280, h: 600 },
  { state: 'sparse-mobile', base: '2026-07-18-w7-grid-sparse-mobile', w: 414, h: 900 },
  { state: 'readonly-desktop', base: '2026-07-18-w7-grid-readonly-desktop', w: 1280, h: 700 },
  { state: 'canvas-desktop', base: '2026-07-24-w7-canvas-desktop', w: 1280, h: 760 },
];

const esbuild = join(repoRoot, 'node_modules/.bin/esbuild');
const bundlePath = join(outDir, 'bundle.js');
execFileSync(
  esbuild,
  [
    join(here, 'mount.tsx'),
    '--bundle',
    '--format=iife',
    '--platform=browser',
    '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"',
    `--alias:@=${repoRoot}`,
    `--alias:@bitfield/runtime-kit/protocol=${join(repoRoot, 'node_modules/@bitfield/runtime-kit/src/protocol/index.ts')}`,
    `--alias:@bitfield/runtime-kit=${join(here, 'stubs/runtime-kit.ts')}`,
    // CodeMirror rides behind field-editors' lazy import; harness never opens
    // a file cell, so the graph is stubbed out (react-single-copy lesson).
    `--alias:@/packages/file-editor/show/FileEditor=${join(here, 'stubs/file-editor.tsx')}`,
    '--loader:.css=empty',
    `--outfile=${bundlePath}`,
  ],
  { stdio: 'inherit' },
);
const bundleJs = readFileSync(bundlePath, 'utf8');
const tailwind = readFileSync(join(sharedHarness, 'tailwindcss-browser.js'), 'utf8');
const tokens = readFileSync(join(sharedHarness, 'tokens.css'), 'utf8');
const globalCss = readFileSync(join(repoRoot, 'packages/bitfield-studio-startup/global-source.css'), 'utf8');

function htmlFor(state) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style type="text/tailwindcss">
${globalCss}
</style>
<style>
${tokens}
:root {
  --surface-primary: #141414;
  --surface-secondary: #1c1c1c;
  --surface-tertiary: #242424;
}
html, body { margin: 0; padding: 0; background: var(--surface-base, #0a0a0a); color: var(--text-primary, #fff); }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
#root { min-height: 100vh; display: flex; flex-direction: column; }
</style>
</head>
<body>
<div id="root"></div>
<script>${tailwind}</script>
<script>window.__STATE__ = ${JSON.stringify(state)};</script>
<script>${bundleJs}</script>
</body>
</html>`;
}

function verifyCanonicalDerivations(state, dumpedDom, surface) {
  const descriptors = state.fields?.descriptors ?? [];
  const legacy = descriptors.filter((descriptor) => Object.prototype.hasOwnProperty.call(descriptor, 'derive'));
  if (legacy.length > 0) {
    throw new Error(`${surface}: proof fixture still contains ignored field.derive descriptors`);
  }
  const total = descriptors.find((descriptor) => descriptor.id === 'total-value');
  if (!total?.default_expression?.derive) return;
  const records = state.records?.records ?? [];
  if (records.length === 0) return;
  const rootStart = dumpedDom.indexOf('<div id="root">');
  const stateScript = dumpedDom.indexOf('<script>window.__STATE__');
  if (rootStart < 0 || stateScript <= rootStart) throw new Error(`${surface}: rendered root was not captured`);
  const document = new JSDOM(dumpedDom.slice(rootStart, stateScript)).window.document;
  const headers = [...document.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim() ?? '');
  const totalIndex = headers.findIndex((label) => label.startsWith('Total value'));
  if (totalIndex < 0) throw new Error(`${surface}: Total value column is absent`);
  const byTitle = new Map(records.map((record) => [record.payload?.title, record.payload]));
  let verified = 0;
  for (const row of document.querySelectorAll('tbody tr')) {
    const cells = [...row.querySelectorAll('td')];
    const title = cells[0]?.textContent?.trim();
    const payload = byTitle.get(title);
    if (!payload || !cells[totalIndex]) continue;
    const expected = String(Number(payload.qty) * Number(payload['unit-cost']));
    const actual = cells[totalIndex].textContent?.trim();
    if (actual !== expected) {
      throw new Error(`${surface}: ${title} expected derived Total value ${expected}, rendered ${JSON.stringify(actual)}`);
    }
    verified += 1;
  }
  if (verified === 0) throw new Error(`${surface}: no rendered derived values were verified`);
}

const results = [];
for (const s of surfaces) {
  const state = JSON.parse(readFileSync(join(stateDir, `${s.state}.json`), 'utf8'));
  const htmlPath = join(outDir, `${s.base}.html`);
  writeFileSync(htmlPath, htmlFor(state));
  const pngPath = join(PROOF, `${s.base}.png`);
  execFileSync(
    SHELL,
    [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-color-profile=srgb', '--default-background-color=00000000',
      `--window-size=${s.w},${s.h}`,
      '--virtual-time-budget=7000',
      '--run-all-compositor-stages-before-draw',
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'inherit' },
  );
  const dumpedDom = execFileSync(
    SHELL,
    [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=7000', '--dump-dom', `file://${htmlPath}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  verifyCanonicalDerivations(state, dumpedDom, s.base);
  const ok = existsSync(pngPath);
  results.push({ surface: s.base, ok });
  console.log(`shot: ${pngPath} (${ok ? 'ok' : 'MISSING'})`);
}
console.log('\n' + JSON.stringify(results, null, 1));
if (results.some((r) => !r.ok)) process.exit(1);
