import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { blake3 } from "@noble/hashes/blake3.js";
import { startRunningAppSession, sendRequestToRunningApp } from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";
import { buildReport, exitCodeFor } from "../../run-the-declared-checks-for-chosen-packages/do-work/run-the-declared-checks-for-chosen-packages.mjs";

const execFileAsync = promisify(execFile);

// Host bootstrap uses the same native delta owner as the installed actions.
// It is available before an older log has acquired those action definitions.
export async function convergeInstalledPackageSource({
  appId,
  url,
  packageName,
  dryRun = true,
  adoptUnversionedSourceRecords = false,
  requestHeaders,
}, {
  start = startRunningAppSession, send = sendRequestToRunningApp,
} = {}) {
  const selectedPackage = validPackageName(packageName);
  // A HOSTED APP IS A RUNNING APP. `startRunningAppSession` has always taken a
  // `url`, and only this function refused to pass one, so a hosted engine could
  // be converged only by something reaching past this owner. Worse, `appId`
  // resolves against THIS machine, so aiming at a hosted app out of habit
  // silently converges whichever local app happens to share that identity,
  // which is a wrong target that reports success. The sibling current-state
  // writer in `send-requests-to-an-engine` already carries this correction and
  // the same reasoning; this is that road, not a second one.
  const remote = typeof url === "string" && url.trim().length > 0 ? url.trim() : null;
  if (remote !== null && !/^https?:\/\//i.test(remote)) {
    throw new Error(`url must be an http or https origin, got ${remote}`);
  }
  if (remote !== null && appId != null) {
    throw new Error("name the app once, by url or by appId, never both");
  }
  const session = await start(remote === null
    ? { appId: required(appId, "appId") }
    : { url: remote, requestHeaders });
  return send(session, dryRun
    ? "package-set-runtime-state.report-package-source-delta"
    : "package-set-runtime-state.apply-package-source-convergence",
  {
    package: selectedPackage,
    ...(adoptUnversionedSourceRecords ? { adopt_unversioned_source_records: true } : {}),
  }, {timeoutMs: 120000});
}

export const PACKAGE_SET_PARTITION_DESCRIPTOR = "package-set-partition.json";
export const PACKAGE_SOURCE_DATA = "things-to-store-and-run.json";
export const PACKAGE_DELTA_SCHEMA = "bitfield.package_delta/v1";
export const PACKAGE_CURRENT_VERSION_SCHEMA = "bitfield.package_current_version/v1";
export const PACKAGE_DELTA_SOURCE_PLAN_SCHEMA = "bitfield.package_delta_source_plan/v1";
export const PACKAGE_DELTA_RECEIPT_SCHEMA = "bitfield.package_delta_receipt/v1";
export const PRODUCT_CORRECTION_EVIDENCE_SCHEMA = "bitfield.product_correction_evidence/v1";
export const PRODUCT_CORRECTION_COMPLETION_SCHEMA = "bitfield.product_correction_completion/v1";
export const PACKAGE_RECORD_SOURCE_METADATA_SCHEMA = "package_record_source_metadata";
export const PACKAGE_DELTA_TARGET = "package-set-runtime-state.apply-package-delta";
export const ENGINE_OPERATION_TARGET = "engine.operation.label-addressed";
export const METADATA_PATH = "package-record-source-metadata";
export const CURRENT_VERSION_PATH = "package-current-version";

/** BUDAG keeps app choices/DATA and reusable package source in separate owners.
 * The legacy layout remains valid when `packagesSourceRoot` is absent, while an
 * authoring checkout can point directly at its one canonical `packages/` root
 * without copying packages beneath every package set. */
export function resolvePackageSourceLayout({ packageSetFolder, packagesSourceRoot }) {
  const setFolder = resolve(required(packageSetFolder, "packageSetFolder"));
  const sourceRoot = packagesSourceRoot == null
    ? resolve(setFolder, "packages")
    : resolve(required(packagesSourceRoot, "packagesSourceRoot"));
  if (packagesSourceRoot != null && sourceRoot.split(/[\\/]/).at(-1) !== "packages") {
    throw new Error(`PACKAGES_SOURCE_ROOT_NOT_PACKAGES_FOLDER:${sourceRoot}`);
  }
  return {
    setFolder,
    sourceRoot,
    compileSetFolder: packagesSourceRoot == null ? setFolder : dirname(sourceRoot),
  };
}

export function packageSetIdentityFrom(packageSetFolder, options = {}) {
  const descriptorPath = resolve(packageSetFolder, PACKAGE_SET_PARTITION_DESCRIPTOR);
  if (!(options.existsSync ?? existsSync)(descriptorPath)) {
    throw new Error(`PACKAGE_SET_IDENTITY_DESCRIPTOR_MISSING:${descriptorPath}`);
  }
  let descriptor;
  try {
    descriptor = JSON.parse((options.readFileSync ?? readFileSync)(descriptorPath, "utf8"));
  } catch (error) {
    throw new Error(`PACKAGE_SET_IDENTITY_DESCRIPTOR_INVALID:${descriptorPath}`, { cause: error });
  }
  const packageSet = usableString(descriptor?.set_name) ?? usableString(descriptor?.package_set);
  const partition = usableString(descriptor?.partition);
  if (packageSet == null || partition == null) {
    throw new Error(`PACKAGE_SET_IDENTITY_DESCRIPTOR_INCOMPLETE:${descriptorPath}`);
  }
  return {
    descriptorPath,
    package_set: packageSet,
    partition,
  };
}

// `resolveLivePackageIdentity` stood here. It scanned a running app to discover
// WHICH PACKAGE SET currently owned a package, so a caller could scope its delta
// to whatever name the live rows happened to carry. Its own docstring said the
// authoring folder "answers only which source bytes to compile" — the set name
// was never ownership, and this function was the workaround for pretending it
// was. Nothing ever called it but its tests. The question it answered does not
// exist now: a package's identity names no app, so there is nothing to discover.


function decodedScanEntryPayload(entry) {
  if (entry?.payload != null && typeof entry.payload === "object") return entry.payload;
  if (typeof entry?.payload_base64 !== "string") return null;
  try {
    return JSON.parse(Buffer.from(entry.payload_base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function scanCurrentUnderPath({ client, partition, pathLabels }) {
  const entries = [];
  let cursor = 0;
  const seenCursors = new Set();
  for (;;) {
    if (seenCursors.has(cursor)) throw new Error(`PACKAGE_LIVE_OWNERSHIP_SCAN_STALLED:${cursor}`);
    seenCursors.add(cursor);
    const reply = await postJson(client, ENGINE_OPERATION_TARGET, {
      operation_label: "engine.operation.scan-current-under-path",
      partition_label: partition,
      path_labels: pathLabels,
      cursor,
      limit: 5000,
    });
    if (!Array.isArray(reply?.entries)) throw new Error("PACKAGE_LIVE_OWNERSHIP_SCAN_INVALID");
    entries.push(...reply.entries);
    if (reply.next_cursor == null) return entries;
    const nextCursor = Number(reply.next_cursor);
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_SCAN_CURSOR_INVALID:${reply.next_cursor}`);
    }
    cursor = nextCursor;
  }
}

function usableWireHex(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return normalized.length > 0 && normalized.length % 2 === 0 && /^[0-9a-f]+$/.test(normalized)
    ? normalized
    : null;
}

export function metadataAddressWireHexForRecord(recordWireHex) {
  const label = `package-record-source-metadata::${recordWireHex}`;
  return labelHashWireHex(label);
}

function reactiveSinkWireHex(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)
    || typeof value.sink !== "string" || value.sink.length === 0) return null;
  const kind = typeof value.sink_address_kind === "string"
    ? value.sink_address_kind
    : "hashed_name";
  if (kind === "hashed_name") return labelHashWireHex(value.sink);
  if (kind === "literal") {
    const bytes = Buffer.from(value.sink);
    return Buffer.concat([
      encodeUnsignedVarint(0x1f),
      encodeUnsignedVarint(bytes.length),
      bytes,
    ]).toString("hex");
  }
  throw new Error(`PACKAGE_LIVE_REACTIVE_SINK_KIND_INVALID:${kind}`);
}

function labelHashWireHex(label) {
  return `1f20${Buffer.from(blake3(new Uint8Array(Buffer.from(label)))).toString("hex")}`;
}

function encodeUnsignedVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("PACKAGE_VARINT_VALUE_INVALID");
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

// The build step inside the loader runs a package's declared build sequence through the process
// engine, and the engine reads its admission policy from exactly one environment variable. That
// variable is the CHILD'S declared input, and the process that spawns the child is the one that
// must provision it. Nothing else can: the agent run guard refuses a leading `NAME=value` on any
// command, so an operator cannot set it from outside either. Measured 2026-09-05: fifteen packages
// failed compile on nothing but this, every one of them declaring correctly.
//
// The value is derived, never authored. The installed opener computes it read-only from an app's
// on-disk handle (`--print-process-admission-policy`), so this asks that owner and passes the
// answer through verbatim. Absent a caller-named app, the child receives nothing and the loader's
// own fail-closed refusal stands: a security input has no default and no fallback.
export const BUILD_POLICY_ENVIRONMENT_KEY = "BITFIELD_PROCESS_ADMISSION_POLICY_JSON";

/** An installed process role may deliberately route a runtime alias through an external provider.
 * Authoring must preserve that owner binding instead of replacing it with a locally discovered
 * executable. */
export function hasProcessRuntimeAliasBinding(buildEnvironment, alias) {
  const raw = buildEnvironment?.[BUILD_POLICY_ENVIRONMENT_KEY];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_MISSING");
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID", { cause: error });
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
      || policy.runtime_aliases === null || typeof policy.runtime_aliases !== "object"
      || Array.isArray(policy.runtime_aliases)) {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID");
  }
  return Object.hasOwn(policy.runtime_aliases, required(alias, "alias"));
}

/** Select an observed native authority for an authoring build whose current loader protocol
 * is newer than the authority embedded in the installed customer app. The caller supplies an
 * executable, never policy bytes; this owner binds its exact observed identity. */
export function bindObservedAuthoringAuthority(buildEnvironment, {
  executablePath,
  executableBytes,
  executableUnixMode,
}) {
  const absolutePath = required(executablePath, "executablePath");
  if (!absolutePath.startsWith("/")) throw new Error("AUTHORING_AUTHORITY_NOT_ABSOLUTE");
  if (!Buffer.isBuffer(executableBytes) || executableBytes.length === 0) {
    throw new Error("AUTHORING_AUTHORITY_BYTES_MISSING");
  }
  if (!Number.isInteger(executableUnixMode) || (executableUnixMode & 0o111) === 0) {
    throw new Error("AUTHORING_AUTHORITY_NOT_EXECUTABLE");
  }
  const raw = buildEnvironment?.[BUILD_POLICY_ENVIRONMENT_KEY];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_MISSING");
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID", { cause: error });
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
      || policy.native_authority === null || typeof policy.native_authority !== "object") {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID");
  }
  policy.native_authority = {
    absolute_path: absolutePath,
    content_hash: hashCodeHexFromBytes(executableBytes),
    expected_unix_mode: executableUnixMode & 0o777,
  };
  return {
    ...buildEnvironment,
    [BUILD_POLICY_ENVIRONMENT_KEY]: canonicalJson(policy),
  };
}

/** Bind one locally discovered authoring tool without turning its path into package DATA.
 *
 * Package build recipes select semantic runtime aliases such as `cargo`. The customer app's
 * signed policy is still the trust base for the native process authority, but authoring must not
 * depend on that customer carrying a compiler. The authoring owner observes the exact executable,
 * binds its current bytes, and grants the one full-computer capability. Nothing in the package
 * manifest or package set chooses a host path or readable-root overlay.
 */
export function bindObservedAuthoringRuntime(buildEnvironment, {
  alias,
  executablePath,
  executableBytes,
  executableUnixMode,
  executableSearchPath,
  runtimeEnvironment = {},
  networkAllowed,
  maxRuntimeMs,
}) {
  const selectedAlias = required(alias, "alias");
  const absolutePath = required(executablePath, "executablePath");
  if (!absolutePath.startsWith("/")) throw new Error("AUTHORING_RUNTIME_NOT_ABSOLUTE");
  if (!Buffer.isBuffer(executableBytes) || executableBytes.length === 0) {
    throw new Error("AUTHORING_RUNTIME_BYTES_MISSING");
  }
  if (!Number.isInteger(executableUnixMode) || (executableUnixMode & 0o111) === 0) {
    throw new Error("AUTHORING_RUNTIME_NOT_EXECUTABLE");
  }
  if (typeof executableSearchPath !== "string" || executableSearchPath.trim() === "") {
    throw new Error("AUTHORING_RUNTIME_SEARCH_PATH_MISSING");
  }
  if (runtimeEnvironment === null || typeof runtimeEnvironment !== "object"
      || Array.isArray(runtimeEnvironment)
      || Object.entries(runtimeEnvironment).some(([key, value]) => (
        typeof key !== "string" || key.trim() === ""
        || typeof value !== "string"
      ))) {
    throw new Error("AUTHORING_RUNTIME_ENVIRONMENT_INVALID");
  }
  const raw = buildEnvironment?.[BUILD_POLICY_ENVIRONMENT_KEY];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_MISSING");
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (error) {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID", { cause: error });
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
      || policy.runtime_aliases === null || typeof policy.runtime_aliases !== "object"
      || Array.isArray(policy.runtime_aliases)) {
    throw new Error("AUTHORING_RUNTIME_BASE_POLICY_INVALID");
  }
  if (Object.hasOwn(policy.runtime_aliases, selectedAlias)) {
    return buildEnvironment;
  }
  policy.runtime_aliases[selectedAlias] = {
    computer_access: "full",
    environment: {
      PATH: {
        kind: "literal",
        value: executableSearchPath,
      },
      ...Object.fromEntries(Object.entries(runtimeEnvironment).map(([key, value]) => [key, {
        kind: "literal",
        value,
      }])),
    },
    execution: {
      kind: "host_executable",
      executable: {
        absolute_path: absolutePath,
        content_hash: hashCodeHexFromBytes(executableBytes),
        expected_unix_mode: executableUnixMode & 0o777,
      },
      readable_roots: [],
    },
    network_allowed: networkAllowed === true,
    max_runtime_ms: maxRuntimeMs,
  };
  return {
    ...buildEnvironment,
    [BUILD_POLICY_ENVIRONMENT_KEY]: canonicalJson(policy),
  };
}

export async function deriveBuildPolicyFromInstalledApp({
  appId,
  sourceBundle,
  opener,
  execFileAsync: run = execFileAsync,
  exists = existsSync,
}) {
  const policyArguments = ["--print-process-admission-policy"];
  if (sourceBundle != null) {
    const bundle = required(sourceBundle, "sourceBundle");
    if (appId != null) throw new Error("BUILD_POLICY_APP_AND_BUNDLE_CONFLICT");
    if (!exists(bundle)) throw new Error(`BUILD_POLICY_SOURCE_BUNDLE_MISSING:${bundle}`);
    policyArguments.push(
      "--process-admission-source-bundle", bundle,
      "--process-admission-candidate-host-root", resolve(dirname(bundle)),
    );
  } else {
    policyArguments.push("--same-app-id", required(appId, "appId"));
  }
  const openerPath = required(opener, "opener");
  if (!exists(openerPath)) throw new Error(`INSTALLED_OPENER_MISSING:${openerPath}`);
  const { stdout } = await run(openerPath, policyArguments, { maxBuffer: 64 * 1024 * 1024 });
  const canonical = String(stdout);
  let decoded;
  try {
    decoded = JSON.parse(canonical);
  } catch (error) {
    throw new Error("BUILD_POLICY_INVALID_JSON", { cause: error });
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("BUILD_POLICY_NOT_AN_OBJECT");
  }
  // Verbatim: the opener prints canonical bytes and the engine decodes canonical bytes. Re-serialising
  // here would put a third encoder between two that already agree.
  return { [BUILD_POLICY_ENVIRONMENT_KEY]: canonical };
}

export async function compileOnePackageSourcePlan({
  packageSetFolder,
  packagesSourceRoot,
  packageName,
  selectedRecordSet,
  packageSet,
  sourcePackageSet = packageSet,
  partition,
  packageLoader,
  // Extra environment the loader child needs and this process does not have. `{}` means the
  // child inherits exactly what this process has, which is the historical behaviour.
  buildEnvironment = {},
  // Authoring repair mode: rebuild source-declared slots even when canonical
  // materialized outputs already exist. Runtime/package compilation never sets it.
  forceSourceBuiltSlots = false,
  execFileAsync: run = execFileAsync,
  exists = existsSync,
  readFile = readFileSync,
}) {
  const loader = required(packageLoader, "packageLoader");
  if (!exists(loader)) throw new Error(`PACKAGE_LOADER_MISSING:${loader}`);
  const set = required(packageSet, "packageSet");
  const selectedPartition = required(partition, "partition");
  const selectedPackage = validPackageName(packageName);
  const recordSet = selectedRecordSet == null ? null : validRecordSetName(selectedRecordSet);
  if (recordSet != null && selectedPackage !== "package-set-records") {
    throw new Error("PACKAGE_RECORD_SET_SCOPE_REQUIRES_PACKAGE_SET_RECORDS");
  }
  const sourceLayout = resolvePackageSourceLayout({ packageSetFolder, packagesSourceRoot });
  // A caller-selected executable owns its runtime through its bytes, not its suffix. A
  // compatibility shim can retain a historical `.mjs` path while using a non-Node shebang;
  // suffix-only dispatch made Node parse that executable as JavaScript before it could delegate.
  let loaderPrefix = "";
  try {
    loaderPrefix = String(readFile(loader, "utf8")).slice(0, 256);
  } catch {
    // An opaque native executable need not be UTF-8-readable. Unknown bytes stay on the direct
    // executable path; only positively identified JavaScript is handed to Node.
  }
  const isJsLoader = /^#!.*\bnode\b/m.test(loaderPrefix)
    || /^\s*(?:import\s|export\s|\/\/|\/\*)/.test(loaderPrefix);
  const compilation = run(isJsLoader ? process.execPath : loader, [
    ...(isJsLoader ? [loader] : []),
    "compile-package-delta-source",
    ...(packagesSourceRoot == null
      ? [
          "--source-root", sourceLayout.compileSetFolder,
          ...(sourcePackageSet === packageSet ? [] : ["--source-package-set", required(sourcePackageSet, "sourcePackageSet")]),
        ]
      : [
          "--package-set-source-root", sourceLayout.setFolder,
          "--packages-source-root", sourceLayout.sourceRoot,
        ]),
    "--partition", selectedPartition,
    "--package", selectedPackage,
    "--package-set", set,
    ...(forceSourceBuiltSlots ? ["--force-source-built-slots"] : []),
  ], { maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, ...buildEnvironment } });
  // Compiler progress belongs on stderr; keep stdout exclusively the source
  // plan. Waiting for execFile to finish hid archive/build diagnostics for the
  // entire build, making an oversized source capture look like a deadlock.
  compilation.child?.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const { stdout } = await compilation;
  let plan;
  try {
    plan = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error("PACKAGE_LOADER_REPLY_INVALID_JSON", { cause: error });
  }
  if (plan?.schema !== PACKAGE_DELTA_SOURCE_PLAN_SCHEMA) {
    throw new Error("PACKAGE_LOADER_REPLY_SCHEMA_INVALID");
  }
  if (plan.package_set !== set || plan.partition !== selectedPartition || plan.package_name !== selectedPackage) {
    throw new Error("PACKAGE_LOADER_REPLY_SCOPE_MISMATCH");
  }
  if (recordSet != null) {
    // Compile through the selected app's own (possibly older) loader, then
    // scope its already-validated full plan by canonical ownership metadata.
    // That loader need not know a newer --record-set CLI option.
    const addresses = new Set();
    for (const write of allPreparedWrites(plan)) {
      if (write.path_labels?.length !== 1 || write.path_labels[0] !== METADATA_PATH) continue;
      const metadata = decodeJsonBytes(Buffer.from(write.payload_base64, "base64"), "PACKAGE_SOURCE_METADATA_INVALID");
      if (!packageSetMetadataNamesRecordSet(metadata, recordSet)) continue;
      addresses.add(write.address_label);
      addresses.add(metadata.resolved_address_wire_hex);
    }
    if (addresses.size === 0) throw new Error(`PACKAGE_RECORD_SET_NOT_FOUND:${recordSet}`);
    plan = {
      ...plan,
      record_writes: plan.record_writes.filter((write) => addresses.has(write.address_label)),
      stored_byte_writes: plan.stored_byte_writes.filter((write) => addresses.has(write.address_label)),
      entry_writes: plan.entry_writes.filter((write) => addresses.has(write.address_label)),
      preserved_record_addresses: [],
    };
  }
  if (allPreparedWrites(plan).length === 0) throw new Error("PACKAGE_SOURCE_PLAN_EMPTY");
  return plan;
}

/** WHERE A PACKAGE'S CURRENT VERSION LIVES, WITH NO APP IN IT.
 *
 * This led with the package-set name until the day a set was renamed and every
 * package under the old name moved to an address nothing would ever ask for
 * again. A reusable package does not carry its installer's name; the partition
 * already says which log, and it is the only one of the two the engine can
 * verify against its own identity. Matches `package_current_version_address` in
 * the runner and in package-loader. */
export function packageCurrentVersionAddressLabel(partition, packageName) {
  return `package-current-version::${required(partition, "partition")}::${required(packageName, "packageName")}`;
}

function legacyPackageCurrentVersionAddressLabel(packageSet, partition, packageName) {
  return `package-current-version::${required(packageSet, "packageSet")}::${required(partition, "partition")}::${required(packageName, "packageName")}`;
}

export const LIVE_INVENTORY_READ_CONCURRENCY = 16;
export const LIVE_INVENTORY_FULL_READ_CONCURRENCY = 8;

export async function inventoryLivePackage({
  client,
  packageSet,
  partition,
  packageName,
  preparedPlan,
  adoptUnversionedSourceRecords = false,
  adoptLiveOwnershipOnly = false,
}) {
  requireTargetClient(client);
  let versionLabel = packageCurrentVersionAddressLabel(partition, packageName);
  let version = await readCurrent(client, {
    partition_label: partition,
    address_label: versionLabel,
    address_mode: "label-hash",
  });
  const canonicalVersionMultihash = currentPayloadHashCodeHex(version);
  let versionMultihash = canonicalVersionMultihash;
  if (versionMultihash == null) {
    const legacyVersionLabel = legacyPackageCurrentVersionAddressLabel(
      packageSet,
      partition,
      packageName,
    );
    const legacyVersion = await readCurrent(client, {
      partition_label: partition,
      address_label: legacyVersionLabel,
      address_mode: "label-hash",
    });
    const legacyVersionMultihash = currentPayloadHashCodeHex(legacyVersion);
    if (legacyVersionMultihash != null) {
      versionLabel = legacyVersionLabel;
      version = legacyVersion;
      versionMultihash = legacyVersionMultihash;
    }
  }
  const currentVersionRecord = versionMultihash == null
    ? null
    : decodeJsonPayload(version, "PACKAGE_CURRENT_VERSION_PAYLOAD_INVALID");
  if (currentVersionRecord != null && (
    currentVersionRecord.schema !== PACKAGE_CURRENT_VERSION_SCHEMA
    || currentVersionRecord.partition !== partition
    || currentVersionRecord.package_ref !== packageName
  )) {
    throw new Error("PACKAGE_CURRENT_VERSION_SCOPE_INVALID");
  }

  // A current-version row is the atomic result of the latest accepted delta, but it is
  // not allowed to erase older live ownership facts merely by omitting them. Older
  // publishers could strand a valid metadata twin outside that row; if inventory reads
  // only the pointer, the orphan becomes invisible forever and blocks the package that
  // now rightfully owns the address. Reconcile the pointer with the canonical live
  // metadata namespace. The metadata twin still has to name this exact set/package,
  // carry implementation authority, and live at the one address derived from its record.
  const [liveOwnershipEntries, liveReactiveEdgeEntries] = await Promise.all([
    scanCurrentUnderPath({ client, partition, pathLabels: [METADATA_PATH] }),
    scanCurrentUnderPath({ client, partition, pathLabels: ["edge-config"] }),
  ]);
  const liveReactiveSinkWireHexes = liveReactiveEdgeEntries
    .map((entry) => reactiveSinkWireHex(decodedScanEntryPayload(entry)))
    .filter((address) => address != null)
    .sort(compareUnicodeCodeUnits);
  const ownedRecords = new Map();
  for (const record of currentVersionRecord?.records ?? []) {
    ownedRecords.set(record.record_address_wire_hex, record);
  }
  for (const entry of liveOwnershipEntries) {
    const metadata = decodedScanEntryPayload(entry);
    if (metadata?.schema !== PACKAGE_RECORD_SOURCE_METADATA_SCHEMA
      || metadata.source_package !== packageName
      || metadata.authority_class_address !== "authority-class::impl") continue;
    // Legacy signed-package admission also wrote ownership notes *about* the
    // package's metadata rows. They have no source path and are not package
    // implementation rows. Treating them as current source ownership makes a
    // normal update try to retire metadata through a nonexistent third twin.
    if (metadata.path?.length === 0
      && String(metadata.source_address ?? "").startsWith("legacy-signed-package-use::")) continue;
    const recordAddress = usableWireHex(metadata.resolved_address_wire_hex);
    const metadataAddress = usableWireHex(entry?.address);
    if (recordAddress == null || metadataAddress == null
      || metadataAddress !== metadataAddressWireHexForRecord(recordAddress)) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_METADATA_ADDRESS_INVALID:${entry?.address ?? "missing"}`);
    }
    const pathLabels = Array.isArray(metadata.path)
      && metadata.path.every((label) => typeof label === "string")
      ? metadata.path
      : null;
    if (pathLabels == null) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_PATH_INVALID:${recordAddress}`);
    }
    const existing = ownedRecords.get(recordAddress);
    const discovered = {
      record_address_wire_hex: recordAddress,
      metadata_address_wire_hex: metadataAddress,
      path_labels: pathLabels,
    };
    if (existing != null
      && existing.metadata_address_wire_hex.toLowerCase() !== metadataAddress) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_CONFLICT:${recordAddress}`);
    }
    // The metadata twin is the current ownership fact and carries the current
    // source path. A historical version pointer may retain older path labels;
    // that is not a second owner and must not make its own retirement impossible.
    ownedRecords.set(recordAddress, discovered);
  }

  const descriptors = new Map();
  for (const write of allPreparedWrites(preparedPlan)) {
    descriptors.set(write.address_label, write.path_labels ?? []);
  }
  for (const record of ownedRecords.values()) {
    descriptors.set(record.record_address_wire_hex, record.path_labels);
    descriptors.set(record.metadata_address_wire_hex, [METADATA_PATH]);
  }

  const currentByWireHex = new Map();
  const desiredAddresses = new Set(allPreparedWrites(preparedPlan)
    .map((write) => String(write.address_label).toLowerCase()));
  // The path scan already returned the exact payload identity and parsed JSON for
  // desired metadata rows. Re-reading all of those rows doubles hosted traffic for
  // no new fact. Keep stale metadata out of this shortcut because a retraction proof
  // needs its exact original bytes; those few rows are read normally below.
  for (const entry of liveOwnershipEntries) {
    const address = usableWireHex(entry?.address);
    const payload = decodedScanEntryPayload(entry);
    if (address == null || payload == null || !desiredAddresses.has(address)
      || typeof entry?.content_hash !== "string") continue;
    currentByWireHex.set(address, {
      payload_multihash: entry.content_hash,
      payload_base64: null,
      payload_object: payload,
      path_labels: [METADATA_PATH],
    });
  }
  const addresses = [...descriptors.keys()]
    .filter((address) => !currentByWireHex.has(address))
    .sort(compareUnicodeCodeUnits);
  // Inventory compares identities, so ask the engine for identities only. Full payload fan-out
  // exhausted a 4 GB hosted runner; metadata-only replies stay bounded even for multi-MB rows.
  const readConcurrency = LIVE_INVENTORY_READ_CONCURRENCY;
  for (let offset = 0; offset < addresses.length; offset += readConcurrency) {
    const batch = addresses.slice(offset, offset + readConcurrency);
    const rows = await Promise.all(batch.map(async (address) => {
      const current = await readCurrentWithRetry(client, {
        partition_label: partition,
        address_label: address,
        address_mode: "multihash-hex",
        metadata_only: true,
      });
      return [address, {
        payload_multihash: currentPayloadHashCodeHex(current),
        payload_base64: typeof current?.payload_base64 === "string" ? current.payload_base64 : null,
        payload_object: current?.payload != null && typeof current.payload === "object"
          ? current.payload
          : null,
        path_labels: descriptors.get(address),
      }];
    }));
    for (const [address, current] of rows) currentByWireHex.set(address, current);
  }

  // A stale ownership proof must carry the metadata bytes that are being retired.
  // Fetch only those exact, small metadata rows in full; all record bodies and all
  // still-desired metadata remain hash-only. The bounded window contains only ownership
  // JSON, never the multi-MB package DATA that caused the earlier memory spike.
  const staleMetadataAddresses = [...ownedRecords.values()]
    .filter((record) => adoptLiveOwnershipOnly || !desiredAddresses.has(record.record_address_wire_hex))
    .map((record) => record.metadata_address_wire_hex)
    .filter((address) => currentByWireHex.get(address)?.payload_multihash != null);
  for (let offset = 0; offset < staleMetadataAddresses.length;
    offset += LIVE_INVENTORY_FULL_READ_CONCURRENCY) {
    const batch = staleMetadataAddresses.slice(offset, offset + LIVE_INVENTORY_FULL_READ_CONCURRENCY);
    const rows = await Promise.all(batch.map(async (address) => {
      const current = await readCurrentWithRetry(client, {
        partition_label: partition,
        address_label: address,
        address_mode: "multihash-hex",
      });
      return [address, {
        payload_multihash: currentPayloadHashCodeHex(current),
        payload_base64: current?.found ? required(current.payload_base64, "current payload_base64") : null,
        payload_object: current?.payload != null && typeof current.payload === "object"
          ? current.payload
          : null,
        path_labels: descriptors.get(address),
      }];
    }));
    for (const [address, current] of rows) currentByWireHex.set(address, current);
  }

  if (currentVersionRecord == null) {
    const liveCandidate = [...currentByWireHex].find(([, current]) => current.payload_multihash != null);
    if (liveCandidate != null && !adoptUnversionedSourceRecords) {
      throw new Error(`PACKAGE_CURRENT_VERSION_MISSING_LIVE_ROW_PRESENT:${liveCandidate[0]}`);
    }
  }

  return {
    currentByWireHex,
    // The legacy pointer can enumerate older ownership, but the delta owner
    // compares the canonical two-part address. Never use a legacy pointer as
    // that address's expected-current basis.
    currentVersion: { payload_multihash: canonicalVersionMultihash },
    currentVersionAddressLabel: versionLabel,
    currentVersionRecord,
    ownedRecords: [...ownedRecords.values()].sort((left, right) =>
      compareUnicodeCodeUnits(left.record_address_wire_hex, right.record_address_wire_hex)),
    liveReactiveSinkWireHexes: [...new Set(liveReactiveSinkWireHexes)],
    adoptingUnversionedSourceRecords:
      currentVersionRecord == null
      && [...currentByWireHex.values()].some((current) => current.payload_multihash != null),
  };
}

/** Establish only the current live package ownership, leaving every record byte untouched.
 * This is an explicit recovery route for a markerless package whose retained
 * signed-source predecessor no longer matches the live log. The native delta
 * owner validates each canonical metadata/record pair and atomically creates
 * the version; a later, separately previewed source delta handles updates.
 */
export function buildLiveOwnershipAdoptionRequest({ packageName, partition, liveInventory }) {
  const selectedPackage = validPackageName(packageName);
  const selectedPartition = required(partition, "partition");
  // A legacy-addressed version may exist; the native delta owner keys the
  // current version at the canonical address, so migrating that old pointer is
  // still an absent-version adoption with live pairs checked anew.
  if (liveInventory.currentVersion?.payload_multihash != null) {
    throw new Error("PACKAGE_LIVE_OWNERSHIP_ADOPTION_REQUIRES_ABSENT_VERSION");
  }
  const reactive = new Set(liveInventory.liveReactiveSinkWireHexes ?? []);
  const proofs = [];
  for (const row of liveInventory.ownedRecords ?? []) {
    if (reactive.has(row.record_address_wire_hex)) continue;
    const record = requiredLiveInventoryRow(liveInventory, row.record_address_wire_hex);
    const metadata = requiredLiveInventoryRow(liveInventory, row.metadata_address_wire_hex);
    if (record.payload_multihash == null || metadata.payload_multihash == null
      || typeof metadata.payload_base64 !== "string") {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_ADOPTION_PAIR_MISSING:${row.record_address_wire_hex}`);
    }
    const proof = ownershipProofFromMetadataBytes({
      metadataAddressWireHex: row.metadata_address_wire_hex,
      metadataPayloadBase64: metadata.payload_base64,
      packageName: selectedPackage,
    });
    if (proof.record_address_wire_hex !== row.record_address_wire_hex) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_ADOPTION_PAIR_MISMATCH:${row.record_address_wire_hex}`);
    }
    proofs.push(proof);
  }
  if (proofs.length === 0) throw new Error("PACKAGE_LIVE_OWNERSHIP_ADOPTION_EMPTY");
  proofs.sort((left, right) => compareUnicodeCodeUnits(left.id, right.id));
  rejectDuplicates(proofs, (proof) => proof.id, "PACKAGE_LIVE_OWNERSHIP_ADOPTION_DUPLICATE");
  const request = {
    schema: PACKAGE_DELTA_SCHEMA,
    partition: selectedPartition,
    package_ref: selectedPackage,
    proposal_multihash: "",
    expected_current_version: expectedVersion(null),
    operations: [],
    ownership_proofs: proofs,
  };
  request.proposal_multihash = proposalMultihash(request);
  return request;
}

export function buildPackageDeltaRequest({
  packageSet,
  partition,
  packageName,
  preparedPlan,
  liveInventory,
  reactiveSinkWireHexes = [],
  retainedLiveDataPaths = [],
  selectedRecordSet = null,
}) {
  const set = required(packageSet, "packageSet");
  const selectedPartition = required(partition, "partition");
  const selectedPackage = validPackageName(packageName);
  const recordSet = selectedRecordSet == null ? null : validRecordSetName(selectedRecordSet);
  if (recordSet != null && selectedPackage !== "package-set-records") {
    throw new Error("PACKAGE_RECORD_SET_SCOPE_REQUIRES_PACKAGE_SET_RECORDS");
  }
  validateSourcePlan(preparedPlan, set, selectedPartition, selectedPackage);
  const reactiveSinks = new Set(reactiveSinkWireHexes.map(required));
  const reactiveSinkDrops = new Set(reactiveSinks);
  const writes = allPreparedWrites(preparedPlan)
    .map(normalizePreparedWrite)
    .filter((write) => !reactiveSinkDrops.has(write.address_wire_hex));
  const desiredByWireHex = uniqueWritesByWireHex(writes);
  for (const write of writes) {
    if (write.path_labels.length === 1 && write.path_labels[0] === METADATA_PATH) {
      const metadata = decodeJsonBytes(Buffer.from(write.payload_base64, "base64"), "PACKAGE_SOURCE_METADATA_INVALID");
      if (metadata.resolved_address_wire_hex != null && reactiveSinks.has(metadata.resolved_address_wire_hex)) {
        reactiveSinkDrops.add(write.address_wire_hex);
        desiredByWireHex.delete(write.address_wire_hex);
      }
    }
  }

  const desiredProofs = [];
  for (const write of desiredByWireHex.values()) {
    if (write.path_labels.length !== 1 || write.path_labels[0] !== METADATA_PATH) continue;
    desiredProofs.push(ownershipProofFromWrite(write, selectedPackage));
  }
  assertClosedDesiredOwnership(desiredByWireHex, desiredProofs);
  refuseAddressesHeldByAnotherPackage({ desiredProofs, liveInventory, packageName: selectedPackage });

  const proofByRecord = new Map(desiredProofs.map((proof) => [proof.record_address_wire_hex, proof]));
  const proofByMetadata = new Map(desiredProofs.map((proof) => [proof.metadata_address_wire_hex, proof]));
  const staleProofs = [];
  const retainedProofs = [];
  const staleOperationsByAddress = new Map();
  for (const record of liveInventory.ownedRecords
    ?? liveInventory.currentVersionRecord?.records
    ?? []) {
    // The version record contains every owned row, including the ownership-
    // metadata rows themselves. `proofByRecord` only indexes the primary row
    // named by each proof, so using it as the desired-set test misclassified a
    // still-desired metadata row as stale. The resulting proposal tried to
    // update and tombstone the same address and failed with
    // PACKAGE_DELTA_OPERATION_DUPLICATE. The compiled desired-address map is
    // the direct authority for whether any row survives, regardless of its
    // role, so test that map instead of one projection of its proofs.
    if (desiredByWireHex.has(record.record_address_wire_hex) || reactiveSinks.has(record.record_address_wire_hex)) continue;
    const liveRecord = requiredLiveInventoryRow(liveInventory, record.record_address_wire_hex);
    const liveMetadata = requiredLiveInventoryRow(liveInventory, record.metadata_address_wire_hex);
    if (liveRecord.payload_multihash == null && liveMetadata.payload_multihash == null) continue;
    if (liveRecord.payload_multihash == null || liveMetadata.payload_multihash == null) {
      throw new Error(`PACKAGE_LIVE_OWNERSHIP_INCOMPLETE:${record.record_address_wire_hex}`);
    }
    // A row the person created is not this package's to retract. The loader
    // already decided this in authority_class.rs, used at lib.rs:606, where a
    // user-data row for this package and set is PRESERVED rather than owned.
    // This half never got that rule, so it reached the impl-only check below
    // and threw, aborting convergence of the whole package. Any package whose
    // people save their own rows alongside its implementation hits this, and
    // the symptom is that the package silently stops converging entirely.
    if (isPreservedUserDataRow(liveMetadata.payload_base64, selectedPackage)) continue;
    const proof = ownershipProofFromMetadataBytes({
      metadataAddressWireHex: record.metadata_address_wire_hex,
      metadataPayloadBase64: required(liveMetadata.payload_base64, "metadata payload"),
      packageSet: set,
      packageName: selectedPackage,
    });
    if (proof.record_address_wire_hex !== record.record_address_wire_hex) {
      throw new Error(`PACKAGE_LIVE_VERSION_METADATA_MISMATCH:${record.record_address_wire_hex}`);
    }
    // A package can declare legacy live DATA paths that must survive a source
    // update. Retain the exact current ownership proof in the next version;
    // never reconstruct, overwrite, or silently orphan the person's bytes.
    const liveSourceMetadata = decodeJsonBytes(
      Buffer.from(liveMetadata.payload_base64, "base64"),
      `PACKAGE_LIVE_METADATA_INVALID:${record.metadata_address_wire_hex}`,
    );
    if (recordSet != null && !packageSetMetadataNamesRecordSet(liveSourceMetadata, recordSet)) {
      retainedProofs.push(proof);
      continue;
    }
    if (retainedLiveDataPaths.some((path) => canonicalJson(path) === canonicalJson(liveSourceMetadata.path))) {
      retainedProofs.push(proof);
      continue;
    }
    staleProofs.push(proof);
    for (const operation of [
      tombstoneOperation(
        record.record_address_wire_hex,
        record.path_labels,
        liveRecord,
        proof.id,
      ),
      tombstoneOperation(
        record.metadata_address_wire_hex,
        [METADATA_PATH],
        liveMetadata,
        proof.id,
      ),
    ]) {
      const existing = staleOperationsByAddress.get(operation.address_wire_hex);
      if (existing == null) {
        staleOperationsByAddress.set(operation.address_wire_hex, operation);
        continue;
      }
      // Ownership rows can themselves be versioned records. When a whole old
      // ownership chain disappears, its middle address is both the metadata
      // twin of one record and the primary row of the next. That is one live
      // address and therefore one retraction. Each candidate carries a valid
      // proof+path pair for that address; retain the first pair intact rather
      // than mixing one candidate's proof with the other's path.
      if (
        canonicalJson(existing.basis) !== canonicalJson(operation.basis)
        || canonicalJson(existing.successor) !== canonicalJson(operation.successor)
      ) {
        throw new Error(`PACKAGE_STALE_OPERATION_CONFLICT:${operation.address_wire_hex}`);
      }
    }
  }

  const operations = [];
  let unchangedCount = 0;
  for (const write of desiredByWireHex.values()) {
    const proof = proofByRecord.get(write.address_wire_hex) ?? proofByMetadata.get(write.address_wire_hex);
    if (proof == null) throw new Error(`PACKAGE_OWNERSHIP_PROOF_MISSING:${write.address_wire_hex}`);
    const current = liveInventory.currentByWireHex.get(write.address_wire_hex) ?? null;
    const successorMultihash = hashCodeHexFromBytes(Buffer.from(write.payload_base64, "base64"));
    if (current?.payload_multihash === successorMultihash
      && (current.path_labels == null || canonicalJson(current.path_labels) === canonicalJson(write.path_labels))) {
      // A source-closed adoption enters the native delta owner with ownership proofs and no row
      // writes. The engine verifies every proof against its live record/metadata pair, then writes
      // only package-current-version. Re-sending identical rows is the old adoption shape and the
      // current engine correctly rejects it as a stale-basis mutation.
      unchangedCount += 1;
      continue;
    }
    operations.push({
      address_wire_hex: write.address_wire_hex,
      path_labels: write.path_labels,
      basis: expectedVersion(current?.payload_multihash ?? null),
      successor: {
        state: "present",
        payload_base64: write.payload_base64,
        payload_multihash: successorMultihash,
      },
      ownership_proof_ref: proof.id,
    });
  }
  operations.push(...staleOperationsByAddress.values());
  operations.sort((left, right) => compareUnicodeCodeUnits(left.address_wire_hex, right.address_wire_hex));
  rejectDuplicates(operations, (operation) => operation.address_wire_hex, "PACKAGE_DELTA_OPERATION_DUPLICATE");

  const ownershipProofs = [...desiredProofs, ...retainedProofs, ...staleProofs]
    .sort((left, right) => compareUnicodeCodeUnits(left.id, right.id));
  rejectDuplicates(ownershipProofs, (proof) => proof.id, "PACKAGE_DELTA_OWNERSHIP_PROOF_DUPLICATE");
  const request = {
    schema: PACKAGE_DELTA_SCHEMA,
    partition: selectedPartition,
    package_ref: selectedPackage,
    proposal_multihash: "",
    expected_current_version: expectedVersion(liveInventory.currentVersion?.payload_multihash ?? null),
    operations,
    ownership_proofs: ownershipProofs,
  };
  request.proposal_multihash = proposalMultihash(request);
  return Object.assign(request, {
    [Symbol.for("bitfield.package_delta.plan_stats")]: Object.freeze({
      create_count: operations.filter((operation) => operation.basis.state === "absent" && operation.successor.state === "present").length,
      update_count: operations.filter((operation) => operation.basis.state === "present" && operation.successor.state === "present").length,
      retract_count: operations.filter((operation) => operation.successor.state === "tombstone").length,
      unchanged_count: unchangedCount,
      retained_live_data_count: retainedProofs.length,
    }),
  });
}

function packageSetMetadataNamesRecordSet(metadata, recordSet) {
  const source = String(metadata?.source_address ?? "");
  return source === `package-set-records::${recordSet}`
    || source.startsWith(`package-set-record::${recordSet}::`);
}

/** Which live addresses a request would REMOVE.
 *
 *  One place computes this so the refusal and the rehearsal can never disagree about what is
 *  about to die. Two copies of that answer would drift, and the first anyone would learn of
 *  the drift is a record that went missing from a customer's app. */
// WHO HOLDS THE ADDRESSES THIS SOURCE WANTS. The engine refuses a proposal whose live metadata
// twin names a different source_package, and its receipt carries counts and hashes and no
// address, so the reader is left guessing which package to retire. The inventory already read
// every desired metadata row before this point; reading the claim inside it costs nothing and
// turns a bare mismatch into a list of holders. Found 2026-09-05 when six type-registry
// addresses moved into one package and both engines refused it without saying who still held them.
export const HELD_BY_ANOTHER_PACKAGE = "PACKAGE_DELTA_ADDRESSES_HELD_BY_ANOTHER_PACKAGE";

/** Which desired addresses a DIFFERENT PACKAGE already holds.
 *
 * This used to ask which package SET held them too, and that question refused
 * an app's own packages the day its set was renamed: the live twins named the
 * old name, the caller carried the new one, and every record looked foreign.
 * The rename-transition branch that sat here existed only to soften that, and
 * it could not fire when the version record was itself under the old name. Both
 * are gone with the field. A package is held by a package, never by an app. */
export function addressesHeldByAnotherPackage({ desiredProofs, liveInventory, packageName }) {
  const held = [];
  for (const proof of desiredProofs) {
    const live = liveInventory.currentByWireHex.get(proof.metadata_address_wire_hex);
    if (live?.payload_base64 == null && live?.payload_object == null) continue;
    let metadata;
    try {
      metadata = live.payload_object
        ?? decodeJsonBytes(Buffer.from(live.payload_base64, "base64"), "PACKAGE_LIVE_METADATA_INVALID");
    } catch {
      continue; // an undecodable live row is the engine's refusal to make, and it will
    }
    if (metadata?.schema !== PACKAGE_RECORD_SOURCE_METADATA_SCHEMA) continue;
    if (metadata.source_package === packageName) continue;
    const currentVersion = liveInventory.currentVersionRecord;
    const currentVersionOwnsThisPair = currentVersion?.schema === PACKAGE_CURRENT_VERSION_SCHEMA
      && currentVersion.package_ref === packageName
      && metadata.source_package === packageName
      && metadata.authority_class_address === "authority-class::impl"
      && currentVersion.records?.some((record) =>
        record.record_address_wire_hex === proof.record_address_wire_hex
        && record.metadata_address_wire_hex === proof.metadata_address_wire_hex);
    if (currentVersionOwnsThisPair) continue;
    held.push({
      package: String(metadata.source_package ?? ""),
      record_address_wire_hex: proof.record_address_wire_hex,
      metadata_address_wire_hex: proof.metadata_address_wire_hex,
      path_labels: liveInventory.currentByWireHex.get(proof.record_address_wire_hex)?.path_labels ?? [],
    });
  }
  return held;
}

function refuseAddressesHeldByAnotherPackage(input) {
  const held = addressesHeldByAnotherPackage(input);
  if (held.length === 0) return;
  const error = new Error(
    `${HELD_BY_ANOTHER_PACKAGE}:${held.length}:${input.packageName}:`
    + held.map((row) => (
      `${row.package}=${row.record_address_wire_hex}@${row.metadata_address_wire_hex}`
    )).join(",")
    + " (retire or re-point the named holder first; the engine will refuse this proposal as an ownership mismatch)",
  );
  error.held_by_another_package = held;
  throw error;
}

export function tombstonedAddresses(request) {
  return request.operations
    .filter((operation) => operation.successor.state === "tombstone")
    .map((operation) => operation.address_wire_hex);
}

export function packageDeltaPlanStats(request) {
  return request[Symbol.for("bitfield.package_delta.plan_stats")] ?? {
    create_count: request.operations.filter((operation) => operation.basis.state === "absent" && operation.successor.state === "present").length,
    update_count: request.operations.filter((operation) => operation.basis.state === "present" && operation.successor.state === "present").length,
    retract_count: request.operations.filter((operation) => operation.successor.state === "tombstone").length,
    unchanged_count: 0,
  };
}

export async function prepareOnePackageDelta({
  packageSetFolder,
  packagesSourceRoot,
  sourcePackageSet,
  packageName,
  selectedRecordSet,
  packageLoader,
  buildEnvironment = {},
  forceSourceBuiltSlots = false,
  onlyIfNoRetractions = false,
  onProgress = () => {},
  client,
  execFileAsync: run = execFileAsync,
  exists = existsSync,
  // The source folder's descriptor answers "what set is this source FOR", which is not the
  // same question as "what set am I updating INTO". They coincide whenever a set is updated
  // from its own checkout, which is why one value served both for so long, and they diverge
  // the moment a package authored in one set is sent to another, which is what publishing to
  // the store IS. Overriding is therefore not a special case; deriving is the default.
  identity = packageSetIdentityFrom(packageSetFolder, { existsSync: exists }),
  // Old whole-set installers could write source rows before the package-current-version owner
  // existed. Adopting those rows is explicit and source-closed: inventory still reads only the
  // addresses compiled from this source, ownership proofs still have to close, and no row outside
  // that set is discovered or removed. The default remains the same fail-closed refusal.
  adoptUnversionedSourceRecords = false,
  adoptLiveOwnershipOnly = false,
}) {
  onProgress('compile source');
  const preparedPlan = await compileOnePackageSourcePlan({
    packageSetFolder,
    packagesSourceRoot,
    packageName,
    selectedRecordSet,
    packageSet: identity.package_set,
    sourcePackageSet,
    partition: identity.partition,
    packageLoader,
    buildEnvironment,
    forceSourceBuiltSlots,
    execFileAsync: run,
    exists,
  });
  const reactiveSinkWireHexes = reactiveSinkWireHexesFromSelectedSource({
    packageSetFolder,
    packagesSourceRoot,
    packageName,
    preparedPlan,
  });
  onProgress('read current package');
  const liveInventory = await inventoryLivePackage({
    client,
    packageSet: identity.package_set,
    partition: identity.partition,
    packageName,
    preparedPlan,
    adoptUnversionedSourceRecords: adoptUnversionedSourceRecords || adoptLiveOwnershipOnly,
    adoptLiveOwnershipOnly,
  });
  onProgress('build package update');
  const request = adoptLiveOwnershipOnly
    ? buildLiveOwnershipAdoptionRequest({
      packageName, partition: identity.partition, liveInventory,
    })
    : buildPackageDeltaRequest({
    packageSet: identity.package_set,
    partition: identity.partition,
    packageName,
    preparedPlan,
    liveInventory,
    selectedRecordSet,
    reactiveSinkWireHexes: [...new Set([
      ...reactiveSinkWireHexes,
      ...(liveInventory.liveReactiveSinkWireHexes ?? []),
    ])],
    retainedLiveDataPaths: retainedLiveDataPathsFromSelectedSource({
      packageSetFolder, packagesSourceRoot, packageName,
    }),
    });
  const stats = packageDeltaPlanStats(request);
  if (onlyIfNoRetractions && stats.retract_count !== 0) {
    throw new Error(`PACKAGE_DELTA_RETRACTIONS_REFUSED:${packageName}:${stats.retract_count}`);
  }
  return { request, stats, liveInventory, identity };
}

export async function makeOnePackageMatchItsSource(options) {
  const { packageSetFolder, packagesSourceRoot, packageName, client, dryRun = false } = options;
  const { request, stats, liveInventory, identity } = await prepareOnePackageDelta(options);
  if (dryRun) {
    return {
      outcome: options.adoptLiveOwnershipOnly
        ? "live-ownership-adoption-preview" : "canonical-source-delta-preview",
      package_set: identity.package_set,
      partition: identity.partition,
      package_ref: packageName,
      proposal_multihash: request.proposal_multihash,
      stats,
      ...(options.adoptLiveOwnershipOnly
        ? { live_owned_pair_count: request.ownership_proofs.length }
        : {}),
      differences: request.operations.map((operation) => ({
        address_wire_hex: operation.address_wire_hex,
        path_labels: operation.path_labels,
        action: operation.successor.state === "tombstone" ? "retract"
          : operation.basis.state === "absent" ? "create" : "update",
      })),
    };
  }
  const migratingLegacyVersion = liveInventory.currentVersionRecord != null
    && liveInventory.currentVersion?.payload_multihash == null;
  if (request.operations.length === 0
    && !liveInventory.adoptingUnversionedSourceRecords
    && !migratingLegacyVersion) {
    return {
      outcome: "source-already-current",
      package_set: identity.package_set,
      partition: identity.partition,
      package_ref: packageName,
      proposal_multihash: request.proposal_multihash,
      stats,
    };
  }
  // A changed package's own declared checks run before its live delta. A
  // compile-only update accepted the login bundle whose full-page panel lived
  // outside the scene root; its newly declared mount check now rejects that
  // exact failure before any customer sees the new bytes.
  const { sourceRoot } = resolvePackageSourceLayout({ packageSetFolder, packagesSourceRoot });
  const checkOptions = {
    packageSetFolder: dirname(sourceRoot),
    packagesSubfolder: basename(sourceRoot),
    packages: [packageName],
    // The declared runner batches all files for one test runtime. A native
    // publication suite builds and runs its real process authority, so a
    // two-minute per-batch cap rejects healthy checks before they can answer.
    timeoutMs: 600000,
  };
  // Package-set records are compiled DATA, not a package with a manifest or a
  // declared test runner. Their compile and atomic delta checks still apply.
  const checkReport = packageName === 'package-set-records' ? null : buildReport(checkOptions);
  if (checkReport && exitCodeFor(checkReport.totals, { requireChecks: false, tolerateMissingRunner: false }) !== 0) {
    const failed = checkReport.packages.flatMap((entry) => entry.checks ?? [])
      .filter((check) => check.outcome !== 'passed')
      .map((check) => `${check.file}:${check.outcome}`);
    throw new Error(`PACKAGE_DECLARED_CHECKS_FAILED:${packageName}:${failed.join(',')}`);
  }
  const result = await applyPackageDelta({ client, request, partition: identity.partition, packageSet: identity.package_set });
  return {
    outcome: result.receipt.outcome,
    package_set: identity.package_set,
    partition: identity.partition,
    package_ref: packageName,
    proposal_multihash: request.proposal_multihash,
    adopted_unversioned_source_records: liveInventory.adoptingUnversionedSourceRecords,
    ...(options.adoptLiveOwnershipOnly
      ? { adopted_live_ownership_only: true, live_owned_pair_count: request.ownership_proofs.length }
      : {}),
    stats,
    ...result,
  };
}

// Exported so a caller can reproduce the real path step for step rather than describing it.
// A dry run that omits this built a DIFFERENT request from the one it claimed to preview, and
// a preview that is not the thing is worse than no preview.
export function reactiveSinkWireHexesFromSelectedSource({
  packageSetFolder,
  packagesSourceRoot,
  packageName,
  preparedPlan,
  readFile = readFileSync,
}) {
  const selectedPackage = validPackageName(packageName);
  // `package-set-records` is the package-loader's DATA projection over
  // `<set>/package-set-records/*.json`; it deliberately has no package manifest. Reactive
  // sinks can only be declared by a package manifest, so this projection has none. Trying to
  // read a synthetic `packages/package-set-records/things-to-store-and-run.json` made the
  // generic convergence owner unable to install the package-set DATA it already knew how to
  // compile. Keep the pseudo-package on the same convergence path and make the absence
  // explicit here rather than inventing a second apply path.
  if (selectedPackage === "package-set-records") return [];
  const { sourceRoot } = resolvePackageSourceLayout({ packageSetFolder, packagesSourceRoot });
  const sourceDataPath = resolve(
    sourceRoot,
    selectedPackage,
    PACKAGE_SOURCE_DATA,
  );
  let sourceData;
  try {
    sourceData = JSON.parse(readFile(sourceDataPath, "utf8"));
  } catch (error) {
    throw new Error(`PACKAGE_SOURCE_DATA_INVALID:${sourceDataPath}`, { cause: error });
  }
  const declaredThings = Array.isArray(sourceData) ? sourceData : sourceData?.things;
  if (!Array.isArray(declaredThings)) {
    throw new Error(`PACKAGE_SOURCE_DATA_THINGS_INVALID:${sourceDataPath}`);
  }

  const reactiveAddresses = [];
  for (const thing of declaredThings) {
    if (thing?.type !== "record_from_matching_records") continue;
    const address = typeof thing.address === "string" ? thing.address.trim() : "";
    if (!address) throw new Error(`PACKAGE_REACTIVE_SINK_ADDRESS_INVALID:${sourceDataPath}`);
    if (reactiveAddresses.includes(address)) {
      throw new Error(`PACKAGE_REACTIVE_SINK_ADDRESS_DUPLICATE:${address}`);
    }
    reactiveAddresses.push(address);
  }
  if (reactiveAddresses.length === 0) return [];

  const metadataBySourceAddress = new Map();
  const sourceWriteAddresses = new Set();
  for (const write of allPreparedWrites(preparedPlan).map(normalizePreparedWrite)) {
    sourceWriteAddresses.add(write.address_wire_hex);
    if (write.path_labels.length !== 1 || write.path_labels[0] !== METADATA_PATH) continue;
    const metadata = decodeJsonBytes(
      Buffer.from(write.payload_base64, "base64"),
      `PACKAGE_SOURCE_METADATA_INVALID:${write.address_wire_hex}`,
    );
    if (typeof metadata.source_address !== "string") continue;
    if (metadataBySourceAddress.has(metadata.source_address)) {
      throw new Error(`PACKAGE_SOURCE_METADATA_ADDRESS_DUPLICATE:${metadata.source_address}`);
    }
    metadataBySourceAddress.set(metadata.source_address, metadata);
  }

  const wireHexes = [];
  for (const address of reactiveAddresses) {
    const metadata = metadataBySourceAddress.get(address);
    if (metadata == null || typeof metadata.resolved_address_wire_hex !== "string") {
      throw new Error(`PACKAGE_REACTIVE_SINK_METADATA_MISSING:${address}`);
    }
    const wireHex = metadata.resolved_address_wire_hex.toLowerCase();
    if (!/^[0-9a-f]+$/.test(wireHex) || !sourceWriteAddresses.has(wireHex)) {
      throw new Error(`PACKAGE_REACTIVE_SINK_ADDRESS_RESOLVE_INVALID:${address}`);
    }
    wireHexes.push(wireHex);
  }
  return [...new Set(wireHexes)].sort(compareUnicodeCodeUnits);
}

/** Preserve declared legacy live DATA without embedding customer values in source.
 * Only attribute-fact paths are eligible; implementation and workflow paths
 * remain source-closed and continue to retract when removed from the manifest. */
export function retainedLiveDataPathsFromSelectedSource({
  packageSetFolder,
  packagesSourceRoot,
  packageName,
  readFile = readFileSync,
}) {
  const selectedPackage = validPackageName(packageName);
  if (selectedPackage === "package-set-records") return [];
  const { sourceRoot } = resolvePackageSourceLayout({ packageSetFolder, packagesSourceRoot });
  const sourceDataPath = resolve(sourceRoot, selectedPackage, PACKAGE_SOURCE_DATA);
  let sourceData;
  try {
    sourceData = JSON.parse(readFile(sourceDataPath, "utf8"));
  } catch (error) {
    throw new Error(`PACKAGE_SOURCE_DATA_INVALID:${sourceDataPath}`, { cause: error });
  }
  const things = Array.isArray(sourceData) ? sourceData : sourceData?.things;
  if (!Array.isArray(things)) throw new Error(`PACKAGE_SOURCE_DATA_THINGS_INVALID:${sourceDataPath}`);
  const policies = things.filter((thing) => thing?.payload?.kind === "bitfield-package-retained-live-data-policy");
  if (policies.length > 1) throw new Error(`PACKAGE_RETAINED_LIVE_DATA_POLICY_DUPLICATE:${selectedPackage}`);
  if (policies.length === 0) return [];
  const policy = policies[0];
  if (policy.type !== "record"
    || policy.address !== `package::${selectedPackage}::retained-live-data-policy`
    || !Array.isArray(policy.payload.path_labels)) {
    throw new Error(`PACKAGE_RETAINED_LIVE_DATA_POLICY_INVALID:${selectedPackage}`);
  }
  const paths = policy.payload.path_labels;
  if (paths.length > 16 || paths.some((path) => !Array.isArray(path) || path.length !== 1
    || typeof path[0] !== "string" || !path[0].startsWith("prop:")
    || path[0].length > 200)) {
    throw new Error(`PACKAGE_RETAINED_LIVE_DATA_PATH_INVALID:${selectedPackage}`);
  }
  const distinct = new Set(paths.map((path) => path[0]));
  if (distinct.size !== paths.length) throw new Error(`PACKAGE_RETAINED_LIVE_DATA_PATH_DUPLICATE:${selectedPackage}`);
  return paths;
}

export async function applyPackageDelta({ client, request, partition, packageSet }) {
  requireTargetClient(client);
  if (request?.schema !== PACKAGE_DELTA_SCHEMA) throw new Error("PACKAGE_DELTA_REQUEST_INVALID");
  const before = await readCurrentCursor(client, partition);
  let receipt;
  try {
    receipt = await postJson(client, PACKAGE_DELTA_TARGET, request);
  } catch (error) {
    // Old installed owners require this field. The schema refusal occurs
    // before mutation, so only that exact error permits a newly signed retry.
    if (!packageSet || !/deserialization failed: missing field `package_set`/.test(String(error?.message))) throw error;
    request.package_set = packageSet;
    request.proposal_multihash = proposalMultihash(request);
    receipt = await postJson(client, PACKAGE_DELTA_TARGET, request);
  }
  const after = await readCurrentCursor(client, partition);
  const receiptBefore = Number(receipt.cursor_before);
  const receiptAfter = Number(receipt.cursor_after);
  if (receipt.schema !== PACKAGE_DELTA_RECEIPT_SCHEMA
    || !Number.isSafeInteger(receiptBefore)
    || !Number.isSafeInteger(receiptAfter)
    || receiptBefore < before
    || receiptAfter < receiptBefore
    || receiptAfter > after) {
    throw new Error("PACKAGE_DELTA_RECEIPT_CURSOR_READBACK_MISMATCH");
  }
  if (receipt.outcome === "rejected") {
    throw new Error(`${receipt.reason_code ?? "PACKAGE_DELTA_REJECTED"}:${canonicalJson(receipt)}`);
  }
  const verification = await verifyPackageDeltaFold({ client, request, receipt, partition });
  return { receipt, verification };
}

export async function verifyPackageDeltaFold({ client, request, receipt, partition }) {
  const operations = [];
  for (const operation of request.operations) {
    const current = await readCurrent(client, {
      partition_label: partition,
      address_label: operation.address_wire_hex,
      address_mode: "multihash-hex",
    });
    const actual = currentPayloadHashCodeHex(current);
    const expected = operation.successor.state === "tombstone"
      ? null
      : operation.successor.payload_multihash;
    if (actual !== expected) throw new Error(`PACKAGE_DELTA_FOLD_READBACK_MISMATCH:${operation.address_wire_hex}`);
    operations.push({ address_wire_hex: operation.address_wire_hex, payload_multihash: actual });
  }
  const versionAddressWireHex = typeof receipt.version_record_address_wire_hex === "string"
    && receipt.version_record_address_wire_hex.length > 0
    ? receipt.version_record_address_wire_hex
    : null;
  const versionAddress = versionAddressWireHex
    ?? packageCurrentVersionAddressLabel(request.partition, request.package_ref);
  const version = await readCurrent(client, {
    partition_label: partition,
    address_label: versionAddress,
    address_mode: versionAddressWireHex == null ? "label-hash" : "multihash-hex",
  });
  const versionMultihash = currentPayloadHashCodeHex(version);
  if (versionMultihash !== receipt.current_version_payload_multihash) {
    throw new Error(
      "PACKAGE_DELTA_VERSION_READBACK_MISMATCH:"
      + `address=${versionAddress}:`
      + `expected=${String(receipt.current_version_payload_multihash)}:`
      + `actual=${String(versionMultihash)}:`
      + `outcome=${String(receipt.outcome)}`,
    );
  }
  return {
    all_operations_match: true,
    operation_count: operations.length,
    version_payload_multihash: versionMultihash,
    operations,
  };
}

// Completion is a read result, never a caller assertion. The accepted package
// change already lives in the package-current-version record. A behavior owner
// separately writes one evidence record after exercising the intended target.
// This verifier returns complete only when both durable records name the same
// proposal, active version, package, partition, and target.
export async function verifyProductCorrectionCompletion({
  client,
  targetRef,
  packageSet,
  partition,
  packageName,
  proposalMultihash: acceptedProposalMultihash,
  currentVersionMultihash: acceptedCurrentVersionMultihash,
  evidenceAddress,
}) {
  requireTargetClient(client);
  const selectedTarget = required(targetRef, "targetRef");
  const selectedSet = required(packageSet, "packageSet");
  const selectedPartition = required(partition, "partition");
  const selectedPackage = validPackageName(packageName);
  const selectedProposal = required(acceptedProposalMultihash, "proposalMultihash");
  const selectedVersion = required(acceptedCurrentVersionMultihash, "currentVersionMultihash");
  const selectedEvidenceAddress = required(evidenceAddress, "evidenceAddress");

  const currentVersion = await readCurrent(client, {
    partition_label: selectedPartition,
    address_label: packageCurrentVersionAddressLabel(selectedPartition, selectedPackage),
    address_mode: "label-hash",
  });
  const observedVersion = currentPayloadHashCodeHex(currentVersion);
  if (observedVersion !== selectedVersion) {
    throw new Error(`PRODUCT_CORRECTION_ACTIVE_VERSION_MISMATCH:${selectedVersion}:${observedVersion ?? "absent"}`);
  }
  const version = decodeJsonPayload(currentVersion, "PRODUCT_CORRECTION_ACTIVE_VERSION_INVALID");
  if (version.schema !== PACKAGE_CURRENT_VERSION_SCHEMA
    || version.partition !== selectedPartition
    || version.package_ref !== selectedPackage
    || version.proposal_multihash !== selectedProposal) {
    throw new Error("PRODUCT_CORRECTION_ACTIVE_CHANGE_MISMATCH");
  }

  const currentEvidence = await readCurrent(client, {
    partition_label: selectedPartition,
    address_label: selectedEvidenceAddress,
    address_mode: "label-hash",
  });
  const evidenceRevisionMultihash = currentPayloadHashCodeHex(currentEvidence);
  if (evidenceRevisionMultihash == null) throw new Error("PRODUCT_CORRECTION_EVIDENCE_MISSING");
  const evidence = decodeJsonPayload(currentEvidence, "PRODUCT_CORRECTION_EVIDENCE_INVALID");
  if (evidence.schema !== PRODUCT_CORRECTION_EVIDENCE_SCHEMA
    || evidence.outcome !== "passed"
    || evidence.target_ref !== selectedTarget
    || evidence.package_set !== selectedSet
    || evidence.partition !== selectedPartition
    || evidence.package_ref !== selectedPackage
    || evidence.proposal_multihash !== selectedProposal
    || evidence.active_version_payload_multihash !== selectedVersion
    || !/^1f:[0-9a-f]{64}$/.test(evidence.result_multihash ?? "")) {
    throw new Error("PRODUCT_CORRECTION_EVIDENCE_DOES_NOT_MATCH_ACTIVE_CHANGE");
  }
  return {
    schema: PRODUCT_CORRECTION_COMPLETION_SCHEMA,
    state: "complete",
    target_ref: selectedTarget,
    package_set: selectedSet,
    partition: selectedPartition,
    package_ref: selectedPackage,
    proposal_multihash: selectedProposal,
    active_version_payload_multihash: selectedVersion,
    evidence_address: selectedEvidenceAddress,
    evidence_revision_multihash: evidenceRevisionMultihash,
    result_multihash: evidence.result_multihash,
  };
}

export async function verifyProductCorrectionChangeSetCompletion({
  client,
  targetRef,
  changes,
  evidenceAddress,
}) {
  requireTargetClient(client);
  const selectedTarget = required(targetRef, "targetRef");
  const selectedEvidenceAddress = required(evidenceAddress, "evidenceAddress");
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error("PRODUCT_CORRECTION_CHANGE_SET_EMPTY");
  }
  const normalized = changes.map((change) => ({
    package_set: required(change.packageSet, "change.packageSet"),
    partition: required(change.partition, "change.partition"),
    package_ref: validPackageName(change.packageName),
    proposal_multihash: required(change.proposalMultihash, "change.proposalMultihash"),
    active_version_payload_multihash: required(
      change.currentVersionMultihash,
      "change.currentVersionMultihash",
    ),
  })).sort((left, right) => compareUnicodeCodeUnits(
    `${left.package_set}\0${left.partition}\0${left.package_ref}`,
    `${right.package_set}\0${right.partition}\0${right.package_ref}`,
  ));
  rejectDuplicates(
    normalized,
    (change) => `${change.package_set}\0${change.partition}\0${change.package_ref}`,
    "PRODUCT_CORRECTION_CHANGE_SET_DUPLICATE",
  );

  for (const change of normalized) {
    const current = await readCurrent(client, {
      partition_label: change.partition,
      address_label: packageCurrentVersionAddressLabel(change.partition,
        change.package_ref,
      ),
      address_mode: "label-hash",
    });
    if (currentPayloadHashCodeHex(current) !== change.active_version_payload_multihash) {
      throw new Error(`PRODUCT_CORRECTION_CHANGE_SET_INCOMPLETE:${change.package_ref}`);
    }
    const version = decodeJsonPayload(current, "PRODUCT_CORRECTION_ACTIVE_VERSION_INVALID");
    if (version.schema !== PACKAGE_CURRENT_VERSION_SCHEMA
      || version.partition !== change.partition
      || version.package_ref !== change.package_ref
      || version.proposal_multihash !== change.proposal_multihash) {
      throw new Error(`PRODUCT_CORRECTION_CHANGE_SET_ACTIVE_CHANGE_MISMATCH:${change.package_ref}`);
    }
  }

  const evidencePartition = normalized[0].partition;
  if (normalized.some((change) => change.partition !== evidencePartition)) {
    throw new Error("PRODUCT_CORRECTION_CHANGE_SET_CROSSES_TARGET_PARTITIONS");
  }
  const currentEvidence = await readCurrent(client, {
    partition_label: evidencePartition,
    address_label: selectedEvidenceAddress,
    address_mode: "label-hash",
  });
  const evidenceRevisionMultihash = currentPayloadHashCodeHex(currentEvidence);
  if (evidenceRevisionMultihash == null) throw new Error("PRODUCT_CORRECTION_EVIDENCE_MISSING");
  const evidence = decodeJsonPayload(currentEvidence, "PRODUCT_CORRECTION_EVIDENCE_INVALID");
  if (evidence.schema !== PRODUCT_CORRECTION_EVIDENCE_SCHEMA
    || evidence.outcome !== "passed"
    || evidence.target_ref !== selectedTarget
    || canonicalJson(evidence.active_changes) !== canonicalJson(normalized)
    || !/^1f:[0-9a-f]{64}$/.test(evidence.result_multihash ?? "")) {
    throw new Error("PRODUCT_CORRECTION_EVIDENCE_DOES_NOT_MATCH_ACTIVE_CHANGE_SET");
  }
  return {
    schema: PRODUCT_CORRECTION_COMPLETION_SCHEMA,
    state: "complete",
    target_ref: selectedTarget,
    active_changes: normalized,
    evidence_address: selectedEvidenceAddress,
    evidence_revision_multihash: evidenceRevisionMultihash,
    result_multihash: evidence.result_multihash,
  };
}

async function readCurrentCursor(client, partition) {
  const reply = await postJson(client, ENGINE_OPERATION_TARGET, {
    operation_label: "engine.operation.current-cursor",
    partition_label: required(partition, "partition"),
  });
  const cursor = Number(reply.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("PACKAGE_CURRENT_CURSOR_READBACK_INVALID");
  return cursor;
}

async function readCurrent(client, request) {
  return postJson(client, ENGINE_OPERATION_TARGET, {
    operation_label: "engine.operation.read-current",
    ...request,
  });
}

async function readCurrentWithRetry(client, request) {
  const delays = [250, 1000, 2500];
  for (let attempt = 0;; attempt += 1) {
    try {
      return await readCurrent(client, request);
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    }
  }
}

async function postJson(client, target, value) {
  const bytes = Buffer.from(canonicalJson(value));
  const response = await client.postBytes(target, bytes, {
    headers: { "Content-Type": "application/json" },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${target} failed: http=${response.status} body=${bodyText.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`${target} returned invalid JSON:${bodyText.slice(0, 1000)}`, { cause: error });
  }
}

function normalizePreparedWrite(write) {
  const mode = String(write.address_mode ?? write.addressMode ?? "").replaceAll("_", "-");
  if (mode !== "multihash-hex") throw new Error(`PACKAGE_SOURCE_WRITE_ADDRESS_MODE_INVALID:${write.address_label}`);
  const address = required(write.address_label ?? write.addressLabel, "prepared address_label").toLowerCase();
  if (!/^[0-9a-f]+$/.test(address)) throw new Error(`PACKAGE_SOURCE_ADDRESS_WIRE_INVALID:${address}`);
  return {
    address_wire_hex: address,
    path_labels: (write.path_labels ?? write.pathLabels ?? []).map((label) => required(label, "path label")),
    payload_base64: required(write.payload_base64 ?? write.payloadBase64, "prepared payload_base64"),
  };
}

function validateSourcePlan(plan, packageSet, partition, packageName) {
  for (const [actual, expected, code] of [
    [plan?.package_set, packageSet, "PACKAGE_SET"],
    [plan?.partition, partition, "PARTITION"],
    [plan?.package_name ?? plan?.packageName, packageName, "PACKAGE"],
  ]) {
    if (actual !== expected) throw new Error(`PACKAGE_SOURCE_PLAN_${code}_MISMATCH`);
  }
}

function allPreparedWrites(plan) {
  return [
    ...(plan?.record_writes ?? plan?.recordWrites ?? []),
    ...(plan?.stored_byte_writes ?? plan?.storedByteWrites ?? []),
    ...(plan?.entry_writes ?? plan?.entryWrites ?? []),
  ];
}

function uniqueWritesByWireHex(writes) {
  const map = new Map();
  for (const write of writes) {
    if (map.has(write.address_wire_hex)) {
      throw new Error(`PACKAGE_SOURCE_WRITE_DUPLICATE:${write.address_wire_hex}`);
    }
    map.set(write.address_wire_hex, write);
  }
  return map;
}

/**
 * True when this live row is the person's own data for this package and set.
 * Mirrors package-loader/src/lib.rs:606-613. Undecodable or foreign bytes
 * return false so they still reach the loud check; only a row that positively
 * proves it is this package's user data is skipped.
 */
function isPreservedUserDataRow(metadataPayloadBase64, packageName) {
  if (typeof metadataPayloadBase64 !== "string") return false;
  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(metadataPayloadBase64, "base64").toString("utf8"));
  } catch {
    return false;
  }
  return metadata?.schema === PACKAGE_RECORD_SOURCE_METADATA_SCHEMA
    && metadata.authority_class_address === "authority-class::user-data"
    && metadata.source_package === packageName;
}

function ownershipProofFromWrite(write, packageName) {
  return ownershipProofFromMetadataBytes({
    metadataAddressWireHex: write.address_wire_hex,
    metadataPayloadBase64: write.payload_base64,
    packageName,
  });
}

function ownershipProofFromMetadataBytes({
  metadataAddressWireHex,
  metadataPayloadBase64,
  packageSet,
  packageName,
}) {
  const metadataBytes = Buffer.from(metadataPayloadBase64, "base64");
  const metadata = decodeJsonBytes(metadataBytes, `PACKAGE_OWNERSHIP_METADATA_INVALID:${metadataAddressWireHex}`);
  // Naming only the address sends the reader looking for a row they cannot
  // decode by hand. A row written by an older revision fails exactly one of
  // these, and which one is the whole diagnosis: a schema mismatch is an
  // outdated writer, while a set or package mismatch is a row owned by
  // something else that must be retired before this package can converge.
  const wrong = [];
  if (metadata.schema !== PACKAGE_RECORD_SOURCE_METADATA_SCHEMA) {
    wrong.push(`schema=${JSON.stringify(metadata.schema)} wanted ${JSON.stringify(PACKAGE_RECORD_SOURCE_METADATA_SCHEMA)}`);
  }
  if (metadata.source_package !== packageName) {
    wrong.push(`source_package=${JSON.stringify(metadata.source_package)} wanted ${JSON.stringify(packageName)}`);
  }
  if (metadata.authority_class_address !== "authority-class::impl") {
    wrong.push(`authority_class_address=${JSON.stringify(metadata.authority_class_address)} wanted "authority-class::impl"`);
  }
  if (typeof metadata.resolved_address_wire_hex !== "string") {
    wrong.push(`resolved_address_wire_hex is ${typeof metadata.resolved_address_wire_hex}, wanted string`);
  }
  if (wrong.length > 0) {
    throw new Error(`PACKAGE_OWNERSHIP_METADATA_INVALID:${metadataAddressWireHex} (${wrong.join("; ")})`);
  }
  return {
    id: `ownership::${metadata.resolved_address_wire_hex}`,
    record_address_wire_hex: metadata.resolved_address_wire_hex,
    metadata_address_wire_hex: metadataAddressWireHex,
    metadata_payload_base64: metadataPayloadBase64,
    metadata_payload_multihash: hashCodeHexFromBytes(metadataBytes),
  };
}

function assertClosedDesiredOwnership(desiredByWireHex, proofs) {
  const covered = new Set();
  for (const proof of proofs) {
    if (!desiredByWireHex.has(proof.record_address_wire_hex)
      || !desiredByWireHex.has(proof.metadata_address_wire_hex)) {
      throw new Error(`PACKAGE_SOURCE_OWNERSHIP_OPEN:${proof.record_address_wire_hex}`);
    }
    covered.add(proof.record_address_wire_hex);
    covered.add(proof.metadata_address_wire_hex);
  }
  for (const address of desiredByWireHex.keys()) {
    if (!covered.has(address)) throw new Error(`PACKAGE_OWNERSHIP_PROOF_MISSING:${address}`);
  }
}

function requiredLiveInventoryRow(inventory, address) {
  const row = inventory.currentByWireHex.get(address);
  if (row == null) throw new Error(`PACKAGE_LIVE_INVENTORY_MISSING:${address}`);
  return row;
}

function tombstoneOperation(addressWireHex, pathLabels, live, proofId) {
  return {
    address_wire_hex: addressWireHex,
    path_labels: pathLabels,
    basis: expectedVersion(live.payload_multihash),
    successor: { state: "tombstone" },
    ownership_proof_ref: proofId,
  };
}

function expectedVersion(payloadMultihash) {
  return payloadMultihash == null
    ? { state: "absent" }
    : { state: "present", payload_multihash: payloadMultihash };
}

export function proposalMultihash(request) {
  const unsigned = { ...request };
  delete unsigned.proposal_multihash;
  return hashCodeHexFromBytes(Buffer.from(canonicalJson(unsigned)));
}

export function currentPayloadHashCodeHex(current) {
  if (current?.found !== true) return null;
  if (typeof current.content_hash === "string") return current.content_hash;
  if (current.payload_base64 == null) return null;
  return hashCodeHexFromBytes(Buffer.from(current.payload_base64, "base64"));
}

export function hashCodeHexFromBytes(bytes) {
  return `1f:${Buffer.from(blake3(new Uint8Array(bytes))).toString("hex")}`;
}

function decodeJsonPayload(current, code) {
  return decodeJsonBytes(Buffer.from(required(current.payload_base64, "payload_base64"), "base64"), code);
}

function decodeJsonBytes(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareUnicodeCodeUnits).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareUnicodeCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectDuplicates(values, key, code) {
  for (let index = 1; index < values.length; index += 1) {
    const previousKey = key(values[index - 1]);
    const currentKey = key(values[index]);
    if (previousKey === currentKey) throw new Error(`${code}:${currentKey}`);
  }
}

function requireTargetClient(client) {
  if (client == null || typeof client.postBytes !== "function") {
    throw new Error("A running-app target client with postBytes is required");
  }
}

function validPackageName(value) {
  const name = required(value, "packageName");
  if (name.includes("/") || name.includes("..") || name.includes("\\")) {
    throw new Error(`PACKAGE_NAME_INVALID:${name}`);
  }
  return name;
}

function validRecordSetName(value) {
  const name = required(value, "recordSet");
  if (name === "." || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`PACKAGE_RECORD_SET_INVALID:${name}`);
  }
  return name;
}

function usableString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function required(value, name) {
  if (value == null || (typeof value === "string" && value.trim().length === 0)) {
    throw new Error(`${requiredName(name)} is required`);
  }
  return value;
}

function requiredName(name) {
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : "value";
}
