// packages/live-namespace/read-data/reconcile-namespace-corpus.mjs
//
// PURPOSE
// Turn a stated name/identity/path table into ONE exact corpus reconciliation report. This is
// the audit half of the publisher's job: it explains what changed since a baseline, which
// identities are unavailable, and what the measured volume says. It does not walk a filesystem,
// publish records, mutate a source, select a provider, or infer a protection promise.

import { identityFromSha256Hex } from "./namespace-records-from-a-name-and-identity-table.mjs";

export class NamespaceCorpusReconciliationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "NamespaceCorpusReconciliationError";
    this.details = details ?? {};
  }
}

function plainObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new NamespaceCorpusReconciliationError(`${label} must be an object`, { field: label });
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NamespaceCorpusReconciliationError(`${label} must be a non-empty string`, { field: label });
  }
  return value;
}

function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NamespaceCorpusReconciliationError(`${label} must be a non-negative safe integer`, { field: label });
  }
  return value;
}

function rowIdentity(row, index, label) {
  const identity = identityFromSha256Hex(row?.sha256Hex);
  if (typeof row.name !== "string" || row.name.length === 0) {
    throw new NamespaceCorpusReconciliationError(`${label}[${index}] has no name`, { index });
  }
  if (typeof row.storedPath !== "string" || !row.storedPath.startsWith("/")) {
    throw new NamespaceCorpusReconciliationError(`${label}[${index}] has no absolute stored path`, { index });
  }
  return identity;
}

function admittedFacts(raw, identity) {
  const facts = plainObject(raw, `fileFactsFor(${identity})`);
  const unknown = Object.keys(facts).filter((key) => !["exists", "byteLength", "modifiedAtMs"].includes(key));
  if (unknown.length > 0) {
    throw new NamespaceCorpusReconciliationError(`facts for ${identity} contain unknown fields`, {
      identity,
      unknownFields: unknown.sort(),
    });
  }
  if (facts.exists !== true && facts.exists !== false) {
    throw new NamespaceCorpusReconciliationError(`facts for ${identity} must state exists as a boolean`, { identity });
  }
  if (facts.exists && !Object.hasOwn(facts, "byteLength")) {
    throw new NamespaceCorpusReconciliationError(`present identity ${identity} needs byteLength`, { identity });
  }
  if (Object.hasOwn(facts, "byteLength")) safeNonNegativeInteger(facts.byteLength, `byteLength for ${identity}`);
  if (Object.hasOwn(facts, "modifiedAtMs")) safeNonNegativeInteger(facts.modifiedAtMs, `modifiedAtMs for ${identity}`);
  return facts;
}

function admittedVolume(raw) {
  const volume = plainObject(raw, "volumeFacts");
  const allowed = new Set(["source", "totalBytes", "freeBytes", "usedBytes", "filesystemType"]);
  const unknown = Object.keys(volume).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NamespaceCorpusReconciliationError("volumeFacts has unknown fields", { unknownFields: unknown.sort() });
  }
  const source = nonEmptyString(volume.source, "volumeFacts.source");
  const totalBytes = safeNonNegativeInteger(volume.totalBytes, "volumeFacts.totalBytes");
  const freeBytes = safeNonNegativeInteger(volume.freeBytes, "volumeFacts.freeBytes");
  if (freeBytes > totalBytes) throw new NamespaceCorpusReconciliationError("free volume bytes exceed total bytes");
  const derivedUsedBytes = totalBytes - freeBytes;
  if (Object.hasOwn(volume, "usedBytes") && volume.usedBytes !== derivedUsedBytes) {
    throw new NamespaceCorpusReconciliationError("volumeFacts.usedBytes disagrees with total minus free", {
      expected: derivedUsedBytes,
      received: volume.usedBytes,
    });
  }
  return {
    source,
    filesystemType: Object.hasOwn(volume, "filesystemType") ? volume.filesystemType : null,
    totalBytes,
    freeBytes,
    usedBytes: derivedUsedBytes,
  };
}

function admittedDescriptor(raw, label) {
  const value = plainObject(raw, label);
  const unknown = Object.keys(value).filter((key) => key !== "descriptor");
  if (unknown.length > 0) {
    throw new NamespaceCorpusReconciliationError(`${label} has unknown fields`, { field: label, unknownFields: unknown.sort() });
  }
  return { descriptor: nonEmptyString(value.descriptor, `${label}.descriptor`) };
}

function admittedPolicy(raw, label, requiredField) {
  const value = plainObject(raw, label);
  const unknown = Object.keys(value).filter((key) => key !== requiredField);
  if (unknown.length > 0) {
    throw new NamespaceCorpusReconciliationError(`${label} has unknown fields`, { field: label, unknownFields: unknown.sort() });
  }
  return { [requiredField]: nonEmptyString(value[requiredField], `${label}.${requiredField}`) };
}

function rowKey(row, identity) {
  return `${row.name}\u0000${identity}\u0000${row.storedPath}`;
}

/**
 * Reconcile a current stated corpus against an optional immutable baseline.
 *
 * The current table and baseline table are row streams supplied by the caller. File and volume
 * measurements are also supplied, so this module can be tested without a disk and can never
 * pretend that a table hash is a byte measurement.
 */
export async function reconcileNamespaceCorpus({
  openRows,
  fileFactsFor,
  volumeFacts,
  futureGrowthPolicy,
  protectionProfile,
  tableDescriptor,
  baselineOpenRows = null,
  baselineDescriptor = null,
  ...unknownOptions
}) {
  const unknownNames = Object.keys(unknownOptions);
  if (unknownNames.length > 0) {
    throw new NamespaceCorpusReconciliationError(`unknown option(s): ${unknownNames.join(", ")}`);
  }
  if (typeof openRows !== "function") throw new NamespaceCorpusReconciliationError("openRows must be a factory function");
  if (typeof fileFactsFor !== "function") throw new NamespaceCorpusReconciliationError("fileFactsFor must be a function");
  if (baselineOpenRows != null && typeof baselineOpenRows !== "function") {
    throw new NamespaceCorpusReconciliationError("baselineOpenRows must be a factory function when supplied");
  }
  const hasBaseline = baselineOpenRows != null;
  if (hasBaseline !== (baselineDescriptor != null)) {
    throw new NamespaceCorpusReconciliationError("baseline rows and baseline descriptor must be supplied together");
  }

  const volume = admittedVolume(volumeFacts);
  const table = admittedDescriptor(tableDescriptor, "tableDescriptor");
  const growth = admittedPolicy(futureGrowthPolicy, "futureGrowthPolicy", "policy");
  const protection = admittedPolicy(protectionProfile, "protectionProfile", "profile");
  const baseline = hasBaseline ? admittedDescriptor(baselineDescriptor, "baselineDescriptor") : null;

  const currentIdentities = new Map();
  const identityByName = new Map();
  const nameConflicts = [];
  const rejectedRows = [];
  const baselineCounts = new Map();
  const baselineIdentities = new Set();
  let rowsSelected = 0;
  let rejectedCount = 0;
  let baselineRowsSelected = 0;
  let baselineRejectedCount = 0;
  let rowsAppendedAfterBaseline = 0;

  if (hasBaseline) {
    let index = 0;
    for await (const row of baselineOpenRows()) {
      index += 1;
      try {
        const identity = rowIdentity(row, index - 1, "baselineRows");
        const key = rowKey(row, identity);
        baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
        baselineIdentities.add(identity);
      } catch (error) {
        baselineRejectedCount += 1;
        if (rejectedRows.length < 20) rejectedRows.push({ source: "baseline", index, reason: error.message });
      }
    }
    baselineRowsSelected = index;
  }

  let index = 0;
  for await (const row of openRows()) {
    index += 1;
    let identity;
    try {
      identity = rowIdentity(row, index - 1, "rows");
    } catch (error) {
      rejectedCount += 1;
      if (rejectedRows.length < 20) rejectedRows.push({ source: "current", index, reason: error.message });
      continue;
    }
    rowsSelected += 1;
    const key = rowKey(row, identity);
    const baselineCount = baselineCounts.get(key) ?? 0;
    if (baselineCount > 0) baselineCounts.set(key, baselineCount - 1);
    else if (hasBaseline) rowsAppendedAfterBaseline += 1;

    let state = currentIdentities.get(identity);
    if (state == null) {
      state = {
        facts: admittedFacts(fileFactsFor(row, identity), identity),
        rows: 0,
        firstRow: row,
      };
      currentIdentities.set(identity, state);
    }
    state.rows += 1;

    const previousIdentity = identityByName.get(row.name);
    if (previousIdentity != null && previousIdentity !== identity) {
      nameConflicts.push({ name: row.name, kept: identity, replaced: previousIdentity });
    }
    identityByName.set(row.name, identity);
  }

  const baselineRowsNotSeenInCurrent = [...baselineCounts.values()].reduce((sum, count) => sum + count, 0);
  const currentIdentitySet = new Set(currentIdentities.keys());
  const baselineIdentitiesNotSeenInCurrent = [...baselineIdentities].filter((identity) => !currentIdentitySet.has(identity));
  const identitiesAddedAfterBaseline = hasBaseline
    ? [...currentIdentitySet].filter((identity) => !baselineIdentities.has(identity)).length
    : null;

  let presentIdentities = 0;
  let missingIdentities = 0;
  let presentRows = 0;
  let missingRows = 0;
  let presentBytes = 0;
  const missingIdentitySamples = [];
  for (const [identity, state] of currentIdentities) {
    if (state.facts.exists) {
      presentIdentities += 1;
      presentRows += state.rows;
      presentBytes += state.facts.byteLength;
    } else {
      missingIdentities += 1;
      missingRows += state.rows;
      if (missingIdentitySamples.length < 60) {
        missingIdentitySamples.push({ identity, rows: state.rows, first_row: state.firstRow });
      }
    }
  }

  return {
    kind: "live-namespace.corpus-reconciliation",
    table: table.descriptor,
    volume,
    future_growth_policy: growth.policy,
    protection_profile: protection.profile,
    rows_selected: rowsSelected,
    rejected_count: rejectedCount,
    rejected_sample: rejectedRows,
    unique_identities: currentIdentities.size,
    present_identities: presentIdentities,
    missing_identities: missingIdentities,
    present_rows: presentRows,
    missing_rows: missingRows,
    present_manifest_bytes: presentBytes,
    missing_manifest_bytes: null,
    names_given_more_than_one_identity: nameConflicts.length,
    names_given_more_than_one_identity_sample: nameConflicts.slice(0, 20),
    missing_identity_sample: missingIdentitySamples,
    baseline: hasBaseline
      ? {
          ...baseline,
          rows_selected: baselineRowsSelected,
          rejected_count: baselineRejectedCount,
          unique_identities: baselineIdentities.size,
          rows_not_seen_in_current: baselineRowsNotSeenInCurrent,
          identities_not_seen_in_current: baselineIdentitiesNotSeenInCurrent.length,
          identities_not_seen_in_current_sample: baselineIdentitiesNotSeenInCurrent.slice(0, 20),
          rows_appended_after_baseline: rowsAppendedAfterBaseline,
          identities_added_after_baseline: identitiesAddedAfterBaseline,
        }
      : null,
  };
}
