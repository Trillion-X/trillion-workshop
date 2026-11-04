// tools/walk-a-new-person-through-setup/report-device-facts.mjs
//
// What a person's devices say about themselves, as one run: device-facts.mjs deviceFacts, unchanged, over a store
// kept in memory for the run. The devices kept so far are handed in, each report is applied in order (a report
// replaces that device's, or that device source's, facts whole), and the devices as kept at the end come back.
//
//   reportDeviceFacts({ devices?, reports, now? }) -> { answers, devices }
//     devices  the devices kept so far (the last run's devices; omit the first time): [{ device, facts, at, identity?, sources? }]
//     reports  [{ device, facts: { name: text }, device_id?, source?, generation? }]; device_id, source and generation
//              come together (a stable id, the source's name and an increasing generation)
//     now      an ISO time stamped on what changes (the run's clock when left out)
//   answers  one per report: { device, changed, device_id?, source?, stale?, current_generation? }
//   devices  every device kept, at most device-facts.json most_devices, the least recently heard dropped first
//
// Refuses: no reports; a report with no device name or one too long; facts that are not { name: text } within
// device-facts.json's bounds; an identified report missing its id, source or generation. The refusal names which
// report and says what fits.
//
// What the run never does: it keeps nothing after the run (send the answered devices back next time), reads no
// device itself, and ticks no setup step (whether a step's Done rule passes is the account's checklist and the
// formula engine's). It reads only what it is given and writes nothing.
import { deviceFacts } from './device-facts.mjs';

export function reportDeviceFacts({ devices = [], reports, now } = {}) {
  if (!Array.isArray(devices)) throw new Error('devices is the list the last run answered (or leave it out the first time).');
  if (!Array.isArray(reports) || reports.length === 0) throw new Error('Give reports: a list of { device, facts: { name: text } }.');
  const at = now === undefined ? null : new Date(now);
  if (at && Number.isNaN(at.getTime())) throw new Error(`now ${JSON.stringify(now)} is not a time; give an ISO time such as 2026-11-04T09:00:00Z.`);
  let kept = devices;
  const store = { read: () => kept, write: next => { kept = next; } };
  const facts = deviceFacts(store, at ? { now: () => at } : {});
  const answers = reports.map((report, index) => {
    try { return facts.report(report); } catch (error) { throw new Error(`Report ${index}: ${error.message}`); }
  });
  return { answers, changed: answers.filter(answer => answer?.changed).length, devices: facts.all() };
}
