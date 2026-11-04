// Looks are measured against the contrast floors in parts/screen-look/look-readability.json when saved and published (src/looks.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLooks } from '../src/looks.mjs';
import { readabilityMisses } from '../../screen-look/read-data/look-readability.ts';
import readability from '../../screen-look/look-readability.json' with { type: 'json' };
import appLooks from '../src/workspace/looks.json' with { type: 'json' };

const APP_ID = appLooks.themes[0].payload.id;
function account() {
  const records = {}, rows = [];
  const looks = makeLooks({
    records: { read: () => structuredClone(records), write: writes => { for (const w of writes) records[w.address_label] = structuredClone(w.payload); } },
    shelf: { published: async () => rows, publish: async ({ row, maker }) => { rows.push({ row, maker }); }, withdraw: async () => false }, maker: 'maker:a',
  });
  return { looks, rows };
}

test('the app\'s own looks all clear the floors, and the pairs are really measured', () => {
  assert.ok(readabilityMisses([{ key: 'text-primary', value: '#808080' }, { key: 'surface-base', value: '#777777' }], readability).length, 'a bad pair is caught on these key names');
  for (const { payload } of appLooks.themes) assert.deepEqual(readabilityMisses(payload.tokens, readability), [], payload.id);
});

test('a look with grey text on a grey ground is saved and published with each miss said', async () => {
  const { looks, rows } = account();
  const made = await looks.save({ from: APP_ID, name: 'Murky', tokens: { 'surface-base': '#777777', 'text-primary': '#808080' } });
  console.log('SAVE:', JSON.stringify(made.readability), made.said);
  assert.equal(made.readability[0].text, 'text-primary');
  assert.match(made.said, /Body text on the page reads at 1\.\d+:1, under the 4\.5:1 it needs/);
  const published = await looks.publish({ look_id: made.look.id });
  console.log('PUBLISH:', published.said);
  assert.equal(rows.length, 1, 'default open: published anyway');
  assert.ok(published.readability.length >= 1);
});

test('a readable look says nothing extra', async () => {
  const { looks } = account();
  const made = await looks.save({ from: APP_ID, name: 'Clear', tokens: { 'surface-base': '#000000', 'text-primary': '#ffffff' } });
  assert.equal(made.readability, undefined);
});
