#!/usr/bin/env node

import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copyDeclaredSource({ packageRoot, sourceFile, outputFile }) {
  const root = await realpath(path.resolve(packageRoot));
  const requestedSource = path.resolve(root, required(sourceFile, 'source_file'));
  const requestedMetadata = await lstat(requestedSource);
  if (requestedMetadata.isSymbolicLink()) throw new Error('source_file cannot be a symlink');
  const source = await realpath(requestedSource);
  const fromRoot = path.relative(root, source);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('source_file resolves outside the package owner');
  }
  const metadata = await lstat(source);
  if (!metadata.isFile()) {
    throw new Error('source_file must be one ordinary package-owned file');
  }
  await writeFile(path.resolve(required(outputFile, 'BITFIELD_PACKAGE_BUILD_OUTPUT')), await readFile(source));
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
  await copyDeclaredSource({
    packageRoot: process.cwd(),
    sourceFile: request.source_file,
    outputFile: process.env.BITFIELD_PACKAGE_BUILD_OUTPUT,
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
