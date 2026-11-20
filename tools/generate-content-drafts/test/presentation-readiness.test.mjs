import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDirectory = new URL("..", import.meta.url).pathname;
const compiler = join(packageDirectory, "do-work", "compile-presentation-plan.mjs");
const evaluator = join(packageDirectory, "do-work", "evaluate-presentation-readiness.mjs");
const formats = join(packageDirectory, "test", "fixtures", "presentation-formats.json");

function makePlan(directory) {
  const materialPath = join(directory, "material.json");
  const planPath = join(directory, "plan.json");
  writeFileSync(materialPath, `${JSON.stringify({
    id: "readiness-material",
    title: "Readiness material",
    revision: 1,
    claims: [
      { id: "teaching_event", text: "lesson", source_refs: ["A"], status: "reported" },
      { id: "boundary", text: "boundary", source_refs: ["A"], status: "boundary" },
      { id: "application", text: "application", source_refs: ["A"], status: "proposal" },
    ],
    required_claims: ["teaching_event", "boundary", "application"],
    fields: {
      series: "Series", hook: "Hook", scene: "Scene", mechanism: "Mechanism",
      boundary: "Boundary", application: "Application", ending: "Ending",
    },
  })}\n`);
  execFileSync(process.execPath, [
    compiler,
    "--material", materialPath,
    "--format", "sample-video",
    "--formats", formats,
    "--out", planPath,
  ], { encoding: "utf8" });
  return planPath;
}

function evaluate(directory, planPath, capabilities, observations, nowMs = 1_000_000) {
  const capabilitiesPath = join(directory, "capabilities.json");
  const observationsPath = join(directory, "observations.json");
  const outputPath = join(directory, "readiness.json");
  writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities)}\n`);
  writeFileSync(observationsPath, `${JSON.stringify(observations)}\n`);
  execFileSync(process.execPath, [
    evaluator,
    "--plan", planPath,
    "--capabilities", capabilitiesPath,
    "--observations", observationsPath,
    "--out", outputPath,
    "--now-ms", String(nowMs),
  ], { encoding: "utf8"});
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

test("a missing physical capability blocks readiness even if every checkbox is checked", () => {
  const directory = tempFolder(join(tmpdir(), "presentation-readiness-"));
  const planPath = makePlan(directory);
  const result = evaluate(directory, planPath, [], {});
  assert.equal(result.state, "awaiting_setup");
  assert.ok(result.problems.some((problem) => problem.kind === "missing_capability" && problem.key === "capture.video"));
});

test("operator evidence cannot satisfy a sensor-only requirement", () => {
  const directory = tempFolder(join(tmpdir(), "presentation-readiness-"));
  const plan = JSON.parse(readFileSync(makePlan(directory), "utf8"));
  const observations = Object.fromEntries(plan.requirements.map((requirement) => [
    requirement.key,
    { value: true, method: "operator", observed_at_ms: 1_000_000 },
  ]));
  const result = evaluate(
    directory,
    join(directory, "plan.json"),
    ["capture.video"],
    observations,
    1_000_000,
  );
  assert.ok(result.problems.some((problem) => problem.kind === "wrong_evidence_method"));
  assert.equal(result.physical_setup_independently_verified, false);
});

test("fresh accepted evidence reaches authorization, not automatic execution", () => {
  const directory = tempFolder(join(tmpdir(), "presentation-readiness-"));
  const plan = JSON.parse(readFileSync(makePlan(directory), "utf8"));
  const observations = Object.fromEntries(plan.requirements.map((requirement) => [
    requirement.key,
    { value: true, method: requirement.methods[0], observed_at_ms: 1_000_000 },
  ]));
  const result = evaluate(
    directory,
    join(directory, "plan.json"),
    ["capture.video"],
    observations,
    1_000_000,
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.state, "ready_to_authorize");
  assert.equal(result.physical_setup_independently_verified, true);
  assert.match(result.next_action, /Authorize this one operation/);
});

test("a stale observation must be rechecked", () => {
  const directory = tempFolder(join(tmpdir(), "presentation-readiness-"));
  const plan = JSON.parse(readFileSync(makePlan(directory), "utf8"));
  const observations = Object.fromEntries(plan.requirements.map((requirement) => [
    requirement.key,
    { value: true, method: requirement.methods[0], observed_at_ms: 1_000_000 },
  ]));
  const result = evaluate(
    directory,
    join(directory, "plan.json"),
    ["capture.video"],
    observations,
    1_100_000,
  );
  assert.ok(result.problems.some((problem) => problem.kind === "stale_observation"));
});
