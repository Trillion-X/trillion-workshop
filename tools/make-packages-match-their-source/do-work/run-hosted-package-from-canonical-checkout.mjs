#!/usr/bin/env node
// Install one canonical package into its hosted app through the existing atomic owner.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOnePackageMatchItsSource } from './make-one-package-match-its-source.mjs';
import { runningAppTargetClient, startRunningAppSession } from '../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs';

const args = process.argv.slice(2);
if ((args.length !== 6 && args.length !== 7) || args[0] !== '--url' || args[2] !== '--package-set' || args[4] !== '--package' || (args.length === 7 && args[6] !== '--adopt-unversioned-source-records')) {
  throw new Error('Usage: --url <hosted app> --package-set <selected set> --package <package> [--adopt-unversioned-source-records]');
}
const [, url, , setName, , packageName] = args;
if (!/^https:\/\//.test(url) || !/^[a-z0-9-]+$/.test(setName) || !/^[a-z0-9-]+$/.test(packageName)) {
  throw new Error('A hosted HTTPS app and semantic package identities are required');
}
const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkoutRoot = dirname(packagesRoot);
const packageSetFolder = join(checkoutRoot, 'package-sets', setName);
const packageLoader = join(dirname(checkoutRoot), 'bitfield-runtime-kit', 'target', 'debug', 'package-loader');
if (!existsSync(join(packageSetFolder, 'package-set-partition.json')) || !existsSync(join(packagesRoot, packageName, 'things-to-store-and-run.json')) || !existsSync(packageLoader)) {
  throw new Error('Canonical package set, package, or package compiler is unavailable');
}
const session = await startRunningAppSession({ url });
const client = runningAppTargetClient(session, { timeoutMs: 180000 });
const result = await makeOnePackageMatchItsSource({ packageSetFolder, packagesSourceRoot: packagesRoot, packageName, packageLoader, client, adoptUnversionedSourceRecords: args.length === 7 });
process.stdout.write(JSON.stringify({ outcome: result.outcome, stats: result.stats, verification: result.verification }) + '\n');
