// build/build-crate-for-a-web-host.mjs
//
// Purpose: build one crate from its Cargo workspace (the `crates/` folder of the tool that owns its job, or the workspace
// of the engine crates its manifests reach by path, their one home) as a plain wasm-bindgen module (the kind a Cloudflare
// Worker or Node loads) and hand back the bindings. Used by build-compiled-modules.mjs for each module and by the tests
// that run it.
//
// Invariants:
// - Cargo compiles into the computer's one shared target folder (scripts/shared-cargo-target.mjs), held for this
//   build alone; wasm-bindgen reads the crate's wasm from it while it is held and writes the bindings into this copy's
//   own `target/web-host-bindings/[<target>/]<crate>/` under the output root (build/output-root.mjs), so copies building at
//   once never read each other's output and no copy keeps a full cargo build of its own.
// - The wasm-bindgen CLI must be the exact version the crate's workspace Cargo.lock pins for the `wasm-bindgen`
//   library, or the bindings are wrong. A mismatch fails with the install command instead of building.
// - `importModules` lists every module the wasm imports from, so a caller can prove no slot-world (`slots:`) or
//   component-model (`$root`) import is left in a module meant for a web host.
// - `bindgenTarget` picks the wasm-bindgen output shape: the default `experimental-nodejs-module` loads itself in
//   Node; `web` exports `initSync({ module })`, which is what a Cloudflare Worker needs. Each target gets its own
//   folder so one never overwrites the other.
// - `outName` names the written module (`<outName>.js`, `<outName>_bg.wasm`); it defaults to the crate's library name.
//   `typescript: false` leaves out the `.d.ts` files and the glue's pointer to them.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputRoot } from './output-root.mjs';
import { cargoEnv, withSharedCargoTarget } from './shared-cargo-target.mjs';

const buildTool = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The Workshop's tools/ folder: every crate is named by its folder below it. */
export const TOOLS = dirname(buildTool);
const cargoJson = (args, cwd) => JSON.parse(execFileSync('cargo', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

let workspaces = null;
/** Each tool's own Cargo workspace: its `crates/` folder, when it keeps crates. */
export function toolCrateWorkspaces() {
  return readdirSync(TOOLS).sort().map(tool => join(TOOLS, tool, 'crates')).filter(folder => existsSync(join(folder, 'Cargo.toml')));
}
/**
 * Every Cargo workspace this builds crates from: the `crates/` of each tool that keeps crates, then the workspace of each
 * crate their manifests reach by path outside them (the engine's, the one home of the crates both share). Read from cargo,
 * so the manifests stay the one place that says where those crates live.
 */
export function crateWorkspaces() {
  if (workspaces) return workspaces;
  const found = toolCrateWorkspaces();
  for (const seed of [...found]) {
    for (const item of cargoJson(['metadata', '--format-version', '1'], seed).packages) {
      if (item.source || found.some(root => item.manifest_path.startsWith(root + sep))) continue;
      const located = execFileSync('cargo', ['locate-project', '--workspace', '--message-format', 'plain', '--manifest-path', item.manifest_path], { encoding: 'utf8' }).trim();
      if (!found.includes(dirname(located))) found.push(dirname(located));
    }
  }
  workspaces = Object.freeze(found);
  return workspaces;
}

const members = new Map();
/** The workspace whose members include `crate` (cargo's own member list, read once per workspace). */
export function workspaceOf(crate) {
  for (const workspace of crateWorkspaces()) {
    if (!members.has(workspace)) {
      members.set(workspace, new Set(cargoJson(['metadata', '--format-version', '1', '--no-deps'], workspace).packages.map(item => item.name)));
    }
    if (members.get(workspace).has(crate)) return workspace;
  }
  throw new Error(`No crate workspace has a member named ${crate}: ${crateWorkspaces().join(', ')}`);
}

function lockedWasmBindgenVersion(workspace) {
  const lock = readFileSync(join(workspace, 'Cargo.lock'), 'utf8');
  const match = lock.match(/\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/);
  if (!match) throw new Error(`${join(workspace, 'Cargo.lock')} does not pin a wasm-bindgen library version`);
  return match[1];
}

function wasmBindgenCommand(version) {
  const command = process.env.WASM_BINDGEN || 'wasm-bindgen';
  let reported = '';
  try {
    reported = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    reported = 'not found';
  }
  if (reported !== `wasm-bindgen ${version}`) {
    throw new Error(
      `wasm-bindgen CLI ${version} is required (found: ${reported} at ${command}). ` +
        `Install it with: cargo install wasm-bindgen-cli --version ${version} --locked ` +
        `--root <dir>, then set WASM_BINDGEN=<dir>/bin/wasm-bindgen.`,
    );
  }
  return command;
}

/**
 * @param {{ crate: string, cargoArgs?: string[], bindgenTarget?: string, outName?: string, typescript?: boolean }} options
 *   crate: the cargo package name (e.g. 'credentials-vault');
 *   cargoArgs: extra `cargo build` arguments (e.g. ['--no-default-features']);
 *   bindgenTarget: wasm-bindgen `--target` (default 'experimental-nodejs-module');
 *   outName: the written module's name (default: the crate's library name);
 *   typescript: write `.d.ts` files beside the glue (default true).
 * @returns {Promise<{ bindings: object, wasmBytes: Buffer, wasmPath: string, gluePath: string, importModules: string[] }>}
 */
export async function buildCrateForAWebHost(options) {
  return withCrateBuilds(builds => builds.webHost(options));
}

/**
 * Keep one existing shared-target ownership scope across related modules and
 * their publication. The supplied builders already hold that target; they do
 * not acquire it recursively. A retained builder cannot run after the scope.
 */
export async function withCrateBuilds(work) {
  return withSharedCargoTarget(toolCrateWorkspaces(), async folder => {
    let active = true;
    const current = () => { if (!active) throw new Error('The crate build scope has ended'); };
    const builds = {
      webHost: async options => { current(); return buildWebHostInTarget(options, folder); },
      target: ({ crate, target, cargoArgs = [] }) => {
        current();
        execFileSync('cargo', ['build', '--release', '-p', crate, '--target', target, ...cargoArgs],
          { cwd: workspaceOf(crate), env: cargoEnv(folder), stdio: 'inherit' });
        return { wasmPath: join(folder, target, 'release', `${crate.replaceAll('-', '_')}.wasm`) };
      },
    };
    try { return await work(builds); }
    finally { active = false; }
  });
}

async function buildWebHostInTarget({ crate, cargoArgs = [], bindgenTarget = 'experimental-nodejs-module', outName, typescript = true }, folder) {
  const workspace = workspaceOf(crate);
  const command = wasmBindgenCommand(lockedWasmBindgenVersion(workspace));
  const libName = crate.replaceAll('-', '_');
  const moduleName = outName ?? libName;
  const outDir = join(outputRoot(), 'target', 'web-host-bindings', ...(bindgenTarget === 'experimental-nodejs-module' ? [] : [bindgenTarget]), crate);
  execFileSync('cargo', ['build', '-p', crate, '--lib', '--release', '--target', 'wasm32-unknown-unknown', ...cargoArgs],
    { cwd: workspace, env: cargoEnv(folder), stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync(command,
    ['--target', bindgenTarget, '--out-dir', outDir, '--out-name', moduleName, ...(typescript ? [] : ['--no-typescript']), join(folder, 'wasm32-unknown-unknown', 'release', `${libName}.wasm`)],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const wasmPath = join(outDir, `${moduleName}_bg.wasm`);
  const wasmBytes = readFileSync(wasmPath);
  const importModules = [
    ...new Set(WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes)).map(entry => entry.module)),
  ];
  const gluePath = join(outDir, `${moduleName}.js`);
  const bindings = await import(pathToFileURL(gluePath).href);
  return { bindings, wasmBytes, wasmPath, gluePath, importModules };
}
