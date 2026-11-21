// The live-screens row runs the plain function runner on check-live-screens' export, in a container on this Mac like the given-pages
// check (the fetched headless shell, the files the export reads, the records door for the pictures' keep path). The window
// picture is not in this row: it is a separate computer row, because it needs the Mac's own window server.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:check-live-screens');
const packed = package_ => row.invoke.files.package_files.find(files => files.package === package_)?.paths ?? [];

test('the live row runs checkLiveScreens through the plain function runner, in a container on this Mac', () => {
  assert.equal(row.invoke.kind, 'container');
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.invoke.argv[2], '/opt/check-every-screen-at-every-width/check-live-screens.mjs');
  assert.equal(row.invoke.argv[3], 'checkLiveScreens');
  assert.equal(row.invoke.programs['chrome-headless-shell'].fetch['macos-aarch64'].version, '153.0.8010.12');
});

test('the live row packs the DATA the check reads and the pictures\' keep path, and no window picture', () => {
  assert.ok(packed('check-every-screen-at-every-width').includes('live-screens.json'));
  assert.ok(!packed('check-every-screen-at-every-width').includes('window-picture.mjs'));
  assert.ok(packed('headless-browser').includes('admission.json'));
  assert.ok(packed('workflows').includes('read-data/whole-file.mjs'));
});

test('the live row takes the reach, sign-in and until inputs and names its picture output', () => {
  assert.ok(row.input_schema.properties.pages.items.properties.reach);
  assert.ok(row.input_schema.properties.pages.items.properties.sign_in.oneOf);
  assert.equal(row.input_schema.properties.window, undefined);
});
