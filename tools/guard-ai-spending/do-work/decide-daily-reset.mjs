#!/usr/bin/env node
// tools/guard-ai-spending/do-work/decide-daily-reset.mjs
//
// THE DAILY-RESET GATE (pure function):
//   should_reset(last_reset_marker, now) -> exit 0 (roll over) | exit 3 (same day)
//
// Single-flight daily reset for the agent wallet's total_spent_today. It exists as a
// compute.process step because only a process has a wall clock (workflow bindings have
// no 'now'), and the engine has no date arithmetic in bindings.
//
// Contract:
//   argv[2] = last-reset marker JSON text ({ kind, day, reset_at } or {} on first run)
//
// stdout:
//   { "should_reset": bool, "now_iso": "<ISO>", "day": "YYYY-MM-DD" }
//
// Exit code (the EDGE gate reads exit_code, NOT stdout — stdout is a byte side-channel
// the edge resolver cannot materialize):
//   0 = the UTC day rolled over since the last reset -> the workflow WRITES the reset
//   3 = same UTC day -> the workflow SKIPS the write (no-op tick)
//   2 = usage / malformed input

import process from 'node:process';

function main() {
  const rawMarker = process.argv[2];
  if (rawMarker === undefined) {
    process.stderr.write('decide-daily-reset: argv[2] last-reset marker is required\n');
    process.exit(2);
  }

  let marker = {};
  try {
    marker = JSON.parse(rawMarker) || {};
  } catch (err) {
    process.stderr.write(`decide-daily-reset: marker is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10); // YYYY-MM-DD (UTC)

  const lastDay = typeof marker.day === 'string' ? marker.day : null;
  const shouldReset = lastDay !== today; // never-reset (null) OR a new UTC day

  process.stdout.write(JSON.stringify({ should_reset: shouldReset, now_iso: nowIso, day: today }));
  process.exit(shouldReset ? 0 : 3);
}

main();
