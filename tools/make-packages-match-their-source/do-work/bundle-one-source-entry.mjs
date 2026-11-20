#!/usr/bin/env node
// packages/make-packages-match-their-source/do-work/bundle-one-source-entry.mjs
//
// PURPOSE: turn ONE source entry into ONE self-contained runnable, with the bundler options
// supplied as arguments rather than baked into the file.
//
// WHY THIS EXISTS. Eight packages ship a file called `do-work/process-scripts/build-process-scripts.mjs`,
// 296 lines between them, and every one of them does the same thing: `import { build } from 'esbuild'`
// and call it with `bundle: true, platform: 'node'` over a list of entries hardcoded in that copy.
// The only things that differ per package are the entry list, the output format, and the occasional
// `external`. Those are DATA, and a ninth copy was the alternative to this file.
//
// WHY IT IS NOT NAMED AFTER ESBUILD OR AFTER ITS FIRST CALLER. Naming it `run-esbuild` would freeze
// the bundler into the identity, and naming it after the package that needed it first would freeze
// the caller in. What it does is turn one entry into one runnable; which bundler performs that is an
// implementation detail that may change, and the callers are open-ended.
//
// WHY IT TAKES A DECLARED `node` ARGV. `materialize-package-stored-bytes-builds.mjs`
// REFUSES any declared build whose `argv[0]` is not `node`, which is the reason those eight copies
// exist at all: a declared producer cannot name the esbuild binary, only a node script that imports
// it. So the generic seam has to BE a node script, and this is it. Anything wanting a bundle names
// this file in its `build` block and passes its options as arguments.
//
// TWO WAYS IN, because it serves two callers that cannot be collapsed:
//
//   1. DECLARED PRODUCER. When `BITFIELD_PACKAGE_BUILD_OUTPUT` is set, the bytes go THERE and
//      `--outfile` is ignored, because the converter owns placement (it copies the result to
//      `built-stored-bytes/<name>`) and a producer that chose its own destination would fight it.
//   2. DIRECT. Otherwise `--outfile` is required and the bytes go where the caller said. This is
//      what rebuilds an artifact that is committed somewhere other than `built-stored-bytes/`,
//      which several already are.
//
// The environment variable WINS rather than erroring on the pair, because the declared path sets it
// unconditionally and a caller cannot know at authoring time whether it will be present.

import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every value given for a repeatable flag, in order. */
export function argumentValues(argv, flag) {
  const found = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) found.push(argv[index + 1]);
  }
  return found;
}

export function argumentValue(argv, flag) {
  return argumentValues(argv, flag).at(-1);
}

/** The options, read once, so the two entry paths cannot drift apart.
 *
 *  `minify` defaults to FALSE. A default that silently minified would make an unminified caller's
 *  output differ from its source in a way nothing in the command line explained, and a drift guard
 *  comparing committed bytes to a fresh build would then fail for a reason its author never wrote
 *  down. */
export function bundleRequestFrom(argv, environment = {}) {
  const entry = argumentValue(argv, '--entry');
  if (!entry) throw new Error('NO_ENTRY: pass --entry <path to the source file>');
  const fromEnvironment = environment.BITFIELD_PACKAGE_BUILD_OUTPUT;
  const outfile = fromEnvironment || argumentValue(argv, '--outfile');
  if (!outfile) {
    throw new Error('NO_OUTFILE: pass --outfile <path>, or set BITFIELD_PACKAGE_BUILD_OUTPUT');
  }
  return {
    entry: path.resolve(entry),
    outfile: path.resolve(outfile),
    // Placement is the converter's when it asked for it. Reported rather than inferred, so a
    // caller reading the result can tell which of the two ways in it took.
    placementOwnedByConverter: Boolean(fromEnvironment),
    format: argumentValue(argv, '--format') ?? 'esm',
    platform: argumentValue(argv, '--platform') ?? 'node',
    minify: argv.includes('--minify'),
    external: argumentValues(argv, '--external'),
  };
}

export async function bundleOneSourceEntry(request, bundle = build) {
  const result = await bundle({
    entryPoints: [request.entry],
    bundle: true,
    write: false,
    format: request.format,
    platform: request.platform,
    minify: request.minify,
    ...(request.external.length > 0 ? { external: request.external } : {}),
  });
  // `write: false` and an explicit write, rather than letting the bundler place the file. The
  // declared-producer path needs the bytes at an exact path the converter chose, and asking the
  // bundler to write there works only while that path stays a plain file it is willing to create.
  // One write here serves both ways in and keeps the byte content identical between them.
  const [output] = result.outputFiles ?? [];
  if (!output) throw new Error(`NO_OUTPUT_PRODUCED:${request.entry}`);
  await writeFile(request.outfile, output.contents);
  return { outfile: request.outfile, byte_length: output.contents.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(new URL(import.meta.url)))) {
  try {
    const request = bundleRequestFrom(process.argv.slice(2), process.env);
    const written = await bundleOneSourceEntry(request);
    console.log(`${written.byte_length} bytes -> ${written.outfile}`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
  }
}
