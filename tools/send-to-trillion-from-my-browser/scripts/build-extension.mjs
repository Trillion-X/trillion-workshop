// Build the Send to Trillion browser extension (this tool's folder) into a folder any Chromium browser loads as an unpacked
// extension (Chrome, Arc, Dia, Edge, Brave): its manifest and pages, the popup and sign-in scripts composed from the
// shared parts, one stylesheet (the look's button tokens, the parts' own looks plus every utility class the bundled
// parts use, compiled by Tailwind the same way as the workspace), and its icons.
//   EXTENSION_OUT=<folder> node tools/send-to-trillion-from-my-browser/scripts/build-extension.mjs      (default dist/extension)
//   The packages the shared parts import (react, lucide-react, tailwindcss and the rest) are the Workshop's own dependencies
//   (package.json), installed in its node_modules.
//   EXTENSION_PAGE_ACCESS='<all_urls>' adds pages to host_permissions, for the proof build only
// The bundle may take from a part only what its part.json declares public; a crossing stops the build.
// Each page carries only the files it uses (the workspace's own plugins: a part's index read as the files it names,
// a part's files marked as doing nothing when imported, only the icons named), and a page over the byte budget in
// budgets.json stops the build, so a page never again drags in the workspace (its live connection, its
// cloud-drive records) because one shared file imported something it never calls.
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { checkBundlePartBoundaries, describeFinding } from 'trillion-workshop/tools/check-bundle-package-boundaries/scripts/check-bundle-part-boundaries.mjs';
import { buttonLookCss } from 'trillion-workshop/tools/screen-look/scripts/make-device-looks.mjs';
import { namedIconsPlugin } from './named-icons.mjs';
import { movedFilesPlugin } from './resolve-moved-files.mjs';
import { partSideEffectsPlugin } from 'trillion-workshop/tools/check-bundle-package-boundaries/scripts/part-side-effects.mjs';
import { barrelImportsPlugin } from 'trillion-workshop/tools/check-bundle-package-boundaries/scripts/barrel-imports.mjs';
import { lightThemeCss } from 'trillion-workshop/tools/check-bundle-package-boundaries/scripts/light-theme.mjs';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(new URL(import.meta.url))), '..');
// The shared screens the pages compose are the Workshop's own tools (tools/ui, tools/addressed-marks, tools/feel,
// tools/screen-look), each a part beside this one; the packages they import are installed in a node_modules.
const parts = dirname(source);
const root = dirname(parts);
const nodeModules = join(root, 'node_modules');
const out = resolve(process.env.EXTENSION_OUT ?? 'dist/extension');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const barrels = barrelImportsPlugin(parts);
// Tailwind comes from the same node_modules as the packages the parts import.
const { compile } = createRequire(join(dirname(nodeModules), 'package.json'))('@tailwindcss/node');

const bundled = await build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(Object.entries({ popup: 'popup.tsx', 'signed-in': 'signed-in.tsx', background: 'background.mjs', 'right-clicked': 'right-clicked.mjs', recorder: 'recorder-offscreen.mjs', 'allow-microphone': 'allow-microphone.tsx', reply: 'reply.tsx', markup: 'markup.tsx', attach: 'attach.tsx' }).map(([page, file]) => [page, join(source, 'src', file)])),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic',
  outdir: out, metafile: true, logLevel: 'warning', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '""' },
  loader: { '.css': 'css', '.wasm': 'file' },
  external: ['node:*'],
  nodePaths: [nodeModules],
  plugins: [namedIconsPlugin(dirname(nodeModules), [source, join(parts, 'ui')]), partSideEffectsPlugin(parts), barrels.plugin, movedFilesPlugin(root)],
});
const boundaries = checkBundlePartBoundaries({ metafile: bundled.metafile, bundleRoot: root, partsRoot: parts, throughIndex: file => barrels.indexesNaming(file) });
if (boundaries.findings.length) {
  for (const finding of boundaries.findings) process.stderr.write(`${describeFinding(finding)}\n`);
  process.exit(1);
}

// No page may weigh more than its budget (budgets.json): a page's script, as the browser loads it.
const budgets = JSON.parse(readFileSync(join(source, 'budgets.json'), 'utf8'));
const heavy = Object.keys(bundled.metafile.outputs).filter(file => file.endsWith('.js')).map(file => ({ page: relative(out, resolve(root, file)), bytes: statSync(resolve(root, file)).size })).filter(({ bytes }) => bytes > budgets.page_script_bytes);
if (heavy.length) {
  for (const { page, bytes } of heavy) process.stderr.write(`${page} is ${bytes} bytes, over the ${budgets.page_script_bytes} a page may weigh (budgets.json). Find what it carries with the build's metafile and cut the import it never uses.\n`);
  process.exit(1);
}

// Every class the bundled parts and the extension's own screens can ask for, read from their source.
const sources = Object.keys(bundled.metafile.inputs).map(input => resolve(root, input)).filter(file => file.startsWith(`${parts}/`));
const candidates = new Set();
for (const file of sources) if (/\.(m?[jt]sx?)$/.test(file)) for (const word of readFileSync(file, 'utf8').match(/[^\s"'`]+/g) ?? []) candidates.add(word);
// The looks moved with screen-look to the Workshop tool (trillion-workshop tools/screen-look/show).
const looks = join(parts, 'screen-look/show');
const look = file => readFileSync(join(looks, file), 'utf8');
const compiled = await compile(`@layer base, components;\n@import "tailwindcss/theme";\n@import "tailwindcss/preflight" layer(base);\n@tailwind utilities;\n${look('coss-workspace.css')}`, { base: join(nodeModules, 'tailwindcss'), onDependency: () => {} });
const LOOKS = ['fonts.css', 'look-bridges.css', 'surfaces.css', 'beautiful-ui-controls.css', 'floating-menus.css', 'loading-mark.css', 'copy-button.css'];
const bundledCss = Object.keys(bundled.metafile.outputs).filter(file => file.endsWith('.css')).map(file => readFileSync(resolve(root, file), 'utf8')).join('\n');
// The look's button tokens come first (scripts/make-device-looks.mjs, from the look settings.json names), so a button
// wears Trillion's corner, fill and depth before the popup's script applies the rest of the look.
const extensionLook = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8')).look;
writeFileSync(join(out, 'look.css'), [buttonLookCss(extensionLook), compiled.build([...candidates]), ...LOOKS.map(look), lightThemeCss(parts), bundledCss, readFileSync(join(source, 'frame.css'), 'utf8')].join('\n'));
for (const file of Object.keys(bundled.metafile.outputs).filter(file => file.endsWith('.css'))) rmSync(resolve(root, file));
cpSync(join(looks, 'fonts'), join(out, 'fonts'), { recursive: true });
for (const file of ['popup.html', 'signed-in.html', 'recorder.html', 'allow-microphone.html', 'reply.html', 'markup.html', 'attach.html']) copyFileSync(join(source, file), join(out, file));
// A proof build (scripts/prove-send-to-trillion.mjs) is lent pages as a host permission, since a script cannot click
// the browser's toolbar button that lends a person's page to the extension.
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
if (process.env.EXTENSION_PAGE_ACCESS) manifest.host_permissions = [...manifest.host_permissions, process.env.EXTENSION_PAGE_ACCESS];
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(source, 'icons'), join(out, 'icons'), { recursive: true });
process.stdout.write(`built ${relative(root, out)}: popup.js, signed-in.js, background.js, recorder.js, allow-microphone.js, reply.js, markup.js, attach.js, look.css, icons, pages\n`);
