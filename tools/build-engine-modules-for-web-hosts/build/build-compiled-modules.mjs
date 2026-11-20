// build/build-compiled-modules.mjs
//
// Purpose: compile the crate-built modules the Worker loads (compiled-modules.mjs) and keep them committed
// under built-stored-bytes/<folder>/ beside this folder, with fingerprint.json naming the crates they came from and the
// identity of those crates' sources. Run it after changing any crate those modules are built from:
//   node tools/build-engine-modules-for-web-hosts/build/build-compiled-modules.mjs
// then commit built-stored-bytes. Every build copies these files instead of compiling, which is why a deploy
// takes seconds and needs no Rust toolchain.
//
// Invariants:
// - The crates listed are the workspace crates in the dependency closure of the modules' crates (from cargo metadata),
//   each named by its folder below the Workshop's tools/. Their source files and every involved workspace's Cargo.toml
//   and Cargo.lock change the fingerprint.
// - fingerprint.json records the head commit for each crate workspace outside the Workshop (the engine's), anchored at
//   that checkout's crates/ and named from tools/.
// - Needs cargo, the wasm32-unknown-unknown target (and each row's own `target`, such as wasm32-wasip1) and the
//   wasm-bindgen CLI each crate workspace's Cargo.lock pins. Cargo builds in the computer's one shared target folder
//   (shared-cargo-target.mjs); each module is copied out while that folder is held.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { crateWorkspaces, withCrateBuilds, workspaceOf } from './build-crate-for-a-web-host.mjs';
import { BUILT_CRATES_FOLDER, COMPILED_MODULES, ENGINE_COMPONENTS, PAGE_COMPILED_MODULES, TOOLS, WORKSHOP, committedModulesCurrent, compiledFileIdentities, crateSourceFingerprint, recoverCompiledModulePublication } from './compiled-modules.mjs';

// One existing target ownership scope covers source validation, every crate and
// publication. A caller that waited for an identical build rechecks only after
// acquiring ownership and does not delete or rebuild that completed output.
await withCrateBuilds(async builds => {
  await recoverCompiledModulePublication();
  const crateRows = [...COMPILED_MODULES, ...PAGE_COMPILED_MODULES, ...ENGINE_COMPONENTS].filter(row => row.crate);
  // Each crate's closure comes from its own workspace's resolution (an engine crate resolves in the engine's workspace).
  const metadataOf = new Map();
  const crateDirSet = new Set();
  const sourceFileSet = new Set();
  const sourceDeclarations = [];
  const appRoot = WORKSHOP;
  for (const { crate } of crateRows) {
    const workspace = workspaceOf(crate);
    if (!metadataOf.has(workspace)) metadataOf.set(workspace, JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1'], { cwd: workspace, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })));
    const metadata = metadataOf.get(workspace);
    const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
    const closure = new Set();
    const walk = id => { if (closure.has(id)) return; closure.add(id); for (const dep of nodes.get(id).deps) walk(dep.pkg); };
    walk(metadata.packages.find(item => item.name === crate).id);
    for (const item of metadata.packages) if (closure.has(item.id) && !item.source) {
      const crateDir = relative(TOOLS, dirname(item.manifest_path));
      crateDirSet.add(crateDir);
      const declaration = item.metadata?.['compiled-module'];
      if (declaration === undefined) continue;
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) || Object.keys(declaration).some(key => key !== 'source-files'))
        throw new Error(`Invalid compiled-module source declaration in ${item.name}`);
      if (!Object.hasOwn(declaration, 'source-files')) continue;
      if (!Array.isArray(declaration['source-files'])) throw new Error(`compiled-module source-files must be a file list in ${item.name}`);
      sourceDeclarations.push({ item, declaration });
    }
  }
  for (const { item, declaration } of sourceDeclarations) {
    for (const file of declaration['source-files']) {
      if (typeof file !== 'string') throw new Error(`compiled-module source-files must name app files in ${item.name}`);
      const suffix = file.replace(/^(?:\.\.\/)+/, '');
      if (!suffix || isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes('\\') || file.includes('\0') || suffix.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error(`compiled-module source-files must contain relative file names in ${item.name}`);
      const source = resolve(dirname(item.manifest_path), file);
      const appPath = relative(appRoot, source);
      if (!appPath || isAbsolute(appPath) || appPath === '..' || appPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
        throw new Error(`compiled-module source-files must name app files in ${item.name}`);
      sourceFileSet.add(appPath);
    }
  }
  const crateDirs = [...crateDirSet].sort();
  const sourceFiles = [...sourceFileSet].sort();
  if (await committedModulesCurrent(crateDirs, sourceFiles)) {
    process.stdout.write('compiled modules already match current source; reused completed output\n');
    return;
  }
  // The commit of each workspace outside the Workshop the crates came from (the engine's), by its path from tools/. The
  // fingerprint reads those crates at this commit, so the commit names exactly the sources it covers, and a release can put
  // that exact checkout beside the Workshop.
  const git = (workspace, args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  const workspace_commits = Object.fromEntries(crateWorkspaces().filter(workspace => !workspace.startsWith(TOOLS + sep)).map(workspace => {
    if (realpathSync(git(workspace, ['rev-parse', '--show-toplevel'])) !== realpathSync(dirname(workspace))) {
      throw new Error(`${workspace} is not the crates/ folder at the top of its own git checkout, so no commit names its crates`);
    }
    return [relative(TOOLS, workspace), git(workspace, ['log', '-1', '--format=%H', '--', '.'])];
  }));
  const fingerprint = await crateSourceFingerprint(crateDirs, sourceFiles, workspace_commits);
  const stageParent = dirname(resolve(BUILT_CRATES_FOLDER));
  mkdirSync(stageParent, { recursive: true });
  const stage = mkdtempSync(join(stageParent, '.compiled-modules-'));
  const next = join(stage, 'next');
  const previous = join(stage, 'previous');
  let retainStage = false;
  try {
    // Preserve entries this builder does not own, including unrelated siblings.
    if (existsSync(BUILT_CRATES_FOLDER)) cpSync(BUILT_CRATES_FOLDER, next, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    else mkdirSync(next);
    if (!lstatSync(next).isDirectory()) throw new Error('The compiled-module output must be an owned directory');
    for (const folder of new Set(crateRows.map(row => row.folder))) rmSync(join(next, folder), { recursive: true, force: true });
    for (const { crate, cargoArgs, folder, target } of crateRows) {
      mkdirSync(join(next, folder), { recursive: true });
      if (target) {
        const built = builds.target({ crate, target, cargoArgs });
        copyFileSync(built.wasmPath, join(next, folder, basename(built.wasmPath)));
      } else {
        const built = await builds.webHost({ crate, cargoArgs, bindgenTarget: 'web' });
        for (const file of [built.gluePath, built.wasmPath]) copyFileSync(file, join(next, folder, basename(file)));
      }
      process.stdout.write(`built ${crate} into private compiled-module output\n`);
    }
    if (await crateSourceFingerprint(crateDirs, sourceFiles, workspace_commits) !== fingerprint) {
      throw new Error('Crate sources changed during compilation; the published modules were left untouched');
    }
    // The BLAKE3 of each file built, so a Workshop exported without the crates beside it admits these bytes and no others.
    const files = await compiledFileIdentities(next);
    writeFileSync(join(next, 'fingerprint.json'), `${JSON.stringify({ crate_dirs: crateDirs, source_files: sourceFiles, fingerprint, workspace_commits, files }, null, 2)}\n`);
    const hadPrevious = existsSync(BUILT_CRATES_FOLDER);
    // Write recovery facts before retiring the current tree. Process exit at
    // either rename leaves enough information for the ordinary next owner.
    writeFileSync(join(stage, 'publication.json'), `${JSON.stringify({
      schema: 'compiled-modules-publication/v1', destination: resolve(BUILT_CRATES_FOLDER), hadPrevious,
    })}\n`);
    if (hadPrevious) renameSync(BUILT_CRATES_FOLDER, previous);
    try {
      renameSync(next, BUILT_CRATES_FOLDER);
    } catch (publicationError) {
      if (hadPrevious) {
        try { renameSync(previous, BUILT_CRATES_FOLDER); }
        catch (recoveryError) {
          retainStage = true;
          throw new AggregateError([publicationError, recoveryError], `Compiled-module publication failed; original output is preserved at ${previous}`);
        }
      }
      throw publicationError;
    }
    process.stdout.write(`fingerprint ${fingerprint.slice(0, 16)} over ${crateDirs.length} crates\n`);
  } finally {
    if (!retainStage) rmSync(stage, { recursive: true, force: true });
  }
});
