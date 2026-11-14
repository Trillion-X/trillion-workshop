// packages/live-namespace/tests/operation-pair-outcome.test.mjs
//
// The judge for T12.9 and the hash bridge that lets a guarded write name what it saw. Each test
// names the failure it prevents, and two of them encode what the real engine did on 2026-09-04
// rather than what was imagined.

import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHashFromExpectedCurrent,
  expectedCurrentFromContentHash,
} from "../read-data/expected-current-from-content-hash.mjs";
import { operationPairOutcome, OperationPairOutcomeError } from "../read-data/operation-pair-outcome.mjs";

const HASH_SEED = "1f:d00c86d42a1fe85f1a8181b00677aae97363245b7880266cf94ef6c7f4a24637";
const HASH_NEXT = "1f:57a5c4b0e6821f5730e5f7d2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4";

function compiledCase(overrides = {}) {
  return {
    caseId: "p151--write-batch--write-batch--sequential-a-b",
    censusId: "P151",
    schedule: "sequential-a-b",
    expected: {
      outcome: "conflict",
      statePredicates: ["exactly-one-write-visible", "no-partial-mutation"],
      errorPredicates: [{ code: "ExpectedCurrentMismatch", count: 1 }],
    },
    ...overrides,
  };
}

function state(entries) {
  return new Map(Object.entries(entries));
}

test("the hash bridge round-trips the engine's two spellings of one multihash", () => {
  // Read side prints `<code hex>:<digest hex>`; write side wants base64 of varint(code) ++
  // varint(len) ++ digest. Getting either wrong turns every guarded write into a codec error.
  const expected = expectedCurrentFromContentHash(HASH_SEED);
  assert.match(expected.payload_hash_base64, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(contentHashFromExpectedCurrent(expected), HASH_SEED);
  // Code 0x1f is one varint byte; a 32-byte digest is one length byte; total wire = 34 bytes.
  assert.equal(Buffer.from(expected.payload_hash_base64, "base64").length, 34);
  // Absent current is the explicit "expect nothing there" precondition, not an error.
  assert.deepEqual(expectedCurrentFromContentHash(null), { payload_hash_base64: null });
  assert.throws(() => expectedCurrentFromContentHash("not-a-hash"), /code hex/);
  assert.throws(() => expectedCurrentFromContentHash("1f:abc"), /whole bytes/);
});

test("a write/write conflict holds when exactly one landed and the loser said why", () => {
  const verdict = operationPairOutcome(compiledCase(), {
    addresses: ["addr"],
    before: state({ addr: { found: true, payload_hash: HASH_SEED } }),
    a: { reply: { write_count: 1 } },
    b: { error: "engine.operation.label-addressed returned 502: FE_EXPECTED_CURRENT_MISMATCH" },
    after: state({ addr: { found: true, payload_hash: HASH_NEXT } }),
  });
  assert.equal(verdict.holds, true, JSON.stringify(verdict.failed));
  assert.equal(verdict.kind, "live-namespace.operation-pair-verdict");
});

test("'both returned 200' FAILS a conflict case, because success is not the oracle", () => {
  const verdict = operationPairOutcome(compiledCase(), {
    addresses: ["addr"],
    before: state({ addr: { found: true, payload_hash: HASH_SEED } }),
    a: { reply: { write_count: 1 } },
    b: { reply: { write_count: 1 } },
    after: state({ addr: { found: true, payload_hash: HASH_NEXT } }),
  });
  assert.equal(verdict.holds, false);
  assert.ok(verdict.failed.includes("exactly-one-write-visible"));
  assert.ok(verdict.failed.includes("error:ExpectedCurrentMismatch"));
});

test("a declared predicate with no judge is REFUSED, never silently passed", () => {
  const unknown = compiledCase({ expected: { outcome: "pass", statePredicates: ["some-new-predicate"], errorPredicates: [] } });
  assert.throws(() => operationPairOutcome(unknown, {
    addresses: ["addr"], before: state({}), a: { reply: {} }, b: { reply: {} }, after: state({}),
  }), OperationPairOutcomeError);
});

test("replaying a guarded write: first lands, replay and b are both refused (real engine, 2026-09-04)", () => {
  const replay = compiledCase({
    schedule: "retry-replay",
    expected: {
      outcome: "conflict",
      statePredicates: ["no-guarded-write-landed-twice", "no-partial-mutation"],
      errorPredicates: [{ code: "ExpectedCurrentMismatch", count: 2 }],
    },
  });
  const verdict = operationPairOutcome(replay, {
    addresses: ["addr"],
    before: state({ addr: { found: true, payload_hash: HASH_SEED } }),
    a: { error: "FE_EXPECTED_CURRENT_MISMATCH", first_attempt: { reply: { write_count: 1 } } },
    b: { error: "FE_EXPECTED_CURRENT_MISMATCH" },
    after: state({ addr: { found: true, payload_hash: HASH_NEXT } }),
  });
  assert.equal(verdict.holds, true, JSON.stringify(verdict.judged));

  // If the FIRST attempt also failed, nothing landed and "current moved" would be a lie the
  // judge must not accept on the strength of the hash alone.
  const nothingLanded = operationPairOutcome(replay, {
    addresses: ["addr"],
    before: state({ addr: { found: true, payload_hash: HASH_SEED } }),
    a: { error: "FE_EXPECTED_CURRENT_MISMATCH", first_attempt: { error: "FE_EXPECTED_CURRENT_MISMATCH" } },
    b: { error: "FE_EXPECTED_CURRENT_MISMATCH" },
    after: state({ addr: { found: true, payload_hash: HASH_NEXT } }),
  });
  assert.equal(nothingLanded.holds, false);
});

test("a refused rename must leave NO new name, whatever the delete did to the old one", () => {
  const rename = compiledCase({
    censusId: "P207",
    expected: {
      outcome: "conflict",
      statePredicates: ["guarded-old-name-retracted", "new-name-created-atomically", "pinned-locator-readable"],
      errorPredicates: [{ code: "ExpectedCurrentMismatch", count: 1 }],
    },
  });
  const run = (fresh) => ({
    addresses: ["old", "new", "locator"],
    before: state({ old: { found: true, payload_hash: HASH_SEED }, new: { found: false, payload_hash: null }, locator: { found: true, payload_hash: HASH_SEED } }),
    a: { error: "FE_EXPECTED_CURRENT_MISMATCH" },
    b: { reply: { write_count: 1 } },
    after: state({ old: { found: false, payload_hash: null }, new: fresh, locator: { found: true, payload_hash: HASH_SEED } }),
  });
  assert.equal(operationPairOutcome(rename, run({ found: false, payload_hash: null })).holds, true);
  // A half-applied rename: the batch was refused yet its second entry landed. Must fail.
  assert.equal(operationPairOutcome(rename, run({ found: true, payload_hash: HASH_NEXT })).holds, false);
});

test("a fork must not move the original, and a merge record must not appear (P252)", () => {
  const fork = compiledCase({
    censusId: "P252",
    expected: { outcome: "pass", statePredicates: ["fork-remains-scoped", "no-semantic-merge-record", "immutable-identity-stable"], errorPredicates: [] },
  });
  const run = ({ originalAfter = HASH_SEED, mergeFound = false, forkFound = true, readHash = HASH_SEED } = {}) => ({
    addresses: ["original", "fork", "merge"],
    before: state({ original: { found: true, payload_hash: HASH_SEED }, fork: { found: false, payload_hash: null }, merge: { found: false, payload_hash: null } }),
    a: { reply: { write_count: 1 } },
    b: { reply: { found: true, content_hash: readHash } },
    after: state({ original: { found: true, payload_hash: originalAfter }, fork: { found: forkFound, payload_hash: forkFound ? HASH_NEXT : null }, merge: { found: mergeFound, payload_hash: mergeFound ? HASH_NEXT : null } }),
  });
  assert.equal(operationPairOutcome(fork, run()).holds, true);
  // The fork write leaked into the original: its hash moved.
  assert.ok(operationPairOutcome(fork, run({ originalAfter: HASH_NEXT })).failed.includes("immutable-identity-stable"));
  // The read during the race saw a hash the original never had.
  assert.ok(operationPairOutcome(fork, run({ readHash: HASH_NEXT })).failed.includes("immutable-identity-stable"));
  // Something wrote a merge record.
  assert.ok(operationPairOutcome(fork, run({ mergeFound: true })).failed.includes("no-semantic-merge-record"));
  // The fork write succeeded but nothing is at the fork address.
  assert.ok(operationPairOutcome(fork, run({ forkFound: false })).failed.includes("fork-remains-scoped"));
});

test("a restore moves current back by hash; the superseded bytes stay readable; reclaim is refused (P377)", () => {
  const restore = compiledCase({
    censusId: "P377",
    expected: { outcome: "pass", statePredicates: ["current-pointer-restored", "immutable-identity-remains", "reclaim-not-admitted"], errorPredicates: [] },
  });
  const run = ({ current = HASH_SEED, bytes = "AQID", found = true, refused = "not registered" } = {}) => ({
    addresses: ["pointer"],
    before: state({ pointer: { found: true, payload_hash: HASH_NEXT } }),
    a: { reply: { write_count: 1, restored_to: HASH_SEED } },
    b: { reply: { found, bytes_base64: bytes, byte_count: 3, superseded_hash: HASH_NEXT, reclaim_refused: refused } },
    after: state({ pointer: { found: true, payload_hash: current } }),
  });
  assert.equal(operationPairOutcome(restore, run()).holds, true);
  // Current did not come back to the earlier hash.
  assert.ok(operationPairOutcome(restore, run({ current: HASH_NEXT })).failed.includes("current-pointer-restored"));
  // The superseded bytes are gone: a restore that could never be undone.
  assert.ok(operationPairOutcome(restore, run({ found: false, bytes: "" })).failed.includes("immutable-identity-remains"));
  // The engine ACCEPTED a reclaim label. That is the defect this row exists to catch.
  assert.ok(operationPairOutcome(restore, run({ refused: null })).failed.includes("reclaim-not-admitted"));
});

test("a revoked tuple and a forged holder are both refused BY NAME; the wrong reason is not a pass (P422)", () => {
  const revoke = compiledCase({
    censusId: "P422",
    expected: {
      outcome: "denied",
      statePredicates: ["stale-authorization-invalid", "possession-is-not-transfer-authority"],
      errorPredicates: [{ code: "AccessDenied", count: 1 }],
    },
  });
  const run = (error) => ({
    addresses: [],
    before: state({}),
    a: { reply: { decision: "allow", decision_proof: "access-decision:fresh" } },
    b: error == null ? { reply: { stale: { verified: true }, forged: { verified: true } } } : { error },
    after: state({}),
  });
  // What the real owner answered on 2026-09-05: both refused as stale-or-unauthorized-decision.
  assert.equal(operationPairOutcome(revoke, run("AccessDenied stale-tuple=stale-or-unauthorized-decision forged-actor=stale-or-unauthorized-decision")).holds, true);
  // Refused for the WRONG reason (the proof was not found at all) is a different defect, not a pass.
  const wrongReason = operationPairOutcome(revoke, run("AccessDenied stale-tuple=decision-not-found forged-actor=decision-not-found"));
  assert.ok(wrongReason.failed.includes("stale-authorization-invalid"));
  assert.ok(wrongReason.failed.includes("possession-is-not-transfer-authority"));
  // Both verified: the owner honoured a revoked tuple and a forged holder.
  const verified = operationPairOutcome(revoke, run(null));
  assert.ok(verified.failed.includes("stale-authorization-invalid"));
  assert.ok(verified.failed.includes("error:AccessDenied"));
});
