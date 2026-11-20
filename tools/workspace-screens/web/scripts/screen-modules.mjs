// scripts/screen-modules.mjs
//
// Purpose
//   A tool's screen can be its own code, kept in its tool folder instead of inside the workspace: its row says
//     "screen": { "kind": "module", "module": { "package": "<tool folder>", "entry": "<file in it>" } }
//   and the workspace build (scripts/build-workspace.mjs) compiles that file into a bundle of ES module files the page
//   imports when the screen opens (src/workspace/tool-screen.tsx), served from the namespace by its identity at
//   /workshop/modules/<bundle>/<file> (src/files-by-identity.mjs). The deploy keeps each bundle as a file of the
//   service's account and writes its identity into the row (scripts/tool-bundles.mjs), so the row reads
//     "module": { "bundle": "1f:<hex>", "file": "<entry>.js" }.
//   React, the shared parts and the workspace's own helpers are never copied into a bundle: every file the workspace
//   page already carries stays in the page, and a bundle reaches it by a name the page's import map resolves to the
//   page's own copy. So a screen and the page share one React, one records store and one set of parts.
//
// Non-negotiable invariants
//   1. Blind: nothing here names a tool, a part or a screen; which screens are modules is the rows' own DATA.
//   2. What a bundle shares with the page is decided by the page: a file of this repository the workspace bundle holds
//      is reached as `@trillion/<path in this repository>`, and an installed module that must be one instance on the
//      page (scripts/screen-modules-shared.json: React) as the name the code imports it by (`react`,
//      `react/jsx-runtime`). Anything else goes inside the bundle, an installed module cut to what the screen uses.
//   3. The page exposes exactly what some bundle imports (`sharedEntries`): for each shared file, one small
//      content-named file the import map points at, giving back only the names bundles import from it (read from the
//      bundles' own import statements) through one surface module of the page, built in the same build as the page so
//      it is the page's own instance. Passing on only those names keeps the rest of each file out of the page (a file
//      shared whole keeps every export alive), and one surface keeps the page split once, not once per shared file.
//   4. A bundle is byte-for-byte the same for the same sources (sorted tar, no times), so an unchanged screen keeps its
//      identity and is uploaded once.
//
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { tarGz } from '../../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { filePathOfBundleInput } from '../../../../tools/check-bundle-package-boundaries/scripts/check-bundle-part-boundaries.mjs';
import { resolveLocal } from '../../../../tools/check-bundle-package-boundaries/scripts/part-side-effects.mjs';
import { moduleAddress, screenModuleSpecifier } from '../src/workspace/screen-module-address.mjs';

/** Where the workspace build leaves what the deploy needs about the screen modules, beside workspace.meta.json. */
export const SCREEN_MODULES_FILE = 'screen-modules.json';
const SHARED_PREFIX = '@trillion/';
export const SHARED_NAMESPACE = 'shared-module';
const VIRTUAL = SHARED_NAMESPACE;
const SHARED_INSTALLED = new Set(JSON.parse(readFileSync(new URL('./screen-modules-shared.json', import.meta.url), 'utf8')).installed_modules);
const SHARED_MODULES = JSON.parse(readFileSync(new URL('./screen-modules-shared.json', import.meta.url), 'utf8'));
// Modules the page's own build answers by name through a plugin (the shipped tours): shared by that name, never carried.
const PAGE_MODULES = new Set(SHARED_MODULES.page_modules);
const SAVED_SCREEN_MODULES = SHARED_MODULES.saved_screen_modules;
const packageOf = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const JS_OR_JSON = /\.(m?[jt]sx?|json)$/;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bare = path => !/^[./#]/.test(path) && !path.startsWith(SHARED_PREFIX) && !/^[a-z][a-z0-9+.-]*:/i.test(path);
const identityOf = bytes => `1f:${bytesToHex(blake3(bytes))}`;

/** The key a module spec is found by in the build's answer: its tool folder and its file. */
export const moduleKey = spec => `${spec.package}/${spec.entry}`;


/** A row's screen module still to be built: `{ package, entry }`. A built one names its `bundle` instead. */
export const moduleSpecOf = row => {
  const module = row?.screen?.kind === 'module' ? row.screen.module : undefined;
  return object(module) && typeof module.package === 'string' && typeof module.entry === 'string' ? module : null;
};

/** Every row payload a rows file (or a folder of them) holds. The Workshop's ai-tool-catalog reads rows files the same
 * way (do-work/derive-tool-rows-from-sources.mjs); that module also imports TypeScript, which Node does not run from
 * node_modules, so the build reads the rows itself. */
const payloadsIn = path => {
  const files = statSync(path).isDirectory() ? readdirSync(path).filter(name => name.endsWith('.json')).map(name => join(path, name)) : [path];
  return files.flatMap(file => (JSON.parse(readFileSync(file, 'utf8')).records ?? []).map(record => record.payload));
};

/** Every screen module the rows in `rowFiles` (scripts/tool-folders.mjs) name, once each. */
export function screenModuleSpecs(rowFiles) {
  const specs = new Map();
  for (const file of rowFiles) for (const row of payloadsIn(file)) {
    const spec = moduleSpecOf(row);
    if (spec) specs.set(moduleKey(spec), { package: spec.package, entry: spec.entry });
  }
  return [...specs.values()];
}

/** Every file a finished esbuild bundle holds, as absolute paths: what a screen module may share with it. */
export const filesOfBundle = (metafile, root) => new Set(Object.keys(metafile.inputs).map(input => filePathOfBundleInput(input, root)).filter(Boolean));

/** The public library for saved screens exists independently of shipped screen imports.
 * These are separate module entry points: merely listing one in the import map does not fetch it.
 * Product capabilities and private records are never exported through this library. */
export function savedScreenSharedModules(asked) {
  const entries = new Map(asked);
  for (const [specifier, declaration] of Object.entries(SAVED_SCREEN_MODULES)) {
    entries.set(specifier, { ...declaration, names: '*' });
  }
  return entries;
}

// A relative import of another code file (of the page's own tree, or inside an installed package, whose `utils.mjs` may
// pass on `./utils/element.mjs` whole): followed in the probe, so the names a file passes on with `export * from` are read.
const CODE_PATH = /^\.{1,2}\/(?:[^?#]*\/)?[^./?#]+(?:\.(?:[cm]?[jt]sx?))?$/;

// What the page passes on for one shared name (`index` numbers it): the names bundles import from it (`names`, or
// every one when some bundle took the whole module), read from the file the page's own build picks for it (the
// bundler's own reading). They pass through one surface module of the page, each under a name of its own
// (`s<index>_<name>`), and the shared name's own file (`stub`) gives them back their names: one surface means the
// page's code is split once for everything shared, however many files are. A CommonJS module (React) has only its
// value, so its names are read from that value and given from it.
async function sharedSource(shared, names, index, root, surface, plugins) {
  const target = shared.kind === 'file' ? `./${shared.path}` : shared.name;
  // A module the page's build answers through a plugin has no file to read its names from: it gives its default.
  const probe = shared.kind === 'page' ? null : await build({
    absWorkingDir: root, entryPoints: [target], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', logLevel: 'silent', outdir: '/probe',
    // A page file that names compiled bytes (record-filter.ts: the formula engine's wasm) is probed for its names like any other; the bytes are not read.
    loader: { '.wasm': 'empty' },
    plugins: [...plugins, { name: 'only-this-file', setup(only) { only.onResolve({ filter: /.*/ }, args => (args.kind === 'entry-point' || args.kind === 'import-statement' && CODE_PATH.test(args.path) ? undefined : { path: args.path, external: true })); } }],
  });
  const exports = probe ? Object.values(probe.metafile.outputs).find(output => output.entryPoint)?.exports ?? [] : ['default'];
  const quoted = JSON.stringify(target);
  const own = name => `s${index}_${name}`;
  if (shared.kind === 'installed' && !exports.some(one => one !== 'default')) {
    const value = createRequire(join(root, 'package.json'))(shared.name);
    const wanted = (names === '*' ? Object.keys(value) : [...names]).filter(key => /^[A-Za-z_$][\w$]*$/.test(key) && key !== 'default' && key !== '__esModule');
    return {
      surface: `export { default as ${own('value')} } from ${quoted};\n`,
      stub: `import { ${own('value')} as value } from ${surface};\nexport default value;\n${wanted.length ? `export const { ${wanted.join(', ')} } = value;\n` : ''}`,
    };
  }
  const wanted = names === '*' ? exports : [...names].sort();
  const missing = wanted.filter(name => !exports.includes(name));
  if (missing.length) throw new Error(`A screen module imports ${missing.join(', ')} from ${target}, which does not export ${missing.length === 1 ? 'it' : 'them'}.`);
  return {
    surface: `export { ${wanted.map(name => `${name} as ${own(name)}`).join(', ')} } from ${quoted};\n`,
    stub: `export { ${wanted.map(name => `${own(name)} as ${name}`).join(', ')} } from ${surface};\n`,
  };
}

// What a bundle's own files import from each shared name, read from its import statements (the bundler writes each
// import of an outside module in one of a few fixed forms): the names, or '*' when it takes the whole module.
const IMPORTS = /\bimport\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s*[\w$]+)?\s*from\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)|\bexport\s*\*\s*from\s*"([^"]+)"/g;
function namesImported(text, shared, asked) {
  for (const match of text.matchAll(IMPORTS)) {
    const specifier = match[3] ?? match[4] ?? match[5];
    if (!shared.has(specifier)) continue;
    const entry = asked.get(specifier);
    const whole = match[4] !== undefined || match[5] !== undefined || /\*\s*as/.test(match[0]);
    if (whole || entry.names === '*') { entry.names = '*'; continue; }
    if (match[1]) entry.names.add('default');
    for (const part of (match[2] ?? '').split(',').map(one => one.trim()).filter(Boolean)) entry.names.add(part.split(/\s+as\s+/)[0].trim());
  }
}

// The file an import of this repository's own code names: a relative path, or one of package.json's own `imports`
// (`#workspace-records`, `#workspace/<file>`); null for anything else, which the bundler resolves as usual. Read here
// rather than asked of the bundler, which answers one question at a time.
function localResolver(root) {
  const aliases = Object.entries(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).imports ?? {});
  return (path, resolveDir) => {
    if (path.startsWith('.')) return resolveLocal(resolve(resolveDir, path));
    if (!path.startsWith('#')) return null;
    for (const [alias, target] of aliases) {
      if (alias === path) return resolveLocal(resolve(root, target));
      if (alias.endsWith('*') && path.startsWith(alias.slice(0, -1))) return resolveLocal(resolve(root, target.replace('*', path.slice(alias.length - 1))));
    }
    return null;
  };
}

// The file the build's other plugins answer an import with, or null; asked once, so this plugin is not asked again.
async function resolvedByTheBuild(builder, args) {
  const answer = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, namespace: args.namespace, pluginData: { askedByShared: true } });
  return answer.errors.length || answer.external ? null : answer.path;
}

// The plugin that leaves every file the page holds out of a bundle, reached by its shared name instead (invariant 2).
function sharedWithThePage({ root, pageFiles, asked, edges }) {
  const local = localResolver(root);
  return {
    name: 'shared-with-the-page',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.kind === 'entry-point' || args.pluginData?.askedByShared) return undefined;
        // An installed module that must be one instance is shared by the name the code imports it by, whoever imports
        // it (an installed module's own import of React too); any other is carried in the bundle, cut to what it uses.
        if (bare(args.path)) {
          if (PAGE_MODULES.has(args.path)) {
            if (!asked.has(args.path)) asked.set(args.path, { kind: 'page', name: args.path, names: new Set() });
            return { path: args.path, external: true };
          }
          if (!SHARED_INSTALLED.has(packageOf(args.path))) return undefined;
          if (!asked.has(args.path)) asked.set(args.path, { kind: 'installed', name: args.path, names: new Set() });
          return { path: args.path, external: true };
        }
        // A screen that lives in a Workshop tool folder (installed under node_modules) or checked out beside the client (outside its folder) reaches the page's files by the
        // names the page's build answers (workshop-shell-imports.mjs): what that build resolves to a file the page
        // holds is shared with the page, never carried in the bundle a second time.
        const installed = args.importer.split(sep).includes('node_modules') || !args.importer.startsWith(root + sep);
        const path = installed
          ? await resolvedByTheBuild(builder, args)
          : local(args.path, args.resolveDir);
        if (!path || !pageFiles.has(path) || !JS_OR_JSON.test(path)) return undefined;
        // The edge the bundle leaves out is still an edge of its code, judged like any other (part boundaries).
        edges.push({ importer: args.importer, path });
        const shared = relative(root, path).split(sep).join('/');
        const specifier = `${SHARED_PREFIX}${shared}`;
        if (!asked.has(specifier)) asked.set(specifier, { kind: 'file', path: shared, names: new Set() });
        return { path: specifier, external: true };
      });
    },
  };
}

// A bundle's inputs with the edges it left to the page added back, keyed as the bundler keys its inputs.
function withEdges(inputs, edges, root) {
  const graph = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, { ...input, imports: [...(input.imports ?? [])] }]));
  for (const edge of edges) {
    const key = relative(root, edge.importer).split(sep).join('/');
    (graph[key] ??= { imports: [] }).imports.push({ path: relative(root, edge.path).split(sep).join('/') });
  }
  return graph;
}

/**
 * Builds each screen module (`specs`, from screenModuleSpecs) against the page whose files are `pageFiles`
 * (filesOfBundle of the page's own build). `options` are the page's own esbuild options (define, loader, jsx,
 * target), `plugins` the page's own plugins. Returns each module's bundle (its tar's bytes and identity, its entry
 * file, the source files it carries and the stylesheet text its own CSS imports made) and every shared name asked.
 */
export async function buildScreenModules({ root, specs, packageDir, pageFiles, options, plugins = [] }) {
  const asked = new Map();
  const modules = [];
  for (const spec of specs) {
    const edges = [];
    const entryPath = join(packageDir(spec.package), spec.entry);
    if (!existsSync(entryPath)) throw new Error(`The screen module ${moduleKey(spec)} names a file its tool folder does not have (${entryPath}).`);
    const built = await build({
      ...options,
      absWorkingDir: root,
      entryPoints: [entryPath],
      bundle: true, format: 'esm', splitting: true, platform: 'browser', write: false, metafile: true,
      outdir: '/screen-module', entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', assetNames: '[name]-[hash]',
      plugins: [sharedWithThePage({ root, pageFiles, asked, edges }), ...plugins],
    });
    // The output made from this screen's entry file: a chunk split off a dynamic import names an entry point too, so the
    // first output with one is not the screen's.
    const entryOutput = Object.entries(built.metafile.outputs).find(([, output]) => output.entryPoint && realpathSync(resolve(root, output.entryPoint)) === realpathSync(entryPath))?.[0];
    if (!entryOutput) throw new Error(`The screen module ${moduleKey(spec)} made no output from its entry file ${entryPath}.`);
    const sharedNames = new Set(Object.values(built.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path)).filter(path => asked.has(path)));
    const files = [];
    let stylesheet = '';
    for (const output of built.outputFiles) {
      const name = relative('/screen-module', output.path).split(sep).join('/');
      if (name.endsWith('.css')) { stylesheet += `${output.text}\n`; continue; }
      if (!name.endsWith('.js')) throw new Error(`The screen module ${moduleKey(spec)} makes ${name}, a file a screen module cannot carry: a screen module is its scripts, and its looks go in the page's stylesheet.`);
      files.push({ name, bytes: output.contents });
      namesImported(output.text, sharedNames, asked);
    }
    const bytes = tarGz(files);
    modules.push({
      key: moduleKey(spec),
      spec: { package: spec.package, entry: spec.entry },
      folder: packageDir(spec.package),
      bundle: identityOf(bytes),
      file: relative('/screen-module', resolve(root, entryOutput)).split(sep).join('/'),
      bytes,
      count: files.length,
      sources: Object.keys(built.metafile.inputs).map(input => filePathOfBundleInput(input, root)).filter(Boolean),
      stylesheet,
      metafile: built.metafile,
      // Its code's import graph as written, the edges to files it shares with the page included, for the boundary check.
      graph: withEdges(built.metafile.inputs, edges, root),
    });
  }
  return { modules, asked };
}

/** The page's own files for the shared names `asked`: esbuild entry points (one small file per name, giving back what
 *  bundles import from it through the page's one surface module) and the plugin that writes them. `entryOf(specifier)`
 *  is the entry point whose output the import map points at. */
export async function sharedEntries(asked, root, plugins = []) {
  const entryPoints = {};
  const entryOf = new Map();
  const stubs = new Map();
  const surface = JSON.stringify(`${VIRTUAL}:surface`);
  const ordered = [...asked].sort(([a], [b]) => (a < b ? -1 : 1));
  const made = await Promise.all(ordered.map(([, shared], index) => sharedSource(shared, shared.names, index, root, surface, plugins)));
  ordered.forEach(([specifier], index) => {
    const key = `shared-${bytesToHex(blake3(new TextEncoder().encode(specifier))).slice(0, 12)}`;
    entryPoints[key] = `${VIRTUAL}:${key}`;
    entryOf.set(specifier, `${VIRTUAL}:${key}`);
    stubs.set(key, made[index].stub);
  });
  const surfaceSource = made.map(one => one.surface).join('');
  const plugin = {
    name: 'shared-with-screen-modules',
    setup(builder) {
      builder.onResolve({ filter: new RegExp(`^${VIRTUAL}:`) }, args => ({ path: args.path.slice(VIRTUAL.length + 1), namespace: VIRTUAL }));
      builder.onLoad({ filter: /.*/, namespace: VIRTUAL }, args => ({ contents: args.path === 'surface' ? surfaceSource : stubs.get(args.path), resolveDir: root, loader: 'js' }));
    },
  };
  return { entryPoints, entryOf, plugin };
}

/** The import map the page carries: each shared name to the address of the page's file for it. */
export function importMap(entryOf, metafile, addressOf, modules = []) {
  const outputs = Object.entries(metafile.outputs);
  const imports = {};
  for (const [specifier, entry] of entryOf) {
    const output = outputs.find(([, made]) => made.entryPoint === entry)?.[0];
    if (!output) throw new Error(`The page built no file for ${specifier}, which a screen module imports.`);
    imports[specifier] = addressOf(output);
  }
  // Each screen module built with this page, by its row's own spec (`screenModuleSpecifier`), so a screen row of the
  // page's own opens its code without asking anyone which bundle it is.
  for (const module of modules) imports[screenModuleSpecifier(module.spec)] = moduleAddress(module.bundle, module.file);
  return { imports };
}

/** The shim files for former names of shared modules still in their window (scripts/screen-modules-shared.json
 * former_names): [{ specifier, file, source }], each a content-named file that warns once and gives back everything the
 * current name exports, through the import map, so the shim reaches the page's own instance. A row whose current name
 * the import map does not hold, or whose `until` day has passed (`today`, YYYY-MM-DD), makes no shim. */
export function formerNameShims(imports, { rows = SHARED_MODULES.former_names ?? {}, today = new Date().toISOString().slice(0, 10) } = {}) {
  const shims = [];
  for (const [specifier, row] of Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!object(row) || typeof row.now !== 'string' || !Object.hasOwn(imports, row.now) || Object.hasOwn(imports, specifier)) continue;
    if (typeof row.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.until) || row.until < today) continue;
    const now = JSON.stringify(row.now);
    const source = `console.warn(${JSON.stringify(`A saved screen imports "${specifier}", the former name of "${row.now}". It resolves until ${row.until}; import "${row.now}" instead.`)});\n`
      + `import * as current from ${now};\nexport * from ${now};\nexport default current.default;\n`;
    shims.push({ specifier, file: `former-${identityOf(new TextEncoder().encode(source)).slice(3, 19)}.js`, source });
  }
  return shims;
}

/** Keeps what the deploy needs (each module's bundle bytes and where it starts) beside the workspace's build files. */
export function writeScreenModules(folder, modules) {
  const bundles = join(folder, 'screen-modules');
  // Rebuilt whole each time, so no earlier build's bundle lingers beside the current ones.
  rmSync(bundles, { recursive: true, force: true });
  mkdirSync(bundles, { recursive: true });
  for (const module of modules) writeFileSync(join(bundles, `${module.bundle.slice(3)}.tar.gz`), module.bytes);
  writeFileSync(join(folder, SCREEN_MODULES_FILE), `${JSON.stringify({ modules: Object.fromEntries(modules.map(module => [module.key, { bundle: module.bundle, file: module.file, files: module.count }])) }, null, 2)}\n`);
}

/** What writeScreenModules kept: key to { bundle, file, files, bytes }. */
export function readScreenModules(folder) {
  const { modules } = JSON.parse(readFileSync(join(folder, SCREEN_MODULES_FILE), 'utf8'));
  return new Map(Object.entries(modules).map(([key, module]) => [key, { ...module, bytes: new Uint8Array(readFileSync(join(folder, 'screen-modules', `${module.bundle.slice(3)}.tar.gz`))) }]));
}
