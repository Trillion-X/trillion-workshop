#!/usr/bin/env node
// packages/make-packages-match-their-source/do-work/build-entry-bytes-for-chosen-packages.mjs
//
// Build the entry bundles for the packages you choose, from their source, into their own
// built-stored-bytes folders. This is the step BEFORE making a live place match its source:
// `run-make-packages-match-their-source.mjs` ships whatever bundle the manifest declares, and
// a manifest can declare a bundle that was never built, or one built before the last source
// edit. This runner exists so that gap is closed by the same owner, with the same
// caller-selected DATA (a set folder and a package list), through flags.
//
// Two steps, both owned by this package:
//   1. regenerate the entry scopes for the chosen packages (`write-package-entry-scopes.mjs`),
//      because the generated shim is derived from the manifest and a stale shim names a
//      source that has since moved;
//   2. materialize the bundles (`materialize-package-entry-bytes-lib.mjs`).
//
// WHY THE WORK IS AN EXPORTED FUNCTION AND THE CLI IS FOUR LINES AT THE BOTTOM:
// declaring an entry bundle and producing it were two steps, and the second was one a human had
// to remember. Across 303 packages, 27 declared their bytes correctly and nobody had ever run
// this, so the app held no rows for them and the surface painted blank. A step that must be
// remembered will be forgotten; that is a property of the shape, not of the person. So the
// consumer calls the producer, and this file stops being something anyone has to know about.
//
// The producer runs at the PACKAGE level, never per (package, place). An entry bundle is a pure
// function of package source, so shipping it to five engines needs one build and five sends. It
// also never runs under `--dry-run`: this writes into package folders, including the manifest
// itself, and a run that asks "what is drifted" must not repair the drift it is measuring.
//
// Usage (every path absolute):
//   node build-entry-bytes-for-chosen-packages.mjs \
//     --package-set-folder <folder> [--packages-source-root <canonical-packages-folder>] \
//     --package <name> [--package <name> ...] [--skip-scopes]
//
// Exit 1 when any entry fails to build; every FAIL line names the package and entry.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolvePackageSourceLayout } from './make-one-package-match-its-source.mjs';

const execFileAsync = promisify(execFile);

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

/** Make every declared entry bundle exist for the named packages.
 *
 *  Throws on a bad argument rather than exiting, because a library that calls `process.exit`
 *  takes the decision away from its caller. The CLI below turns a throw back into an exit code.
 *  Returns the lib's own result, `{ materialized, skippedRecordedInputsCurrent,
 *  skippedRebuiltIdentical, failed, failures }`. The two skips are separate because they answer
 *  different questions, and each field is spelled exactly like the word it prints, so a reader
 *  holding the output can grep for it without translating. */
export async function makeDeclaredEntryBytesExist({
  packageSetFolder,
  packagesSourceRoot,
  packageNames,
  skipScopes = false,
  log = console.log,
  logError = console.error,
}) {
  const setFolder = path.resolve(String(packageSetFolder ?? '').trim());
  if (setFolder === '' || !existsSync(setFolder)) {
    throw new Error(`PACKAGE_SET_FOLDER_MISSING:${packageSetFolder}`);
  }
  const names = [...new Set((packageNames ?? []).map((name) => String(name).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('NO_PACKAGE_NAMED');
  const packageNamesWithManifests = names.filter((name) => name !== 'package-set-records');
  // Package-set DATA is compiled from `<set>/package-set-records/*.json`; it has no entries and
  // no synthetic package manifest. It still uses this convergence owner, so an all-DATA run is a
  // successful no-op at the entry-byte stage rather than a misleading NO_SUCH_PACKAGE warning.
  if (packageNamesWithManifests.length === 0) {
    return {
      materialized: 0,
      skippedRecordedInputsCurrent: 0,
      skippedRebuiltIdentical: 0,
      failed: 0,
      failures: [],
    };
  }
  const { sourceRoot, compileSetFolder } = resolvePackageSourceLayout({
    packageSetFolder: setFolder,
    packagesSourceRoot,
  });
  if (!existsSync(sourceRoot)) throw new Error(`PACKAGES_SOURCE_ROOT_MISSING:${sourceRoot}`);
  for (const name of packageNamesWithManifests) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`INVALID_PACKAGE_NAME:${name}`);
    if (!existsSync(path.join(sourceRoot, name, 'things-to-store-and-run.json'))) {
      throw new Error(`NO_SUCH_PACKAGE:${name}`);
    }
  }

  const ownerRoot = path.dirname(fileURLToPath(import.meta.url));
  const scopeWriter = path.join(ownerRoot, 'write-package-entry-scopes.mjs');
  const materializerLib = path.join(ownerRoot, 'materialize-package-entry-bytes-lib.mjs');
  for (const file of [scopeWriter, materializerLib]) {
    if (!existsSync(file)) throw new Error(`SET_BUILDER_MISSING:${file}`);
  }

  if (!skipScopes) {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scopeWriter], {
      cwd: compileSetFolder,
      env: { ...process.env, BITFIELD_PACKAGE_NAMES: packageNamesWithManifests.join(',') },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (stdout.trim()) log(stdout.trim());
    if (stderr.trim()) logError(stderr.trim());
  }

  const { materializePackageEntryBytes } = await import(materializerLib);
  // The lib's own progress lines follow the caller's `log`, so a caller that routes progress
  // to stderr keeps its stdout clean for the report.
  return materializePackageEntryBytes({ setRoot: compileSetFolder, packageNames: packageNamesWithManifests, log });
}

// CLI. Runs only when this file is the program, so importing it for the function above costs
// nothing and cannot exit the importing process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await makeDeclaredEntryBytesExist({
      packageSetFolder: required('--package-set-folder'),
      packagesSourceRoot: argumentValues('--packages-source-root').at(-1) ?? null,
      packageNames: argumentValues('--package'),
      skipScopes: process.argv.includes('--skip-scopes'),
    });
    if (result.failed > 0) process.exit(1);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
}
