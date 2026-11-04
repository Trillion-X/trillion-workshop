#!/usr/bin/env node
/**
 * file: packages/record-video/do-work/build-recording-session-from-presentation-plan.mjs
 *
 * PURPOSE: Convert one already-compiled video presentation plan into the
 * recording-session DATA consumed by this package's capture surface.
 *
 * BOUNDARIES:
 * - This script never opens a device and never treats plan existence as consent.
 * - It can stage an unauthorized session for review with auto_start = false.
 * - auto_start = true additionally requires a matching readiness result whose
 *   state is ready_to_authorize and a separate unexpired authorization grant.
 * - A format that gathers unpredictable answers cannot be flattened into a
 *   prewritten teleprompter session; it must fail explicitly.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { recordingSessionFromPlan } from "./recording-session-from-presentation-plan.mjs";

const arguments_ = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  arguments_.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}

const plan = readJson(required("plan"), "presentation plan");
const outPath = required("out");
const readinessArgument = arguments_.get("readiness");
const authorizationArgument = arguments_.get("authorization");
const readiness = readinessArgument
  ? readJson(readinessArgument, "presentation readiness result")
  : null;
const authorization = authorizationArgument
  ? readJson(authorizationArgument, "recording authorization")
  : null;
const nowArgument = arguments_.get("now-ms");
const nowMs = nowArgument && nowArgument !== "null" ? Number(nowArgument) : Date.now();

let session;
try {
  session = recordingSessionFromPlan({ plan, readiness, authorization, nowMs });
} catch (error) {
  fail(error.message);
}

writeFileSync(outPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  plan_id: plan.id,
  session_address: "record-video-recording-session",
  auto_start: session.auto_start,
  readiness_state: session.readiness_state,
  authorization_state: session.authorization_state,
  output: outPath,
}));

function required(name) {
  const value = arguments_.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(
      "usage: build-recording-session-from-presentation-plan.mjs --plan <json> --out <json> [--readiness <json>] [--authorization <json>] [--now-ms <ms>]",
    );
    process.exit(2);
  }
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label}: ${error?.message ?? error}`);
  }
}

function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
