// The share step's Files right is one the engine hands a run: the row asks for it in its top-level stored list (trillion-rust
// container.rs records_of reads row.stored, never invoke.stored), for /published-clips/ and share_file only, and tool:your-files
// offers share_file to runs, scoped by the name it shares, so the right reaches no name outside that folder. Nov 25 2026: with the
// list under invoke no door was mounted on descriptor 3 and every clip list with a published clip failed
// "EINVAL: invalid argument, read" (publish/site, 10:09 AM CST onward).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const clips = json('../records.json').things.find(thing => thing.payload?.id === 'tool:read-published-clips').payload;
const files = json('../../live-namespace/tool-rows.json').records.map(record => record.payload).find(row => row.id === 'tool:your-files');

test('the clips row asks for its Files right at its top level, for its folder and share_file only', () => {
  assert.deepEqual(clips.stored, [{ files: '/published-clips/', operations: ['share_file'] }]);
  assert.equal(clips.invoke.stored, undefined, 'none under invoke, where the engine never reads it');
  assert.equal(clips.invoke.records, undefined, 'and no records right besides it');
});

test('tool:your-files offers share_file to runs, scoped by the name it shares', () => {
  const offers = findOffers(files);
  assert.ok(offers, 'tool:your-files declares offers_runs');
  assert.equal(offers.right, 'files');
  assert.deepEqual(offers.operations.share_file, { id: 'name_or_identity' });
});

function findOffers(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.offers_runs) return value.offers_runs;
  for (const inner of Object.values(value)) {
    const found = findOffers(inner);
    if (found) return found;
  }
  return null;
}
