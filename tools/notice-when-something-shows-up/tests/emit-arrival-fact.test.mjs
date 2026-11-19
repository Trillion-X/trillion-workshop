// packages/notice-when-something-shows-up/tests/emit-arrival-fact.test.mjs
//
// Hostile proof for the resident emitter. Every test drives the real pure functions and the
// real resident loop through a FAKE carrier, so nothing here opens a socket or a volume.
//
// The proofs the plan's capability ledger names, in order:
//   1. clock parity: the clock waiter row reproduces the clock-tick record byte for byte
//   2. an unmatched appearance is a fact, not an error
//   3. departure emits
//   4. two volumes sharing a visible name are told apart by identity, never by name
//   5. the emitter never dispatches (no workflow target, no consumer, no action id)
//   6. a refused waiter row is recorded as a fact

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARRIVAL_FIELDS,
  CONDITIONS,
  WaiterRowRefused,
  buildScope,
  candidatesFromFeedEntries,
  currentAddressFromFile,
  identityMatches,
  makeCarrier,
  matchedSourceRefs,
  nextObservedAt,
  readWaiterRow,
  resolveMechanism,
  resolveRunningShellConfig,
  resumeSequenceFrom,
  runResidentEmitter,
  selectPayload,
  shouldHandOverAfterFailures,
} from "../do-work/emit-arrival-fact.mjs";
import * as elapsedTime from "../do-work/mechanisms/elapsed-time.mjs";
import * as volumeAttachment from "../do-work/mechanisms/filesystem-volume-attachment.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(packageRoot, "things-to-store-and-run.json"), "utf8"));

test("local carrier resolves its stable app through the shared owner on every operation", async () => {
  let generation = 0;
  const owner = {
    async startRunningAppSession(selector) {
      assert.deepEqual(selector, { appId: "fixture-app" });
      return { generation: ++generation };
    },
    async sendRequestToRunningApp(session, target, body) {
      assert.equal(target, "engine.operation.label-addressed");
      assert.equal(body.partition_label, "fixture-partition");
      return session.generation;
    },
  };
  const carrier = makeCarrier({ appId: "fixture-app", partition: "fixture-partition", loadOwner: async () => owner });
  assert.equal(await carrier.readCurrent("one"), 1);
  assert.equal(await carrier.readCurrent("two"), 2);
  assert.deepEqual(await Promise.all([carrier.readCurrent("three"), carrier.readCurrent("four")]), [3, 4]);
});

test("arrival DATA carries app identity and mounts the canonical connector without transport fields", () => {
  assert.doesNotMatch(JSON.stringify(MANIFEST), /bf-fwd-|forwarding_socket|shell_socket_path|carrier_socket_path|BITFIELD_TARGET_CARRIER_SOCKET/);
  const action = MANIFEST.things.find(row => row.payload?.id === "action:notice-when-something-shows-up:start-waiting").payload;
  const ownerRead = action.steps.find(step => step.id === "read_running_app_owner");
  assert.equal(ownerRead.config.from, "package::send-requests-to-an-engine::stored-bytes::find-and-send-node-source");
  const process = action.steps.find(step => step.kind === "ask").config.input.descriptor.process;
  assert.equal(process.env.RUNNING_APP_APP_ID.select.path, "app_id");
  assert.equal(process.inputs.find(input => input.mount_path === "running-app-requests.mjs").source.hash.select.key, ownerRead.id);
});
const waiterRows = MANIFEST.things
  .filter((thing) => thing.payload?.kind === "notice-when-something-shows-up.waiter-descriptor")
  .map((thing) => thing.payload);
const CLOCK_ROW = waiterRows.find((row) => row.id === "waiter:elapsed-time");
const VOLUME_ROW = waiterRows.find((row) => row.id === "waiter:attached-volumes");

// Read off the running app on 2026-09-05 (address clock::tick, partition trillion). The
// predecessor wrote exactly these keys in exactly this order. Frozen here so the parity
// proof survives the predecessor's deletion.
const PREDECESSOR_TICK_TEXT = "{\"kind\":\"clock-tick\",\"iso_time\":\"2026-09-04T15:15:27.436Z\",\"epoch_ms\":1788534927436,\"counter\":16,\"every\":\"interval\"}";

function fakeCarrier({ waiters = waiterRows, feed = [], current = {} } = {}) {
  const writes = [];
  return {
    writes,
    async scanUnderPath(pathLabels) {
      const key = pathLabels.join("/");
      if (key === "packages/notice-when-something-shows-up/waiter-descriptor") {
        return { entries: waiters.map((payload) => ({ payload })) };
      }
      if (key === "prop:observed_content:source_descriptor") return { entries: feed };
      return { entries: [] };
    },
    async readCurrent(addressLabel) {
      if (!(addressLabel in current)) throw new Error("not found");
      return { found: true, payload: current[addressLabel] };
    },
    async writeRecord(write) {
      writes.push(write);
      return { ok: true };
    },
  };
}

function loadModuleFrom(map) {
  return async (leaf) => {
    if (!(leaf in map)) throw new Error(`no such leaf ${leaf}`);
    return map[leaf];
  };
}

test("1. clock parity: the clock waiter row projects the predecessor's record byte for byte", () => {
  const predecessor = JSON.parse(PREDECESSOR_TICK_TEXT);
  const transition = {
    condition: CONDITIONS.reachable,
    observed_identity: { elapsed_seconds: 45, every: "interval" },
    detail: elapsedTime.buildDetail(CLOCK_ROW.mechanism_settings, predecessor.counter, predecessor.epoch_ms),
  };
  const scope = buildScope(readWaiterRow(CLOCK_ROW), transition, {
    observedAt: predecessor.iso_time,
    sequence: predecessor.counter,
    matched: [],
  });
  const payload = selectPayload(CLOCK_ROW.emitted_record.change_kind, CLOCK_ROW.emitted_record.payload_fields, scope);
  assert.equal(JSON.stringify(payload), PREDECESSOR_TICK_TEXT);
  assert.equal(CLOCK_ROW.emitted_record.address_label, "clock::tick");
  assert.deepEqual(CLOCK_ROW.emitted_record.path_labels, ["current-item", "clock-tick"]);
  // The sequence resumes from the predecessor's counter, so the supersession is continuous.
  assert.equal(resumeSequenceFrom({ payload: predecessor }), 17);
});

test("1b. the clock's interval and schedule descriptor match what the predecessor ran with", () => {
  assert.equal(CLOCK_ROW.mechanism_settings.interval_seconds, 45);
  assert.equal(CLOCK_ROW.mechanism_settings.every, "interval");
});

test("2. an appearance nobody declared is a fact with empty matched_source_refs, not an error", async () => {
  const carrier = fakeCarrier({ waiters: [VOLUME_ROW], feed: [] });
  const controller = new AbortController();
  const mechanism = {
    describeMechanism: volumeAttachment.describeMechanism,
    async watchForTransitions(_settings, handlers) {
      await handlers.onTransition({
        condition: CONDITIONS.reachable,
        observed_identity: { filesystem_identity: "FS-UNDECLARED", attachment_path: "/Volumes/Mystery", visible_name: "Mystery" },
        detail: {},
      });
      controller.abort();
    },
  };
  await runResidentEmitter({
    env: {},
    carrier,
    loadModule: loadModuleFrom({ "filesystem-volume-attachment.mjs": mechanism }),
    signal: controller.signal,
    nowMs: () => 1_800_000_000_000,
  });
  assert.equal(carrier.writes.length, 1);
  const fact = carrier.writes[0].payload;
  assert.equal(fact.kind, "something-showed-up");
  assert.deepEqual(fact.matched_source_refs, []);
  assert.equal(fact.condition, CONDITIONS.reachable);
  assert.equal(fact.sequence, 0);
  assert.deepEqual(Object.keys(fact), ["kind", ...ARRIVAL_FIELDS]);
  assert.equal(carrier.writes[0].addressLabel, "something-showed-up::attached-volumes");
});

test("3. departure emits the same fact with the departure polarity, and sequence advances", async () => {
  const carrier = fakeCarrier({ waiters: [VOLUME_ROW] });
  const controller = new AbortController();
  const identity = { filesystem_identity: "FS-A", attachment_path: "/Volumes/A", visible_name: "A" };
  const mechanism = {
    describeMechanism: volumeAttachment.describeMechanism,
    async watchForTransitions(_settings, handlers) {
      await handlers.onTransition({ condition: CONDITIONS.reachable, observed_identity: identity, detail: {} });
      await handlers.onTransition({ condition: CONDITIONS.unreachable, observed_identity: identity, detail: {} });
      controller.abort();
    },
  };
  let now = 1_800_000_000_000;
  await runResidentEmitter({
    env: {},
    carrier,
    loadModule: loadModuleFrom({ "filesystem-volume-attachment.mjs": mechanism }),
    signal: controller.signal,
    nowMs: () => now,
  });
  assert.equal(carrier.writes.length, 2);
  assert.equal(carrier.writes[0].payload.condition, CONDITIONS.reachable);
  assert.equal(carrier.writes[1].payload.condition, CONDITIONS.unreachable);
  assert.equal(carrier.writes[0].payload.sequence, 0);
  assert.equal(carrier.writes[1].payload.sequence, 1);
  // observed_at never moves backward even when the wall clock did not advance.
  assert.ok(carrier.writes[1].payload.observed_at > carrier.writes[0].payload.observed_at);
});

test("4. two volumes sharing a visible name are told apart by filesystem identity, never by name", async () => {
  const feed = [
    { payload: { value_json: JSON.stringify({ source_ref: "source:camera-a", identity_predicate: { claims: [{ select: { from: "observed_identity", path: "filesystem_identity" }, operator: "op:core.equals", value: "FS-A" }] } }) } },
    { payload: { value_json: JSON.stringify({ source_ref: "source:camera-b", identity_predicate: { claims: [{ select: { from: "observed_identity", path: "filesystem_identity" }, operator: "op:core.equals", value: "FS-B" }] } }) } },
    // A descriptor with no predicate has not said which thing it is, and matches nothing.
    { payload: { value_json: JSON.stringify({ source_ref: "source:undeclared-identity" }) } },
  ];
  const candidates = candidatesFromFeedEntries(feed, VOLUME_ROW.candidate_identity_feed);
  assert.equal(candidates.length, 3);
  const sameName = (fs) => ({ filesystem_identity: fs, attachment_path: "/Volumes/1TB SSD", visible_name: "1TB SSD" });
  assert.deepEqual(matchedSourceRefs(sameName("FS-A"), candidates), ["source:camera-a"]);
  assert.deepEqual(matchedSourceRefs(sameName("FS-B"), candidates), ["source:camera-b"]);
  assert.deepEqual(matchedSourceRefs(sameName(null), candidates), []);
  // A predicate over the visible name is refused as unusable, not evaluated.
  assert.throws(() => identityMatches({ claims: [{ select: { from: "visible_name", path: "x" }, operator: "op:core.equals", value: "1TB SSD" }] }, sameName("FS-A")));
  assert.throws(() => identityMatches({ claims: [{ select: { from: "observed_identity", path: "filesystem_identity" }, operator: "op:core.contains", value: "FS" }] }, sameName("FS-A")));
});

test("5. the emitter never dispatches: no workflow target, no consumer, no action id in code or DATA", () => {
  const emitterSource = readFileSync(path.join(packageRoot, "do-work/emit-arrival-fact.mjs"), "utf8");
  for (const banned of ["slot::workflow", "execute_definition", "definition_id", "observe-content-sources", "observed-content::", "removable", "Expansion"]) {
    assert.equal(emitterSource.includes(banned), false, `emitter source names ${banned}`);
  }
  for (const row of waiterRows) {
    // Only the fields the emitter READS are checked. `supersedes` and `why` are lineage prose
    // for a human and are never dereferenced by code.
    const { supersedes, why, ...read } = row;
    const text = JSON.stringify(read);
    for (const banned of ["slot::", "execute_definition", "definition_id", "action:"]) {
      assert.equal(text.includes(banned), false, `waiter ${row.id} names ${banned}`);
    }
  }
  // The only dispatching row in this package starts the emitter itself on runtime load.
  const triggers = MANIFEST.things.filter((thing) => thing.payload?.trigger_type);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].payload.topic, "runtime_loaded");
});

test("6. a refused waiter row is recorded as a fact, and the good rows still start", async () => {
  const bad = { ...VOLUME_ROW, id: "waiter:points-at-a-different-leaf", mechanism_leaf: "elapsed-time.mjs" };
  const carrier = fakeCarrier({ waiters: [bad, VOLUME_ROW] });
  const controller = new AbortController();
  const refusals = [];
  const mechanism = {
    describeMechanism: volumeAttachment.describeMechanism,
    async watchForTransitions() { controller.abort(); },
  };
  await runResidentEmitter({
    env: {},
    carrier,
    loadModule: loadModuleFrom({ "filesystem-volume-attachment.mjs": mechanism, "elapsed-time.mjs": elapsedTime }),
    signal: controller.signal,
    onRefusal: (error) => refusals.push(error),
  });
  assert.equal(refusals.length, 1);
  assert.ok(refusals[0] instanceof WaiterRowRefused);
  assert.equal(refusals[0].reason, "mechanism-capability-mismatch");
  const refusalFact = carrier.writes.find((write) => write.payload.observed_identity?.waiter_refused === true);
  assert.ok(refusalFact, "the refusal is a fact in the log");
  assert.equal(refusalFact.payload.condition, CONDITIONS.unreachable);
});

test("6b. a mechanism may not shadow an arrival field, and a leaf outside the folder is refused", async () => {
  const shadowing = {
    describeMechanism: () => ({ mechanism_ref: VOLUME_ROW.mechanism_capability_ref, detail_fields: ["sequence"], conditions: [] }),
    watchForTransitions: async () => {},
  };
  await assert.rejects(
    resolveMechanism(VOLUME_ROW, { loadModule: loadModuleFrom({ "filesystem-volume-attachment.mjs": shadowing }) }),
    (error) => error instanceof WaiterRowRefused && error.reason === "shadowed-arrival-field",
  );
  for (const leaf of ["../emit-arrival-fact.mjs", "/etc/passwd", "Elapsed.mjs", "elapsed-time.js", ""]) {
    assert.throws(() => readWaiterRow({ ...VOLUME_ROW, mechanism_leaf: leaf }), WaiterRowRefused, leaf);
  }
});

test("the real mechanism leaves answer to the capability references the manifest rows declare", async () => {
  const real = async (leaf) => import(`../do-work/mechanisms/${leaf}`);
  for (const row of waiterRows) {
    const resolved = await resolveMechanism(row, { loadModule: real });
    assert.equal(resolved.described.mechanism_ref, row.mechanism_capability_ref);
  }
});

test("the volume mechanism reports what it can currently see on start, and identity is parsed off the host reply", async () => {
  const seen = [];
  const controller = new AbortController();
  await volumeAttachment.watchForTransitions({ attachment_place: "/place" }, {
    signal: controller.signal,
    listNames: () => ["Alpha", "Beta"],
    identityOptions: {
      readIdentityFile: async (filePath) => {
        assert.ok(filePath.endsWith(volumeAttachment.VOLUME_IDENTITY_FILE));
        return path.basename(path.dirname(path.dirname(filePath))) === "Alpha"
          ? "AC54F9DF-9505-476D-B057-FC17B494DF55\n"
          : "18D76D48-6BEA-475F-AC36-C64A498061E5";
      },
    },
    watchPlace: () => { queueMicrotask(() => controller.abort()); return { close() {} }; },
    onTransition: async (transition) => seen.push(transition),
  });
  assert.deepEqual(seen.map((t) => [t.condition, t.observed_identity.filesystem_identity]), [
    [CONDITIONS.reachable, "AC54F9DF-9505-476D-B057-FC17B494DF55"],
    [CONDITIONS.reachable, "18D76D48-6BEA-475F-AC36-C64A498061E5"],
  ]);
  assert.equal(volumeAttachment.filesystemIdentityFromFileText("garbage"), null);
  assert.equal(volumeAttachment.filesystemIdentityFromFileText(""), null);
  // A volume with no identity file is still reported, with a null identity.
  assert.equal(await volumeAttachment.readFilesystemIdentity("/nowhere", { readIdentityFile: async () => { throw new Error("ENOENT"); } }), null);
});

test("a mechanism that cannot wait becomes a recorded fact and does not take the other waiters down", async () => {
  const carrier = fakeCarrier({ waiters: [VOLUME_ROW, CLOCK_ROW] });
  const controller = new AbortController();
  const refusals = [];
  const volume = {
    describeMechanism: volumeAttachment.describeMechanism,
    async watchForTransitions() { throw new Error("cannot watch /Volumes: EPERM"); },
  };
  const clock = {
    describeMechanism: elapsedTime.describeMechanism,
    async watchForTransitions(_settings, handlers) {
      await handlers.onTransition({
        condition: CONDITIONS.reachable,
        observed_identity: { elapsed_seconds: 45, every: "interval" },
        detail: elapsedTime.buildDetail(CLOCK_ROW.mechanism_settings, handlers.nextSequence, 1_800_000_000_000),
      });
      controller.abort();
    },
  };
  await runResidentEmitter({
    env: {},
    carrier,
    loadModule: loadModuleFrom({ "filesystem-volume-attachment.mjs": volume, "elapsed-time.mjs": clock }),
    signal: controller.signal,
    nowMs: () => 1_800_000_000_000,
    onRefusal: (error) => refusals.push(error),
  });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].message, /cannot watch/);
  const refusalFact = carrier.writes.find((write) => write.payload.observed_identity?.waiter_refused === true);
  assert.equal(refusalFact.payload.waiter_ref, "waiter:attached-volumes");
  assert.equal(refusalFact.payload.observed_identity.refusal_reason, "mechanism-cannot-wait");
  assert.ok(carrier.writes.some((write) => write.addressLabel === "clock::tick"), "the clock still ticked");
});

test("a listing the process is forbidden to make is an error, never an empty healthy answer", () => {
  const forbidden = () => { const error = new Error("EPERM"); error.code = "EPERM"; throw error; };
  assert.throws(() => volumeAttachment.listReachableNames("/place", { readdir: forbidden }), /cannot list \/place: EPERM/);
  const absent = () => { const error = new Error("ENOENT"); error.code = "ENOENT"; throw error; };
  assert.deepEqual(volumeAttachment.listReachableNames("/place", { readdir: absent }), []);
});

test("which address source wins is proven by calling the resolver, not by reading text order", () => {
  // Ported from the predecessor's runtime-address-source test when it was retired. The
  // `check-source-files-against-declared-rules` rule that names this file can only see that
  // both sources are mentioned; precedence is semantic and is proven here.
  const partition = { BITFIELD_ARRIVAL_PARTITION: "a-partition" };
  const readFileSync = (p) => {
    assert.equal(p, "/published/here");
    return "http://127.0.0.1:57438\n";
  };
  assert.equal(currentAddressFromFile({ ...partition, BITFIELD_TARGET_CARRIER_URL_FILE: "/published/here" }, { readFileSync }), "http://127.0.0.1:57438");
  assert.deepEqual(
    resolveRunningShellConfig({ ...partition, BITFIELD_TARGET_CARRIER_URL_FILE: "/published/here" }, { readFileSync }),
    { url: "http://127.0.0.1:57438", partition: "a-partition" },
  );
  // An address handed over directly still wins, so a cleared-environment spawn is unaffected.
  assert.equal(
    resolveRunningShellConfig(
      { ...partition, BITFIELD_TARGET_CARRIER_URL: "https://handed.over.directly", BITFIELD_TARGET_CARRIER_URL_FILE: "/published/here" },
      { readFileSync: () => "http://127.0.0.1:57438" },
    ).url,
    "https://handed.over.directly",
  );
  // Stable app identity selects the shared discovery owner ahead of remote URL settings.
  assert.deepEqual(
    resolveRunningShellConfig(
      { ...partition, RUNNING_APP_APP_ID: "fixture-app", BITFIELD_TARGET_CARRIER_URL: "https://stale.example" },
    ),
    { appId: "fixture-app", partition: "a-partition" },
  );
  // No socket, no URL, no file: nothing is invented from a port number.
  assert.equal(resolveRunningShellConfig({ ...partition, PORT: "3012" }), null);
  // A runtime that is down, or has not published yet, is a wait rather than a crash.
  const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  assert.equal(currentAddressFromFile({ ...partition, BITFIELD_TARGET_CARRIER_URL_FILE: "/not/written/yet" }, { readFileSync: missing }), null);
  assert.equal(resolveRunningShellConfig({ ...partition, BITFIELD_TARGET_CARRIER_URL_FILE: "/not/written/yet" }, { readFileSync: missing }), null);
  assert.equal(currentAddressFromFile({ ...partition, BITFIELD_TARGET_CARRIER_URL_FILE: "/a" }, { readFileSync: () => "   \n" }), null);
});

test("handover and time flooring are the predecessor's guarantees, kept", () => {
  assert.equal(shouldHandOverAfterFailures(10, 10), true);
  assert.equal(shouldHandOverAfterFailures(9, 10), false);
  assert.equal(shouldHandOverAfterFailures(1000, 0), false);
  assert.equal(nextObservedAt(1000, "1970-01-01T00:00:05.000Z"), "1970-01-01T00:00:05.001Z");
  assert.equal(nextObservedAt(9000, "1970-01-01T00:00:05.000Z"), "1970-01-01T00:00:09.000Z");
  assert.equal(resumeSequenceFrom(null), 0);
  assert.equal(resumeSequenceFrom({ payload: { sequence: 4 } }), 5);
});

test("a change fact names where it happened and carries the change when it fits, and leaves out what does not", () => {
  const rows = JSON.parse(readFileSync(new URL("../tool-rows.json", import.meta.url), "utf8"));
  const wake = rows.records[0].payload.wakes.find(w => w.id === "keep-noticing-row-changes");
  const waiter = wake.input.waiters[0];
  const transition = { condition: "became-reachable", observed_identity: {}, detail: { where: "d", place: "post", change: "added", at: "2026-11-18T00:00:00.000Z", key: "d:7:3", before: null, after: null, by: "may_change_rows_0a1b2c3d4e5f" } };
  const scope = buildScope(readWaiterRow(waiter), transition, { observedAt: "2026-11-18T00:00:00.000Z", sequence: 1, matched: [], connection: "own-rows-postgres-connection" });
  assert.equal(wake.input.credential_name, undefined, "the shared row names no vault name: the person's switch gives it");
  const payload = selectPayload(waiter.emitted_record.change_kind, waiter.emitted_record.payload_fields, scope);
  assert.equal(payload.where, "own-rows-postgres-connection");
  assert.equal(payload.after, null, "the leaf hands an after too big for a fact field as null, and a null field is not told");
  // kind names the fact and is not one of its fields (tell-the-engine.mjs factOf); the rest are at most the engine's 8.
  assert.ok(Object.keys(payload).filter(name => name !== "kind").length <= 8 && Object.values(payload).every(v => v === null || (typeof v === "string" && Buffer.byteLength(v) <= 1024)));
  assert.equal(buildScope(readWaiterRow(waiter), transition, { observedAt: "x", sequence: 1, matched: [] }).where, null);
  const small = { ...transition, detail: { ...transition.detail, key: "d:7:3", after: JSON.stringify({ topic: "tides" }) } };
  const carried = selectPayload(waiter.emitted_record.change_kind, waiter.emitted_record.payload_fields, buildScope(readWaiterRow(waiter), small, { observedAt: "x", sequence: 1, matched: [], connection: "c" }));
  assert.equal(carried.after, '{"topic":"tides"}');
  assert.equal(carried.key, "d:7:3");
  assert.equal(carried.by, "may_change_rows_0a1b2c3d4e5f", "who made the change rides with it");
});
