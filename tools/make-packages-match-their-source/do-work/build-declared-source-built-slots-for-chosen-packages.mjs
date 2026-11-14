#!/usr/bin/env node
// Build the DECLARED source-built slots for the packages you choose.
//
// A slot `build` declaration is instructions, not a scheduler. package-loader executes it while
// compiling a successor plan, but a rehearsal returns DATA and leaves no package-local artifact,
// so an app projection that requires prebuilt bytes cannot consume that clean build. This front
// door runs the same compile owner with its derived process-admission policy, selects the one
// implementation-owned un-pathed slot artifact from the returned metadata graph, and writes only
// that artifact under the slot-builder's canonical `slots/<slot-name>` path.
//
// Usage (every path absolute):
//   node build-declared-source-built-slots-for-chosen-packages.mjs \
//     --package-set-folder <folder> --package <name> [--package <name> ...] \
//     [--packages-source-root <canonical-packages-folder>] \
//     --package-loader <path> --build-policy-from-app <stable-app-name>
//     (or --build-policy-from-bundle <signed-app-open-source-bundle.json>)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installedOpenerPath } from "../../converge-installed-apps-to-their-current-handle/do-work/converge-installed-apps-to-their-current-handle.mjs";
import {
  compileOnePackageSourcePlan,
  bindObservedAuthoringAuthority,
  bindObservedAuthoringRuntime,
  deriveBuildPolicyFromInstalledApp,
  hasProcessRuntimeAliasBinding,
  packageSetIdentityFrom,
  resolvePackageSourceLayout,
} from "./make-one-package-match-its-source.mjs";

const execFileAsync = promisify(execFile);

export function authoringExecutableDiscoveryAlias(alias, platform = process.platform) {
  // macOS /bin/sh is an Apple shim whose exec-stopped mapped image is /bin/bash.
  // Bind the image actually executed so the process owner's held-vnode check stays exact.
  return platform === "darwin" && alias === "sh" ? "bash" : alias;
}

async function currentAuthoringExecutable(alias, run = execFileAsync) {
  const observedAlias = authoringExecutableDiscoveryAlias(alias);
  const command = observedAlias === "cargo" ? "rustup" : "which";
  const arguments_ = observedAlias === "cargo" ? ["which", "cargo"] : [observedAlias];
  const { stdout } = await run(command, arguments_, { encoding: "utf8" });
  const observed = String(stdout).trim();
  if (observed === "") throw new Error(`AUTHORING_RUNTIME_NOT_FOUND:${alias}`);
  const executable = await realpath(observed);
  const metadata = await stat(executable);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`AUTHORING_RUNTIME_NOT_EXECUTABLE:${alias}`);
  }
  return {
    executable,
    bytes: await readFile(executable),
    unixMode: metadata.mode & 0o777,
  };
}

function sourceBuiltSlotRuntimeRequirements(data) {
  const requirements = new Map();
  for (const thing of data.things ?? []) {
    if (thing?.type !== "slot" || thing?.build == null) continue;
    for (const step of thing.build?.sequence?.steps ?? []) {
      const process = step?.process;
      const alias = process?.argv?.[0];
      if (typeof alias !== "string" || alias.trim() === "") continue;
      const current = requirements.get(alias) ?? {
        alias,
        networkAllowed: false,
        maxRuntimeMs: 0,
      };
      current.networkAllowed ||= process.network_access === "allowed";
      current.maxRuntimeMs = Math.max(current.maxRuntimeMs, Number(process.timeout_ms) || 0);
      requirements.set(alias, current);
    }
  }
  return [...requirements.values()];
}

function argumentValues(flag) {
  const found = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === flag) found.push(process.argv[index + 1]);
  }
  return found;
}

function required(flag) {
  const values = argumentValues(flag);
  const value = values.length === 0 ? null : values[values.length - 1];
  if (value === null || String(value).trim() === "") {
    console.error(`${flag} is required`);
    process.exit(2);
  }
  return String(value).trim();
}

function decodedJson(write) {
  try {
    return JSON.parse(Buffer.from(write.payload_base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function sourceBuiltSlotNames(data) {
  return (data.things ?? [])
    .filter((thing) => thing?.type === "slot" && thing?.build)
    .map((thing) => thing.name)
    .filter((name) => typeof name === "string" && name.trim() !== "");
}

function manifestByteSourcePaths(data) {
  return new Set((data.things ?? []).flatMap((thing) => {
    const sourcePath = thing?.artifact?.source_path ?? thing?.source_path;
    return typeof sourcePath === "string" && sourcePath !== "" ? [sourcePath] : [];
  }));
}

export function legacySourceBuiltSlotArtifactName(slotName) {
  return `${slotName.replaceAll("-", "_")}.wasm`;
}

export async function reconcileLegacySourceBuiltSlotArtifact({
  packageRoot,
  slotName,
  manifestData,
  unlinkFile = unlink,
}) {
  const legacyName = legacySourceBuiltSlotArtifactName(slotName);
  const canonical = path.join(packageRoot, "slots", slotName);
  const legacy = path.join(packageRoot, "slots", legacyName);
  const legacyRelative = path.relative(packageRoot, legacy);
  if (legacyRelative.startsWith("..") || path.isAbsolute(legacyRelative)) {
    throw new Error(`SOURCE_BUILT_SLOT_PATH_OUTSIDE_PACKAGE:${slotName}`);
  }
  if (!existsSync(legacy)) return false;
  const legacySourcePath = path.posix.join("slots", legacyName);
  if (manifestByteSourcePaths(manifestData).has(legacySourcePath)) {
    throw new Error(`SOURCE_BUILT_SLOT_LEGACY_ARTIFACT_STILL_DECLARED:${legacySourcePath}`);
  }
  if (!existsSync(canonical)) {
    throw new Error(`SOURCE_BUILT_SLOT_CANONICAL_ARTIFACT_MISSING:${slotName}`);
  }
  await unlinkFile(legacy);
  return true;
}

async function writeFileWhenDifferent(destination, bytes) {
  if (existsSync(destination)) {
    const current = await readFile(destination);
    if (current.equals(bytes)) {
      const { mode } = await stat(destination);
      if ((mode & 0o777) !== 0o644) {
        const { chmod } = await import("node:fs/promises");
        await chmod(destination, 0o644);
      }
      return false;
    }
  }
  await writeFile(destination, bytes, { mode: 0o644 });
  return true;
}

/** Make source-built slot bytes exist in their source package.
 *
 *  This is deliberately a package-loader caller, not another Cargo runner: admission policy,
 *  source closure selection, path containment, and slot compilation remain owned by Runtime Kit.
 *  package-loader names each slot artifact with the semantic source address
 *  `package::<package>::slot-artifact::<slot>`, so this front door never guesses from an
 *  un-pathed metadata record. Multiple source-built slots still fail closed until this
 *  authoring loop can select and write each slot independently.
 */
export async function makeDeclaredSourceBuiltSlotsExist({
  packageSetFolder,
  packagesSourceRoot,
  packageNames,
  packageLoader,
  buildPolicyApp,
  buildPolicyBundle,
  authoringAuthority,
  opener = installedOpenerPath(),
}) {
  const setFolder = path.resolve(String(packageSetFolder ?? "").trim());
  if (setFolder === "" || !existsSync(setFolder)) {
    throw new Error(`PACKAGE_SET_FOLDER_MISSING:${packageSetFolder}`);
  }
  const names = [...new Set((packageNames ?? []).map((name) => String(name).trim()).filter(Boolean))];
  if (names.length === 0) throw new Error("NO_PACKAGE_NAMED");
  if (!existsSync(packageLoader)) throw new Error(`PACKAGE_LOADER_MISSING:${packageLoader}`);
  const hasApp = typeof buildPolicyApp === "string" && buildPolicyApp.trim() !== "";
  const hasBundle = typeof buildPolicyBundle === "string" && buildPolicyBundle.trim() !== "";
  if (hasApp === hasBundle) {
    throw new Error("BUILD_POLICY_APP_OR_BUNDLE_REQUIRED");
  }
  if (!existsSync(opener)) throw new Error(`INSTALLED_OPENER_MISSING:${opener}`);

  const { sourceRoot } = resolvePackageSourceLayout({
    packageSetFolder: setFolder,
    packagesSourceRoot,
  });
  if (!existsSync(sourceRoot)) throw new Error(`PACKAGES_SOURCE_ROOT_MISSING:${sourceRoot}`);

  // BUDAG keeps package-set DATA and reusable package source in separate canonical roots.
  // package-loader's source owner is the checkout root that directly contains `packages/`,
  // while package-set identity still comes from the selected package-set DATA folder.

  const identity = packageSetIdentityFrom(setFolder);
  const baseBuildEnvironment = await deriveBuildPolicyFromInstalledApp({
    appId: hasApp ? buildPolicyApp : null,
    sourceBundle: hasBundle ? buildPolicyBundle : null,
    opener,
  });
  let buildEnvironment = baseBuildEnvironment;
  if (authoringAuthority != null) {
    const authorityPath = await realpath(String(authoringAuthority));
    const authorityMetadata = await stat(authorityPath);
    if (!authorityMetadata.isFile() || (authorityMetadata.mode & 0o111) === 0) {
      throw new Error(`AUTHORING_AUTHORITY_NOT_EXECUTABLE:${authorityPath}`);
    }
    buildEnvironment = bindObservedAuthoringAuthority(buildEnvironment, {
      executablePath: authorityPath,
      executableBytes: await readFile(authorityPath),
      executableUnixMode: authorityMetadata.mode & 0o777,
    });
  }
  const runtimeRequirements = new Map();
  for (const packageName of names) {
    const manifestPath = path.join(sourceRoot, packageName, "things-to-store-and-run.json");
    if (!existsSync(manifestPath)) throw new Error(`NO_SUCH_PACKAGE:${packageName}`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const requirement of sourceBuiltSlotRuntimeRequirements(manifest)) {
      const current = runtimeRequirements.get(requirement.alias) ?? requirement;
      current.networkAllowed ||= requirement.networkAllowed;
      current.maxRuntimeMs = Math.max(current.maxRuntimeMs, requirement.maxRuntimeMs);
      runtimeRequirements.set(requirement.alias, current);
    }
  }
  for (const requirement of runtimeRequirements.values()) {
    if (hasProcessRuntimeAliasBinding(buildEnvironment, requirement.alias)) continue;
    const executable = await currentAuthoringExecutable(requirement.alias);
    buildEnvironment = bindObservedAuthoringRuntime(buildEnvironment, {
      alias: requirement.alias,
      executablePath: executable.executable,
      executableBytes: executable.bytes,
      executableUnixMode: executable.unixMode,
      executableSearchPath: [path.dirname(executable.executable), process.env.PATH]
        .filter(Boolean).join(path.delimiter),
      runtimeEnvironment: {
        HOME: homedir(),
        CARGO_HOME: path.join(homedir(), ".cargo"),
        RUSTUP_HOME: path.join(homedir(), ".rustup"),
      },
      networkAllowed: requirement.networkAllowed,
      maxRuntimeMs: requirement.maxRuntimeMs,
    });
  }
  const results = [];

  for (const packageName of names) {
    const packageRoot = path.join(sourceRoot, packageName);
    const manifestPath = path.join(packageRoot, "things-to-store-and-run.json");
    if (!existsSync(manifestPath)) throw new Error(`NO_SUCH_PACKAGE:${packageName}`);
    const slotNames = sourceBuiltSlotNames(JSON.parse(await readFile(manifestPath, "utf8")));
    if (slotNames.length === 0) continue;
    if (slotNames.length !== 1) {
      throw new Error(`SOURCE_BUILT_SLOT_MAPPING_UNSUPPORTED:${packageName}:${slotNames.join(",")}`);
    }

    const plan = await compileOnePackageSourcePlan({
      packageSetFolder: setFolder,
      packagesSourceRoot,
      packageName,
      packageSet: identity.package_set,
      partition: identity.partition,
      packageLoader,
      buildEnvironment,
      forceSourceBuiltSlots: true,
    });

    const slotArtifactSourceAddress = `package::${packageName}::slot-artifact::${slotNames[0]}`;
    const metadata = [];
    for (const write of plan.record_writes) {
      const payload = decodedJson(write);
      if (payload?.schema === "package_record_source_metadata") metadata.push({ write, payload });
    }
    const artifactMetadata = metadata.filter(
      ({ payload }) => payload.source_address === slotArtifactSourceAddress,
    );
    if (artifactMetadata.length !== 1) {
      throw new Error(`SOURCE_BUILT_SLOT_ARTIFACT_NOT_UNIQUE:${packageName}:${artifactMetadata.length}`);
    }
    const artifactAddress = artifactMetadata[0].payload.resolved_address_wire_hex;
    const artifactWrite = plan.record_writes.find((write) => write.address_label === artifactAddress);
    if (artifactWrite == null) throw new Error(`SOURCE_BUILT_SLOT_ARTIFACT_MISSING:${packageName}`);
    const bytes = Buffer.from(artifactWrite.payload_base64, "base64");
    if (bytes.length === 0) throw new Error(`SOURCE_BUILT_SLOT_ARTIFACT_EMPTY:${packageName}`);

    const destination = path.join(packageRoot, "slots", slotNames[0]);
    if (path.relative(packageRoot, destination).startsWith("..")) {
      throw new Error(`SOURCE_BUILT_SLOT_PATH_OUTSIDE_PACKAGE:${packageName}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const wroteBytes = await writeFileWhenDifferent(destination, bytes);
    const manifestData = JSON.parse(await readFile(manifestPath, "utf8"));
    const prunedLegacyArtifact = await reconcileLegacySourceBuiltSlotArtifact({
      packageRoot,
      slotName: slotNames[0],
      manifestData,
    });
    results.push({
      package: packageName,
      slot: slotNames[0],
      byte_length: bytes.length,
      wrote_bytes: wroteBytes,
      pruned_legacy_artifact: prunedLegacyArtifact,
    });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await makeDeclaredSourceBuiltSlotsExist({
      packageSetFolder: required("--package-set-folder"),
      packagesSourceRoot: argumentValues("--packages-source-root").at(-1) ?? null,
      packageNames: argumentValues("--package"),
      packageLoader: required("--package-loader"),
      buildPolicyApp: argumentValues("--build-policy-from-app").at(-1) ?? null,
      buildPolicyBundle: argumentValues("--build-policy-from-bundle").at(-1) ?? null,
      authoringAuthority: argumentValues("--authoring-authority").at(-1) ?? null,
    });
    for (const built of results) {
      console.log(`${built.wrote_bytes ? "WROTE" : "UNCHANGED"} ${built.package}/${built.slot} ${built.byte_length} bytes`);
    }
    console.log(`${results.length} declared source-built slots built`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
