#!/usr/bin/env node
// Generates package-entry scopes from package DATA. This package-owned script is
// the active implementation; it never delegates to a selected runtime root.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The shim imports the declared source module by its extensionless path only when esbuild
// will add that extension back on its own. esbuild's implicit resolve list is exactly
// `.tsx .ts .jsx .js .css .json`; a `.mjs`, `.cjs`, `.mts` or `.cts` module is never found
// without its extension, so those keep it. Declared HERE, above the top-level run that
// calls writeScope: as a `const` below that run it sat in the temporal dead zone and the
// first real ship run died with "Cannot access before initialization" (2026-09-05).
const esbuildImplicitExtensions = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.json']);
const root = process.cwd();
const packagesRoot = path.join(root, 'packages');
const sharedScopeBinding = JSON.parse(await readFile(path.join(root, 'package-entry-scope-binding.json'), 'utf8')).scope_binding;
const selectedPackages = selectedNames(process.env.BITFIELD_PACKAGE_NAMES, 'BITFIELD_PACKAGE_NAMES');
const selectedEntries = selectedNames(process.env.BITFIELD_ENTRY_NAMES, 'BITFIELD_ENTRY_NAMES');

const packageNames = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && (!selectedPackages || selectedPackages.has(entry.name)))
  .map((entry) => entry.name).sort();
if (selectedPackages && packageNames.length !== selectedPackages.size) {
  const found = new Set(packageNames);
  throw new Error(`unknown package scope selection: ${[...selectedPackages].filter((name) => !found.has(name)).join(', ')}`);
}
let written = 0;
for (const packageName of packageNames) {
  const packageRoot = path.join(packagesRoot, packageName);
  const packageData = await optionalJson(path.join(packageRoot, 'things-to-store-and-run.json'));
  if (!packageData) continue;
  const declaredEntryNames = new Set();
  const bindings = await optionalEntryMap(packageName, packageRoot, 'entry-scope-bindings.json', 'bitfield-entry-scope-bindings', 'scope_binding', plainObject);
  const readPackages = await optionalEntryMap(packageName, packageRoot, 'entry-read-scope-packages.json', 'bitfield-entry-read-scope-packages', 'read_scope_package_data_packages', readScopePackages);
  for (const thing of packageData.things ?? []) {
    const payload = thing.payload;
    if (payload?.kind !== 'bitfield-package-entry') continue;
    // Recorded BEFORE the selection filter. What the DATA declares is a fact about
    // the DATA; which entries this run happens to WRITE is a separate question.
    // Conflating them is what made pruning conditional below.
    declaredEntryNames.add(payload.entry_name);
    if (selectedEntries && !selectedEntries.has(payload.entry_name)) continue;
    await writeScope(packageName, packageRoot, packageData, {
      ...payload,
      source_path: thing.build_source_path ?? payload.source_path,
      scope_binding: bindings.get(payload.entry_name),
      read_scope_package_data_packages: readPackages.get(payload.entry_name) ?? payload.read_scope_package_data_packages,
    });
    written += 1;
  }
  // Prune scope folders for entries the DATA no longer declares. Without this the
  // generator only ever adds, so a renamed or removed entry leaves a folder whose
  // generated source re-exports a file that no longer exists, and the whole set's
  // build fails on it.
  //
  // This used to run only on a full run, because `declaredEntryNames` was filled
  // AFTER the selection filter and so held only the selected entries: pruning
  // against it would have deleted every unselected entry's folder. That made
  // correctness depend on someone remembering to do a full run, and orphans
  // accumulated silently in between. Five of them survived long enough to keep a
  // retired app name alive in generated wrappers, and had to be removed by hand.
  //
  // Now the declared set is read from the DATA whatever this run was asked to
  // write, so pruning is unconditional and a selected run cannot leave an orphan
  // behind. The filter narrows the WORK, never the TRUTH.
  await pruneUndeclaredScopes(packageRoot, declaredEntryNames);
}
if (selectedEntries && written === 0) throw new Error(`no package entries matched BITFIELD_ENTRY_NAMES: ${[...selectedEntries].join(', ')}`);
console.log(`wrote ${written} package entry scopes`);

async function pruneUndeclaredScopes(packageRoot, declaredEntryNames) {
  const scopeRoot = path.join(packageRoot, '.bitfield-entry-scope');
  let existing;
  try {
    existing = await readdir(scopeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of existing) {
    if (!entry.isDirectory() || declaredEntryNames.has(entry.name)) continue;
    await rm(path.join(scopeRoot, entry.name), { recursive: true, force: true });
    console.log(`pruned undeclared package entry scope: ${path.basename(packageRoot)}/${entry.name}`);
  }
}

async function writeScope(packageName, packageRoot, packageData, entry) {
  const entryName = requiredString(entry.entry_name, `${packageName} entry_name`);
  const readMode = liveReadMode(entry.live_read_mode, `${packageName}/${entryName}`);
  const entryRoot = path.join(packageRoot, '.bitfield-entry-scope', entryName);
  await mkdir(entryRoot, { recursive: true });
  const binding = {
    entry_name: entryName,
    package: packageName,
    scope_binding: { target_path: ['el'], ...plainObject(sharedScopeBinding, 'shared package entry scope binding'), ...plainObject(entry.scope_binding, `${packageName}/${entryName} scope_binding`) },
  };
  assertNoSelectorLabel(binding, `${packageName}/${entryName}`);
  const sourcePath = requiredString(entry.source_path, `${packageName}/${entryName} source_path`);
  // The declared source must exist before a shim is written for it. Without this check a
  // wrong declaration (a `.mjs` name for a `.js` file, a mount file that was never written,
  // a markdown contract declared as an entry) produced a shim that failed only inside
  // esbuild, one build later, with the declared path nowhere in the error.
  if (!existsSync(path.join(packageRoot, sourcePath))) {
    throw new Error(`${packageName}/${entryName} source_path names a file that does not exist: ${sourcePath}`);
  }
  const sourceModule = withoutExtension(sourcePath);
  await writeFile(path.join(entryRoot, 'entry.ts'), entry.export_name
    ? `// Generated from things-to-store-and-run.json package entry records. Do not edit.\nexport * from "../../${sourceModule}";\nexport { ${entry.export_name}, ${entry.export_name} as mount } from "../../${sourceModule}";\n`
    : `// Generated from things-to-store-and-run.json package entry records. Do not edit.\nexport * from "../../${sourceModule}";\nexport { default as mount } from "../../${sourceModule}";\n`);
  const bindingText = JSON.stringify(binding, null, 2);
  await writeFile(path.join(entryRoot, 'runtime-kit.ts'), `// Generated from things-to-store-and-run.json package entry records. Do not edit.\nimport { createPackageEntryTargetSender } from '@bitfield/runtime-kit/internal/owner-surface';\nexport type { BitfieldTargetReply, BitfieldTargetRequest } from '@bitfield/runtime-kit/internal/owner-surface';\n// This file names NO app. The partition (which installed app's store an\n// operation lands in) is read from the trusted runtime at call time, so a\n// target runs unchanged in any app that installs it.\n// The read wrapper retains partition metadata only for explicit operation callers.\n// Data hooks use the running connection and do not preload package records.\nexport { readTrustedRuntimePartition, readTrustedRuntimePartitionIfPresent, readTrustedRuntimeClockMs, readTrustedRuntimeEntropyHex, createTrustedRuntimeIdMinter } from '@bitfield/runtime-kit/internal/owner-surface';\nexport type { BitfieldRuntimeContext } from '@bitfield/runtime-kit/internal/owner-surface';\n\nexport const bitfieldGeneratedPackageEntryScopeBinding = ${bindingText} as const;\nexport const sendRequestToBitfieldTarget = createPackageEntryTargetSender(bitfieldGeneratedPackageEntryScopeBinding);\n`);
  await writeFile(path.join(entryRoot, 'runtime-kit-react.ts'), readMode === 'none'
    ? noLiveRuntimeKitReactSource(bindingText, packageName, entryName)
    : liveRuntimeKitReactSource(bindingText, JSON.stringify(await readEntryInputs(packageName, entryName, packageData, readScopePackages(entry.read_scope_package_data_packages, `${packageName}/${entryName}`)), null, 2)));
}

function liveRuntimeKitReactSource(bindingText, descriptorText) {
  const descriptor = JSON.parse(descriptorText);
  const own = descriptor.packages.find(pkg => pkg.packageName === descriptor.packageName).inputs;
  const names = new Set(own.map(input => input.inputName));
  const borrowed = new Map();
  for (const pkg of descriptor.packages) {
    if (pkg.packageName === descriptor.packageName) continue;
    for (const input of pkg.inputs) {
      if (!input.inputName || names.has(input.inputName)) continue;
      const prior = borrowed.get(input.inputName);
      borrowed.set(input.inputName, prior && prior.address !== input.address ? null : prior === null ? null : input);
    }
  }
  const things = own.map(input => ({ type: 'record', address: input.address, payload: input.payload }));
  for (const input of borrowed.values()) if (input) things.push({
    type: 'record', address: input.address, payload: { ...input.payload, is_default: false },
  });
  return `// Generated input definitions. Values come from the normal current-data subscription.\nimport { createReadScopeFromPackageData, createUseBitfieldData, createUseBitfieldFold } from '@bitfield/runtime-kit/internal/owner-surface';\n\nexport const bitfieldGeneratedPackageEntryScopeBinding = ${bindingText} as const;\nexport const bitfieldGeneratedLiveReadScopeDescriptor = ${descriptorText} as const;\n\nconst bitfieldPackageReadScope = createReadScopeFromPackageData(${JSON.stringify({ package: descriptor.packageName, things })});\nexport const useBitfieldData = createUseBitfieldData(bitfieldPackageReadScope);\nexport const useBitfieldFold = createUseBitfieldFold(bitfieldPackageReadScope);\n`;
}

function noLiveRuntimeKitReactSource(bindingText, packageName, entryName) {
  const message = JSON.stringify(`BPS_ENTRY_READ_0001_NO_LIVE_SCOPE: ${packageName}/${entryName} declares live_read_mode:none and cannot read live package data`);
  return `// Generated from things-to-store-and-run.json package entry records. Do not edit.\n// This entry receives sealed props only. Live package reads are structurally unavailable.\n\nexport const bitfieldGeneratedPackageEntryScopeBinding = ${bindingText} as const;\nexport const bitfieldGeneratedLiveReadScopeDescriptor = { live_read_mode: 'none' } as const;\n\nfunction noLivePackageEntryRead(): never { throw new Error(${message}); }\nexport function useBitfieldData(..._args: readonly unknown[]): never { return noLivePackageEntryRead(); }\nexport function useBitfieldFold(..._args: readonly unknown[]): never { return noLivePackageEntryRead(); }\n`;
}

async function readEntryInputs(packageName, entryName, packageData, readPackageNames) {
  const packages = [{ packageName, inputs: packageInputs(packageData) }];
  for (const readPackageName of readPackageNames) {
    const readData = JSON.parse(await readFile(path.join(packagesRoot, readPackageName, 'things-to-store-and-run.json'), 'utf8'));
    packages.push({ packageName: readPackageName, inputs: packageInputs(readData) });
  }
  return { packageName, entryName, packages };
}

function packageInputs(packageData) {
  const byAddress = new Map();
  for (const thing of packageData.things ?? []) {
    const payload = thing.payload;
    if (thing.remove !== true && payload?.kind === 'bitfield-input-descriptor' && (payload.is_default === true || typeof payload.input_name === 'string' && payload.input_name.length > 0) && typeof thing.address === 'string' && thing.address.length > 0 && !byAddress.has(thing.address)) byAddress.set(thing.address, { inputName: payload.input_name ?? null, address: thing.address, payload });
  }
  return [...byAddress.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
}

function liveReadMode(value, label) {
  if (value === undefined || value === null) return 'live';
  if (value === 'none') return value;
  throw new Error(`${label} live_read_mode must be "none" when provided`);
}

function readScopePackages(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} read_scope_package_data_packages must be an array`);
  const seen = new Set();
  return value.filter((item) => {
    if (typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item)) throw new Error(`${label} read_scope_package_data_packages contains an invalid package name`);
    if (seen.has(item)) return false;
    seen.add(item); return true;
  });
}

async function optionalEntryMap(packageName, packageRoot, fileName, kind, property, decoder) {
  const raw = await optionalJson(path.join(packageRoot, fileName));
  if (!raw) return new Map();
  if (raw.kind !== kind || !Array.isArray(raw.entries)) throw new Error(`${packageName}/${fileName} has unsupported shape`);
  const entries = new Map();
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${packageName}/${fileName} entry must be an object`);
    const name = requiredString(entry.entry_name, `${packageName}/${fileName} entry_name`);
    if (entries.has(name)) throw new Error(`${packageName}/${fileName} duplicates ${name}`);
    entries.set(name, decoder(entry[property], `${packageName}/${fileName}/${name} ${property}`));
  }
  return entries;
}

async function optionalJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}
function requiredString(value, label) { if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty`); return value; }
function selectedNames(value, label) {
  if (value === undefined) return null;
  const names = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) throw new Error(`${label} must contain at least one name`);
  for (const name of names) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`${label} contains an invalid name: ${name}`);
  return new Set(names);
}
function plainObject(value, label) { if (value === undefined || value === null) return {}; if (typeof value === 'object' && !Array.isArray(value)) return value; throw new Error(`${label} must be an object`); }
function withoutExtension(sourcePath) {
  const extension = /\.[^.\/]+$/.exec(sourcePath)?.[0] ?? '';
  return esbuildImplicitExtensions.has(extension) ? sourcePath.slice(0, -extension.length) : sourcePath;
}
function assertNoSelectorLabel(value, label) { const text = JSON.stringify(value); const suffix = new RegExp(`(?:^|[._-])${String.fromCharCode(118)}[0-9]+(?:$|[._-])`, 'i'); if (text.includes('"kind"') || suffix.test(text)) throw new Error(`entry scope ${label} contains a forbidden selector label`); }
