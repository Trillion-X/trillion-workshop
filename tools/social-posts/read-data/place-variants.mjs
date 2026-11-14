// tools/social-posts/read-data/place-variants.mjs
//
// Purpose: make the by_input variants of the two tool rows that reach a place (tool:send-a-post and
// tool:check-a-connection) from the place rows (read-data/post-places.json), so the place row is the one owner of
// which connection kind, which held fields, how the access token is renewed and how a connection is asked who it is,
// and no tool id names a vendor. A variant is a JSON merge patch over the row's invoke, chosen by the run's `place`
// input (the place's slug: its id without `post-place:`); the engine merges it before any kind reads the row.
//
// Non-Negotiable Invariants:
//   1. Nothing here names a place or a vendor: every fact is read from a place row.
//   2. A send variant mounts exactly the held fields the place signs with (`heldFields`), on descriptors 4, 5, ... in
//      the order the sender reads them, so no run is handed a value its place never uses.
//   3. A check variant places the held value only in the header or query the place row says, bound to the one host
//      of the check's address.
//   4. A place with no `check` has no check variant: asking it is refused naming the places that do.
//
// Use: `node tools/social-posts/read-data/place-variants.mjs --write` rewrites the variants in
// tools/social-posts/tool-rows.json from the place rows; `--check` exits 1 when they differ (test/place-variants.test.mjs
// holds the same).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import placeRows from './post-places.json' with { type: 'json' };
import { heldFields } from './posts.mjs';

export const SEND_TOOL = 'tool:send-a-post';
export const CHECK_TOOL = 'tool:check-a-connection';
const FIRST_HELD_DESCRIPTOR = 4;
const ACCOUNT_INPUT = 'account_id';

/** The place's slug: its row id without the `post-place:` prefix. */
export const slugOf = place => place.id.replace(/^post-place:/, '');

const connectionOf = place => ({ vendor: place.connection_vendor, from_input: ACCOUNT_INPUT });

/** One variant per place: its connection kind, its held fields as mounts and how its access token is renewed. */
export function sendVariants(places = placeRows.places) {
  return Object.fromEntries(places.map(place => [slugOf(place), {
    connection: connectionOf(place),
    credential_mounts: heldFields(place.options).map((field, at) => ({ field_id: field, fd: FIRST_HELD_DESCRIPTOR + at })),
    ...(place.refresh ? { refresh: place.refresh } : {}),
  }]));
}

/** One variant per place that declares a check: the request, its one injection and the connection kind. */
export function checkVariants(places = placeRows.places) {
  return Object.fromEntries(places.filter(place => place.check).map(place => {
    const { url, query, field_id: fieldId, placement, timeout_seconds: timeoutSeconds } = place.check;
    return [slugOf(place), {
      ...(place.refresh ? { refresh: place.refresh } : {}),
      url,
      timeout_seconds: timeoutSeconds,
      query: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, { const: value }])),
      credential_injections: [{ hosts: [new URL(url).host], field_id: fieldId, placement }],
      connection: connectionOf(place),
    }];
  }));
}

const ROWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tool-rows.json');
const variantsFor = { [SEND_TOOL]: sendVariants, [CHECK_TOOL]: checkVariants };

/** tool-rows.json's text with each place tool's variants made from the place rows. */
export function withVariants(text) {
  const rows = JSON.parse(text);
  for (const record of rows.records) {
    const make = variantsFor[record.payload.id];
    if (make) record.payload.invoke.by_input.variants = make();
  }
  return `${JSON.stringify(rows, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = readFileSync(ROWS, 'utf8');
  const made = withVariants(current);
  if (process.argv.includes('--write')) writeFileSync(ROWS, made);
  else if (made !== current) { console.error('tool-rows.json variants differ from the place rows: run with --write'); process.exit(1); }
}
