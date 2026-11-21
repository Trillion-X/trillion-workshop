// tools/screen-look/test/font-licences.test.mjs
// The font licence gate (do-work/font-licences.mjs) on this repository's tracked files, and on fixtures for each refusal.
// The gate runs on every push through `npm test`, which runs every tools/**/*.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fontLicenceRefusals, KIT_FONTS, readLicences, trackedPaths } from '../do-work/font-licences.mjs';

const licences = readLicences();
const kit = file => `${KIT_FONTS}${file}`;

test('every font the repository tracks has a licence that allows the web', () => {
  assert.deepEqual(fontLicenceRefusals(trackedPaths(), licences), []);
});

test('a kit face file the licence DATA names for the web is accepted', () => {
  assert.deepEqual(fontLicenceRefusals([kit('Look-Regular.woff2'), kit('Recoleta-SemiBold.woff2')], licences), []);
});

test('a face file the licence DATA does not name is refused', () => {
  assert.equal(fontLicenceRefusals([kit('Sample-Regular.woff2')], licences).length, 1);
});

test('the removed SF Pro Text files are refused', () => {
  assert.equal(fontLicenceRefusals([kit('SF-Pro-Text-Regular.woff2')], licences).length, 1);
});

test('a font outside the kit folder is refused, even under a name the licence DATA lists', () => {
  assert.deepEqual(fontLicenceRefusals(['tools/ui/show/Look-Regular.woff2'], licences), [
    'tools/ui/show/Look-Regular.woff2: no face in tools/screen-look/show/fonts/licences.json names this file',
  ]);
});

test('a font in a subfolder of the kit folder is refused', () => {
  assert.equal(fontLicenceRefusals([`${KIT_FONTS}copies/Look-Regular.woff2`], licences).length, 1);
});

test('.ttf and .otf files are judged too, and other files are not', () => {
  assert.equal(fontLicenceRefusals(['app/Sample.ttf', 'app/Sample.otf'], licences).length, 2);
  assert.deepEqual(fontLicenceRefusals(['app/readme.md', 'app/font-notes.json'], licences), []);
});

test('a face its licence does not allow for the web is refused', () => {
  const app = { faces: [{ family: 'App Only', files: ['App-Only.woff2'], licensed_for: ['app'] }] };
  assert.deepEqual(fontLicenceRefusals([kit('App-Only.woff2')], app), [`${kit('App-Only.woff2')}: App Only is not licensed for the web`]);
});
