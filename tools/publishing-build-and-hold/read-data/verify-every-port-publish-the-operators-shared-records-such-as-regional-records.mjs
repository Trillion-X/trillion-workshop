// read-data/verify-every-port-publish-the-operators-shared-records-such-as-regional-records.mjs
//
// The publish decisions for the operator's shared records, ported from the old src/service-records.mjs (commit
// b6ae0ebf815f of the earlier repository). Only the rules are here: no storage, no network, no clock, no hashing. The old module published
// to a Worker edge store, which is retired; where the records live now and how each region reads them is an owner
// ruling that is not made yet, so nothing in this folder is wired.
//
// Invariants kept from the old module:
//   1. Only a label the data names, or one starting with one of its prefixes, is published or read.
//   2. A publication is skipped when the kept record is newer or carries the same identity, so a late arrival never
//      brings back an older value. Records in one batch are judged in order, each against what the batch kept before it.
//   3. A read kept for its time is still the answer; a read older than its time is not.
//   4. A refresh is wanted once per window: the first want of a window wins, a want for an earlier window never does.
//
//   isServiceRecordLabel(label, settings) → boolean
//   assertServiceRecordLabel(label, settings) → label | throws
//   operatorStorePublished(settings) → { labels, prefixes }
//   planServiceRecordPublication(records, kept, settings) → { publish: [record], skipped: [{ label, reason }] }
//   isKeptServiceRead(found, now, seconds) → boolean
//   planServiceRefreshWant(input, before, settings) → { first, next }
//
// A record's identity is the owner's content identity, computed by the caller. This module never computes one.
import serviceRecordSettings from './verify-every-port-publish-the-operators-shared-records-such-as-regional-records.json' with { type: 'json' };

export const isServiceRecordLabel = (label, settings = serviceRecordSettings) => typeof label === 'string' && label.length > 0
  && (settings.labels.includes(label) || settings.prefixes.some(prefix => label.startsWith(prefix)));

export function assertServiceRecordLabel(label, settings = serviceRecordSettings) {
  if (!isServiceRecordLabel(label, settings)) throw new Error('The service keeps no record by that name.');
  return label;
}

/** What the operator's store still publishes: every label and prefix except the ones a record owner writes itself
 *  (own_record_sources, not derived). */
export function operatorStorePublished(settings = serviceRecordSettings) {
  const owned = Object.entries(settings.own_record_sources).filter(([label]) => !settings.derived_labels.includes(label));
  const labels = new Set(owned.map(([label]) => label));
  const prefixes = new Set(owned.flatMap(([, source]) => source.workspace_prefixes ?? []));
  return { labels: settings.labels.filter(label => !labels.has(label)), prefixes: settings.prefixes.filter(prefix => !prefixes.has(prefix)) };
}

/** Judges a batch in order. `kept` maps a label to { at, identity } of the value already kept; it is not changed. */
export function planServiceRecordPublication(records, kept, settings = serviceRecordSettings) {
  if (!Array.isArray(records) || !records.length || records.length > settings.publish_most) throw new Error(`Publish between 1 and ${settings.publish_most} records at a time.`);
  const keptNow = new Map(Object.entries(kept));
  const publish = [];
  const skipped = [];
  for (const record of records) {
    const label = assertServiceRecordLabel(record?.label, settings);
    if (!Number.isFinite(record.at)) throw new Error('Each published record needs the time it was read.');
    const identity = record.identity ?? null;
    const before = keptNow.get(label);
    if (before && before.at > record.at) { skipped.push({ label, reason: 'a newer value is kept' }); continue; }
    if (before && before.identity === identity) { skipped.push({ label, reason: 'the same value is kept' }); continue; }
    publish.push({ label, value: record.value ?? null, identity, at: record.at });
    keptNow.set(label, { at: record.at, identity });
  }
  return { publish, skipped };
}

export function isKeptServiceRead(found, now, seconds = serviceRecordSettings.read_seconds) {
  return Boolean(found) && now - found.at < seconds * 1000;
}

/** The first want of a refresh window wins; a want for an earlier window than the kept one is refused. */
export function planServiceRefreshWant(input, before, settings = serviceRecordSettings) {
  if (input?.operation !== 'want') throw new Error('A service record refresh can only be wanted.');
  const label = assertServiceRecordLabel(input.label, settings);
  if (!Number.isSafeInteger(input.window)) throw new Error('A wanted refresh names its window.');
  if (before && before.window >= input.window) return { first: false, next: before };
  return { first: true, next: { label, window: input.window } };
}
