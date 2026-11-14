#!/usr/bin/env node
// packages/make-packages-match-their-source/do-work/build-declared-stored-bytes-for-chosen-packages.mjs
//
// Build the DECLARED stored_bytes for the packages you choose, from the producer each row
// names in its own `build` block, into their built-stored-bytes folders.
//
// WHY THIS EXISTS, and it is the same reason its entry-bundle sibling exists. Declaring a
// blob and producing it were two steps, and the second was one a human had to remember. For
// entry bundles that gap was closed by `build-entry-bytes-for-chosen-packages.mjs`. For every
// OTHER kind of stored_bytes it was not, and the only caller of the general converter was
// `native-artifact/do-work/project-app-open-bundle.sh`, which runs while preparing an offline
// bundle. So the only way to rebuild a declared blob was to prepare a whole app bundle, and
// nobody does that to fix one file.
//
// WHAT THAT COST, so this is not read as tidying. The converter used to DELETE the `build`
// block it had just executed, which made the step one-way and left the producer named nowhere.
// Three process scripts in `hosted-public-app` were stranded that way, and the package-owned
// builder sat with zero declared callers and one
// consumer, its own test. The conversion is non-destructive now, so declarations survive; this
// runner is the other half, the reachable way to act on them.
//
// SCOPE, stated because the neighbouring runner has a different one. This builds only rows
// that DECLARE a producer. A row with no `build` block has no instructions and is left alone,
// which is not a silent skip: it is the whole difference the one-way conversion destroyed.
//
// Usage (every path absolute):
//   node build-declared-stored-bytes-for-chosen-packages.mjs \
//     --package-set-folder <folder> [--packages-source-root <canonical-packages-folder>] \
//     --package <name> [--package <name> ...]
//
// Exit 1 when a declared build fails, 2 on a bad argument.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePackageSourceLayout } from './make-one-package-match-its-source.mjs';

function argumentValues(flag) {
  const found = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === flag) found.push(process.argv[index + 1]);
  }
  return found;
}

function required(flag) {
  const values = argumentValues(flag);
  const value = values.length === 0 ? null : values[values.length - 1];
  if (value === null || String(value).trim() === '') {
    console.error(`${flag} is required`);
    process.exit(2);
  }
  return String(value).trim();
}

/** Make every DECLARED stored_bytes blob exist for the named packages.
 *
 *  Throws on a bad argument rather than exiting, because a library that calls `process.exit`
 *  takes the decision away from its caller. The CLI below turns a throw back into an exit code.
 *  Returns the converter's own result, an array of `{ package, stored_bytes, byte_length }`. */
export async function makeDeclaredStoredBytesExist({ packageSetFolder, packagesSourceRoot, packageNames, storedBytesNames = [] }) {
  const setFolder = path.resolve(String(packageSetFolder ?? '').trim());
  if (setFolder === '' || !existsSync(setFolder)) {
    throw new Error(`PACKAGE_SET_FOLDER_MISSING:${packageSetFolder}`);
  }
  const names = [...new Set((packageNames ?? []).map((name) => String(name).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('NO_PACKAGE_NAMED');
  const { sourceRoot, compileSetFolder } = resolvePackageSourceLayout({
    packageSetFolder: setFolder,
    packagesSourceRoot,
  });
  if (!existsSync(sourceRoot)) throw new Error(`PACKAGES_SOURCE_ROOT_MISSING:${sourceRoot}`);
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`INVALID_PACKAGE_NAME:${name}`);
    if (!existsSync(path.join(sourceRoot, name, 'things-to-store-and-run.json'))) {
      throw new Error(`NO_SUCH_PACKAGE:${name}`);
    }
  }
  for (const name of storedBytesNames) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`INVALID_STORED_BYTES_NAME:${name}`);
  }

  const converter = path.join(path.dirname(fileURLToPath(import.meta.url)), 'materialize-package-stored-bytes-builds.mjs');
  if (!existsSync(converter)) throw new Error(`SET_BUILDER_MISSING:${converter}`);

  const { materializePackageStoredBytesBuilds } = await import(converter);
  return materializePackageStoredBytesBuilds(compileSetFolder, { packageNames: names, storedBytesNames: storedBytesNames.length ? storedBytesNames : null });
}

// CLI. Runs only when this file is the program, so importing it for the function above costs
// nothing and cannot exit the importing process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await makeDeclaredStoredBytesExist({
      packageSetFolder: required('--package-set-folder'),
      packagesSourceRoot: argumentValues('--packages-source-root').at(-1) ?? null,
      packageNames: argumentValues('--package'),
      storedBytesNames: argumentValues('--stored-bytes'),
    });
    // WROTE and UNCHANGED, never one word for both. Every row used to print BUILT whether the
    // bytes were new or byte-identical to what was already there, so the only way to learn whether
    // a run changed anything was `git status`, and a reader watching the output could not tell a
    // real rebuild from a no-op.
    for (const built of results) {
      const outcome = built.wrote_bytes ? 'WROTE' : 'UNCHANGED';
      console.log(`${outcome} ${built.package}/${built.stored_bytes} ${built.byte_length} bytes`);
    }
    const wrote = results.filter((built) => built.wrote_bytes).length;
    console.log(`${results.length} declared stored_bytes built, ${wrote} wrote new bytes`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(error?.message?.startsWith?.('materialize-package-stored-bytes-builds:') ? 1 : 2);
  }
}
