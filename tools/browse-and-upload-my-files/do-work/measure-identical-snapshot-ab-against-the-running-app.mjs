#!/usr/bin/env node
// packages/live-namespace/do-work/measure-identical-snapshot-ab-against-the-running-app.mjs
//
// PURPOSE
// T12.10: the read-only runtime bridge for the identical-snapshot A/B normalizer. It takes ONE
// live immutable identity, fixes ONE receiver snapshot (a verified held prefix), measures the
// alternatives that existing owners can execute today against the REAL running app, feeds the
// measurements through the pure normalizer, and writes the normalized comparison as ONE
// measurement record. It never enables optimized execution, never touches the exact hot path,
// and never grants authority; the normalizer keeps `execution_admitted: false` and this bridge
// cannot change that.
//
// WHAT IS MEASURED AND WHAT IS CARRIED UNMEASURED
//   direct-exact-transfer   GET /cas/<identity>, whole body, one connection per sample
//   missing-range-read      residual windows from the held prefix (pure T12.3 owner), fetched
//                           with Range, reassembled with the held bytes
//   receiver-cache-read     serve from what the receiver holds; on this snapshot that is a
//                           prefix, so the digest does NOT match, and the record says so
//   existing-exact-result   read-current on the locator record, compare the declared
//                           `byte_length` observable to the measured length
//   exact-delta-reconstruct carried with no proofs: no delta/recipe owner executes here
//   remote-compute-result   carried with no proofs: no compute owner executes here
// A record with no proofs normalizes as unadmitted, which is the honest shape; a fabricated
// proof would be refused by the normalizer if malformed and would be a lie if well-formed.
//
// HOW "FRESH PROCESS" IS MADE TRUE
// Every measured alternative runs in its OWN child of this script (`--alternative <id>`), so
// cold_setup.basis = fresh-process is a fact about how it ran, not a declaration. The parent
// only orders the children and composes the record.
//
// HOW COUNTERS ARE MEASURED (each names its real source; none is inferred)
//   network_counters   net.Socket bytesRead/bytesWritten per request, keep-alive off
//   payload_bytes      body bytes counted per chunk; metadata = socket bytes minus body
//   cpu_time           process.cpuUsage() delta
//   resident_memory    process.memoryUsage().rss, peak across samples
//   page_cache         process.resourceUsage() minor/major page faults delta (getrusage)
//   wall_time          process.hrtime.bigint() per sample; p50/p95/p99 by nearest rank
//   cancellations      count of samples that threw; retries are never attempted
//   exact_equality     sha256 of the reassembled bytes versus the identity's digest
//
// USAGE (one line, absolute paths; the run guard matches the literal argv token)
//   node <pkg>/do-work/measure-identical-snapshot-ab-against-the-running-app.mjs --engine 127.0.0.1:<port> --scheme http --identity 12:<sha256> --partition live-namespace-measurement [--samples 5] [--hold-fraction 0.5]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  readCurrentRecord,
  startRunningAppSession,
  writeRecords,
} from "../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs";
import { IDENTICAL_SNAPSHOT_AB_SHAPE, identicalSnapshotAbPlanFromData } from "../read-data/identical-snapshot-ab-plan.mjs";
import { locatorAddressFor } from "../read-data/namespace-records-from-a-name-and-identity-table.mjs";
import { RESIDUAL_READ_SHAPE, residualReadDemandFromReceiverFacts } from "../read-data/residual-read-demand-from-receiver-facts.mjs";

const SELF = fileURLToPath(import.meta.url);
const RECEIVER_ID = "this-process";
const MEASURED_ALTERNATIVES = ["direct-exact-transfer", "missing-range-read", "receiver-cache-read", "existing-exact-result"];
const UNMEASURED_ALTERNATIVES = [
  ["exact-delta-reconstruct", "exact-delta-reconstruct", "immutable-bytes"],
  ["remote-compute-result", "remote-compute-result", "exact-result"],
];
const RESULT_OBSERVABLE = { source: "live-namespace.locator", field: "byte_length" };

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

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestOf(identity) {
  const [code, hex] = identity.split(":");
  if (code !== "12" || !/^[0-9a-f]{64}$/.test(hex ?? "")) throw new Error("identity must be 12:<sha256 hex>; only sha256 identities can be judged by digest here");
  return hex;
}

/** ONE ranged or whole GET over its own connection, with the socket's real byte counters. */
function fetchCas(base, basis, identity, range) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/cas/${encodeURIComponent(identity)}`, base);
    const headers = { "X-Bitfield-Running-Command-List-Basis": basis, ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) };
    const request = http.request(url, { method: "GET", headers, agent: new http.Agent({ keepAlive: false }) }, (response) => {
      const chunks = [];
      let bodyBytes = 0;
      response.on("data", (chunk) => { chunks.push(chunk); bodyBytes += chunk.length; });
      response.on("end", () => {
        const socket = response.socket;
        const expected = range ? 206 : 200;
        if (response.statusCode !== expected) {
          // The body IS the reason; a bare status number sent one investigation into the shell
          // source when the shell had already said what was wrong.
          reject(new Error(`GET /cas returned ${response.statusCode}, expected ${expected}: ${Buffer.concat(chunks).toString("utf8").slice(0, 400)}`));
          return;
        }
        resolve({
          body: Buffer.concat(chunks),
          bodyBytes,
          socketBytesRead: socket?.bytesRead ?? bodyBytes,
          socketBytesWritten: socket?.bytesWritten ?? 0,
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function percentile(sortedNanoseconds, fraction) {
  const rank = Math.max(0, Math.ceil(fraction * sortedNanoseconds.length) - 1);
  return Number(sortedNanoseconds[rank]);
}

/** Runs ONE alternative in this (fresh) process and prints its measurement record as JSON. */
async function runAlternative({ alternativeId, base, basis, identity, samples, holdFraction, expectedByteLength }) {
  const digest = digestOf(identity);
  const setupStart = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const faultsStart = process.resourceUsage();

  // Setup fixes the receiver snapshot: one verified whole read, keep a prefix, drop the rest.
  // The prefix is verified because it is a prefix of bytes whose whole digest matched.
  const prefill = await fetchCas(base, basis, identity, null);
  if (sha256Hex(prefill.body) !== digest) throw new Error("prefill bytes did not match the identity digest; the snapshot cannot be fixed");
  const byteLength = prefill.body.length;
  const heldLength = Math.floor(byteLength * holdFraction);
  const held = prefill.body.subarray(0, heldLength);
  const setupNanoseconds = Number(process.hrtime.bigint() - setupStart);
  const receiverFacts = heldLength > 0
    ? [{ schemaVersion: RESIDUAL_READ_SHAPE, receiverId: RECEIVER_ID, identity, receiverStateVersion: `held-prefix-${heldLength}`, authorization: { subject: RECEIVER_ID, grantId: "measurement", version: 1 }, interval: { offset: 0, length: heldLength }, verified: true }]
    : [];

  const wall = [];
  let peakRss = process.memoryUsage().rss;
  let net = { origin: { bytesSent: 0, bytesReceived: 0, requests: 0 }, receiver: { bytesSent: 0, bytesReceived: 0, requests: 0 } };
  let payloadReceived = 0;
  let metadataSent = 0;
  let metadataReceived = 0;
  let failures = 0;
  let observedText = null;
  let expectedText = null;
  let isEqual = false;

  const account = (reply) => {
    payloadReceived += reply.bodyBytes;
    metadataReceived += Math.max(0, reply.socketBytesRead - reply.bodyBytes);
    metadataSent += reply.socketBytesWritten;
    net.origin.bytesSent += reply.socketBytesRead;
    net.origin.bytesReceived += reply.socketBytesWritten;
    net.origin.requests += 1;
    net.receiver.bytesReceived += reply.socketBytesRead;
    net.receiver.bytesSent += reply.socketBytesWritten;
    net.receiver.requests += 1;
  };

  for (let sample = 0; sample < samples; sample += 1) {
    const start = process.hrtime.bigint();
    try {
      if (alternativeId === "direct-exact-transfer") {
        const reply = await fetchCas(base, basis, identity, null);
        account(reply);
        observedText = sha256Hex(reply.body);
      } else if (alternativeId === "missing-range-read") {
        const plan = residualReadDemandFromReceiverFacts({
          demand: { schemaVersion: RESIDUAL_READ_SHAPE, receiverId: RECEIVER_ID, identity, receiverStateVersion: `held-prefix-${heldLength}`, authorization: { subject: RECEIVER_ID, grantId: "measurement", version: 1 }, range: { offset: 0, length: byteLength } },
          receiverFacts,
        });
        const parts = [held];
        for (const window of plan.missing) {
          const reply = await fetchCas(base, basis, identity, { offset: window.offset, length: window.length });
          account(reply);
          parts.push(reply.body);
        }
        observedText = sha256Hex(Buffer.concat(parts));
      } else if (alternativeId === "receiver-cache-read") {
        // Zero network by construction: the receiver serves what it holds, and on this snapshot
        // that is a prefix. The digest will not match, and that is the measured truth.
        observedText = sha256Hex(held);
      } else if (alternativeId === "existing-exact-result") {
        const session = { url: base, basis };
        const record = await readCurrentRecord(session, "trillion", locatorAddressFor(identity));
        if (record.found !== true) throw new Error("locator record not found");
        observedText = String(record.payload?.byte_length);
        // One JSON request; its bytes are not on a socket we own, so they are not claimed.
      } else {
        throw new Error(`no measurement for alternative ${alternativeId}`);
      }
    } catch (error) {
      failures += 1;
      process.stderr.write(`sample ${sample} of ${alternativeId} failed: ${String(error?.message ?? error)}\n`);
    }
    wall.push(process.hrtime.bigint() - start);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  const track = alternativeId === "existing-exact-result" ? "exact-result" : "immutable-bytes";
  if (track === "immutable-bytes") {
    expectedText = digest;
    isEqual = observedText === digest;
  } else {
    expectedText = String(expectedByteLength ?? byteLength);
    isEqual = observedText === expectedText;
  }

  const cpu = process.cpuUsage(cpuStart);
  const faults = process.resourceUsage();
  const sorted = wall.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const equalityMethod = track === "immutable-bytes" ? "byte-digest-comparison" : "declared-observable-comparison";
  const proof = (method) => ({ measured: true, source: "measure-identical-snapshot-ab-against-the-running-app", method });

  return {
    alternativeId,
    byteLength,
    heldLength,
    record: {
      recordId: `${alternativeId}-${Date.now()}`,
      alternativeId,
      snapshotId: null,
      method: "identical-snapshot-ab",
      sampleCount: samples,
      proofs: {
        cold_setup: proof("monotonic-clock"),
        payload_bytes: proof("byte-counter"),
        cpu_time: proof("process-cpu-counter"),
        resident_memory_bytes: proof("process-rss-counter"),
        page_cache: proof("page-cache-counter"),
        network_counters: proof("socket-counter"),
        wall_time_p50_p95_p99: proof("monotonic-clock"),
        cancellations: proof("run-ledger"),
        exact_equality: proof(equalityMethod),
      },
      values: {
        cold_setup: {
          setupCount: 1,
          basis: "fresh-process",
          interpreter: { kind: "node", version: process.version, coldStart: true },
          cachePlacement: { instructionCache: "cold", dataCache: "cold", translationCache: "cold" },
          durationNanoseconds: setupNanoseconds,
          bytesRead: prefill.socketBytesRead,
          bytesWritten: 0,
        },
        payload_bytes: {
          payload: { sent: 0, received: payloadReceived, total: payloadReceived },
          metadata: { sent: metadataSent, received: metadataReceived, total: metadataSent + metadataReceived },
        },
        cpu_time: { userNanoseconds: cpu.user * 1000, systemNanoseconds: cpu.system * 1000, totalNanoseconds: (cpu.user + cpu.system) * 1000 },
        resident_memory_bytes: { peakBytes: peakRss },
        page_cache: { hits: Math.max(0, faults.minorPageFault - faultsStart.minorPageFault), misses: Math.max(0, faults.majorPageFault - faultsStart.majorPageFault) },
        network_counters: { origin: net.origin, relay_or_peer: { bytesSent: 0, bytesReceived: 0, requests: 0 }, receiver: net.receiver },
        wall_time_p50_p95_p99: { p50Nanoseconds: percentile(sorted, 0.5), p95Nanoseconds: percentile(sorted, 0.95), p99Nanoseconds: percentile(sorted, 0.99) },
        cancellations: { count: failures, retries: 0, deadlineMisses: 0, failedProofs: failures },
        exact_equality: track === "immutable-bytes"
          ? { isEqual, equalityKind: "sha256-exact", observed: observedText ?? "none", expected: expectedText }
          : { isEqual, equalityKind: "declared-observable-only", observed: observedText ?? "none", expected: expectedText, observable: RESULT_OBSERVABLE },
      },
    },
  };
}

function runChild(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, ...argv], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(`child for ${argv[1]} exited ${code}`)); return; }
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`child for ${argv[1]} printed no JSON: ${String(error?.message ?? error)}`)); }
    });
  });
}

try {
  const scheme = optional("--scheme", "http");
  const engine = required("--engine");
  const base = `${scheme}://${engine}`;
  const identity = required("--identity");
  const samples = Number(optional("--samples", "5"));
  const holdFraction = Number(optional("--hold-fraction", "0.5"));
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  if (!(holdFraction >= 0 && holdFraction < 1)) throw new Error("--hold-fraction must be in [0, 1)");

  const alternativeId = optional("--alternative", null);
  if (alternativeId != null) {
    const basis = required("--basis");
    const expectedByteLength = optional("--expected-byte-length", null);
    const result = await runAlternative({ alternativeId, base, basis, identity, samples, holdFraction, expectedByteLength: expectedByteLength == null ? null : Number(expectedByteLength) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const partition = required("--partition");
    if (partition === "trillion") throw new Error("refusing to write measurement records to the trillion partition");
    const session = await startRunningAppSession({ url: base });
    const common = ["--engine", engine, "--scheme", scheme, "--identity", identity, "--samples", String(samples), "--hold-fraction", String(holdFraction), "--basis", session.basis];

    const measured = [];
    let byteLength = null;
    for (const id of MEASURED_ALTERNATIVES) {
      const argv = ["--alternative", id, ...common, ...(byteLength == null ? [] : ["--expected-byte-length", String(byteLength)])];
      const result = await runChild(argv);
      byteLength = byteLength ?? result.byteLength;
      measured.push(result);
      process.stderr.write(`${id}: ${result.record.values.exact_equality.isEqual ? "EQUAL" : "NOT EQUAL"} p50=${(result.record.values.wall_time_p50_p95_p99.p50Nanoseconds / 1e6).toFixed(1)}ms origin.bytesSent=${result.record.values.network_counters.origin.bytesSent}\n`);
    }

    const heldLength = measured[0].heldLength;
    const snapshotId = `${RECEIVER_ID}-holding-prefix-${heldLength}-of-${byteLength}`;
    const locator = await readCurrentRecord(session, "trillion", locatorAddressFor(identity));
    const resultIdentity = locator.content_hash;
    const snapshot = {
      snapshotId,
      receiverId: RECEIVER_ID,
      receiverStateVersion: `held-prefix-${heldLength}`,
      immutableSubject: { kind: "immutable-bytes", identity },
      resultSubject: { kind: "exact-result", identity: resultIdentity, observable: RESULT_OBSERVABLE },
    };
    const subjectFor = (track) => (track === "immutable-bytes" ? { kind: track, identity } : { kind: track, identity: resultIdentity, observable: RESULT_OBSERVABLE });

    const alternatives = measured.map(({ alternativeId: id, record }) => {
      const track = id === "existing-exact-result" ? "exact-result" : "immutable-bytes";
      return { alternativeId: id, capabilityEdgeId: id === "direct-exact-transfer" ? "direct-exact-read" : id, snapshotId, subject: subjectFor(track), records: [{ ...record, snapshotId }] };
    });
    for (const [id, edgeId, track] of UNMEASURED_ALTERNATIVES) {
      alternatives.push({ alternativeId: id, capabilityEdgeId: edgeId, snapshotId, subject: subjectFor(track), records: [{ recordId: `${id}-unmeasured`, alternativeId: id, snapshotId, method: "identical-snapshot-ab", sampleCount: 1 }] });
    }

    const normalized = identicalSnapshotAbPlanFromData({ schemaVersion: IDENTICAL_SNAPSHOT_AB_SHAPE, snapshot, alternatives });
    const address = `live-namespace::identical-snapshot-ab::${snapshotId}::${identity}`;
    await writeRecords(session, [{
      partition_label: partition,
      address_label: address,
      address_mode: "identity_text",
      path_labels: ["live-namespace", "measurement", "/identical-snapshot-ab"],
      payload: normalized,
    }]);
    const readback = await readCurrentRecord(session, partition, address);

    process.stdout.write(`${JSON.stringify({
      identity,
      byte_length: byteLength,
      held_prefix_bytes: heldLength,
      samples_per_alternative: samples,
      measured_alternatives: measured.map((m) => m.alternativeId),
      unmeasured_alternatives: UNMEASURED_ALTERNATIVES.map(([id]) => id),
      per_alternative: normalized.alternatives.map((a) => ({
        alternativeId: a.alternativeId,
        candidateMeasurementAdmitted: a.candidateMeasurementAdmitted,
        missingProofs: a.records[0].missingProofs,
        isEqual: a.records[0].values?.exact_equality?.isEqual ?? null,
        p50_ms: a.records[0].values ? a.records[0].values.wall_time_p50_p95_p99.p50Nanoseconds / 1e6 : null,
        origin_bytes_sent: a.records[0].values?.network_counters.origin.bytesSent ?? null,
        origin_requests: a.records[0].values?.network_counters.origin.requests ?? null,
      })),
      summary: normalized.summary,
      measurement_record: { partition, address, readback_found: readback.found === true, readback_hash: readback.content_hash ?? null },
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error), details: error?.details ?? null, where: String(error?.stack ?? "").split("\n").slice(1, 4) }, null, 2)}\n`);
  process.exitCode = 1;
}
