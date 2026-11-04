// src/device-facts.mjs
//
// Purpose
//   What the person's own devices report about themselves, kept so that what waits on the person can tick itself:
//   a page on a Mac says which cameras it sees, the iPhone app says whether its switches are on. A row on the Waiting
//   on you list whose "Done once" rule passes on one device's facts is done (src/person-store.mjs
//   doneByDeviceFacts), so the person never has to mark done what a device can see for itself.
//
// Non-negotiable invariants
//   1. Nothing here names a device, a fact or a check: a device is its own name, a fact is a name and a text, and what
//      a fact means is only ever in a row's rule. A new kind of fact is a device reporting it.
//   2. A report replaces that device's facts whole: a camera unplugged is a camera no longer listed, never a stale one.
//   3. A report that changes nothing writes nothing.
//   4. Bounded: at most `most_devices` devices, the least recently heard dropped first, and `most_facts` short facts
//      each; anything else is refused with words saying what fits (src/device-facts.json).
//   5. A rule passes on ONE device's facts, never on facts mixed from several, so "the switch is on" is the switch of
//      a device that says so. Every fact is text, so a rule compares it with text operators (is_text, contains); a
//      rule the engine cannot finish passes nothing.
//
// Key concepts
//   Legacy device  { device, facts: { name: text }, at }
//   Profile device { device: display label, identity: profile id, facts: merged source facts,
//                    sources: { source: { generation, facts } }, at }
//
// Security
//   Facts live in this person's own store and are reported only by their signed-in pages and apps; nothing here is
//   read by anyone else.
//

import settings from './device-facts.json' with { type: 'json' };

export class DeviceFactsError extends Error {}

const words = (key, values) => settings.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const NAME = new RegExp(settings.name_pattern);
const REPORT_GENERATION = /^\d{16}-page-[a-z0-9-]{1,60}-\d{8}$/;

function combinedSources(sources) {
  const facts = {};
  for (const source of Object.values(sources ?? {})) Object.assign(facts, source?.facts ?? {});
  return facts;
}

function validReportFacts(facts) {
  const entries = facts && typeof facts === 'object' && !Array.isArray(facts) ? Object.entries(facts) : null;
  return entries && entries.length <= settings.most_facts
    && entries.every(([key, value]) => NAME.test(key) && typeof value === 'string' && value.length <= settings.value_chars)
    ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) : null;
}

/** store: { read() → [device], write([device]) } */
export function deviceFacts(store, { now = () => new Date() } = {}) {
  const list = () => (Array.isArray(store.read()) ? store.read() : []);
  return {
    all: list,
    report({ device, device_id, source, generation, facts } = {}) {
      const name = typeof device === 'string' ? device.trim() : '';
      if (!name || name.length > settings.device_chars) throw new DeviceFactsError(words('bad_device', { chars: settings.device_chars }));
      const kept = validReportFacts(facts);
      if (!kept) throw new DeviceFactsError(words('bad_facts', { most: settings.most_facts }));
      const identified = device_id !== undefined || source !== undefined || generation !== undefined;
      if (identified && (typeof device_id !== 'string' || !NAME.test(device_id) || typeof source !== 'string' || !NAME.test(source)
        || !(Number.isSafeInteger(generation) && generation > 0) && !(typeof generation === 'string' && REPORT_GENERATION.test(generation))))
        throw new DeviceFactsError('A device report needs its stable device id, source name and increasing generation.');
      const rows = list();
      const earlier = rows.find(row => identified ? row.identity === device_id : !row.identity && row.device === name);
      if (identified) {
        const sources = { ...(earlier?.sources ?? {}) };
        const prior = sources[source];
        if (prior && (typeof generation !== typeof prior.generation || generation <= prior.generation))
          return { device: name, device_id, source, changed: false, stale: true, current_generation: prior.generation };
        sources[source] = { generation, facts: kept };
        const sourceNames = Object.keys(sources);
        if (sourceNames.length > (settings.most_sources ?? 20)) throw new DeviceFactsError(words('bad_sources', { most: settings.most_sources ?? 20 }));
        const merged = combinedSources(sources);
        if (Object.keys(merged).length > settings.most_facts) throw new DeviceFactsError(words('bad_facts', { most: settings.most_facts }));
        const unchanged = earlier && JSON.stringify(earlier.facts) === JSON.stringify(merged) && earlier.device === name;
        const updated = { ...(earlier ?? {}), device: name, identity: device_id, facts: merged, sources, at: now().toISOString() };
        store.write([...rows.filter(row => row !== earlier), updated].slice(-settings.most_devices));
        return { device: name, device_id, source, changed: !unchanged };
      }
      if (earlier && JSON.stringify(earlier.facts) === JSON.stringify(kept)) return { device: name, changed: false };
      const next = [...rows.filter(row => row !== earlier), { device: name, facts: kept, at: now().toISOString() }];
      store.write(next.slice(-settings.most_devices));
      return { device: name, changed: true };
    },
  };
}

/**
 * Which rows' rules pass on some one device's facts. rows: [{ id, tree }]; filterRows: the formula engine's row filter
 * ({ tree, fields, rows } → { matches, incomplete }). Answers the ids of the rows that pass.
 */
export async function passedOnSomeDevice(rows, devices, filterRows) {
  if (!rows.length || !devices.length) return [];
  const names = [...new Set(devices.flatMap(row => Object.keys(row.facts ?? {})))];
  const fields = names.map(id => ({ id, kind: 'text' }));
  const facts = devices.map(row => Object.fromEntries(names.map(id => [id, row.facts?.[id] ?? null])));
  const passed = [];
  for (const row of rows) {
    // A rule the engine cannot finish (an operator that does not apply to text, a missing value) passes nothing.
    const { matches, incomplete } = await filterRows({ tree: row.tree, fields, rows: facts });
    if (!(incomplete ?? []).length && (matches ?? []).length) passed.push(row.id);
  }
  return passed;
}
