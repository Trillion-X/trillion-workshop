#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { hashBoundBuildInputReceipt } from './package-entry-byte-build-lib.mjs';

export const browserIslandBuilderId = 'bitfield.browser-island-bytes-builder/declared-source-bundle';

export async function buildBrowserIslandBytes({ packageRoot, sourceFile, outputFile, receiptFile = null, storedBytesName = null }) {
  const root = realpathSync(packageRoot);
  const source = realpathSync(resolve(root, sourceFile));
  if (source !== root && !source.startsWith(`${root}${sep}`)) throw new Error('browser island source leaves its package');
  if (!existsSync(source)) throw new Error('browser island source is missing');
  const setRoot = dirname(dirname(root));
  const result = await esbuild.build({
    entryPoints: [source],
    absWorkingDir: root,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    outfile: resolve(outputFile),
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': setRoot, '@bitfield-package-entry-scope': join(setRoot, 'packages') },
    resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    loader: { '.js': 'jsx' },
    legalComments: 'none',
    sourcemap: false,
    minify: true,
    metafile: true,
  });
  if (receiptFile) {
    const receipt = await hashBoundBuildInputReceipt({
      packageRoot: root,
      packageName: root.split(sep).at(-1),
      storedBytesName: storedBytesName ?? 'browser-island',
      builder: browserIslandBuilderId,
      artifactBytes: await readFile(outputFile),
      metafile: result.metafile,
    });
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  return outputFile;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(await readFile(process.env.BITFIELD_PACKAGE_BUILD_REQUEST, 'utf8'));
  await buildBrowserIslandBytes({
    packageRoot: process.cwd(),
    sourceFile: request.source_file,
    outputFile: process.env.BITFIELD_PACKAGE_BUILD_OUTPUT,
    receiptFile: process.env.BITFIELD_PACKAGE_BUILD_RECEIPT ?? null,
    storedBytesName: request.stored_bytes ?? null,
  });
}
