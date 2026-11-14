// packages/live-namespace/tests/residual-read-demand-from-receiver-facts.test.mjs
//
// Hostile proof for receiver-relative residual demand. Each rejection prevents a byte being
// inferred from a fact that does not describe exactly this receiver, state, authorization, and
// immutable identity.

import assert from "node:assert/strict";
import test from "node:test";

import {
  RESIDUAL_READ_SHAPE,
  ResidualDemandError,
  residualReadDemandFromReceiverFacts,
} from "../read-data/residual-read-demand-from-receiver-facts.mjs";
import { DIRECT_EDGE_ID, DISPATCH_BUDGET_POLICY, RESOURCE_COUNTERS } from "../read-data/capability-edges.mjs";

const IDENTITY = "12:3300f2037090fbc433ce4f405d016aa949de441b1d7791c8aa0128361db7fedd";

function demand(overrides = {}) {
  return {
    schemaVersion: RESIDUAL_READ_SHAPE,
    receiverId: "receiver-a",
    identity: IDENTITY,
    receiverStateVersion: "state-17",
    authorization: { subject: "receiver-a", grantId: "read-9", version: 3 },
    range: { offset: 100, length: 100 },
    ...overrides,
  };
}

function fact(overrides = {}) {
  return {
    schemaVersion: RESIDUAL_READ_SHAPE,
    receiverId: "receiver-a",
    identity: IDENTITY,
    receiverStateVersion: "state-17",
    authorization: { subject: "receiver-a", grantId: "read-9", version: 3 },
    interval: { offset: 120, length: 20 },
    verified: true,
    ...overrides,
  };
}

function missingOffsets(plan) {
  return plan.missing.map(({ offset, length }) => [offset, length]);
}

test("with no facts, the only plan is the caller's exact demand, never an inferred source", () => {
  const plan = residualReadDemandFromReceiverFacts({ demand: demand(), receiverFacts: [] });
  assert.deepEqual(missingOffsets(plan), [[100, 100]]);
  assert.deepEqual(plan.fallback, {
    kind: "live-namespace.exact-read",
    identity: IDENTITY,
    offset: 100,
    length: 100,
    useWhen: "facts are absent, stale, or do not converge",
  });
  assert.equal(plan.coldAccounting.factsSupplied, 0);
  assert.equal(plan.coldAccounting.missingBytes, 100);
  assert.equal(plan.coldAccounting.inferredNetworkByteCount, 0);
  assert.equal(plan.coldAccounting.inferredNetworkSpeed, null);
});

test("facts outside the demand are clamped, and only their overlap is credited", () => {
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand(),
    receiverFacts: [
      fact({ interval: { offset: 0, length: 105 } }),
      fact({ interval: { offset: 210, length: 20 } }),
    ],
  });
  assert.deepEqual(missingOffsets(plan), [[105, 95]]);
  assert.equal(plan.coldAccounting.explicitVerifiedBytesWithinDemand, 5);
  assert.equal(plan.coldAccounting.factsSupplied, 2);
});

test("overlapping and adjacent facts normalize into known runs and split exact holes", () => {
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ range: { offset: 0, length: 100 } }),
    receiverFacts: [
      fact({ interval: { offset: 40, length: 20 } }),
      fact({ interval: { offset: 50, length: 5 } }),
      fact({ interval: { offset: 70, length: 20 } }),
      fact({ interval: { offset: 0, length: 10 } }),
      fact({ interval: { offset: 10, length: 10 } }),
      fact({ interval: { offset: 95, length: 5 } }),
    ],
  });
  assert.deepEqual(missingOffsets(plan), [[20, 20], [60, 10], [90, 5]]);
  assert.equal(plan.coldAccounting.explicitVerifiedBytesWithinDemand, 65);
  assert.equal(plan.coldAccounting.missingBytes, 35);
  assert.equal(plan.coldAccounting.explicitFactCoverageRatio, 0.65);
});

test("a complete explicit fact set leaves no missing read while preserving the fallback", () => {
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ range: { offset: 10, length: 10 } }),
    receiverFacts: [fact({ interval: { offset: 10, length: 10 } })],
  });
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(missingOffsets(plan), []);
  assert.equal(plan.coldAccounting.missingBytes, 0);
  assert.equal(plan.coldAccounting.explicitFactCoverageRatio, 1);
  assert.equal(plan.fallback.length, 10);
});

test("schema, receiver, state, identity, and authorization mismatches fail closed", () => {
  const mismatch = (overrides, label) => () => residualReadDemandFromReceiverFacts({
    demand: demand(),
    receiverFacts: [fact(overrides)],
  });
  assert.throws(mismatch({ schemaVersion: "live-namespace.residual-read-from-assumed-facts" }), ResidualDemandError);
  assert.throws(mismatch({ receiverId: "receiver-b" }), ResidualDemandError);
  assert.throws(mismatch({ receiverStateVersion: "state-18" }), ResidualDemandError);
  assert.throws(mismatch({ identity: "12:5ec4d3cbc9374276b83b5333f5251c28518c6749a924a93a044a614975e165f0" }), ResidualDemandError);
  assert.throws(mismatch({ authorization: { subject: "receiver-a", grantId: "read-9", version: 4 } }), ResidualDemandError);
  assert.throws(mismatch({ authorization: { subject: "receiver-a", grantId: "read-10", version: 3 } }), ResidualDemandError);
  assert.throws(mismatch({ verified: false }), ResidualDemandError);
});

test("demand version or authorization mismatch is refused before any arithmetic", () => {
  assert.throws(() => residualReadDemandFromReceiverFacts({
    demand: demand({ schemaVersion: "receiver-cache-with-similar-representation" }),
    receiverFacts: [],
  }), ResidualDemandError);
  assert.throws(() => residualReadDemandFromReceiverFacts({
    demand: demand({ authorization: { subject: "receiver-a", grantId: "other", version: 3 } }),
    receiverFacts: [fact()],
  }), ResidualDemandError);
});

test("a hostile mix containing one invalid fact produces no plan, not partial trust", () => {
  assert.throws(() => residualReadDemandFromReceiverFacts({
    demand: demand({ range: { offset: 0, length: 20 } }),
    receiverFacts: [fact({ interval: { offset: 0, length: 20 } }), fact({ verified: false })],
  }), ResidualDemandError);
});

test("names, equivalent identities, and semantic proxy fields are not byte facts", () => {
  const rejected = [
    fact({ identity: "holiday movie final" }),
    fact({ identity: IDENTITY.toUpperCase() }),
    fact({ equivalentIdentity: "12:5ec4d3cbc9374276b83b5333f5251c28518c6749a924a93a044a614975e165f0" }),
    fact({ semanticKey: "same-movie" }),
    fact({ proxy: { target: "cdn" } }),
    fact({ sourcePath: "/Volumes/Expansion/movie.mp4" }),
  ];
  for (const semanticFact of rejected) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand(), receiverFacts: [semanticFact] }),
      (error) => error instanceof ResidualDemandError,
    );
  }
});

test("malformed demand ranges and fact intervals are refused, not clamped into a claim", () => {
  const cases = [
    { demand: demand({ range: { offset: -1, length: 10 } }), facts: [] },
    { demand: demand({ range: { offset: 0, length: 0 } }), facts: [] },
    { demand: demand({ range: { offset: 0, length: 1.5 } }), facts: [] },
    { demand: demand({ range: { offset: 0, length: 10, end: 9 } }), facts: [] },
    {
      demand: demand(),
      facts: [fact({ interval: { offset: 100, length: Number.MAX_SAFE_INTEGER } })],
    },
  ];
  for (const input of cases) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: input.demand, receiverFacts: input.facts }),
      ResidualDemandError,
    );
  }
});

// Full demand contract (plan section 14.4), T12.12. Each field is carried exactly or refused.

function budget(overrides = {}) {
  return {
    resource: Object.fromEntries(RESOURCE_COUNTERS.map((counter) => [counter, 1_000_000])),
    monetary: null,
    ...overrides,
  };
}

test("an omitted extension defaults to exact bytes, no budget, and the direct read, admitting nothing", () => {
  const plan = residualReadDemandFromReceiverFacts({ demand: demand(), receiverFacts: [] });
  assert.equal(plan.demandContract.fidelity, "exact");
  assert.equal(plan.demandContract.subjectKind, "immutable-bytes");
  assert.equal(plan.demandContract.logicalObject, null);
  assert.equal(plan.demandContract.immutableVersion, IDENTITY);
  assert.deepEqual(plan.demandContract.observable, { kind: "byte-range", offset: 100, length: 100 });
  assert.deepEqual(plan.demandContract.freshness.value, "state-17");
  assert.equal(plan.demandContract.deadline.value, null);
  assert.equal(plan.demandContract.budget, null);
  assert.deepEqual(plan.demandContract.fallbackPolicy, { whenNoVerifiedFacts: DIRECT_EDGE_ID });
  assert.equal(plan.feasibility.budgetSupplied, false);
  assert.equal(plan.feasibility.admitted, false);
  assert.equal(plan.monetaryAccounting.priced, false);
});

test("a fidelity other than exact is refused: a semantic result never satisfies a byte demand", () => {
  for (const fidelity of ["approximate", "semantic", "lossy", "same-media", "", null, 1]) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand({ fidelity }), receiverFacts: [] }),
      (error) => error instanceof ResidualDemandError && error.details.field === "demand.fidelity",
      String(fidelity),
    );
  }
});

test("an exact-result demand is refused by name and routed to the capability-edge owner", () => {
  assert.throws(
    () => residualReadDemandFromReceiverFacts({ demand: demand({ subjectKind: "exact-result" }), receiverFacts: [] }),
    (error) => error instanceof ResidualDemandError && error.details.owner === "live-namespace capability-edges",
  );
});

test("a logical object is carried opaque and contributes no byte fact", () => {
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ logicalObject: "holiday movie final" }),
    receiverFacts: [],
  });
  assert.equal(plan.demandContract.logicalObject, "holiday movie final");
  assert.equal(plan.coldAccounting.explicitVerifiedBytesWithinDemand, 0);
  assert.throws(
    () => residualReadDemandFromReceiverFacts({ demand: demand({ logicalObject: "" }), receiverFacts: [] }),
    ResidualDemandError,
  );
});

test("a budget names exactly the capability-edge resource counters, each a finite nonnegative bound", () => {
  const plan = residualReadDemandFromReceiverFacts({ demand: demand({ budget: budget() }), receiverFacts: [] });
  assert.deepEqual(Object.keys(plan.demandContract.budget.resource), [...RESOURCE_COUNTERS]);
  assert.equal(plan.demandContract.deadline.owner, "budget.resource.wall_time");
  assert.equal(plan.demandContract.deadline.value, 1_000_000);
  assert.equal(plan.feasibility.budgetSupplied, true);
  assert.equal(plan.feasibility.admitted, true);
  assert.equal(plan.feasibility.rule, DISPATCH_BUDGET_POLICY);

  const { payload_bytes, ...missingOne } = budget().resource;
  const hostile = [
    budget({ resource: missingOne }),
    budget({ resource: { ...budget().resource, gpu_time: 5 } }),
    budget({ resource: { ...budget().resource, cpu_time: -1 } }),
    budget({ resource: { ...budget().resource, wall_time: Number.POSITIVE_INFINITY } }),
    budget({ resource: { ...budget().resource, page_cache: "unbounded" } }),
    budget({ resource: { ...budget().resource, payload_bytes: Number.NaN } }),
    { resource: budget().resource },
    budget({ deadline: 5 }),
  ];
  for (const bad of hostile) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand({ budget: bad }), receiverFacts: [] }),
      ResidualDemandError,
      JSON.stringify(bad),
    );
  }
});

test("exact holes larger than the payload bound refuse dispatch instead of trimming the demand", () => {
  const tight = budget({ resource: { ...budget().resource, payload_bytes: 50 } });
  assert.throws(
    () => residualReadDemandFromReceiverFacts({ demand: demand({ budget: tight }), receiverFacts: [] }),
    (error) => error instanceof ResidualDemandError
      && error.details.exceeded[0].counter === "payload_bytes"
      && error.details.exceeded[0].required === 100
      && error.details.exceeded[0].bound === 50,
  );
  // The same bound admits once verified facts shrink the holes to fit.
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ budget: tight }),
    receiverFacts: [fact({ interval: { offset: 100, length: 60 } })],
  });
  assert.equal(plan.coldAccounting.missingBytes, 40);
  assert.equal(plan.feasibility.admitted, true);
});

test("a monetary ceiling is carried in one declared currency and prices nothing", () => {
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ budget: budget({ monetary: { amount_inclusive: 0.25, currency: "USD" } }) }),
    receiverFacts: [],
  });
  assert.deepEqual(plan.monetaryAccounting.budget, { amount_inclusive: 0.25, currency: "USD" });
  assert.equal(plan.monetaryAccounting.priced, false);
  for (const monetary of [
    { amount_inclusive: -1, currency: "USD" },
    { amount_inclusive: 1, currency: "dollars" },
    { amount_inclusive: "1", currency: "USD" },
    { amount_inclusive: 1, currency: "USD", per: "month" },
    { amount_inclusive: Number.POSITIVE_INFINITY, currency: "USD" },
  ]) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand({ budget: budget({ monetary }) }), receiverFacts: [] }),
      ResidualDemandError,
      JSON.stringify(monetary),
    );
  }
});

test("a receiver may refuse the direct read when no verified fact covers the demand, and only then", () => {
  const refuse = { whenNoVerifiedFacts: "refuse" };
  assert.throws(
    () => residualReadDemandFromReceiverFacts({ demand: demand({ fallbackPolicy: refuse }), receiverFacts: [] }),
    (error) => error instanceof ResidualDemandError && error.details.field === "demand.fallbackPolicy.whenNoVerifiedFacts",
  );
  // A fact outside the demand window is not coverage.
  assert.throws(
    () => residualReadDemandFromReceiverFacts({
      demand: demand({ fallbackPolicy: refuse }),
      receiverFacts: [fact({ interval: { offset: 0, length: 50 } })],
    }),
    ResidualDemandError,
  );
  const plan = residualReadDemandFromReceiverFacts({
    demand: demand({ fallbackPolicy: refuse }),
    receiverFacts: [fact()],
  });
  assert.deepEqual(missingOffsets(plan), [[100, 20], [140, 60]]);
  for (const policy of [{ whenNoVerifiedFacts: "nearest-peer" }, { whenNoVerifiedFacts: "cdn" }, { onStale: "refuse" }, "refuse"]) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand({ fallbackPolicy: policy }), receiverFacts: [] }),
      ResidualDemandError,
      JSON.stringify(policy),
    );
  }
});

test("freshness and deadline have exactly one owner each; a second field for either is refused", () => {
  for (const extra of [{ freshness: "state-17" }, { deadline: 5000 }, { staleness: 0 }, { version: 1 }]) {
    assert.throws(
      () => residualReadDemandFromReceiverFacts({ demand: demand(extra), receiverFacts: [] }),
      (error) => error instanceof ResidualDemandError && error.details.field === "demand",
      JSON.stringify(extra),
    );
  }
});

test("inputs are never mutated by normalization", () => {
  const immutableDemand = demand();
  const immutableFact = fact({ interval: { offset: 90, length: 30 } });
  const demandCopy = structuredClone(immutableDemand);
  const factCopy = structuredClone(immutableFact);
  residualReadDemandFromReceiverFacts({ demand: immutableDemand, receiverFacts: [immutableFact] });
  assert.deepEqual(immutableDemand, demandCopy);
  assert.deepEqual(immutableFact, factCopy);
});
