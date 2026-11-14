#!/usr/bin/env node
// packages/live-namespace/do-work/run-operation-pair-cases-against-the-running-app.mjs
//
// PURPOSE
// T12.9: take the operation-pair cases T12.8 compiled as DATA, execute each one's two
// operations against the REAL engine under the schedule the case names, read the state back,
// and judge it against the predicate the census row declared before anything ran.
//
// WHAT IT NEVER DOES
// Touch a partition other than the one it is told (a throwaway test partition, never
// `trillion`), invent an expected outcome, or let a case it cannot express vanish. A case whose
// executable target has no recipe here is REPORTED as unexecuted, because an unexecuted case
// that drops out of the count reads as a pass.
//
// HOW A SCHEDULE IS MADE REAL
//   sequential-a-b       await a; await b
//   sequential-b-a       await b; await a
//   concurrent-overlap   both dispatched with no ordering, both awaited
//   retry-replay         a; a again with the IDENTICAL request; then b
//   injected-partition   a probe is sent with a basis the app must refuse, then a and b run
//                        normally. A stale basis is the one partition a client can inject from
//                        its side without kill(), and it is the one that matters: it is exactly
//                        what a reconnecting client presents.
//
// USAGE (one line, absolute paths; the run guard matches the literal argv token)
//   node <pkg>/do-work/run-operation-pair-cases-against-the-running-app.mjs --engine 127.0.0.1:<port> --scheme http --partition operation-pair-test [--case-ids <id>,<id>]

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readCurrentRecord,
  sendRequestToRunningApp,
  startRunningAppSession,
  writeRecords,
} from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";
import { expectedCurrentFromContentHash } from "../read-data/expected-current-from-content-hash.mjs";
import { OPERATION_PAIR_CENSUS_SHAPE, operationPairCasesFromCensus } from "../read-data/operation-pair-cases.mjs";
import { operationPairOutcome } from "../read-data/operation-pair-outcome.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function optional(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function required(name) {
  const value = optional(name, null);
  if (value == null) throw new Error(`${name} is required`);
  return value;
}

/** The census rows are package DATA, read from the same place the T12.8 tests read them. */
function censusInput() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "things-to-store-and-run.json"), "utf8"));
  const pairs = manifest.things
    .filter((thing) => thing.address?.startsWith("package::live-namespace::operation-pair-case::"))
    .map((thing) => thing.payload);
  return {
    schemaVersion: OPERATION_PAIR_CENSUS_SHAPE,
    selectedCaseIds: pairs.map((pair) => pair.pairId),
    pairs,
  };
}

/** One state snapshot the judge can compare: found + payload hash per address. */
async function snapshot(session, partition, addresses) {
  const states = new Map();
  for (const address of addresses) {
    const reply = await readCurrentRecord(session, partition, address);
    states.set(address, { found: reply.found === true, payload_hash: reply.content_hash ?? null });
  }
  return states;
}

function record(partition, address, payload, expectedCurrent) {
  return {
    partition_label: partition,
    address_label: address,
    address_mode: "identity_text",
    path_labels: ["live-namespace", "operation-pair-test", "/cases"],
    ...(payload === undefined ? {} : { payload }),
    ...(expectedCurrent === undefined ? {} : { expected_current: expectedCurrent }),
  };
}

/**
 * Recipes: executableTarget -> how to make the two operations real.
 * Each returns `{ addresses, seed, a, b }`. `seed` runs BEFORE the pre-snapshot and may capture
 * the current hash so a guarded write can name what it saw. Adding a target is adding a row.
 */
const RECIPES = {
  "engine-operation.read-current-twice": ({ session, partition, run }) => {
    const address = `live-namespace::pair::${run}::read-read`;
    return {
      addresses: [address],
      seed: async () => writeRecords(session, [record(partition, address, { kind: "live-namespace.pair-fixture", run })]),
      a: async () => readCurrentRecord(session, partition, address),
      b: async () => readCurrentRecord(session, partition, address),
    };
  },

  "engine-operation.read-write-guarded": ({ session, partition, run }) => {
    const address = `live-namespace::pair::${run}::read-write`;
    let seen = null;
    return {
      addresses: [address],
      seed: async () => {
        await writeRecords(session, [record(partition, address, { kind: "live-namespace.pair-fixture", run, stage: "before" })]);
        seen = await readCurrentRecord(session, partition, address);
      },
      a: async () => readCurrentRecord(session, partition, address),
      b: async () => writeRecords(session, [
        record(partition, address, { kind: "live-namespace.pair-fixture", run, stage: "after" }, expectedCurrentFromContentHash(seen.content_hash)),
      ]),
    };
  },

  "engine-operation.write-write-conflict": ({ session, partition, run }) => {
    const address = `live-namespace::pair::${run}::write-write`;
    let seen = null;
    return {
      addresses: [address],
      seed: async () => {
        await writeRecords(session, [record(partition, address, { kind: "live-namespace.pair-fixture", run, stage: "before" })]);
        seen = await readCurrentRecord(session, partition, address);
      },
      // BOTH writers name the SAME expected current. Whichever lands second must be refused.
      a: async () => writeRecords(session, [
        record(partition, address, { kind: "live-namespace.pair-fixture", run, writer: "a" }, expectedCurrentFromContentHash(seen.content_hash)),
      ]),
      b: async () => writeRecords(session, [
        record(partition, address, { kind: "live-namespace.pair-fixture", run, writer: "b" }, expectedCurrentFromContentHash(seen.content_hash)),
      ]),
    };
  },

  "engine-operation.write-batch-replay": ({ session, partition, run }) => {
    const addresses = [1, 2, 3].map((n) => `live-namespace::pair::${run}::batch-${n}`);
    const batch = () => addresses.map((address, index) => record(partition, address, { kind: "live-namespace.pair-fixture", run, member: index + 1 }));
    return {
      addresses,
      seed: async () => {},
      a: async () => {
        const reply = await writeRecords(session, batch());
        const states = await snapshot(session, partition, addresses);
        return { ...reply, hashes_after: addresses.map((address) => states.get(address).payload_hash) };
      },
      b: async () => writeRecords(session, batch()),
    };
  },

  "engine-operation.rename-delete-atomic": ({ session, partition, run }) => {
    const oldName = `live-namespace::pair::${run}::name-old`;
    const newName = `live-namespace::pair::${run}::name-new`;
    const locator = `live-namespace::pair::${run}::locator`;
    let seen = null;
    return {
      addresses: [oldName, newName, locator],
      seed: async () => {
        await writeRecords(session, [
          record(partition, locator, { kind: "live-namespace.pair-fixture", run, role: "locator" }),
          record(partition, oldName, { kind: "live-namespace.pair-fixture", run, role: "name" }),
        ]);
        seen = await readCurrentRecord(session, partition, oldName);
      },
      // rename = ONE batch: retract old (guarded on what we saw) + create new.
      a: async () => writeRecords(session, [
        record(partition, oldName, undefined, expectedCurrentFromContentHash(seen.content_hash)),
        record(partition, newName, { kind: "live-namespace.pair-fixture", run, role: "name" }),
      ]),
      // delete = retract old, guarded on the same expectation.
      b: async () => writeRecords(session, [
        record(partition, oldName, undefined, expectedCurrentFromContentHash(seen.content_hash)),
      ]),
    };
  },

  // P252 fork racing merge. A fork is a NEW record at a scoped address that names the identity
  // it forked from; it never touches the original. "Merge" in this engine is not a verb: the
  // only way to see the original is to read it, so `b` is that read, and the judge proves the
  // original's identity never moved and that no merge record appeared anywhere.
  "engine-operation.fork-scope-only": ({ session, partition, run }) => {
    const original = `live-namespace::pair::${run}::original`;
    const fork = `live-namespace::pair::${run}::fork`;
    const merge = `live-namespace::pair::${run}::merge`;
    let seen = null;
    return {
      addresses: [original, fork, merge],
      seed: async () => {
        await writeRecords(session, [record(partition, original, { kind: "live-namespace.pair-fixture", run, role: "original" })]);
        seen = await readCurrentRecord(session, partition, original);
      },
      // Unguarded on purpose: a fork carries its basis IN the payload, so replaying it is
      // idempotent and racing it with a read cannot conflict.
      a: async () => writeRecords(session, [
        record(partition, fork, { kind: "live-namespace.pair-fixture", run, role: "fork", forked_from: seen.content_hash }),
      ]),
      b: async () => readCurrentRecord(session, partition, original),
    };
  },

  // P377 restore racing garbage-collect. Restore is a pointer move: current goes back to the
  // earlier payload, so its hash returns to the earlier hash. Garbage-collect is not an
  // admitted verb: `b` proves the superseded bytes are still readable by their hash through
  // read-cas-range, and records the engine's own refusal of a reclaim label.
  "engine-operation.restore-pointer-only": ({ session, partition, run }) => {
    const pointer = `live-namespace::pair::${run}::pointer`;
    const earlier = { kind: "live-namespace.pair-fixture", run, stage: "earlier" };
    const later = { kind: "live-namespace.pair-fixture", run, stage: "later", padding: "x".repeat(64) };
    let earlierHash = null;
    let laterHash = null;
    return {
      addresses: [pointer],
      seed: async () => {
        await writeRecords(session, [record(partition, pointer, earlier)]);
        earlierHash = (await readCurrentRecord(session, partition, pointer)).content_hash;
        await writeRecords(session, [record(partition, pointer, later, expectedCurrentFromContentHash(earlierHash))]);
        laterHash = (await readCurrentRecord(session, partition, pointer)).content_hash;
      },
      // Unguarded: restoring to the same bytes twice is idempotent, which is what a replayed
      // restore must be.
      a: async () => ({ ...(await writeRecords(session, [record(partition, pointer, earlier)])), restored_to: earlierHash }),
      b: async () => {
        const bytes = await sendRequestToRunningApp(session, "engine.operation.label-addressed", {
          operation_label: "engine.operation.read-cas-range",
          partition_label: partition,
          content_hash: laterHash,
          offset: 0,
          length: 16,
        });
        const reclaim = await observe(() => sendRequestToRunningApp(session, "engine.operation.label-addressed", {
          operation_label: "engine.operation.reclaim-unreferenced",
          partition_label: partition,
          content_hash: laterHash,
        }));
        return { ...bytes, superseded_hash: laterHash, reclaim_refused: reclaim.error ?? null };
      },
    };
  },

  // P422 revoke racing evict, owned by access-rule. A decision is minted by the owner; "revoke"
  // is a new revision (the owner keys authority on an exact revision tuple), and "evict" is a
  // recipient presenting the OLD tuple. The owner must answer verified:false for the stale
  // tuple whatever order the two land in, and holding the proof string must not be authority.
  // The owner reads its partition from the runtime, not from us, so this recipe touches no
  // address on the test partition; the judge reads the owner's replies.
  "access-rule.revision-decision": ({ session, run }) => {
    const request = () => ({
      kind: "access-decision-request",
      correlation_id: `correlation:pair-${run}`,
      subject_ref: `subject:pair-${run}`,
      action_ref: "action:pair-test",
      authorized_action_refs: ["action:pair-test"],
      constraints: {},
      predicate_ref: "predicate:pair-test",
      predicate_binding: { any: "opaque" },
      context: { any: "opaque" },
      ambient_actor: { actor_ref: `actor:pair-${run}`, session_ref: `session:pair-${run}`, session_revision: "session:1" },
      revisions: { session_revision: "session:1", policy_revision: "policy:1", membership_revision: "membership:1", resource_revision: "resource:1" },
    });
    let decision = null;
    return {
      addresses: [],
      seed: async () => {
        decision = await sendRequestToRunningApp(session, "access-rule.evaluate", request());
      },
      // revoke: the policy revision moves, minting a fresh proof under the new tuple.
      a: async () => sendRequestToRunningApp(session, "access-rule.evaluate", {
        ...request(),
        revisions: { ...request().revisions, policy_revision: "policy:2" },
      }),
      // evict: a recipient presents the ORIGINAL proof under the tuple it now sees (the revoked
      // policy revision), and then a forger presents the same proof under a different actor.
      // The owner answers with a structured refusal rather than throwing; that refusal IS the
      // denial the census declared, so it is surfaced as the operation's error, with each
      // reason named, and the judges read the reasons.
      b: async () => {
        const verify = (overrides) => sendRequestToRunningApp(session, "access-rule.verify-decision", {
          decision_proof: decision.decision_proof,
          actor_ref: decision.actor_ref,
          session_ref: decision.session_ref,
          subject_ref: decision.subject_ref,
          action_ref: "action:pair-test",
          revisions: { ...request().revisions, policy_revision: "policy:2" },
          ...overrides,
        });
        const stale = await verify({});
        const forged = await verify({ actor_ref: `actor:forged-${run}`, revisions: request().revisions });
        if (stale.verified === false || forged.verified === false) {
          throw new Error(`AccessDenied stale-tuple=${stale.reason ?? "verified"} forged-actor=${forged.reason ?? "verified"}`);
        }
        return { stale, forged };
      },
    };
  },
};

async function observe(operation) {
  try {
    return { reply: await operation() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

async function underSchedule(schedule, recipe, session, partition) {
  switch (schedule) {
    case "sequential-a-b": {
      const a = await observe(recipe.a);
      const b = await observe(recipe.b);
      return { a, b };
    }
    case "sequential-b-a": {
      const b = await observe(recipe.b);
      const a = await observe(recipe.a);
      return { a, b };
    }
    case "concurrent-overlap": {
      const [a, b] = await Promise.all([observe(recipe.a), observe(recipe.b)]);
      return { a, b };
    }
    case "retry-replay": {
      // The judge must see BOTH attempts. Reporting only the replay hid the fact that the first
      // attempt landed, which made a correct engine look like it had half-applied a rename.
      const first = await observe(recipe.a);
      const replay = await observe(recipe.a);
      const b = await observe(recipe.b);
      return { a: { ...replay, first_attempt: first }, b };
    }
    case "injected-partition": {
      const stale = { ...session, basis: `${session.basis}-stale` };
      const probe = await observe(() => sendRequestToRunningApp(stale, "engine.operation.label-addressed", {
        operation_label: "engine.operation.read-current",
        partition_label: partition,
        address_label: recipe.addresses[0],
        address_mode: "identity_text",
      }));
      const a = await observe(recipe.a);
      const b = await observe(recipe.b);
      return { a, b, probe };
    }
    default:
      throw new Error(`no execution for schedule ${schedule}`);
  }
}

try {
  const session = await startRunningAppSession({ url: `${optional("--scheme", "http")}://${required("--engine")}` });
  const partition = required("--partition");
  if (partition === "trillion") throw new Error("refusing to run interleaving cases against the trillion partition");
  const selectedRaw = optional("--case-ids", null);
  const selected = selectedRaw == null ? null : new Set(selectedRaw.split(",").map((s) => s.trim()).filter(Boolean));

  const compiled = operationPairCasesFromCensus(censusInput());
  const verdicts = [];
  const unexecuted = [];

  for (const compiledCase of compiled.cases) {
    if (selected != null && !selected.has(compiledCase.caseId)) continue;
    const makeRecipe = RECIPES[compiledCase.executableTarget];
    if (makeRecipe == null) {
      unexecuted.push({ caseId: compiledCase.caseId, executableTarget: compiledCase.executableTarget, reason: "no execution recipe for this target" });
      continue;
    }
    const run = randomBytes(6).toString("hex");
    const recipe = makeRecipe({ session, partition, run });
    await recipe.seed();
    const before = await snapshot(session, partition, recipe.addresses);
    const { a, b, probe } = await underSchedule(compiledCase.schedule, recipe, session, partition);
    const after = await snapshot(session, partition, recipe.addresses);
    const verdict = operationPairOutcome(compiledCase, { addresses: recipe.addresses, before, a, b, after });
    verdicts.push({ ...verdict, ...(probe ? { stale_basis_probe: probe.error ?? "ACCEPTED (defect: stale basis was not refused)" } : {}) });
    process.stderr.write(`${verdict.holds ? "PASS" : "FAIL"} ${verdict.caseId}${verdict.holds ? "" : ` -> ${verdict.failed.join(", ")}`}\n`);
  }

  const summary = {
    cases_compiled: compiled.cases.length,
    deferred: compiled.summary.deferred.length,
    executed: verdicts.length,
    held: verdicts.filter((v) => v.holds).length,
    failed: verdicts.filter((v) => !v.holds).map((v) => ({ caseId: v.caseId, failed: v.failed, judged: v.judged.filter((j) => !j.holds) })),
    stale_basis_probes: verdicts.filter((v) => v.stale_basis_probe).map((v) => ({ caseId: v.caseId, result: v.stale_basis_probe })),
    unexecuted,
    partition,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exitCode = 1;
}
