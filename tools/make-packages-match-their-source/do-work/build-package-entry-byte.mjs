#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPackageEntryBytes } from './package-entry-byte-build-lib.mjs';

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

async function main() {
  const requestPath = requiredEnv('BITFIELD_PACKAGE_BUILD_REQUEST');
  const outputPath = requiredEnv('BITFIELD_PACKAGE_BUILD_OUTPUT');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  if (Object.hasOwn(request, 'package_root')) {
    throw new Error('BPS_ENTRY_BYTES_0004_RETIRED_HOST_PATH: package_root');
  }
  const packageRoot = path.resolve('.');
  const entryName = readString(request.entry_name, 'entry_name');
  const bytes = await buildPackageEntryBytes({ packageRoot, entryName });
  await writeFile(outputPath, bytes);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`BPS_ENTRY_BYTES_0002_ENV_MISSING: ${name}`);
  }
  return value;
}

function readString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`BPS_ENTRY_BYTES_0003_STRING_INVALID: ${label}`);
  }
  return value;
}
