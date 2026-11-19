# tools/build-engine-modules-for-web-hosts/

Compiles the Rust engine crates a web host loads into WebAssembly modules, keeps each committed module current with the sources it was built from by a fingerprint, and stages the modules for a release.

The crates themselves live with the tool whose job they do, in that tool's `crates/` folder (a Cargo workspace of its own): `tools/http-client/crates`, `tools/refuse-requests-to-private-addresses/crates`, `tools/screen-arrangement/crates`, `tools/composition-scene-renderer/crates` and `tools/browse-and-upload-my-files/crates`. The engine's own crates stay in the engine repository, `../trillion-rust/crates`, beside this checkout. Moved here from Trillion-X/trillion-apps (`web/scripts`, `web/test`, `web/crates/built-stored-bytes`) at 9bcf27ec7d, and adapted to this folder's layout; `moved-from.json` names each file's source and the identity of its bytes there and here.

## Files

| File | Purpose |
|------|---------|
| `build/compiled-modules.mjs` | The rows of the modules (`COMPILED_MODULES` for the Workers, `PAGE_COMPILED_MODULES` for the page, `ENGINE_COMPONENTS` for the engine to run as a tool's component), `crateSourceFingerprint`, `committedModulesCurrent`, `withCommittedModules` (one coherent admitted generation for a reader) and `prepareCompiledModules` (stage the modules and their restartable glue into a folder). |
| `build/build-compiled-modules.mjs` | Compile every row's crate and publish `built-stored-bytes/` whole, with `fingerprint.json`; a failed or interrupted build leaves the published generation as it was. |
| `build/build-crate-for-a-web-host.mjs` | Build one crate as a wasm-bindgen module (`buildCrateForAWebHost`), find the Cargo workspaces (`crateWorkspaces`: each tool's `crates/`, then the engine's) and the one a crate belongs to. |
| `build/shared-cargo-target.mjs` | The one cargo target folder of the computer, held by one build at a time, kept under a size ceiling, with the flags that keep the building computer's paths out of a module. |
| `build/build-formula-evaluator.mjs` | Rebuild the formula engine's row evaluator into `tools/formula-engine/built-stored-bytes/evaluate-over-rows/`. |
| `built-stored-bytes/` | The committed modules (`composition-engine/`, `held-values/`, `screen-arrangement/`, `trigger-engine/`, `workflow-engine/`, `workflow-component/`) and `fingerprint.json`. Regenerate; never edit. |
| `test/` | The tests of the build: the fingerprint, the published generation under interruption and under readers, the shared target folder, and the engines running in WebAssembly. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `crateSourceFingerprint` | `(crateDirs, sourceFiles?) -> hex` | BLAKE3 identity of every source file of the listed crates (named from `tools/`), the build scripts, and the measured `Cargo.toml` and `Cargo.lock` of each crate workspace. |
| `withCommittedModules` | `(read) -> value` | Runs `read` over one admitted generation; rebuilds first where cargo is present, and stops with the command where it is not. |
| `prepareCompiledModules` | `({ modules?, destination? })` | Copies the committed modules into `destination/<folder>/` and writes each glue file again as `<name>.fresh.js`. |

## Dependencies

**Depends on:** cargo, the `wasm32-unknown-unknown` and `wasm32-wasip1` targets, the wasm-bindgen CLI the crate workspace's `Cargo.lock` pins, `@noble/hashes`, the engine checkout beside this one (`../trillion-rust`) at the commit `built-stored-bytes/fingerprint.json` names in `workspace_commits`, and `tools/process-session/do-work/computer-cache-folder.mjs`.

**Depended on by:** Trillion-X/trillion-apps `scripts/prepare-compiled-modules.mjs`, `scripts/cargo-in-shared-target.mjs`, `scripts/put-engine-crates-beside.mjs` (reads `built-stored-bytes/fingerprint.json`) and the tests that load the committed modules.

## Invariants

- A module is published only with the fingerprint of the sources it was compiled from; a change to any source, workspace manifest, lock or build script makes it stale.
- `built-stored-bytes/` is replaced whole by one rename, so a reader never sees half of two generations.
- No compiled module carries the path of the computer that built it (`shared-cargo-target.mjs` `pathRemapFlags`).
