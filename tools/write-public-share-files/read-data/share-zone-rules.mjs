// Ported from immutable source 21b59753dd315040af8e148359164f0056bc054f:
// src/record-sharing.mjs lines 157-159 and 172-176.
import sharing from './share-time-zone.json' with { type: 'json' };

const ZONED = new Set(sharing.when_facts.filter(fact => fact.zoned).map(fact => fact.id));
const namesZone = tree => tree?.kind === 'rule' ? ZONED.has(tree.field) : (tree?.rules ?? []).some(namesZone);
// HELD: canonical wall-time import is pending shared-import adoption.
const zoneOk = zone => timeZoneName(zone) !== null;

export function zoneProblem(condition, zone) {
  if (zone !== null && zone !== undefined && !zoneOk(zone)) return 'time_zone is an IANA zone such as Europe/London.';
  if (condition && namesZone(condition) && !zoneOk(zone)) return 'A rule on the hour or the day needs time_zone: an IANA zone such as Europe/London.';
  return null;
}
