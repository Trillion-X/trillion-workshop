// Ported from immutable source 21b59753dd315040af8e148359164f0056bc054f:
// src/record-sharing.mjs lines 157-159 and 172-176.
import sharing from './share-time-zone.json' with { type: 'json' };
import { timeZoneName } from '../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs';

const ZONED = new Set(sharing.when_facts.filter(fact => fact.zoned).map(fact => fact.id));
const namesZone = tree => tree?.kind === 'rule' ? ZONED.has(tree.field) : (tree?.rules ?? []).some(namesZone);
// A zone is one the timed-action engine names (the one zone check of every Workshop owner).
const zoneOk = zone => timeZoneName({ value: zone }) !== null;

export function zoneProblem(condition, zone) {
  if (zone !== null && zone !== undefined && !zoneOk(zone)) return 'time_zone is an IANA zone such as Europe/London.';
  if (condition && namesZone(condition) && !zoneOk(zone)) return 'A rule on the hour or the day needs time_zone: an IANA zone such as Europe/London.';
  return null;
}
