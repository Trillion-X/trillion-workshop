import { withSharedCargoTargetLock } from './shared-cargo-target.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This tool's folder, the Workshop's tools/ folder every crate directory is named from (a tool's crate is
// <tool>/crates/<crate>; an engine crate is ../../trillion-rust/crates/<crate>, the engine checkout beside the Workshop)
// and the Workshop checkout, from which the identity names every file.
export const BUILD_TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS = dirname(BUILD_TOOL);
export const WORKSHOP = dirname(TOOLS);
// Each compiled module the Workers load and the folder under dist/ it goes in, beside the bundle: the locked box's two,
// and the engines that run in the engines Worker as Workshop tools: the workflow engine and the
// formula evaluator. A row names a crate to build, or `copy_from`, a folder of a tool's built module that is already the
// one copy (tools/formula-engine, built by build-formula-evaluator.mjs). The app's release checks put them in dist/
// (prepareCompiledModules), each beside the bundle of the Worker that uploads it.
// `worker` is the Worker that uploads and loads it: `main`, where each person's store runs its locked box against its
// own storage, or `engines`, the engines Worker.
export const COMPILED_MODULES = [
  { crate: 'http-client', cargoArgs: ['--no-default-features'], folder: 'held-values', worker: 'main' },
  { copy_from: join(TOOLS, 'browse-and-upload-my-files/built-stored-bytes/content-chunks'), folder: 'content-chunks', worker: 'main' },
  { crate: 'workflow-engine', folder: 'workflow-engine', worker: 'engines' },
  { copy_from: join(TOOLS, 'formula-engine/built-stored-bytes/formula-engine'), folder: 'formula-engine', worker: 'engines', workers: ['main', 'engines'] },
];
// Loaded by the page, not the Worker. A row naming a `target` is a slot built for that
// target as it is, with no bindings: the page runs it through the shared buffer exchange (tools/workspace-screens/web/src/workspace/slot-in-the-page.ts).
// A row without one is a wasm-bindgen module (`<crate>.js` + `<crate>_bg.wasm`); the composition engine is built both
// ways into one folder (its wasm-bindgen entry is `answer_composition`, tools/composition-scene-renderer/crates/composition-engine/src/run_in_a_page.rs).
export const PAGE_COMPILED_MODULES = [
  { crate: 'screen-arrangement', folder: 'screen-arrangement' },
  { crate: 'composition-engine', target: 'wasm32-wasip1', folder: 'composition-engine' },
  { crate: 'composition-engine', folder: 'composition-engine' },
];
// Run by the engine as a tool on any computer: a row naming a `target` built as a WASI component with no bindings, which a
// tool row lays out from here and names as its component (tools/workflows/tool-rows.json `tool:run-workflow-definition`,
// argv ["component", ...]; the engine's src/tool_runs/tools/component.rs).
export const ENGINE_COMPONENTS = [
  { crate: 'workflow-component', target: 'wasm32-wasip2', folder: 'workflow-component' },
];

// The crate-built modules are committed under BUILT_CRATES_FOLDER, so a build (Cloudflare's included) never needs Rust:
// build-compiled-modules.mjs compiles them once when a crate changes and writes fingerprint.json, the BLAKE3
// identity of every source file of every crate they are built from (the crates in their dependency closure, named
// below tools/, listed there, which include the engine crates its manifests reach by path) plus Cargo.toml and Cargo.lock
// of every crate workspace (the `crates/` folder of each tool, and the engine's beside the Workshop). A build whose
// sources no longer match that identity builds them again where cargo is present, and stops with the command where it
// is not; a hosted build without the engine checkout beside it stops the same way.
export const BUILT_CRATES_FOLDER = join(BUILD_TOOL, 'built-stored-bytes');
const BUILD_COMMAND = join(BUILD_TOOL, 'build/build-compiled-modules.mjs');
export async function crateSourceFingerprint(crateDirs, sourceFiles = [], workspaceCommits = {}) {
  const { readdirSync, readFileSync, statSync, lstatSync, realpathSync, openSync, fstatSync, closeSync, constants } = await import('node:fs');
  const { basename, dirname, join, relative, resolve, isAbsolute } = await import('node:path');
  const { blake3 } = await import('@noble/hashes/blake3.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const files = [], suppliedAppFiles = new Map(), root = realpathSync(WORKSHOP);
  const stable = ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'];
  const canonicalRelative = value => {
    if (typeof value !== 'string' || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.includes('\0')) return false;
    for (const part of value.split('/')) {
      if (!part || part === '.') return false;
      if (part === '..') return false;
    }
    return true;
  };
  const readCanonicalFile = (folder, file, label) => {
    if (!canonicalRelative(file)) throw new Error(`Compiled-module source path is not canonical: ${label}`);
    if (realpathSync(folder) !== folder) throw new Error(`Compiled-module source base directory is aliased: ${label}`);
    const path = join(folder, file);
    const named = () => {
      let parent = folder;
      for (const [index, part] of file.split('/').entries()) {
        if (!readdirSync(parent).includes(part)) throw new Error(`Compiled-module source path is missing or aliased: ${label}`);
        parent = join(parent, part);
        if (index < file.split('/').length - 1) {
          const directory = lstatSync(parent);
          if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Compiled-module source path has an alias or non-directory parent: ${label}`);
        }
      }
      const info = lstatSync(path, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error(`Compiled-module source is not an unaliased regular file: ${label}`);
      return info;
    };
    named();
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) throw new Error('Compiled-module sources require no-follow, nonblocking file reads');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new Error(`Compiled-module source is not an unaliased regular file: ${label}`);
      bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true }), current = named();
      if (BigInt(bytes.length) !== before.size || stable.some(key => before[key] !== after[key] || before[key] !== current[key]))
        throw new Error(`Compiled-module source changed while reading: ${label}`);
    } finally { closeSync(fd); }
    return bytes;
  };
  const walk = folder => {
    for (const name of readdirSync(folder)) {
      if (name === 'target' || name === '.DS_Store') continue;
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(relative(WORKSHOP, path));
    }
  };
  // A crate outside this Workshop (the engine's checkout beside it) is read from the commit its fingerprint records, never from
  // that checkout's working files, which may hold other sessions' uncommitted edits.
  const siblingBytes = new Map();
  const atCommit = (workspace, file) => {
    const commit = workspaceCommits[workspace];
    if (!commit) throw new Error(`${workspace} has no recorded commit; its crates are read at a commit, not from its working files`);
    return execFileSync('git', ['-C', join(TOOLS, workspace), 'show', `${commit}:./${file}`], { maxBuffer: 1 << 30 });
  };
  const textOf = (workspace, file) => workspace.startsWith('../') ? atCommit(workspace, file).toString('utf8') : readFileSync(join(TOOLS, workspace, file), 'utf8');
  for (const dir of crateDirs) {
    if (!dir.startsWith('../')) { walk(join(TOOLS, dir)); continue; }
    const workspace = dirname(dir), commit = workspaceCommits[workspace];
    if (!commit) throw new Error(`${workspace} has no recorded commit; its crates are read at a commit, not from its working files`);
    const listed = execFileSync('git', ['-C', join(TOOLS, workspace), 'ls-tree', '-r', '--name-only', commit, '--', basename(dir)], { encoding: 'utf8' });
    for (const file of listed.split('\n').filter(Boolean)) {
      if (file.split('/').some(part => part === 'target' || part === '.DS_Store')) continue;
      const path = relative(WORKSHOP, join(TOOLS, workspace, file));
      files.push(path);
      siblingBytes.set(path, atCommit(workspace, file));
    }
  }
  // Compiler options and path remapping are source inputs too. A changed build
  // owner must invalidate its existing bytes even when no Rust source changed.
  for (const name of ['shared-cargo-target', 'build-crate-for-a-web-host', 'compiled-modules', 'build-compiled-modules']) files.push(relative(WORKSHOP, join(BUILD_TOOL, 'build', `${name}.mjs`)));
  // Each workspace's manifest and lock: the one beside every crate (a crate is a child of its workspace).
  // They are measured by what a build of these crates reads from them (workspaceManifestMeasure, lockClosureMeasure): a
  // crate added to a workspace, or the engine binary's own dependencies, leave the modules current.
  const measured = new Map();
  const crateNames = crateDirs.map(dir => packageNameOf(textOf(dirname(dir), `${basename(dir)}/Cargo.toml`)));
  for (const workspace of new Set(crateDirs.map(dir => dirname(dir)))) {
    for (const file of ['Cargo.toml', 'Cargo.lock']) {
      const path = relative(WORKSHOP, join(TOOLS, workspace, file));
      if (!files.includes(path)) files.push(path);
      const text = textOf(workspace, file);
      measured.set(path, Buffer.from(file === 'Cargo.toml' ? workspaceManifestMeasure(text) : lockClosureMeasure(text, crateNames)));
    }
  }
  if (!Array.isArray(sourceFiles) || sourceFiles.some(file => typeof file !== 'string') || new Set(sourceFiles).size !== sourceFiles.length)
    throw new Error('Compiled-module source_files must be a list of distinct Workshop files');
  for (const file of sourceFiles) {
    if (!canonicalRelative(file) || relative(root, resolve(root, file)) !== file) throw new Error('Compiled-module source_files must name canonical files inside the Workshop');
    suppliedAppFiles.set(file, readCanonicalFile(root, file, file));
    if (!files.includes(file)) files.push(file);
  }
  const hasher = blake3.create();
  for (const path of files.sort()) {
    const bytes = suppliedAppFiles.get(path) ?? measured.get(path) ?? siblingBytes.get(path) ?? readFileSync(join(WORKSHOP, path));
    hasher.update(new TextEncoder().encode(`${path}\0${bytes.length}\0`));
    hasher.update(bytes);
  }
  return bytesToHex(hasher.digest());
}

// A crate's package name, from the [package] table of its manifest.
export function packageNameOf(manifest) {
  const table = /^\[package\][ \t]*(?:#.*)?$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest)?.[1] ?? '';
  const name = /^name[ \t]*=[ \t]*"([^"]+)"/m.exec(table)?.[1];
  if (!name) throw new Error('A compiled-module crate manifest names no [package] name');
  return name;
}

// A workspace manifest as a member's build reads it: everything but the [workspace] table's member lists (`members`,
// `exclude`, `default-members`), which say which crates belong and change whenever one is added. Its dependency table,
// profiles, patches and package defaults are kept byte for byte. A manifest written in a shape not read here is kept whole.
export function workspaceManifestMeasure(manifest) {
  const header = /^\[workspace\][ \t]*(?:#.*)?$/m.exec(manifest);
  if (!header) return manifest;
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(manifest.slice(start));
  const end = next ? start + next.index : manifest.length;
  const table = manifest.slice(start, end);
  const kept = table.replace(/^(?:members|exclude|default-members)[ \t]*=[ \t]*\[[^\]]*\][ \t]*(?:#[^\n]*)?\n?/gm, '');
  if (/^(?:members|exclude|default-members)\b/m.test(kept)) return manifest;
  return manifest.slice(0, start) + kept + manifest.slice(end);
}

// A Cargo.lock as these crates' build reads it: its header and the [[package]] entries reachable from the named crates
// through their `dependencies`, in the lock's own order and bytes. An entry for a crate the modules never build (another
// member of the workspace, or what only it uses) leaves the measure unchanged; a changed version, source or checksum of
// anything they reach changes it. A lock written in a shape not read here, or one whose dependency names do not resolve
// to exactly one entry, is kept whole.
export function lockClosureMeasure(lock, crateNames) {
  const [head, ...blocks] = lock.split(/^\[\[package\]\]\n/m);
  if (/^\[/m.test(head.replace(/^#.*$/gm, '')) || blocks.some(block => /^\[/m.test(block))) return lock;
  const entries = blocks.map(block => {
    const field = key => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1];
    const list = /^dependencies = \[\n?([\s\S]*?)\]$/m.exec(block)?.[1] ?? '';
    return { block, name: field('name'), version: field('version'), source: field('source'), deps: [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]) };
  });
  if (entries.some(entry => !entry.name || !entry.version)) return lock;
  const resolve = spec => {
    const [, name, version, source] = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(spec) ?? [];
    const found = entries.filter(entry => entry.name === name && (!version || entry.version === version) && (!source || entry.source === source));
    return found.length === 1 ? found[0] : null;
  };
  const reached = new Set();
  const walk = entry => {
    if (reached.has(entry)) return true;
    reached.add(entry);
    return entry.deps.every(spec => { const dep = resolve(spec); return dep !== null && walk(dep); });
  };
  for (const name of new Set(crateNames)) {
    const own = entries.filter(entry => entry.name === name && entry.source === undefined);
    if (own.length > 1 || (own.length === 1 && !walk(own[0]))) return lock;
  }
  return head + entries.filter(entry => reached.has(entry)).map(entry => `[[package]]\n${entry.block}`).join('');
}

/** The files supplied by the crate rows; copied parts keep their own directory owner. */
export function compiledModuleFiles() {
  const rows = [...COMPILED_MODULES, ...PAGE_COMPILED_MODULES, ...ENGINE_COMPONENTS].filter(row => row.crate);
  return rows.flatMap(({ crate, folder, target }) => {
    const name = crate.replaceAll('-', '_');
    return (target ? [`${name}.wasm`] : [`${name}.js`, `${name}_bg.wasm`])
      .map(file => `${BUILT_CRATES_FOLDER}/${folder}/${file}`);
  });
}

/** Source identity and required files must both be current. Failed/partial builds refuse. */
async function currentCommittedModules(expectedCrateDirs = null, expectedSourceFiles = null) {
  const { readFileSync, statSync } = await import('node:fs');
  let built;
  try { built = JSON.parse(readFileSync(`${BUILT_CRATES_FOLDER}/fingerprint.json`, 'utf8')); }
  catch { return null; }
  if (!Array.isArray(built.crate_dirs) || !built.crate_dirs.every(dir => typeof dir === 'string') || typeof built.fingerprint !== 'string') return null;
  if (expectedCrateDirs && JSON.stringify([...built.crate_dirs].sort()) !== JSON.stringify([...expectedCrateDirs].sort())) return null;
  const sourceFiles = Object.hasOwn(built, 'source_files') ? built.source_files : [];
  if (!Array.isArray(sourceFiles) || sourceFiles.some(file => typeof file !== 'string') || new Set(sourceFiles).size !== sourceFiles.length ||
      expectedSourceFiles !== null && (!Array.isArray(expectedSourceFiles) || expectedSourceFiles.some(file => typeof file !== 'string') || JSON.stringify([...sourceFiles].sort()) !== JSON.stringify([...expectedSourceFiles].sort()))) return null;
  try { if (await crateSourceFingerprint(built.crate_dirs, sourceFiles, built.workspace_commits ?? {}) !== built.fingerprint) return null; }
  catch { return null; }
  if (!compiledModuleFiles().every(file => {
    try { return statSync(file).isFile(); } catch { return false; }
  })) return null;
  return Object.freeze({ fingerprint: built.fingerprint, crate_dirs: Object.freeze([...built.crate_dirs]), source_files: Object.freeze([...sourceFiles]) });
}

/** Boolean preflight; byte consumers use withCommittedModules for their complete read. */
export async function committedModulesCurrent(expectedCrateDirs = null, expectedSourceFiles = null) {
  return (await currentCommittedModules(expectedCrateDirs, expectedSourceFiles)) !== null;
}

/**
 * The first file a declared crate input needs that is not there, as { dir, file } (dir and file as written relative to
 * the tools folder, the form fingerprint.json uses), or null. The fingerprint reads each crate's Cargo.toml and its
 * workspace's Cargo.toml and Cargo.lock, so a partial sibling checkout is named here instead of only failing the check.
 */
export function missingCrateInput(crateDirs, base = TOOLS) {
  for (const dir of crateDirs) {
    const workspace = dirname(dir);
    for (const file of [join(dir, 'Cargo.toml'), join(workspace, 'Cargo.toml'), join(workspace, 'Cargo.lock')]) {
      if (!existsSync(join(base, file))) return { dir, file };
    }
  }
  return null;
}

/**
 * Recover only this owner's interrupted publication stages while holding its
 * existing shared-target ownership. Never promote a stranded next generation.
 * A retired previous tree is restored when the public path is absent.
 */
export async function recoverCompiledModulePublication() {
  const { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } = await import('node:fs');
  const { basename, dirname, join, resolve } = await import('node:path');
  const destination = resolve(BUILT_CRATES_FOLDER);
  const parent = dirname(destination);
  if (!existsSync(parent)) return [];
  const stages = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.compiled-modules-')) continue;
    const stage = join(parent, entry.name);
    let publication;
    try { publication = JSON.parse(readFileSync(join(stage, 'publication.json'), 'utf8')); }
    catch { continue; } // Unregistered/private data is never guessed or erased.
    if (publication?.schema !== 'compiled-modules-publication/v1' ||
        publication.destination !== destination || typeof publication.hadPrevious !== 'boolean') continue;
    stages.push({ stage, publication });
  }
  // Serial ownership creates at most one interrupted publication. Ambiguous
  // recovery must preserve every original instead of choosing by file age.
  if (stages.length > 1) throw new Error('Multiple interrupted compiled-module publications require exact recovery');
  const recovered = [];
  for (const { stage, publication } of stages) {
    const previous = join(stage, 'previous');
    if (existsSync(destination) && !lstatSync(destination).isDirectory()) {
      throw new Error(`Compiled-module recovery found an unexpected published path; preserved ${stage}`);
    }
    if (existsSync(previous)) {
      if (!lstatSync(previous).isDirectory()) throw new Error(`Compiled-module recovery found an unexpected previous path; preserved ${stage}`);
      if (!existsSync(destination)) renameSync(previous, destination);
    } else if (publication.hadPrevious && !existsSync(destination)) {
      throw new Error(`The prior compiled-module generation is unavailable; preserved ${stage}`);
    }
    // Current exists after a completed move, before any first move, or after
    // restoring previous. A new build starts afresh; next is never rolled in.
    rmSync(stage, { recursive: true, force: true });
    recovered.push(basename(stage));
  }
  return recovered;
}

/**
 * Admit and consume one coherent existing generation under the build owner's
 * same cache lock. A source edit after admission does not change that cohort.
 * Rebuilding is outside the read-held scope to avoid recursive ownership.
 */
const admittedReaders = new AsyncLocalStorage();

function consumeAdmitted(scope, read) {
  if (scope.pending === 0) scope.drained = new Promise(resolve => { scope.resolveDrained = resolve; });
  scope.pending += 1;
  return Promise.resolve().then(() => read(scope.admitted)).finally(() => {
    scope.pending -= 1;
    if (scope.pending === 0) scope.resolveDrained();
  });
}

export async function withCommittedModules(read) {
  const inherited = admittedReaders.getStore();
  if (inherited?.open) return consumeAdmitted(inherited, read);
  const attempt = () => withSharedCargoTargetLock(async () => {
    await recoverCompiledModulePublication();
    const admitted = await currentCommittedModules();
    if (!admitted) return { current: false };
    const scope = { admitted, open: true, pending: 0 };
    return admittedReaders.run(scope, async () => {
      try { return { current: true, value: await consumeAdmitted(scope, read) }; }
      finally {
        // Started nested consumers share this physical generation. A callback
        // scheduled after the scope closes must obtain its own fresh admission.
        while (scope.pending) await scope.drained;
        scope.open = false;
      }
    });
  });
  let result = await attempt();
  if (result.current) return result.value;
  if (process.env.WORKERS_CI) {
    process.stderr.write(`\nBUILD STOPPED: a compiled module is missing or its crate sources changed, and ${BUILT_CRATES_FOLDER} was not rebuilt. Run node ${BUILD_COMMAND} and commit ${BUILT_CRATES_FOLDER}.\n`);
    process.exit(1);
  }
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [BUILD_COMMAND], { stdio: 'inherit' });
  result = await attempt();
  if (!result.current) throw new Error('Compiled modules did not match current source after their build');
  return result.value;
}

// Build again when the committed modules no longer match their crates' sources; Cloudflare's build has no cargo, so
// there it stops and names the command instead.
export async function ensureCommittedModules() {
  await withCommittedModules(() => {});
}

// A compiled module's wasm-bindgen glue keeps ONE instance for the module's life (`initSync` answers the first one
// forever), so an engine that traps once (a panic, `unreachable`, memory out of bounds) would stay broken for the whole
// isolate. The app's Worker build writes each glue file again beside itself as `<name>.fresh.js`: its whole text inside
// `freshBindings()`, which makes a new copy of it, with its own instance, each time it is called
// (src/restartable-engine.mjs starts one again after a trap). Glue that imports another module, or exports in a way not
// read here, is refused rather than wrapped wrongly.
export function restartableGlue(text, file = 'glue') {
  if (/^\s*import\s/m.test(text)) throw new Error(`${file} imports another module, so it cannot be wrapped as restartable.`);
  const names = [];
  let body = text.replace(/^export\s+(class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => { names.push([name, name]); return `${kind} ${name}`; });
  body = body.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, list) => {
    for (const item of list.split(',').map(part => part.trim()).filter(Boolean)) {
      const [local, , exported = local] = item.split(/\s+/);
      names.push([exported, local]);
    }
    return '';
  });
  if (/^export\s/m.test(body)) throw new Error(`${file} exports in a way restartableGlue does not know.`);
  return `// Written by the Worker build from ${file.split('/').pop()} (tools/build-engine-modules-for-web-hosts/build/compiled-modules.mjs restartableGlue).\nexport function freshBindings() {\n${body}\nreturn { ${names.map(([exported, local]) => `${JSON.stringify(exported)}: ${local}`).join(', ')} };\n}\n`;
}
/** Every wasm-bindgen glue file in `folder` written again beside itself as `<name>.fresh.js`. */
export async function writeFreshGlue(folder) {
  const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.js') || name.endsWith('.fresh.js')) continue;
    const text = readFileSync(join(folder, name), 'utf8');
    if (!/\bfunction initSync\b/.test(text)) continue;
    writeFileSync(join(folder, name.replace(/\.js$/, '.fresh.js')), restartableGlue(text, join(folder, name)));
  }
}

/** Copy each module folder of `modules` into `destination` and write its glue again as restartable glue. */
async function copyModules(modules, destination) {
  const { cpSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const folders = new Set();
  for (const { folder, copy_from: copyFrom } of modules) {
    if (folders.has(folder)) continue;
    folders.add(folder);
    mkdirSync(join(destination, folder), { recursive: true });
    cpSync(copyFrom ?? join(BUILT_CRATES_FOLDER, folder), join(destination, folder), { recursive: true });
    await writeFreshGlue(join(destination, folder));
  }
}

/** Stage exact committed modules and fresh restartable glue through the same owner for builds, after the fingerprint says they are current. */
export async function prepareCompiledModules({ modules = COMPILED_MODULES, destination = 'dist' } = {}) {
  return withCommittedModules(() => copyModules(modules, destination));
}

/**
 * Stage the committed modules and fresh restartable glue without checking them against their crates: a release has
 * neither cargo nor the engine's crates beside the Workshop, and this tool's own test (test/compiled-modules-current.test.mjs)
 * is what says the modules match their sources. Reads one coherent generation: it holds the build owner's target lock and
 * first recovers an interrupted publication.
 */
export async function stageCommittedModules({ modules = COMPILED_MODULES, destination = 'dist' } = {}) {
  return withStagedModules(() => copyModules(modules, destination));
}

/**
 * Run `read` over the committed modules as they are, without checking them against their crates (see stageCommittedModules):
 * the web client's build of a named commit (a release), which has neither cargo nor the engine's crates beside the Workshop, reads them through this.
 */
export async function withStagedModules(read) {
  return withSharedCargoTargetLock(async () => {
    await recoverCompiledModulePublication();
    return read();
  });
}
