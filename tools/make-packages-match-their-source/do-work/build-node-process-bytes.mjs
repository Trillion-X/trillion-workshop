#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

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

export const nodeProcessBytesBuilderId = 'bitfield.node-process-bytes-builder/declared-source-bundle';

export async function buildNodeProcessBytes({
  packageRoot,
  sourceFile,
  outputFile,
  receiptFile = null,
  storedBytesName = null,
  outputKind = 'javascript',
  optionalExternalModules = [],
}) {
  const root = requiredPath(packageRoot, 'packageRoot');
  const source = requiredPath(path.resolve(root, sourceFile), 'sourceFile');
  const output = requiredPath(outputFile, 'outputFile');
  if (!existsSync(root)) throw new Error(`packageRoot does not exist: ${root}`);
  if (!existsSync(source)) throw new Error(`sourceFile does not exist: ${source}`);
  inside(root, source, 'sourceFile');
  if (!['javascript', 'css'].includes(outputKind)) {
    throw new TypeError(`unsupported outputKind: ${outputKind}`);
  }
  if (!Array.isArray(optionalExternalModules)
    || optionalExternalModules.some(name => typeof name !== 'string'
      || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(name))) {
    throw new TypeError('optionalExternalModules must contain plain package names');
  }
  const esbuildOutput = outputKind === 'css' ? `${output}.bundle.mjs` : output;
  // The metafile is asked for unconditionally. esbuild already knows every file it read,
  // and the cost of carrying that knowledge out is a JSON object; the cost of discarding
  // it is a blob nobody can attest to later, which is the state these bytes were in.
  // A PROCESS MAY READ ANOTHER PACKAGE, and until this was here it could not.
  //
  // Only the ENTRY is required to sit inside the package; what it imports is a
  // different question and always was. Packages refer to each other through the
  // same package-alias name the rest of the source uses, and that name resolved
  // nowhere here, so a process whose imports crossed a package boundary simply
  // could not be built. It failed loudly with "Could not resolve" for files that
  // exist, and the practical result was that such a process was never declared at
  // all: the public server that answers a public address had no build, so nothing
  // carried it anywhere and nothing started it.
  //
  // The root is found rather than assumed: the nearest ancestor that holds the
  // `packages` directory this package sits in. Nothing existing can change meaning,
  // because today that name resolves to nothing at all.
  const setRoot = path.dirname(path.dirname(root));
  const result = await esbuild.build({
    entryPoints: [source],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: esbuildOutput,
    ...(outputKind === 'css' ? { write: false } : {}),
    // A module bundle still has to be able to reach node's own modules. Bundled
    // CommonJS dependencies ask for them by calling require, and a module file
    // has no require, so the bundler leaves a stub that throws the moment one of
    // them runs. The real one is made here from this file's own location, and
    // the stub uses it when it is present, so a dependency asking for `util`
    // gets `util` instead of stopping the program on its first request.
    banner: {
      js: [
        "import { createRequire as createRequireForBundledDependencies } from 'node:module';",
        'const require = createRequireForBundledDependencies(import.meta.url);',
      ].join('\n'),
    },
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    alias: {
      '@': setRoot,
      // The name a package uses for another package's entry scope. Same directory,
      // different spelling, and the source already uses both.
      '@bitfield-package-entry-scope': path.join(setRoot, 'packages'),
    },
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    loader: { '.js': 'jsx' },
    // Native optional addons cannot be embedded in one JavaScript stored byte.
    // Keep their guarded runtime require as a module lookup; a missing optional
    // addon must be handled by the dependency itself, never by this builder.
    external: [...new Set(optionalExternalModules)],
  });
  if (outputKind === 'css') {
    const cssOutput = result.outputFiles?.find((file) => file.path.endsWith('.css'));
    if (!cssOutput) throw new Error(`sourceFile did not produce CSS: ${sourceFile}`);
    await writeFile(output, cssOutput.contents);
  }
  if (receiptFile) {
    const receipt = await hashBoundBuildInputReceipt({
      packageRoot: root,
      packageName: path.basename(root),
      storedBytesName: storedBytesName ?? path.basename(output),
      builder: nodeProcessBytesBuilderId,
      artifactBytes: await readFile(output),
      metafile: result.metafile,
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
  await buildNodeProcessBytes({
    packageRoot: process.cwd(),
    sourceFile: request.source_file,
    outputFile,
    outputKind: request.output_kind ?? 'javascript',
    optionalExternalModules: request.optional_external_modules ?? [],
    // Opt-in, and absence is silence rather than failure. A caller that offers nowhere to
    // report what was consumed gets exactly the old behaviour, so this reaches every
    // existing invocation without changing any of them.
    receiptFile: process.env.BITFIELD_PACKAGE_BUILD_RECEIPT ?? null,
    storedBytesName: request.stored_bytes ?? null,
  });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
