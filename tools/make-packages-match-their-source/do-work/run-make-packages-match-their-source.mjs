#!/usr/bin/env node
// Converge one named package into one named installed app through the app's
// package-set-runtime-state owner. Source roots, loaders, hosts, ports, output
// paths, staging files, and review objects are owner facts, not CLI inputs.

import path from "node:path";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  convergeInstalledPackageSource,
  deriveBuildPolicyFromInstalledApp,
  makeOnePackageMatchItsSource,
} from "./make-one-package-match-its-source.mjs";
import {
  runningAppTargetClient,
  startRunningAppSession,
  statusFileForAppId,
} from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";

const VALUE_FLAGS = new Set(["--app-id", "--url", "--package", "--record-set"]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--adopt-unversioned-source-records", "--adopt-live-ownership-only", "--only-if-no-retractions"]);

export function installedConvergenceOptionsFromArgs(args) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (VALUE_FLAGS.has(token)) {
      if (values.has(token)) throw new Error(`${token} may be named only once`);
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${token} requires one semantic identity`);
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token)) throw new Error(`${token} may be named only once`);
      booleans.add(token);
      continue;
    }
    throw new Error(`unsupported package convergence argument: ${token}`);
  }
  // One app, named once. `--url` names a hosted app by the address a caller was
  // handed; `--app-id` names an installation on this machine. Both answer the
  // same question, so accepting both at once leaves the target ambiguous and
  // accepting neither leaves it unstated. Neither is a host, a port, a root, or
  // a transport: the app is named, and it resolves its own.
  if (values.has("--app-id") === values.has("--url")) {
    throw new Error("package convergence requires exactly one of --app-id or --url");
  }
  if (!values.has("--package")) {
    throw new Error("package convergence requires one --package");
  }
  if (booleans.has("--adopt-live-ownership-only") && booleans.has("--adopt-unversioned-source-records")) {
    throw new Error("choose one explicit adoption mode");
  }
  if (values.has("--record-set") && values.get("--package") !== "package-set-records") {
    throw new Error("--record-set requires package-set-records");
  }
  return {
    appId: values.get("--app-id"),
    url: values.get("--url"),
    packageName: values.get("--package"),
    ...(values.has("--record-set") ? { selectedRecordSet: values.get("--record-set") } : {}),
    dryRun: booleans.has("--dry-run"),
    adoptUnversionedSourceRecords: booleans.has("--adopt-unversioned-source-records"),
    ...(booleans.has("--adopt-live-ownership-only") ? { adoptLiveOwnershipOnly: true } : {}),
    onlyIfNoRetractions: booleans.has("--only-if-no-retractions"),
  };
}

/**
 * Resolve the canonical authoring checkout and the selected app's own package
 * compiler from identities the caller already supplied. Package changes must
 * not be compiled from the immutable bootstrap copy retained for reinstall.
 */
export function canonicalConvergenceLocations(appId, {
  moduleFile = fileURLToPath(import.meta.url),
  readFile = readFileSync,
  exists = existsSync,
  statusFile = statusFileForAppId(appId),
} = {}) {
  const repositoryRoot = path.resolve(path.dirname(moduleFile), "../../..");
  const packageSetFolder = path.join(repositoryRoot, "package-sets", appId);
  const packagesSourceRoot = path.join(repositoryRoot, "packages");
  const status = JSON.parse(readFile(statusFile, "utf8"));
  const bitfieldRoot = String(status?.bitfield_root ?? "").trim();
  if (!bitfieldRoot) throw new Error("RUNNING_APP_BITFIELD_ROOT_MISSING");
  const bundleRoot = path.join(
    bitfieldRoot,
    "runtime-kit/app-open-source-bundles",
    `app-open-source-bundle-${Buffer.from(appId, "utf8").toString("hex")}`,
  );
  const bundle = JSON.parse(readFile(path.join(bundleRoot, "app-open-source-bundle.json"), "utf8"));
  const runtimeReceipt = bundle?.copy_files?.["bitfield-runtime-kit-copy-files"];
  // The bundle records its copied files relative to its own folder; an absolute
  // receipt path resolves to itself.
  const runtimeFolder = typeof runtimeReceipt === "string"
    ? path.dirname(path.resolve(bundleRoot, runtimeReceipt))
    : "";
  const packageLoader = runtimeFolder ? path.join(runtimeFolder, "bin/package-loader") : "";
  const opener = runtimeFolder ? path.join(runtimeFolder, "bin/open-bitfield-app") : "";
  for (const [label, selected] of [
    ["PACKAGE_SET_FOLDER", packageSetFolder],
    ["PACKAGES_SOURCE_ROOT", packagesSourceRoot],
    ["PACKAGE_LOADER", packageLoader],
    ["INSTALLED_OPENER", opener],
  ]) {
    if (!selected || !exists(selected)) throw new Error(`${label}_MISSING:${selected}`);
  }
  return { packageSetFolder, packagesSourceRoot, packageLoader, opener };
}

export async function convergeCanonicalCheckoutPackageSource({
  appId,
  packageName,
  selectedRecordSet,
  dryRun = false,
  adoptUnversionedSourceRecords = false,
  adoptLiveOwnershipOnly = false,
  onlyIfNoRetractions = false,
}, {
  start = startRunningAppSession,
  makeClient = runningAppTargetClient,
  locate = canonicalConvergenceLocations,
  deriveBuildEnvironment = deriveBuildPolicyFromInstalledApp,
  converge = makeOnePackageMatchItsSource,
} = {}) {
  const { opener, ...locations } = locate(appId);
  const buildEnvironment = await deriveBuildEnvironment({ appId, opener });
  const session = await start({ appId });
  return converge({
    ...locations,
    packageName,
    ...(selectedRecordSet == null ? {} : { selectedRecordSet }),
    dryRun,
    adoptUnversionedSourceRecords,
    ...(adoptLiveOwnershipOnly ? { adoptLiveOwnershipOnly: true } : {}),
    onlyIfNoRetractions,
    buildEnvironment,
    client: makeClient(session, { timeoutMs: 180000 }),
  });
}

async function main() {
  const options = installedConvergenceOptionsFromArgs(process.argv.slice(2));
  if (options.url != null && options.onlyIfNoRetractions) {
    throw new Error("--only-if-no-retractions requires a local canonical-checkout preview and apply");
  }
  if (options.url != null && options.adoptLiveOwnershipOnly) {
    throw new Error("--adopt-live-ownership-only requires a local selected app");
  }
  if (options.url != null && options.selectedRecordSet != null) {
    throw new Error("--record-set requires a local selected app");
  }
  // WHO COMPILES DEPENDS ON WHERE THE APP IS, and that is not a preference.
  // `convergeCanonicalCheckoutPackageSource` resolves the package compiler out
  // of an installed bundle ON THIS MACHINE, so it can only ever converge an app
  // that is here. A hosted app has its own compiler and its own checkout of the
  // same source, and its `package-set-runtime-state` owner already accepts the
  // whole job; asking it is the only honest road to a machine this one cannot
  // read the filesystem of.
  const result = options.url != null
    ? await convergeInstalledPackageSource(options)
    : await convergeCanonicalCheckoutPackageSource(options);
  writeSync(1, `${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    writeSync(2, `${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
