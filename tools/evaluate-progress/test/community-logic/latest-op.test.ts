// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/latest-op.test.ts.
// packages/progression-evaluator/read-data/latest-op.test.ts
//
// Contract for the `latest` measure op — the generic "current value" reduction:
// the value of the field on the MOST RECENT fact, ordered by a DATA sort key
// (default recorded_at). It names no domain: the athlete's latest self-reported
// mood, the last reading of any sensor, the current status of any entity are the
// SAME op with different selectors/params (L069/L090). Distinct from `rank`
// (numeric field -> ordered ids); `latest` returns the raw value of ANY type.
//
// Run: ../../node_modules/.bin/vitest run read-data/latest-op.test.ts
//
// Carried from old trillion test/community-logic/latest-op.test.ts (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. read-data/measure-ops.ts here asks every `latest` for its sortBy and keeps no
// default, so latestDef names recorded_at, the old default, where a case named none. Nothing else changed but imports.
import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import { deriveMeasure, type FactRecord, type MeasureDefinition } from '../../read-data/derive-measure.ts';
import { measureOps } from '../../read-data/measure-ops.ts';

const latestDef = (field: string[], sortBy: string[] = ["recorded_at"], kind = "mental.self_report"): MeasureDefinition =>
  ({
    id: "latest-x",
    op: "latest",
    emit: "measure.latest",
    inputs: [{ match: { kind }, field }],
    params: { sortBy },
  } as MeasureDefinition);

// Realistic Apeak self-report facts: a category `state` + an ISO `recorded_at`.
const selfReports: FactRecord[] = [
  { id: "a", kind: "mental.self_report", state: "flat", recorded_at: "2026-07-01T09:00:00Z" },
  { id: "b", kind: "mental.self_report", state: "tense", recorded_at: "2026-07-01T14:30:00Z" }, // latest
  { id: "c", kind: "mental.self_report", state: "steady", recorded_at: "2026-07-01T11:15:00Z" },
];

test("latest — returns the CATEGORY value of the most recent fact (ISO recorded_at sorts as string)", () => {
  const r = deriveMeasure(selfReports as any, latestDef(["state"]), measureOps);
  assert.equal(r.value, "tense"); // 14:30 is the latest window
});

test("latest — respects a DATA sortBy pointing at a different key", () => {
  // sort by state alphabetically -> "tense" is lexicographically last of {flat,steady,tense}
  const r = deriveMeasure(selfReports as any, latestDef(["state"], ["state"]), measureOps);
  assert.equal(r.value, "tense");
});

test("latest — works on a NUMERIC sort key (epoch ms), returns the newest reading's value", () => {
  const readings: FactRecord[] = [
    { id: "r1", kind: "sensor.reading", hr: 72, t: 1000 },
    { id: "r2", kind: "sensor.reading", hr: 88, t: 3000 }, // newest
    { id: "r3", kind: "sensor.reading", hr: 64, t: 2000 },
  ];
  const r = deriveMeasure(readings as any, latestDef(["hr"], ["t"], "sensor.reading"), measureOps);
  assert.equal(r.value, 88);
});

test("DELETION TEST (L069): a completely different domain (order status) reads through the SAME op, zero code", () => {
  const orders: FactRecord[] = [
    { id: "o1", kind: "order.event", status: "placed", recorded_at: "2026-06-30T10:00:00Z" },
    { id: "o2", kind: "order.event", status: "shipped", recorded_at: "2026-07-01T08:00:00Z" }, // current
    { id: "o3", kind: "order.event", status: "packed", recorded_at: "2026-06-30T22:00:00Z" },
  ];
  const r = deriveMeasure(orders as any, latestDef(["status"], ["recorded_at"], "order.event"), measureOps);
  assert.equal(r.value, "shipped"); // the CURRENT order status — a measure the op was never coded for
});

test("latest — no facts -> null (fail-soft), and confidence 0", () => {
  const r = deriveMeasure([] as any, latestDef(["state"]), measureOps);
  assert.equal(r.value, null);
  assert.equal(r.confidence, 0);
});

test("latest — the value field missing on the latest fact -> null (never throws)", () => {
  const facts: FactRecord[] = [
    { id: "x", kind: "mental.self_report", state: "steady", recorded_at: "2026-07-01T09:00:00Z" },
    { id: "y", kind: "mental.self_report", recorded_at: "2026-07-01T18:00:00Z" }, // latest, no state
  ];
  const r = deriveMeasure(facts as any, latestDef(["state"]), measureOps);
  assert.equal(r.value, null);
});

test("latest — a single fact returns its value", () => {
  const r = deriveMeasure(
    [{ id: "only", kind: "mental.self_report", state: "steady", recorded_at: "2026-07-01T09:00:00Z" }] as any,
    latestDef(["state"]),
    measureOps
  );
  assert.equal(r.value, "steady");
});

test("latest — equal sort keys resolve deterministically to the later fact in the selector", () => {
  const facts: FactRecord[] = [
    { id: "p", kind: "mental.self_report", state: "tense", recorded_at: "2026-07-01T12:00:00Z" },
    { id: "q", kind: "mental.self_report", state: "steady", recorded_at: "2026-07-01T12:00:00Z" }, // same ts, later in list
  ];
  const r = deriveMeasure(facts as any, latestDef(["state"]), measureOps);
  assert.equal(r.value, "steady");
});
