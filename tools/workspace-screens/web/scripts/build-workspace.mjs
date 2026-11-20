// Build the signed-in workspace page's files: its script (src/workspace/main.tsx and the parts it composes, split so
// each screen's code is its own file fetched when the screen first opens), the file view AI apps draw
// (src/workspace/file-view.tsx), one stylesheet (the parts' own looks plus every utility class the bundled parts use,
// compiled by Tailwind), and the compiled parts' bytes. They are served beside the Worker as static files under
// /workspace/. Everything the page loads is content-named under /workspace/named/ (a changed file gets a new name, so
// the Worker lets a browser keep it for a year); files.json names the current script, stylesheet and the files to
// fetch alongside them, and the Worker writes those names into the page.
//   WORKSPACE_OUT=<folder> node scripts/build-workspace.mjs      (default dist/workspace-assets)
// The bundle may take from a part only what its part.json declares public; a crossing stops the build.
// A name a module asks of a local file that the file does not export stops the build (esbuild drops it silently).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
// `trillion-workshop/...` is answered by this resolve hook from here on (nothing in node_modules links the Workshop to itself), so the
// client's own files this build runs under node are imported after it, not statically with the lines above it.
import '../../../../test-helpers/workshop-self-resolve.mjs';
import { logoOf } from '../../../../tools/set-up-my-account/read-data/site-icon-url.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { build, transform } from 'esbuild';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { compile } from '@tailwindcss/node';
import { lightThemeCss } from '../../../../tools/check-bundle-package-boundaries/scripts/light-theme.mjs';
import { oneCopyOfEachRule } from './one-copy-of-each-rule.mjs';
import { checkBundlePartBoundaries, describeFinding, filePathOfBundleInput } from '../../../../tools/check-bundle-package-boundaries/scripts/check-bundle-part-boundaries.mjs';
import { assertBundleExports } from './check-entry-exports.mjs';
import { BUILT_CRATES_FOLDER, withCommittedModules, withStagedModules } from '../../../../tools/build-engine-modules-for-web-hosts/build/compiled-modules.mjs';
import { workshopShellImportsPlugin } from '../../../../tools/workspace-pieces/scripts/workshop-shell-imports.mjs';
import { writeOpenSourceNotices } from './open-source-notices.mjs';
import { namedIconsPlugin } from '../../../../tools/send-to-trillion-from-my-browser/scripts/named-icons.mjs';
import { partSideEffectsPlugin } from '../../../../tools/check-bundle-package-boundaries/scripts/part-side-effects.mjs';
import { barrelImportsPlugin } from '../../../../tools/check-bundle-package-boundaries/scripts/barrel-imports.mjs';
import { jsonFieldsPlugin } from './json-fields.mjs';
import { buildScreenModules, filesOfBundle, formerNameShims, importMap, savedScreenSharedModules, screenModuleSpecs, SHARED_NAMESPACE, sharedEntries, writeScreenModules } from './screen-modules.mjs';
import { toolFolders } from './tool-folders.mjs';
import { firstLoadInputs } from './workspace-screen-sizes.mjs';
import { writeHarnessSetupAssets } from './harness-setup-assets.mjs';
import { moduleDownloadGraph, staticModuleClosure } from './module-download-graph.mjs';
import { keepBundleNames } from './keep-bundle-names.mjs';
import { walkthroughsPlugin } from './walkthroughs-plugin.mjs';
import { clientFileAt, partsAreToolsPlugin, toolFileOfPart } from './parts-are-tools.mjs';
import { SOURCE_RECORD_FILE, buildCommit, sourceRecord } from '../../../../tools/native-space-source-release/scripts/workspace-source-record.mjs';
import { writePublicIcons } from './public-icons.mjs';
import { installedModules, workshopRoot } from './installed-modules.mjs';
import { lookDocumentCss } from '../../../../tools/screen-look/read-data/look-document-css.js';
import { fileURLToPath } from 'node:url';

const { whatsNewList } = await import('../src/whats-new-rows.mjs');
const { devicesFor } = await import('../src/devices.mjs');

const root = resolve(dirname(fileURLToPath(new URL(import.meta.url))), '..');
// The Workshop's own folder, and the node_modules that holds the build's other packages (scripts/installed-modules.mjs).
const workshop = workshopRoot(root);
const modules = installedModules(root);
const out = resolve(root, process.env.WORKSPACE_OUT ?? 'dist/workspace-assets', 'workspace');
// The content-named files: rebuilt whole each time, so no earlier build's names linger beside the current ones.
const NAMED = 'named';
const named = join(out, NAMED);
const PUBLIC_NAMED = `/workspace/${NAMED}/`;
rmSync(named, { recursive: true, force: true });
mkdirSync(named, { recursive: true });
// Each part is the Workshop tool of its name: this client sits at tools/workspace-screens/web, so the parts are two folders up.
const parts = resolve(root, '../..');
const partsAreTools = partsAreToolsPlugin(root, parts);
// Imports of a part's index become imports of the files it names, so the first load carries only what it uses.
const barrels = barrelImportsPlugin(parts);
// A Workshop tool's import of a file the web shell keeps is answered with that file (scripts/workshop-shell-imports.mjs).
const workshopShell = workshopShellImportsPlugin(root, { modules, workshop });
// A JSON file the page reads only some fields of carries only those fields (scripts/browser-json-fields.json). It is
// listed before the part plugin in every build, which answers every relative import inside a part (a part's own JSON
// file included) and would otherwise hand the page the whole file.
const jsonFields = jsonFieldsPlugin(root, file => clientFileAt(root, file));
// The icons the first load carries are those its own files name; the rest arrive when first drawn. The files are known
// from the first build of the page (below), so that build carries every icon and the page's own build splits them.
const firstLoadSources = { files: null };
// The icons are those the client's own src and the parts (the Workshop's tools) name.
const iconFolders = [join(root, 'src'), parts];
const pageIcons = namedIconsPlugin(root, iconFolders, { files: () => firstLoadSources.files });
// The tours the workspace ships: every file in src/workspace/walkthroughs/ is one tour, so adding a tour is adding a file.
const walkthroughsDir = join(root, 'src/workspace/walkthroughs');
const walkthroughFiles = readdirSync(walkthroughsDir).filter(file => file.endsWith('.json')).sort().map(file => `src/workspace/walkthroughs/${file}`);
// The arrangement's own math, compiled for the page (crates/screen-arrangement): its glue is bundled, its bytes served.
// It is committed already built (crates/built-stored-bytes, scripts/build-compiled-modules.mjs), so this needs no Rust.
// A build of a named commit (WORKSPACE_SOURCE_COMMIT: a release, which has neither cargo nor the engine's crates beside the Workshop) reads the compiled
// modules as committed, and the source record below judges them like every other input; any other build checks them against their crates first.
await (process.env.WORKSPACE_SOURCE_COMMIT ? withStagedModules : withCommittedModules)(async () => {
const arrangement = { gluePath: resolve(root, BUILT_CRATES_FOLDER, 'screen-arrangement/screen_arrangement.js'), wasmPath: resolve(root, BUILT_CRATES_FOLDER, 'screen-arrangement/screen_arrangement_bg.wasm') };
// The composition engine a written page is laid out by (crates/composition-engine), a slot the page runs itself
// (src/workspace/slot-in-the-page.ts); its bytes are served as their own content-named file.
const compositionEngineBytes = resolve(root, BUILT_CRATES_FOLDER, 'composition-engine/composition_engine.wasm');
// The name every content-named file the page loads carries: its BLAKE3 identity, cut to 16 characters.
const contentName = bytes => bytesToHex(blake3(bytes)).slice(0, 16);
// The tours are DATA, read when one is first wanted (the tour host after the page has drawn, Tours, the page editor), so
// no script carries every tour's words: one content-named file the page fetches, its address the module's only words.
const tours = `[${walkthroughFiles.map(file => JSON.stringify(JSON.parse(readFileSync(join(root, file), 'utf8')))).join(',')}]`;
const toursName = `walkthroughs-${contentName(Buffer.from(tours))}.json`;
writeFileSync(join(named, toursName), tours);

// The page's own build, as one set of options: built once to learn which files the page holds, then again with the
// files the tools' own screens share with it (scripts/screen-modules.mjs).
const pageBuild = (extraEntries = {}, extraPlugins = [], write = true) => build({
  absWorkingDir: root,
  // The screen view an AI app draws (src/workspace/screen-view.tsx) is an entry of the same build, so it mounts the very
  // screens the page does, from the same files.
  // The signed-in workspace as files any computer serves (src/workspace/account-workspace.ts) is an entry of the same
  // build too, so it mounts the same screens from the same files.
  entryPoints: { workspace: 'src/workspace/main.tsx', 'screen-view': 'src/workspace/screen-view.tsx', 'account-workspace': 'src/workspace/account-workspace.ts', ...extraEntries },
  // Each screen main.tsx fetches with import() becomes its own file; code two screens share becomes a file both fetch.
  bundle: true, format: 'esm', splitting: true, platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic',
  outdir: named, entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', assetNames: '[name]-[hash]', publicPath: PUBLIC_NAMED,
  metafile: true, logLevel: 'warning', legalComments: 'none', write,
  // The filter's generated glue names its bytes relative to its own module; this page always hands it the bytes.
  define: { 'process.env.NODE_ENV': '"production"' },
  // A compiled part's bytes imported by the page become a content-named file; the import is its address.
  loader: { '.css': 'css', '.wasm': 'file' },
  // The shared uploader reads a file from disk only when run on a computer; the page hands it the File instead.
  plugins: [pageIcons, jsonFields, partSideEffectsPlugin(parts), workshopShell, partsAreTools, barrels.plugin, {
    name: 'screen-arrangement-in-the-page',
    setup(builder) {
      builder.onResolve({ filter: /^screen-arrangement-in-the-page$/ }, () => ({ path: arrangement.gluePath }));
      builder.onResolve({ filter: /^screen-arrangement-bytes$/ }, () => ({ path: arrangement.wasmPath }));
      builder.onResolve({ filter: /^composition-engine-bytes$/ }, () => ({ path: compositionEngineBytes }));
    },
  }, walkthroughsPlugin({ publicNamed: PUBLIC_NAMED, toursName, walkthroughFiles, root }), ...extraPlugins],
});
// The tools' own screens (a row's screen.kind "module"): each built into its own bundle that leaves out every file the
// page holds, reached through the page's import map instead, so a screen shares the page's React, parts and helpers.
const probe = await pageBuild({}, [], false);
// Only Trillion's own files name icons by name; an installed package's files (Lucide's own index names every icon) do not.
firstLoadSources.files = firstLoadInputs(probe.metafile).filter(file => !file.split('/').includes('node_modules')).map(file => resolve(root, file)).filter(file => existsSync(file));
const folders = toolFolders(undefined, root, modules, { 'trillion-workshop': workshop });
const toolScreens = await buildScreenModules({
  root, specs: screenModuleSpecs(folders.rowFiles), packageDir: folders.packageDir,
  pageFiles: filesOfBundle(probe.metafile, root),
  options: { target: 'es2022', minify: true, jsx: 'automatic', logLevel: 'warning', legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' } },
  plugins: [namedIconsPlugin(root, iconFolders), jsonFields, partSideEffectsPlugin(parts), workshopShell, partsAreTools, barrels.plugin, walkthroughsPlugin({ publicNamed: PUBLIC_NAMED, toursName, walkthroughFiles, root })],
});
const shared = await sharedEntries(savedScreenSharedModules(toolScreens.asked), root, [partsAreTools, workshopShell]);
const bundled = keepBundleNames(await pageBuild(shared.entryPoints, [shared.plugin], false),
  { root, outdir: named, publicPath: PUBLIC_NAMED });
// The view an AI app draws when show_file names it (src/workspace/file-view.tsx): the shared file preview and player,
// in the same look, served beside the workspace as file-view.js (its classes are the workspace's, so it shares workspace.css).
const fileView = await build({
  absWorkingDir: root,
  entryPoints: ['src/workspace/file-view.tsx'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic',
  outfile: join(out, 'file-view.js'), metafile: true, logLevel: 'warning', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [namedIconsPlugin(root, iconFolders), jsonFields, partSideEffectsPlugin(parts), workshopShell, partsAreTools, barrels.plugin],
});
// Public share pages mount the same media player, without loading the signed-in workspace program.
const shareView = await build({
  absWorkingDir: root,
  entryPoints: ['src/workspace/share-view.tsx'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic',
  outfile: join(out, 'share-view.js'), metafile: true, logLevel: 'warning', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [namedIconsPlugin(root, iconFolders), jsonFields, partSideEffectsPlugin(parts), workshopShell, partsAreTools, barrels.plugin],
});
// The worker that keeps the person's records on this device (tools/device-copy): its own module, with SQLite's compiled
// bytes as a content-named file beside it; device-copy-worker.js is a one-line fixed address importing this build's.
const deviceCopyEntry = relative(root, join(parts, 'device-copy/do-work/device-copy-worker.mjs'));
const deviceCopyWorker = keepBundleNames(await build({
  absWorkingDir: root,
  entryPoints: { 'device-copy-worker': deviceCopyEntry },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  outdir: named, entryNames: '[name]-[hash]', assetNames: '[name]-[hash]', publicPath: PUBLIC_NAMED,
  loader: { '.wasm': 'file' }, metafile: true, logLevel: 'warning', legalComments: 'none', write: false,
  plugins: [workshopShell],
}), { root, outdir: named, publicPath: PUBLIC_NAMED });
const deviceCopyOutput = Object.entries(deviceCopyWorker.metafile.outputs).find(([, output]) => output.entryPoint === deviceCopyEntry);
writeFileSync(join(out, 'device-copy-worker.js'), `import ${JSON.stringify(`${PUBLIC_NAMED}${relative(named, resolve(root, deviceCopyOutput[0]))}`)};\n`);
// The page's files passing on what screen modules share are generated, not written, so the edges judged for them are
// the screen modules' own (each module's graph carries the edges it leaves to the page).
const writtenInputs = Object.fromEntries(Object.entries(bundled.metafile.inputs).filter(([input]) => !input.startsWith(`${SHARED_NAMESPACE}:`)));
// The boundary the build judges is the one the web client held when its tools were installed beside it: the parts folder of the client
// itself (parts/, each with a part.json). The Workshop tools the client takes from are not judged here; their part.json files do not
// yet declare the files the client reaches (the findings of judging them are the lane that declares them).
const boundaryParts = join(root, 'parts');
const boundaries = checkBundlePartBoundaries({ metafile: { inputs: Object.assign({}, writtenInputs, fileView.metafile.inputs, shareView.metafile.inputs, deviceCopyWorker.metafile.inputs, ...toolScreens.modules.map(module => module.graph)), outputs: bundled.metafile.outputs }, bundleRoot: root, partsRoot: boundaryParts, throughIndex: file => barrels.indexesNaming(file) });
if (boundaries.findings.length) {
  for (const finding of boundaries.findings) process.stderr.write(`${describeFinding(finding)}\n`);
  throw new Error('Workspace bundle violates declared part boundaries');
}
assertBundleExports({ metafile: bundled.metafile, bundleRoot: root });
assertBundleExports({ metafile: fileView.metafile, bundleRoot: root });
assertBundleExports({ metafile: shareView.metafile, bundleRoot: root });
assertBundleExports({ metafile: deviceCopyWorker.metafile, bundleRoot: root });
for (const module of toolScreens.modules) assertBundleExports({ metafile: module.metafile, bundleRoot: root });
// These scripts execute as browser pages: leaving an external Node import in them can make the asset fail when the
// browser evaluates it, even when the importing branch is only used by a local computer caller.
const nodeImports = [...Object.values(bundled.metafile.outputs), ...Object.values(fileView.metafile.outputs), ...Object.values(shareView.metafile.outputs), ...Object.values(deviceCopyWorker.metafile.outputs)]
  .flatMap(output => output.imports.map(item => item.path))
  .filter(path => path.startsWith('node:'));
if (nodeImports.length) throw new Error(`Browser bundles may not import Node modules: ${[...new Set(nodeImports)].join(', ')}`);

// Every class the bundled parts can ask for, read from their own source, so the stylesheet holds exactly those.
// A screen module's looks live in this stylesheet too, so its classes are read with the page's.
const sources = [...new Set([...Object.keys(bundled.metafile.inputs), ...Object.keys(fileView.metafile.inputs), ...Object.keys(shareView.metafile.inputs), ...Object.keys(deviceCopyWorker.metafile.inputs)].map(input => filePathOfBundleInput(input, root)).concat(toolScreens.modules.flatMap(module => module.sources)))].filter(file => file && (file.startsWith(`${parts}/`) || file.startsWith(join(root, 'src/workspace/')) || toolScreens.modules.some(module => file.startsWith(`${module.folder}/`))));
// A class may carry single quotes in its arbitrary value ([grid-template-areas:'bin_player']), so each source is read
// both split at single quotes (a class inside a '...' string) and kept whole (the quotes inside a class).
const classWords = text => [...(text.match(/[^\s"'`]+/g) ?? []), ...(text.match(/[^\s"`{}]+/g) ?? [])];
const candidates = new Set();
for (const file of sources) if (/\.(m?[jt]sx?)$/.test(file)) for (const word of classWords(readFileSync(file, 'utf8'))) candidates.add(word);
// A look is the web shell's own (tools/screen-look/show) or, when the web shell does not hold it, the Workshop's
// screen-look tool's, where the looks moved (trillion-workshop tools/screen-look/show).
const workshopLooks = relative(root, join(workshop, 'tools/screen-look/show'));
const lookAt = file => [join(relative(root, join(parts, 'screen-look/show')), file), join(workshopLooks, file)].find(path => existsSync(join(root, path))) ?? join(relative(root, join(parts, 'screen-look/show')), file);
// A look whose comment closes without opening (its first "/*" lost) makes the browser drop every rule after it, in this
// sheet and every sheet it is joined into, with no error anywhere: the build refuses it instead.
const look = file => {
  const css = readFileSync(join(root, lookAt(file)), 'utf8');
  if (css.replace(/\/\*[\s\S]*?\*\//g, '').includes('*/')) throw new Error(`${lookAt(file)} closes a comment it never opened, so a browser would drop every rule after it.`);
  return css;
};
const { workspaceUtilitySource } = await import('../../../../tools/screen-look/do-work/workspace-utility-source.mjs');
const tailwindSource = workspaceUtilitySource(look('coss-workspace.css'));
const compiled = await compile(tailwindSource, { base: join(modules, 'tailwindcss'), onDependency: () => {} });
// The parts' own looks, each from its one source, in the order the screens rely on (DATA: a test checks every class
// the shared record views draw has a rule in one of them, test/record-views-classes-have-looks.test.mjs).
const LOOKS = JSON.parse(readFileSync(join(root, 'scripts/workspace-looks.json'), 'utf8'));
const twenty = file => readFileSync(join(parts, 'ui/show/twenty', file), 'utf8');
// The stylesheets esbuild wrote for the bundle's own CSS imports (one per file that imports CSS, a screen's included),
// joined into the one stylesheet and then removed, so a screen opened later never waits for its own look.
const bundledCssPaths = Object.keys(bundled.metafile.outputs).map(file => resolve(root, file)).filter(file => file.endsWith('.css'));
const bundledCss = [...bundledCssPaths.map(file => readFileSync(file, 'utf8')), ...toolScreens.modules.map(module => module.stylesheet)].join('\n');
for (const file of bundledCssPaths) rmSync(file);
// Minified as one sheet: its parts are written to be read (comments, spacing). A look several screens import arrives
// once per screen's own stylesheet; the minifier drops most repeats, and oneCopyOfEachRule drops the ones it keeps
// (a rule holding url(...)), so each look arrives once.
// The light theme carries only the tokens something here can read: the parts' own source and every other look.
const utilities = compiled.build([...candidates]);
const otherLooks = [...LOOKS.map(look), twenty('record-table.css'), bundledCss, readFileSync(join(root, 'src/workspace/workspace.css'), 'utf8')];
const lightTheme = lightThemeCss(parts, [tailwindSource, utilities, ...otherLooks, ...sources.filter(file => !file.startsWith(join(parts, 'ui/show/twenty/theme-'))).map(file => readFileSync(file, 'utf8'))]);
const stylesheet = oneCopyOfEachRule((await transform([
  utilities,
  ...LOOKS.map(look),
  lightTheme, twenty('record-table.css'),
  bundledCss,
  readFileSync(join(root, 'src/workspace/workspace.css'), 'utf8'),
].join('\n'), { loader: 'css', minify: true, logLevel: 'silent' })).code);
// The content-named copy sits one folder deeper than the looks it is made of, so an address a look gives relative to
// its own folder (its faces: url('fonts/...')) is given relative to /workspace/ instead.
const namedStylesheet = stylesheet.replace(/url\((['"]?)(?![a-z][a-z0-9+.-]*:|\/|#)/gi, 'url($1../');
const stylesheetName = `workspace-${contentName(Buffer.from(namedStylesheet))}.css`;
writeFileSync(join(named, stylesheetName), namedStylesheet);
// The file view keeps fixed addresses (file-view.js, workspace.css): AI apps keep its page between Trillion's deploys,
// so it may only name files that outlive one.
writeFileSync(join(out, 'workspace.css'), stylesheet);
// The public player pays only for the classes it actually uses, not every signed-in screen's stylesheet.
const shareSources = Object.keys(shareView.metafile.inputs).map(input => resolve(root, input)).filter(file => file.startsWith(`${parts}/`) || file.startsWith(join(root, 'src/workspace/')));
const shareCandidates = new Set();
for (const file of shareSources) if (/\.(m?[jt]sx?)$/.test(file)) for (const word of classWords(readFileSync(file, 'utf8'))) shareCandidates.add(word);
const shareCompiled = await compile(tailwindSource, { base: join(modules, 'tailwindcss'), onDependency: () => {} });
writeFileSync(join(out, 'share-view.css'), [shareCompiled.build([...shareCandidates]), look('coss-workspace.css'),
  twenty('record-table.css'), look('look-bridges.css'), look('edge-fade.css'), look('chart.css'),
  look('schedule-calendar.css'), look('rotating-carousel.css'), look('creative-workspace.css')].join('\n'));
// The look every page starts with (src/page-look.mjs), alone, at a fixed address (look.css), for code that is not built
// here: a screen an AI wrote (tools/ui/show/run-the-screen-an-ai-wrote) may link it or carry it, and draw with its tokens.
const { wornLook } = await import('../src/page-look.mjs');
writeFileSync(join(out, 'look.css'), (await transform(lookDocumentCss(wornLook(null).palette), { loader: 'css', minify: true, logLevel: 'silent' })).code);
// The public share look also serves collections with no media player, so it is an independent stylesheet.
writeFileSync(join(out, 'public-share.css'), [look('loading-mark.css'), look('public-share.css')].join('\n'));
// What the Worker writes into the workspace page (src/workspace-files.mjs): the script, the stylesheet, and the files
// the script imports before it can run, fetched alongside it instead of after it is read.
const entryOutput = Object.entries(bundled.metafile.outputs).find(([, output]) => output.entryPoint === 'src/workspace/main.tsx');
const addressOf = file => `${PUBLIC_NAMED}${relative(named, resolve(root, file))}`;
const staticClosure = file => staticModuleClosure(bundled.metafile, file);
const moduleDownloadSources = new Set(Object.keys(bundled.metafile.inputs).filter(file => file.endsWith('/module-downloads.json')).flatMap(file => Object.values(JSON.parse(readFileSync(resolve(root, file), 'utf8')))));
const firstLoad = [...staticClosure(entryOutput[0])];
// The screen view keeps a fixed address (screen-view.js) for the same reason the file view does: an AI app keeps the
// view's page between deploys. It is one line that imports this build's content-named entry.
const screenViewOutput = Object.entries(bundled.metafile.outputs).find(([, output]) => output.entryPoint === 'src/workspace/screen-view.tsx');
writeFileSync(join(out, 'screen-view.js'), `import ${JSON.stringify(addressOf(screenViewOutput[0]))};\n`);
// Each screen's own files (its file and the shared files the first load did not bring), by the entry name screen-mounts.ts
// mounts it under, so the Worker can fetch the asked-for screen's code alongside the page's.
const screenModules = [...readFileSync(join(root, 'src/workspace/screen-mounts.ts'), 'utf8').matchAll(/^\s+'?([\w-]+)'?: lazyScreen\(\(\) => import\('([^']+)'\)/gm)]
  .map(([, entry, path]) => {
    const asked = resolve(root, 'src/workspace', path);
    return [entry, relative(root, toolFileOfPart(asked, parts) ?? asked).replace(/\.[mc]?[jt]sx?$/, '')];
  });
const outputOfModule = module => Object.keys(bundled.metafile.outputs).find(file => (bundled.metafile.outputs[file].entryPoint ?? '').replace(/\.[mc]?[jt]sx?$/, '') === module);
const screenFiles = Object.fromEntries(screenModules.map(([entry, module]) => {
  const own = outputOfModule(module);
  if (!own) throw new Error(`screen-mounts.ts mounts ${entry} from ${module}, which the bundle has no file for.`);
  return [entry, [...staticClosure(own)].filter(file => !firstLoad.includes(file)).map(addressOf)];
}));
// What a tool's own screen code imports the page's files by (scripts/screen-modules.mjs), with each former name of a
// shared module still in its window pointed at its shim file (formerNameShims).
const screenImportMap = importMap(shared.entryOf, bundled.metafile, addressOf, toolScreens.modules);
for (const shim of formerNameShims(screenImportMap.imports)) {
  writeFileSync(join(named, shim.file), shim.source);
  screenImportMap.imports[shim.specifier] = `${PUBLIC_NAMED}${shim.file}`;
}
writeFileSync(join(out, 'files.json'), `${JSON.stringify({
  public_assets: writePublicIcons(named),
  module_downloads: moduleDownloadGraph({ metafile: bundled.metafile, root, sources: moduleDownloadSources, addressOf }),
  script: addressOf(entryOutput[0]),
  stylesheet: `${PUBLIC_NAMED}${stylesheetName}`,
  preload: firstLoad.filter(file => file !== entryOutput[0]).map(addressOf),
  first_load_script_bytes: firstLoad.reduce((sum, file) => sum + bundled.metafile.outputs[file].bytes, 0),
  screens: screenFiles,
  import_map: screenImportMap,
}, null, 2)}\n`);
// The page of the signed-in workspace any computer serves as files (src/workspace/account-workspace.ts): /workspace and its
// sign-in callback are the same page. Its client document (CIMD, src/workspace/account-pass.json) names the page's own
// origin, so it is written for the origin the build is given (WORKSPACE_ORIGIN, the public name a front door serves it at);
// a build given none writes no client document, and that page cannot sign in. The page's name is the site's own
// (WORKSPACE_NAME, from the brand row of the site that serves it), else its host name.
const accountOutput = Object.entries(bundled.metafile.outputs).find(([, output]) => output.entryPoint === 'src/workspace/account-workspace.ts');
const accountFiles = [...staticClosure(accountOutput[0])].filter(file => file !== accountOutput[0]).map(addressOf);
const siteOrigin = process.env.WORKSPACE_ORIGIN ? new URL(process.env.WORKSPACE_ORIGIN).origin : null;
const siteName = process.env.WORKSPACE_NAME || (siteOrigin ? new URL(siteOrigin).hostname : '');
const escapeHtml = text => text.replace(/[&<>"]/g, mark => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[mark]);
const accountPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(siteName)}</title>`
  + `<link rel="stylesheet" href="${PUBLIC_NAMED}${stylesheetName}"><script type="importmap">${JSON.stringify(screenImportMap)}</script>`
  + accountFiles.map(file => `<link rel="modulepreload" href="${file}">`).join('')
  + `</head><body><script type="module" src="${addressOf(accountOutput[0])}"></script></body></html>\n`;
const accountPass = JSON.parse(readFileSync(join(root, 'src/workspace/account-pass.json'), 'utf8'));
writeFileSync(resolve(out, '..', `${accountPass.home.slice(1)}.html`), accountPage);
writeFileSync(resolve(out, '..', `${accountPass.callback.slice(1)}.html`), accountPage);
if (siteOrigin) {
  const origin = siteOrigin;
  writeFileSync(resolve(out, '..', accountPass.client_document.slice(1)), `${JSON.stringify({
    client_id: `${origin}${accountPass.client_document}`, client_name: siteName, client_uri: origin,
    redirect_uris: [`${origin}${accountPass.callback}`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', scope: accountPass.scope,
  }, null, 2)}\n`);
}
// Each screen module's bundle, for the deploy to keep in the namespace and name in its tool's row (scripts/tool-bundles.mjs).
writeScreenModules(resolve(out, '..', '..'), toolScreens.modules);
// The faces the looks name (fonts.css), served beside the stylesheet; fonts.css itself too, so a page drawn by the
// server (src/page-look.mjs) reads the same faces without the workspace stylesheet.
cpSync(join(root, lookAt('fonts')), join(out, 'fonts'), { recursive: true });
copyFileSync(join(root, lookAt('fonts.css')), join(out, 'fonts.css'));
// The drawings pages open with (a section's `illustration`), served as /workspace/illustrations/<meaning>.webp.
const illustrationFiles = readdirSync(join(root, 'assets/illustrations')).filter(file => file.endsWith('.webp')).sort();
cpSync(join(root, 'assets/illustrations'), join(out, 'illustrations'), { recursive: true });
// The files a showcase's seed writes into the demo account (src/showcases.json `content_asset`), served as /workspace/showcase/<name>.
if (existsSync(join(root, 'assets/showcase'))) cpSync(join(root, 'assets/showcase'), join(out, 'showcase'), { recursive: true });
// The packages served as their own files (a PDF's first page reader, the HEIF photo decoder: each loaded only when a
// card first needs it, scripts/open-source-notices.json), and the notices for every package the workspace ships, with
// each licence text, at /workspace/open-source/ (scripts/open-source-notices.mjs).
// What is new, as a list's rows read from the what's-new tours this build ships (src/whats-new-rows.mjs), at
// /workspace/whats-new.json, with each tour's picture at /workspace/whats-new/<file>: a Trillion list fills itself from
// it (tool:fill-a-list-from-a-feed) and the service's changelog page reads that list, so nobody types a changelog.
const whatsNewPictures = join(walkthroughsDir, 'pictures');
const whatsNewPicturesFile = join(whatsNewPictures, 'pictures.json');
const pictures = existsSync(whatsNewPicturesFile) ? JSON.parse(readFileSync(whatsNewPicturesFile, 'utf8')) : {};
writeFileSync(join(out, 'whats-new.json'), `${JSON.stringify(whatsNewList(walkthroughFiles.map(file => JSON.parse(readFileSync(join(root, file), 'utf8'))), { pictures }))}\n`);
if (existsSync(whatsNewPictures)) cpSync(whatsNewPictures, join(out, 'whats-new'), { recursive: true, filter: source => !source.endsWith('pictures.json') });
// Every way into Trillion, at /workspace/devices.json: the same rows (src/devices.json) the app offers in Use Trillion
// in your AI and start_setup, each with its logo and every link per system, for any site to show (the service's
// ways-in section reads it), so a new app or a newly published link is one row and shows everywhere.
writeFileSync(join(out, 'devices.json'), `${JSON.stringify({ devices: devicesFor().map(({ installed: _installed, ...device }) => ({ ...device, logo: logoOf(device.domain) })) })}\n`);
// The current AI can obtain and run this setup pair from the same existing public static-asset route.
const harnessSetupInputs = writeHarnessSetupAssets({ root, out });
writeOpenSourceNotices({ root, out, modules, inputs: [...Object.keys(bundled.metafile.inputs), ...Object.keys(fileView.metafile.inputs), ...Object.keys(shareView.metafile.inputs), ...Object.keys(deviceCopyWorker.metafile.inputs), ...harnessSetupInputs] });
// Every source file these assets are made of (the bundle's inputs, the looks, the crate), beside the assets folder and
// never inside it, so a deploy can refuse to upload anything not committed (scripts/deploy-worker.mjs).
const lookFiles = [...LOOKS, 'coss-workspace.css', ...readdirSync(join(root, lookAt('fonts'))).map(file => `fonts/${file}`)].map(lookAt);
// The crates the page's compiled modules are built from sit in the Workshop tool that owns each, one crates/ workspace per tool.
const crateTools = { 'screen-arrangement': 'screen-arrangement', 'composition-engine': 'composition-scene-renderer', 'composition-engine-core': 'composition-scene-renderer', 'state-graph': 'composition-scene-renderer' };
const cratesOf = tool => relative(root, join(parts, tool, 'crates'));
const crateSources = crate => {
  const folder = `${cratesOf(crateTools[crate])}/${crate}`;
  return [`${folder}/Cargo.toml`, ...readdirSync(join(root, folder, 'src'), { recursive: true }).filter(file => file.endsWith('.rs')).map(file => `${folder}/src/${file}`)];
};
const crateFiles = [...new Set(Object.values(crateTools))].flatMap(tool => [`${cratesOf(tool)}/Cargo.toml`, `${cratesOf(tool)}/Cargo.lock`]).concat(Object.keys(crateTools).flatMap(crateSources));
// The bundle's own import graph beside it, for the per-screen size check (scripts/workspace-screen-sizes.mjs).
writeFileSync(resolve(out, '..', '..', 'workspace.meta.json'), JSON.stringify(bundled.metafile));
const inputsFile = resolve(out, '..', '..', 'workspace.inputs.json');
writeFileSync(inputsFile, JSON.stringify([...new Set([...[...Object.keys(bundled.metafile.inputs), ...Object.keys(fileView.metafile.inputs), ...Object.keys(shareView.metafile.inputs), ...Object.keys(deviceCopyWorker.metafile.inputs), ...toolScreens.modules.flatMap(module => Object.keys(module.metafile.inputs))].filter(path => !path.includes(':')), ...lookFiles, lookAt('public-share.css'), 'scripts/workspace-looks.json', ...walkthroughFiles, 'src/whats-new-rows.mjs', 'src/devices.json', ...harnessSetupInputs, ...(existsSync(whatsNewPictures) ? readdirSync(whatsNewPictures).sort().map(file => `src/workspace/walkthroughs/pictures/${file}`) : []), ...illustrationFiles.map(file => `assets/illustrations/${file}`), ...(existsSync(join(root, 'assets/showcase')) ? readdirSync(join(root, 'assets/showcase')).sort().map(file => `assets/showcase/${file}`) : []), relative(root, join(parts, 'ui/show/twenty/theme-light.css')), relative(root, join(parts, 'ui/show/twenty/record-table.css')), 'src/workspace/workspace.css', ...crateFiles])].sort()));
// Which of those inputs the commit this build names holds byte for byte; the Mac app carries this client only when all of them (scripts/workspace-source-record.mjs).
writeFileSync(resolve(out, '..', '..', SOURCE_RECORD_FILE), JSON.stringify(sourceRecord({
  root, inputs: JSON.parse(readFileSync(inputsFile, 'utf8')), commit: buildCommit(root), repo: process.env.WORKSPACE_SOURCE_REPO ?? root,
  prefix: process.env.WORKSPACE_SOURCE_PREFIX ?? '',
  // The client is the Workshop's own files, asked of the Workshop commit at their path from the Workshop's folder (a link to it in a checkout, the installed copy elsewhere).
  treeRoot: realpathSync(workshop) })));
process.stdout.write(`built ${relative(root, out)}: ${Object.keys(bundled.metafile.outputs).filter(file => !file.endsWith('.css')).length} content-named files and ${stylesheetName} in ${NAMED}/, file-view.js, screen-view.js, share-view.js, device-copy-worker.js, share-view.css, look.css, workspace.css, files.json; ${toolScreens.modules.length} screen modules sharing ${shared.entryOf.size} files with the page\n`);

});
