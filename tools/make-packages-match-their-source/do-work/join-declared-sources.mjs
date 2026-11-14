#!/usr/bin/env node

import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function joinDeclaredSources({ packageRoot, sourceFiles, outputFile }) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0
      || sourceFiles.some((source) => typeof source !== 'string' || source.trim() === '')) {
    throw new Error('source_files must be a non-empty string array');
  }
  const root = await realpath(path.resolve(packageRoot));
  const chunks = [];
  for (const declared of sourceFiles) {
    const requested = path.resolve(root, declared);
    const requestedMetadata = await lstat(requested);
    if (requestedMetadata.isSymbolicLink()) throw new Error('source_files cannot contain a symlink');
    const source = await realpath(requested);
    const fromRoot = path.relative(root, source);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error('source_files resolve outside the package owner');
    }
    if (!(await lstat(source)).isFile()) throw new Error('source_files must name ordinary files');
    chunks.push(await readFile(source));
  }
  const joined = Buffer.concat(chunks.flatMap((chunk, index) => (
    index === chunks.length - 1 ? [chunk] : [chunk, Buffer.from('\n')]
  )));
  await writeFile(path.resolve(required(outputFile, 'BITFIELD_PACKAGE_BUILD_OUTPUT')), joined);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

async function main() {
  const request = JSON.parse(await readFile(required(
    process.env.BITFIELD_PACKAGE_BUILD_REQUEST,
    'BITFIELD_PACKAGE_BUILD_REQUEST',
  ), 'utf8'));
  await joinDeclaredSources({
    packageRoot: process.cwd(),
    sourceFiles: request.source_files,
    outputFile: process.env.BITFIELD_PACKAGE_BUILD_OUTPUT,
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
