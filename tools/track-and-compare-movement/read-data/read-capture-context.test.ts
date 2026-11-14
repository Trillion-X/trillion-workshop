// packages/motion-analysis/read-data/read-capture-context.test.ts
//
// Proves the capture-surface reads: tracker DATA → a complete TrackerDescriptor
// (or null fail-closed), view DATA → the projection view, the session match-stat
// → the result trigger, and the inline visual-database surfaceInput shape. Pure,
// no React.

import { test } from "../../../test-helpers/vitest-shim.mjs";
import assert from "node:assert/strict";
import {
  captureRows,
  readTrackerDescriptor,
  readMatchStatsView,
  findMatchStat,
  buildResultSurfaceInput,
} from "./read-capture-context.ts";

const rows = [
  {
    kind: "tracker-descriptor",
    id: "court-ball-point-v1",
    trackerId: "court-ball-point-v1",
    orchestratorPath: "/abs/match_perception_orchestrate.sh",
    maxFrames: 0,
    timeoutMs: 560000,
    env: { MATCH_VENDOR_ROOT: "/abs/models", MATCH_PYTHON: "/abs/python3" },
  },
  { kind: "match-stats-view", id: "tennis", view: { id: "match-stats.tennis", label: "Match stats", sources: [], fields: [{ id: "shot_speed_kmh" }] } },
  { kind: "match-stat", id: "mp-session-7", label: "This match", fields: { shot_speed_kmh: 389.1, rally_length: 18 } },
  { kind: "match-stat", id: "mp-other", fields: { shot_speed_kmh: 1 } },
];

test("captureRows flattens an array, a {records} carrier, OR a single record payload", () => {
  assert.equal(captureRows(rows).length, 4);
  assert.equal(captureRows({ records: rows }).length, 4);
  // a single targeted-address read hands back one record payload (carries `kind`)
  assert.equal(captureRows(rows[0]).length, 1);
  assert.equal(captureRows(rows[0])[0].id, "court-ball-point-v1");
  assert.deepEqual(captureRows(null), []);
  assert.deepEqual(captureRows("nope"), []);
  assert.deepEqual(captureRows({ no: "kind" }), []);
});

test("readTrackerDescriptor returns a complete descriptor from DATA", () => {
  const t = readTrackerDescriptor(rows, "court-ball-point-v1");
  assert.equal(t?.trackerId, "court-ball-point-v1");
  assert.equal(t?.orchestratorPath, "/abs/match_perception_orchestrate.sh");
  assert.equal(t?.maxFrames, 0);
  assert.equal(t?.timeoutMs, 560000);
  assert.equal(t?.env?.MATCH_VENDOR_ROOT, "/abs/models");
});

test("readTrackerDescriptor fails closed (null) when absent or missing the orchestrator path", () => {
  assert.equal(readTrackerDescriptor(rows, "no-such-tracker"), null);
  assert.equal(readTrackerDescriptor([{ kind: "tracker-descriptor", id: "x", trackerId: "x" }], "x"), null);
});

test("readMatchStatsView returns the view DATA by id", () => {
  const v = readMatchStatsView(rows, "tennis") as { id?: string };
  assert.equal(v?.id, "match-stats.tennis");
  assert.equal(readMatchStatsView(rows, "missing"), null);
});

test("findMatchStat returns the session record by stat id (the result trigger)", () => {
  assert.equal(findMatchStat(rows, "mp-session-7")?.fields && (findMatchStat(rows, "mp-session-7")!.fields as Record<string, unknown>).rally_length, 18);
  assert.equal(findMatchStat(rows, "not-yet"), null); // still working until the record appears
});

test("buildResultSurfaceInput is null until BOTH inputs exist, then preserves inline match stats as visual-database DATA", () => {
  const view = readMatchStatsView(rows, "tennis");
  const stat = findMatchStat(rows, "mp-session-7");
  assert.equal(buildResultSurfaceInput(view, null), null);
  assert.equal(buildResultSurfaceInput(null, stat), null);
  const si = buildResultSurfaceInput(view, stat)!;
  assert.equal(si.records.length, 1);
  assert.equal(si.records[0].id, "mp-session-7");
  const fields = si.fields.descriptors as Array<{ id: string; paths: string[][] }>;
  assert.deepEqual(fields.find((field) => field.id === "shot_speed_kmh")?.paths, [["fields", "shot_speed_kmh"]]);
  const views = si.views.views as Array<{ id: string; kind: string; metrics?: Array<{ values: Array<{ id: string }> }> }>;
  assert.equal(views[0].id, "match-stats.tennis.metrics");
  assert.equal(views[0].kind, "metric");
  assert.deepEqual(views[0].metrics?.[0].values.map((value) => value.id), ["shot_speed_kmh"]);
  assert.equal(views[1].kind, "table");
  assert.deepEqual(si.actions, { kind: "visual-database.actions", version: 1, actions: [] });
});
