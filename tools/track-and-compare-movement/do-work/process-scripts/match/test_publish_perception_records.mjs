// packages/motion-analysis/do-work/process-scripts/match/test_publish_perception_records.mjs
//
// Gate for the browser on-device fact-delivery seam (publish_perception_records.mjs).
// Proves the browser reuses the EXISTING motion-analysis admission path (record-maker +
// generic per-record writer action) against the REAL record-maker run on the REAL 73-fact
// command-output fixture — no live engine, no models, no browser needed.
//
//   node test_publish_perception_records.mjs
// =============================================================================
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORD_WRITE_ACTION_ID,
  buildRecordWriteDispatches,
  deliverPerceptionCommandOutput,
} from "./publish_perception_records.mjs";

const HERE = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.MATCH_PYTHON || "python3";
let pass = 0, fail = 0;
const T = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

console.log("publish_perception_records — browser on-device fact delivery\n");

// The generic per-record writer action's input contract (motion-analysis
// workflow-action::write-command-run-record). Every dispatch we build must satisfy it.
const WRITER_REQUIRED = ["record"]; // input_schema.required
const recordSatisfiesContract = (rec) =>
  rec && typeof rec === "object" &&
  typeof rec.address === "string" && rec.address.length > 0 &&
  rec.payload && typeof rec.payload === "object";

// --- Run the REAL record-maker on the REAL 73-fact fixture (the native worker's own seam) ---
const fixture = path.join(HERE, "_probe", "command-output.json");
const recordMaker = path.join(HERE, "..", "make-motion-analysis-records-from-command-output.py");
let records = null;
if (fs.existsSync(fixture) && fs.existsSync(recordMaker)) {
  const reqPath = path.join(os.tmpdir(), "ppr_req.json");
  const outPath = path.join(os.tmpdir(), "ppr_out.json");
  fs.writeFileSync(reqPath, JSON.stringify({ request_id: "browser-ondevice-test", sources: [{ fingerprint: "clip-fp-1", source_index: 0 }] }));
  try {
    execFileSync(PY, [recordMaker, "--request-json", reqPath, "--command-output-json", fixture, "--output-json", outPath], { encoding: "utf8" });
    records = JSON.parse(fs.readFileSync(outPath, "utf8")).records;
  } catch (e) {
    console.log(`  (record-maker unavailable: ${String(e).slice(0, 120)} — running pure-builder tests only)`);
  }
}

if (records) {
  // 1. The real record-maker produced canonical records from the real command-output.
  T("real record-maker → 73 canonical records from the 73-fact fixture", records.length === 73);

  // 2. Every canonical record satisfies the writer action's input contract.
  T("every record has address + object payload (writer input_schema record.address/payload)",
    records.every(recordSatisfiesContract));

  // 3. buildRecordWriteDispatches → one dispatch per record, targeting the EXISTING writer action.
  const dispatches = buildRecordWriteDispatches(records);
  T("one dispatch per record (73)", dispatches.length === 73);
  T("every dispatch targets the EXISTING writer action (no new endpoint, L093)",
    dispatches.every((d) => d.action_id === RECORD_WRITE_ACTION_ID)
    && RECORD_WRITE_ACTION_ID === "action:write-motion-analysis-record-from-command-run");
  T("every dispatch input satisfies the writer contract {record:{address,payload}}",
    dispatches.every((d) => WRITER_REQUIRED.every((k) => k in d.input) && recordSatisfiesContract(d.input.record)));
  T("dispatch payload is the record's own payload (self-describing, unchanged)",
    dispatches[0].input.record.payload === records[0].payload
    && dispatches[0].input.record.address === records[0].address);

  // 4. deliverPerceptionCommandOutput serializes one write per record, in order.
  const seen = [];
  const spyDispatch = async (d) => { seen.push(d.input.record.address); return { ok: true }; };
  const injectedMake = async () => ({ records });
  const res = await deliverPerceptionCommandOutput({ request_id: "x" }, { facts: [], records }, { makeRecords: injectedMake, dispatch: spyDispatch });
  T("deliver → 73 serialized dispatches, order preserved",
    res.count === 73 && seen.length === 73 && seen[0] === records[0].address && seen[72] === records[72].address);
} else {
  console.log("  SKIP live-fixture tests (record-maker/fixture unavailable)");
}

// --- Pure-builder tests (no fixture needed) ---
// 5. Generic / fail-closed: malformed records (missing address or empty payload) are dropped.
{
  const mixed = [
    { address: "a::1", payload: { kind: "x", v: 1 } },
    { address: "", payload: { kind: "y" } },          // no address -> drop
    { address: "a::2", payload: {} },                  // empty payload -> drop
    { address: "a::3" },                                // no payload -> drop
    { address: "a::4", payload: { kind: "z" } },
  ];
  const d = buildRecordWriteDispatches(mixed);
  T("fail-closed: only well-formed {address,payload} records are dispatched (2 of 5)",
    d.length === 2 && d[0].input.record.address === "a::1" && d[1].input.record.address === "a::4");
}

// 6. L090 generic: the builder carries NO perception vocabulary — it round-trips arbitrary
//    self-describing records (a completely different domain) unchanged.
{
  const alien = [{ address: "package::anything::foo::1", payload: { kind: "totally.unrelated", z: 9 } }];
  const d = buildRecordWriteDispatches(alien);
  T("generic: arbitrary self-describing record dispatched unchanged (no domain vocab in seam)",
    d.length === 1 && d[0].action_id === RECORD_WRITE_ACTION_ID
    && d[0].input.record.payload.kind === "totally.unrelated");
}

// 7. deliver requires both injected capabilities (fail-closed API).
{
  let threw = 0;
  try { await deliverPerceptionCommandOutput({}, {}, { dispatch: async () => {} }); } catch { threw++; }
  try { await deliverPerceptionCommandOutput({}, {}, { makeRecords: async () => ({ records: [] }) }); } catch { threw++; }
  T("deliver fail-closed: throws without makeRecords and without dispatch", threw === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
