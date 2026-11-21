// The live-screens row runs the plain function runner on check-live-screens' export, on the person's computer (it needs the
// Mac's window server for the window picture), and packs the files the export reads, the window picture included.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:check-live-screens');
const packed = package_ => row.invoke.files.package_files.find(files => files.package === package_)?.paths ?? [];

test('the live row runs checkLiveScreens through the plain function runner, on the computer', () => {
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.invoke.argv[2], '/opt/check-every-screen-at-every-width/check-live-screens.mjs');
  assert.equal(row.invoke.argv[3], 'checkLiveScreens');
});

test('the live row packs the window picture and its lister, and the DATA the check reads', () => {
  assert.ok(packed('check-every-screen-at-every-width').includes('window-picture.mjs'));
  assert.ok(packed('check-every-screen-at-every-width').includes('list-windows.py'));
  assert.ok(packed('check-every-screen-at-every-width').includes('live-screens.json'));
  assert.ok(packed('workflows').includes('read-data/whole-file.mjs'));
});

test('the live row names a window input and its picture output', () => {
  assert.equal(row.input_schema.properties.window.type, 'boolean');
  assert.ok(row.output_schema.properties.window);
});
