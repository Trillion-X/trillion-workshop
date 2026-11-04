// parts/timed-action/do-work/zone-drift.ts
//
// Purpose
//   Whether the zone a device now shows differs from the zone a person plans in, and whether to ask about it. Pure.
//
// Non-negotiable invariants
//   1. The planning zone (where plans and working hours are kept) and the device's display zone are two facts; a
//      difference is never fixed silently.
//   2. A newly detected zone is asked about once: the zones already asked about are remembered, so a "keep" answer is
//      not asked again on the next load, and moving to a zone again after leaving it is asked afresh only when it was
//      never asked about.
//   3. An unknown zone name on either side is refused (TypeError), never read as UTC (wall-time.ts timeZoneName).
import { timeZoneName } from './wall-time.ts';

export interface ZoneDriftAnswer {
  planning_zone: string;
  device_zone: string;
  drifted: boolean;
  /** Ask the person whether to move their plans to the device zone. */
  ask: boolean;
}

export function zoneDrift(planningZone: string, deviceZone: string, askedZones: readonly string[] = []): ZoneDriftAnswer {
  const planning = timeZoneName(planningZone), device = timeZoneName(deviceZone);
  if (!planning || !device) throw new TypeError('Both zones must be time zones like America/New_York.');
  const asked = new Set(askedZones.map(zone => timeZoneName(zone)).filter(Boolean));
  const drifted = planning !== device;
  return { planning_zone: planning, device_zone: device, drifted, ask: drifted && !asked.has(device) };
}
