// parts/record-audio/read-data/capture-preflight.mjs
//
// THE DEVICE IS CHECKED BEFORE A RECORDING STARTS, AND KEPT AWAKE WHILE IT RUNS.
//
// Purpose: a recording that dies halfway because the device ran out of room, slept, or the battery gave out is the worst
// failure a recorder has. These checks read facts the page can read, stop a recording that cannot succeed before the person
// has spoken, and warn about one that probably will not. What is held while recording (the device stays awake) is released when
// the recording ends, however it ends. Every limit, every word key and every held thing is DATA (./capture-preflight.json).
//
// Non-negotiable invariants:
//   1. This file names no probe, no limit and no holder: probes and holders are handed in by the caller, rows say which.
//   2. A probe that answers null (the device cannot tell) never fails a check: not knowing is not a reason to refuse a recording.
//   3. Only a `block` row can stop a recording; the others only warn. Words are the problem keys of capture-sources.json.
//   4. `holdWhileRecording` never throws: a holder that cannot hold is skipped, and the release it returns is safe to call twice.
//
// Key concepts: `runPreflight(probes, rules?)` -> { blocking, warnings }; `holdWhileRecording(holders, rules?)` -> release().
import preflight from './capture-preflight.json' with { type: 'json' };

async function readProbe(probes, name) {
  try { const value = await probes[name]?.(); return typeof value === 'number' || typeof value === 'boolean' ? value : null; } catch { return null; }
}

/** Runs every check against `probes` ({ [probe]: () => value | Promise }). -> { blocking: [{ id, problem }], warnings: [{ id, problem }] } */
export async function runPreflight(probes, rules = preflight) {
  const values = new Map();
  const valueOf = async (name) => { if (!values.has(name)) values.set(name, await readProbe(probes, name)); return values.get(name); };
  const blocking = [];
  const warnings = [];
  for (const check of rules.checks) {
    const value = await valueOf(check.probe);
    if (typeof value !== 'number' || !(value < check.below)) continue;
    if (check.only_when && (await valueOf(check.only_when.probe)) !== check.only_when.is) continue;
    (check.block ? blocking : warnings).push({ id: check.id, problem: check.problem });
  }
  return { blocking, warnings };
}

/** Starts every held thing the device can hold; the returned function releases them all and is safe to call twice. */
export async function holdWhileRecording(holders, rules = preflight) {
  const held = [];
  for (const row of rules.hold) {
    try { const release = await holders[row.holder]?.(); if (typeof release === 'function') held.push(release); } catch { /* this device cannot hold it */ }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of held) { try { void Promise.resolve(release()).catch(() => {}); } catch { /* already released */ } }
  };
}
