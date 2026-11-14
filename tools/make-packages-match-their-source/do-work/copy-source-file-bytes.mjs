#!/usr/bin/env node
//
// Materialize a declared stored_bytes row whose build is a straight copy of one source file,
// and report what it consumed.
//
// This producer exists because the copy was being written INLINE, as `node -e "...
// copyFileSync(request.source_file, BUILD_OUTPUT)"` pasted into the manifest, in 29 places. An
// inline producer is unnameable and unattestable by construction: it has no identity to record
// as `builder`, and it is handed nowhere to write a receipt, so every blob it produced named
// nothing that made it. `a-built-blob-must-declare-what-produced-it` reports exactly those rows,
// and no amount of editing the manifest could clear one honestly, because the declaration would
// have pointed at a receipt nothing ever wrote.
//
// The seam is the same one `build-node-process-bytes.mjs` uses, and deliberately so: the
// converter (`materialize-package-stored-bytes-builds.mjs`) offers `BITFIELD_PACKAGE_BUILD_RECEIPT`
// and copies whatever appears there, knowing nothing about any producer. A producer opts in by
// reporting what it read. Absence stays silence, so a caller offering nowhere to report gets the
// old behaviour byte for byte.
//
// It does NOT re-derive the receipt shape. `hashBoundBuildInputReceipt` reads only the KEYS of
// `metafile.inputs`, so a build with exactly one input describes itself with a one-key object and
// every hash, root-labelling and portability rule stays owned by the one place that owns it. A
// second implementation of that shape would be a second source of truth for what a receipt means.
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hashBoundBuildInputReceipt } from './package-entry-byte-build-lib.mjs';

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty path`);
  }
  return path.resolve(value);
}

function inside(root, requested, label) {
  const resolvedRoot = realpathSync(root);
  const resolved = realpathSync(requested);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} resolves outside the package root`);
  }
  return resolved;
}

export const copiedSourceFileBytesBuilderId = 'bitfield.copied-source-file-bytes-builder/declared-source-copy';

export async function copySourceFileBytes({
  packageRoot,
  sourceFile,
  outputFile,
  receiptFile = null,
  storedBytesName = null,
}) {
  const root = requiredPath(packageRoot, 'packageRoot');
  const source = requiredPath(path.resolve(root, sourceFile), 'sourceFile');
  const output = requiredPath(outputFile, 'outputFile');
  if (!existsSync(root)) throw new Error(`packageRoot does not exist: ${root}`);
  if (!existsSync(source)) throw new Error(`sourceFile does not exist: ${source}`);
  // The inline version copied whatever path it was handed. A row naming `../../../etc/passwd`
  // would have been served as package bytes, and the manifest that named it is the least
  // watched file in the package. The bundling producer already refuses that; a copy is not a
  // weaker operation just because it is a shorter one.
  inside(root, source, 'sourceFile');

  await copyFile(source, output);

  if (receiptFile) {
    const receipt = await hashBoundBuildInputReceipt({
      packageRoot: root,
      packageName: path.basename(root),
      storedBytesName: storedBytesName ?? path.basename(output),
      builder: copiedSourceFileBytesBuilderId,
      artifactBytes: await readFile(output),
      // A copy reads exactly one file, and the receipt owner takes its inputs as the keys of
      // this object. Stating the single key is the whole difference between a blob that names
      // its source and one that does not.
      metafile: { inputs: { [path.relative(root, source).split(path.sep).join('/')]: {} } },
    });
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return output;
}

async function main() {
  const requestFile = requiredPath(
    process.env.BITFIELD_PACKAGE_BUILD_REQUEST,
    'BITFIELD_PACKAGE_BUILD_REQUEST',
  );
  const outputFile = requiredPath(
    process.env.BITFIELD_PACKAGE_BUILD_OUTPUT,
    'BITFIELD_PACKAGE_BUILD_OUTPUT',
  );
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  if (Object.hasOwn(request, 'package_root')) {
    throw new TypeError('package_root is retired; the process owner supplies the workspace cwd');
  }
  await copySourceFileBytes({
    packageRoot: process.cwd(),
    sourceFile: request.source_file,
    outputFile,
    receiptFile: process.env.BITFIELD_PACKAGE_BUILD_RECEIPT ?? null,
    storedBytesName: request.stored_bytes ?? null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
