// Two-tier capture dedupe (tools/tell-a-repeated-capture-from-a-new-one/read-data/capture-dedupe.mjs;
// moved from Trillion test/capture-categories.test.mjs, F-0142).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDedupe, dedupeSettings, distance, simhash } from '../read-data/capture-dedupe.mjs';

const page = 'Quarterly report for the finance team with revenue costs and the plan for the next three quarters of the year';

test('the exact tier catches the same text, the near tier a lightly changed one, a different text and a short one pass, and erasing a span forgets it', () => {
  const dedupe = createDedupe(dedupeSettings());
  assert.deepEqual(dedupe.seen(page, 1000), { duplicate: false });
  assert.equal(dedupe.seen(`  ${page.toUpperCase()}  `, 2000).duplicate, 'exact');
  assert.equal(dedupe.seen(`${page} today`, 3000).duplicate, 'near');
  assert.equal(dedupe.seen('Completely different words appear on this other screen about travel plans to the coast next summer', 4000).duplicate, false);
  assert.equal(dedupe.seen('Save', 5000).duplicate, false);
  assert.equal(dedupe.seen('Cancel', 6000).duplicate, false, 'short texts are never near each other');
  assert.equal(dedupe.erase(900, 2500), 1);
  assert.deepEqual(dedupe.seen(page, 7000), { duplicate: false }, 'an erased capture no longer hides a later one');
  const aged = createDedupe({ ...dedupeSettings(), remember_seconds: 1 });
  aged.seen(page, 0); assert.equal(aged.seen(page, 5000).duplicate, false);
  const bounded = createDedupe({ ...dedupeSettings(), most_entries: 2 });
  ['alpha one two three four five six seven eight', 'beta one two three four five six seven eight nine', 'gamma ten eleven twelve thirteen fourteen fifteen sixteen'].forEach((t, i) => bounded.seen(t, i));
  assert.equal(bounded.size(), 2);
  assert.ok(distance(simhash(page), simhash(`${page} today`)) <= 6);
  assert.ok(distance(simhash(page), simhash('Completely different words appear on this other screen about travel plans')) > 10);
});

test('the memory survives a restart as plain JSON', () => {
  const first = createDedupe(dedupeSettings());
  first.seen(page, 1000);
  const second = createDedupe(dedupeSettings(), JSON.parse(JSON.stringify(first.entries())));
  assert.equal(second.seen(`${page} today`, 2000).duplicate, 'near');
  assert.equal(second.seen(page, 3000).duplicate, 'exact');
});
