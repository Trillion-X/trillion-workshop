import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageSetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function runtimeKitRootFromSourcePackage(packagePath) {
  const sourcePackage = realpathSync(packagePath);
  const isPackagesJs = path.basename(sourcePackage) === 'js'
    && path.basename(path.dirname(sourcePackage)) === 'packages';
  const root = path.resolve(sourcePackage, '../..');
  return isPackagesJs && existsSync(path.join(root, 'Cargo.toml')) ? root : undefined;
}

const installedPackage = path.join(packageSetRoot, 'node_modules/@bitfield/runtime-kit');
let resolvedRuntimeKitRoot;
if (existsSync(installedPackage)) {
  resolvedRuntimeKitRoot = runtimeKitRootFromSourcePackage(installedPackage);
}

if (!resolvedRuntimeKitRoot) {
  const packageManifest = JSON.parse(readFileSync(path.join(packageSetRoot, 'package.json'), 'utf8'));
  const sourcePointer = packageManifest.dependencies?.['@bitfield/runtime-kit']
    ?? packageManifest.devDependencies?.['@bitfield/runtime-kit'];
  if (typeof sourcePointer !== 'string' || !sourcePointer.startsWith('file:')) {
    throw new Error('Checked-in @bitfield/runtime-kit file: source pointer is absent');
  }
  resolvedRuntimeKitRoot = runtimeKitRootFromSourcePackage(
    path.resolve(packageSetRoot, sourcePointer.slice('file:'.length)),
  );
}

if (!resolvedRuntimeKitRoot) {
  throw new Error('Resolved @bitfield/runtime-kit source must be packages/js beneath a Runtime Kit Cargo workspace');
}

export const runtimeKitRoot = resolvedRuntimeKitRoot;

export function runtimeKitBinary(name, packageName = name) {
  const binary = path.join(runtimeKitRoot, 'target', 'debug', name);
  if (!existsSync(binary)) {
    execFileSync('cargo', [
      'build', '--offline', '--manifest-path', path.join(runtimeKitRoot, 'Cargo.toml'),
      '--package', packageName,
    ], { cwd: runtimeKitRoot, stdio: 'pipe' });
  }
  if (!existsSync(binary)) throw new Error(`Runtime Kit tool was not built: ${name}`);
  return binary;
}
