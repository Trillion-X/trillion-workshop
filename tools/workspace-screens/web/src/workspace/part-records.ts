// src/workspace/part-records.ts
//
// PURPOSE
//   The feeds a ported part reads, made from the records its own package manifest ships (`things-to-store-and-run.json`,
//   copied unchanged from its package). A part written for the record engine reads a feed by name: a selection of the
//   current records (`record_from_matching_records`: the records at a path whose fields match). Here each declared feed
//   is computed once from the manifest's records, as label -> value for `startRecords`, so the part opens with the
//   materials, shortcuts, marks and actions its package ships.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a part, a feed or a field: the feeds, their paths and their tests are the manifest's DATA.
//   2. A feed row has the record engine's shape: `{ record: { address, source_package }, path, payload }`.
//   3. A test this file does not know stops with its name, so a feed is never silently wider or narrower than declared.
//   4. `partManifestFeeds` returns only feeds, never the manifest's own records under their labels, so a record the
//      person saved under the same label is never replaced by the package's copy. `partManifestInputValues` returns the
//      records the manifest's own input descriptors read (`value_address_label`), for records.ts `showMissing`, which
//      shows each only where nothing is kept under that label.

type Thing = {
  type?: string;
  address?: string;
  path?: string[];
  payload?: unknown;
  remove?: boolean;
  matching_record_paths?: string[][];
  payload_bytes?: { value_to_bytes?: string; rows?: { match?: Test[] } };
};
type Test = { path: string[] } & Record<string, unknown>;
type Manifest = { package?: string; things?: Thing[] };
type Row = { record: { address: string; source_package?: string }; path: string[]; payload: unknown };

const at = (value: unknown, path: string[]) => path.reduce<unknown>((here, key) => (here && typeof here === 'object' ? (here as Record<string, unknown>)[key] : undefined), value);

// Each test a feed may declare, by its key: whether the value at the test's path passes it.
const TESTS: Record<string, (value: unknown, expected: unknown) => boolean> = {
  equals: (value, expected) => value === expected,
  not_equals: (value, expected) => value !== expected,
  in: (value, expected) => Array.isArray(expected) && expected.includes(value),
  contains: (value, expected) => typeof value === 'string' && typeof expected === 'string' && value.includes(expected),
  present: (value, expected) => (value !== undefined && value !== null) === expected,
  address_not_prefixed: (value, expected) => typeof value === 'string' && Array.isArray(expected) && !expected.some(prefix => value.startsWith(String(prefix))),
};

function passes(row: Row, test: Test) {
  const keys = Object.keys(test).filter(key => key !== 'path');
  return keys.every(key => {
    const check = TESTS[key];
    if (!check) throw new Error(`A feed asks for a record test this app does not know: ${key}.`);
    return check(at(row, test.path), test[key]);
  });
}

/** Every feed a part's manifest declares, computed from the current records the manifest ships. */
export function partManifestFeeds(manifest: Manifest): Record<string, unknown> {
  const things = manifest.things ?? [];
  const records = things.filter(thing => thing.type === 'record' && typeof thing.address === 'string' && !thing.remove && thing.payload !== null && thing.payload !== undefined);
  const feeds: Record<string, unknown> = {};
  for (const feed of things) {
    if (feed.type !== 'record_from_matching_records' || typeof feed.address !== 'string') continue;
    const paths = (feed.matching_record_paths ?? []).map(path => path.join('/'));
    const tests = feed.payload_bytes?.rows?.match ?? [];
    feeds[feed.address] = records
      .filter(record => paths.includes((record.path ?? []).join('/')))
      .map((record): Row => ({ record: { address: record.address!, source_package: manifest.package }, path: record.path ?? [], payload: record.payload }))
      .filter(row => tests.every(test => passes(row, test)));
  }
  return feeds;
}

/** The records a part's declared inputs read (an input descriptor's `value_address_label` naming a record the manifest
 * ships), as label -> value: the settings and descriptors its package publishes for its own screen. */
export function partManifestInputValues(manifest: Manifest): Record<string, unknown> {
  const things = manifest.things ?? [];
  const byAddress = new Map(things.filter(thing => thing.type === 'record' && typeof thing.address === 'string' && !thing.remove).map(thing => [thing.address!, thing.payload]));
  const values: Record<string, unknown> = {};
  for (const thing of things) {
    const label = (thing.payload as { kind?: unknown; value_address_label?: unknown } | undefined)?.kind === 'bitfield-input-descriptor'
      ? (thing.payload as { value_address_label?: unknown }).value_address_label : undefined;
    if (typeof label === 'string' && byAddress.get(label) != null) values[label] = byAddress.get(label);
  }
  return values;
}
