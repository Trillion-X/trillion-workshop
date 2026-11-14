import assert from "node:assert/strict";
import test from "node:test";

import {
  NamespaceCorpusReconciliationError,
  reconcileNamespaceCorpus,
} from "../read-data/reconcile-namespace-corpus.mjs";

const HASH_A = "3300f2037090fbc433ce4f405d016aa949de441b1d7791c8aa0128361db7fedd";
const HASH_B = "5ec4d3cbc9374276b83b5333f5251c28518c6749a924a93a044a614975e165f0";
const HASH_C = "3093db057d6dc5422d3bb747d226d17dc7a46e7b2dcd5a52f61ca866fd2d8359";

function rows(items) {
  return () => (async function* generate() { yield* items; })();
}

function factsByPath({ exists = true, byteLength = 100 } = {}) {
  return () => ({ exists, byteLength });
}

function input(overrides = {}) {
  return {
    openRows: rows([
      { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
      { name: "two.mov", sha256Hex: HASH_B, storedPath: "/store/b.mov" },
    ]),
    fileFactsFor: factsByPath({ byteLength: 100 }),
    volumeFacts: {
      source: "test:volume",
      totalBytes: 1000,
      freeBytes: 400,
    },
    futureGrowthPolicy: { policy: "no automatic growth without exact authority" },
    protectionProfile: { profile: "unselected; measured only" },
    tableDescriptor: { descriptor: "test:current-table" },
    ...overrides,
  };
}

test("counts rows once but bytes once per identity, and reports volume truth separately", async () => {
  const report = await reconcileNamespaceCorpus(input({
    openRows: rows([
      { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
      { name: "same.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
      { name: "two.mov", sha256Hex: HASH_B, storedPath: "/store/b.mov" },
    ]),
    fileFactsFor: (row) => ({ exists: true, byteLength: row.storedPath === "/store/a.mov" ? 300 : 20 }),
  }));
  assert.equal(report.rows_selected, 3);
  assert.equal(report.unique_identities, 2);
  assert.equal(report.present_manifest_bytes, 320);
  assert.deepEqual(report.volume, {
    source: "test:volume",
    filesystemType: null,
    totalBytes: 1000,
    freeBytes: 400,
    usedBytes: 600,
  });
});

test("an absent identity is counted as unavailable rather than converted into zero trustworthy bytes", async () => {
  const report = await reconcileNamespaceCorpus(input({
    fileFactsFor: (row) => row.storedPath === "/store/a.mov"
      ? { exists: true, byteLength: 100 }
      : { exists: false },
  }));
  assert.equal(report.present_identities, 1);
  assert.equal(report.missing_identities, 1);
  assert.equal(report.present_rows, 1);
  assert.equal(report.missing_rows, 1);
  assert.equal(report.present_manifest_bytes, 100);
  assert.equal(report.missing_manifest_bytes, null);
  assert.equal(report.missing_identity_sample.length, 1);
});

test("baseline multiset reconciliation counts exact appended rows without pretending order matters", async () => {
  const baseline = [
    { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
    { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
    { name: "two.mov", sha256Hex: HASH_B, storedPath: "/store/b.mov" },
  ];
  const current = [
    { name: "two.mov", sha256Hex: HASH_B, storedPath: "/store/b.mov" },
    { name: "new.mov", sha256Hex: HASH_C, storedPath: "/store/c.mov" },
    { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
    { name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
  ];
  const report = await reconcileNamespaceCorpus(input({
    openRows: rows(current),
    baselineOpenRows: rows(baseline),
    baselineDescriptor: { descriptor: "test:baseline" },
  }));
  assert.equal(report.baseline.rows_selected, 3);
  assert.equal(report.baseline.rows_not_seen_in_current, 0);
  assert.equal(report.baseline.rows_appended_after_baseline, 1);
  assert.equal(report.baseline.identities_added_after_baseline, 1);
  assert.equal(report.baseline.identities_not_seen_in_current, 0);
});

test("a removed baseline row is surfaced, never cancelled out by an unrelated appended row", async () => {
  const report = await reconcileNamespaceCorpus(input({
    openRows: rows([{ name: "new.mov", sha256Hex: HASH_C, storedPath: "/store/c.mov" }]),
    baselineOpenRows: rows([{ name: "one.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" }]),
    baselineDescriptor: { descriptor: "test:baseline" },
  }));
  assert.equal(report.baseline.rows_not_seen_in_current, 1);
  assert.equal(report.baseline.rows_appended_after_baseline, 1);
  assert.equal(report.baseline.identities_not_seen_in_current, 1);
});

test("one name with two identities is reported instead of silently keeping whichever arrived last", async () => {
  const report = await reconcileNamespaceCorpus(input({
    openRows: rows([
      { name: "same.mov", sha256Hex: HASH_A, storedPath: "/store/a.mov" },
      { name: "same.mov", sha256Hex: HASH_B, storedPath: "/store/b.mov" },
    ]),
  }));
  assert.equal(report.names_given_more_than_one_identity, 1);
  assert.deepEqual(report.names_given_more_than_one_identity_sample[0], {
    name: "same.mov",
    kept: `12:${HASH_B}`,
    replaced: `12:${HASH_A}`,
  });
});

test("bad rows are counted visibly, while bad facts, arithmetic, and options fail closed", async () => {
  const rowReport = await reconcileNamespaceCorpus(input({
    openRows: rows([{ name: "bad", sha256Hex: "oops", storedPath: "/x" }]),
  }));
  assert.equal(rowReport.rows_selected, 0);
  assert.equal(rowReport.rejected_count, 1);
  assert.equal(rowReport.rejected_sample[0].source, "current");
  await assert.rejects(
    reconcileNamespaceCorpus(input({ fileFactsFor: () => ({ exists: true }) })),
    NamespaceCorpusReconciliationError,
  );
  await assert.rejects(
    reconcileNamespaceCorpus(input({ volumeFacts: { source: "x", totalBytes: 10, freeBytes: 20 } })),
    NamespaceCorpusReconciliationError,
  );
  await assert.rejects(
    reconcileNamespaceCorpus(input({ accidentallyTypoed: true })),
    NamespaceCorpusReconciliationError,
  );
});
