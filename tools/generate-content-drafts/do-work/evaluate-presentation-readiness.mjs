#!/usr/bin/env node
import { realpathSync } from 'node:fs';
/**
 * file: tools/generate-content-drafts/do-work/evaluate-presentation-readiness.mjs
 *
 * PURPOSE: Evaluate one compiled presentation plan against declared capabilities
 * and fresh observations. It never converts an operator statement into sensor
 * evidence, never grants capture permission, and never starts a device.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function evaluatePresentationReadiness(plan, capabilities, observations, nowMs = Date.now()) {
if (!Number.isFinite(nowMs)) fail("now-ms must be a finite epoch millisecond value");

if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("plan must be an object");
if (!Array.isArray(capabilities)) fail("capabilities must be an array");
if (!observations || typeof observations !== "object" || Array.isArray(observations)) {
  fail("observations must be an object keyed by requirement key");
}
if (!Array.isArray(plan.requirements)) fail("plan.requirements must be an array");
if (!Array.isArray(plan.capabilities)) fail("plan.capabilities must be an array");

const availableCapabilities = new Set(
  capabilities.map((capability) => {
    if (typeof capability !== "string") fail("every capability must be a string");
    return capability;
  }),
);
const problems = [];
const evaluatedRequirements = [];
const requirementKeys = new Set();

for (const requirement of plan.requirements) {
  if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) fail("every requirement must be an object");
  if (typeof requirement.key !== "string" || !requirement.key.trim()) fail("every requirement needs a key");
  if (requirementKeys.has(requirement.key)) fail(`duplicate requirement key ${requirement.key}`);
  requirementKeys.add(requirement.key);
  if (!Array.isArray(requirement.methods) || !requirement.methods.length || requirement.methods.some(method => typeof method !== "string" || !method.trim())) fail(`requirement ${requirement.key} needs accepted evidence methods`);
  if (!Number.isFinite(requirement.max_age_seconds) || requirement.max_age_seconds < 0) fail(`requirement ${requirement.key} needs a finite nonnegative max_age_seconds`);
  const problem = requirementProblem(requirement);
  evaluatedRequirements.push({
    ...requirement,
    satisfied: problem === null,
    problem,
  });
  if (problem) problems.push(problem);
}

for (const capability of plan.capabilities) {
  if (!availableCapabilities.has(capability)) {
    const problem = {
      kind: "missing_capability",
      key: capability,
      instruction: `Connect and test the adapter: ${capability}`,
    };
    problems.push(problem);
  }
}

const ready = problems.length === 0;
const result = {
  plan_id: plan.id,
  material_id: plan.material_id,
  format_id: plan.format_id,
  state: ready ? "ready_to_authorize" : "awaiting_setup",
  physical_setup_independently_verified: ready
    && evaluatedRequirements.some((requirement) => requirement.expected !== false && requirement.satisfied && observations[requirement.key]?.method === "sensor"),
  problems,
  requirements: evaluatedRequirements,
  next_action: problems[0]?.instruction ?? "Authorize this one operation; authorization is separate from readiness.",
  note: "An operator confirmation can request a recheck only where the format accepts operator evidence. It cannot replace a required sensor observation.",
};

return result;

function requirementProblem(requirement) {
  if (requirement.expected === false) return null;
  const observation = observations[requirement.key];
  if (!observation || typeof observation !== "object") {
    return {
      kind: "not_checked",
      key: requirement.key,
      instruction: requirement.instruction,
    };
  }
  if (observation.value !== true) {
    return {
      kind: "failed_check",
      key: requirement.key,
      instruction: requirement.instruction,
    };
  }
  if (!requirement.methods.includes(observation.method)) {
    return {
      kind: "wrong_evidence_method",
      key: requirement.key,
      instruction: `${requirement.instruction} Accepted evidence: ${requirement.methods.join(", ")}.`,
    };
  }
  const observedAt = observation.observed_at_ms;
  if (!Number.isFinite(observedAt)) {
    return {
      kind: "invalid_observation_time",
      key: requirement.key,
      instruction: requirement.instruction,
    };
  }
  const ageMs = nowMs - observedAt;
  if (ageMs < 0 || ageMs > requirement.max_age_seconds * 1000) {
    return {
      kind: "stale_observation",
      key: requirement.key,
      instruction: `${requirement.instruction} Recheck within ${requirement.max_age_seconds} seconds.`,
    };
  }
  return null;
}
}

function required(arguments_, name) {
  const value = arguments_.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(
      "usage: evaluate-presentation-readiness.mjs --plan <json> --capabilities <json> --observations <json> --out <json> [--now-ms <ms>]",
    );
    process.exit(2);
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    if (process.argv.includes("--json")) {
      const input = JSON.parse(readFileSync(0, "utf8"));
      console.log(JSON.stringify({ result: evaluatePresentationReadiness(input.plan, input.capabilities, input.observations, input.now_ms) }));
    } else {
      const arguments_ = new Map();
      for (let index = 2; index < process.argv.length; index += 2) {
        arguments_.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
      }
      const planPath = required(arguments_, "plan");
      const outputPath = required(arguments_, "out");
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      const capabilities = JSON.parse(readFileSync(required(arguments_, "capabilities"), "utf8"));
      const observations = JSON.parse(readFileSync(required(arguments_, "observations"), "utf8"));
      const nowArgument = arguments_.get("now-ms");
      const nowMs = nowArgument && nowArgument !== "null" ? Number(nowArgument) : Date.now();
      const result = evaluatePresentationReadiness(plan, capabilities, observations, nowMs);
      writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ plan_id: plan.id, state: result.state, problems: result.problems.length, output: outputPath }));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
