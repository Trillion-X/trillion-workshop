// tools/wikimedia-commons/test/assess-commons-reuse.test.mjs
// The reuse check admits only an exact Public Domain, CC0 or CC BY declaration with its matching license address and
// full credit fields, refuses share-alike, non-commercial, no-derivatives and conflicting declarations, keeps the
// original metadata, and never passes HTML through. The command runs the way its row runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assessCommonsFileForReuse } from '../do-work/assess-commons-reuse.mjs';

const folder = resolve(import.meta.dirname, '..');
const file = (ext, page = 'https://commons.wikimedia.org/wiki/File:Example.jpg') => ({
  file: { title: 'File:Example.jpg', imageinfo: [{ descriptionurl: page, extmetadata: Object.fromEntries(Object.entries(ext).map(([key, value]) => [key, { value }])) }] },
});
const byFour = { Title: 'Example', Artist: 'A. Author', LicenseShortName: 'CC BY 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };

test('an exact CC BY declaration with title, author and Commons page is eligible, with a text credit', () => {
  const answer = assessCommonsFileForReuse({ ...file(byFour), changes: 'Cropped' });
  assert.equal(answer.eligible_for_selection, true);
  assert.equal(answer.credit.text, 'Example — A. Author — https://commons.wikimedia.org/wiki/File:Example.jpg — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changes: Cropped');
  assert.equal(answer.original_metadata.license_short_name, 'CC BY 4.0');
});

test('share-alike, a mismatched license address and a missing author are not eligible, and say why', () => {
  const shareAlike = assessCommonsFileForReuse(file({ ...byFour, LicenseShortName: 'CC BY-SA 4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' }));
  assert.equal(shareAlike.eligible_for_selection, false);
  assert.equal(shareAlike.credit, null);
  const mismatched = assessCommonsFileForReuse(file({ ...byFour, LicenseUrl: 'https://creativecommons.org/licenses/by/3.0/' }));
  assert.equal(mismatched.eligible_for_selection, false);
  const { Artist: _artist, ...noAuthor } = byFour;
  const unattributed = assessCommonsFileForReuse(file(noAuthor));
  assert.equal(unattributed.eligible_for_selection, false);
  assert.ok(unattributed.reasons.includes('Missing author metadata needed for a confident reuse candidate.'));
});

test('public domain needs Copyrighted=false; CC0 is admitted; a page off Commons is refused', () => {
  assert.equal(assessCommonsFileForReuse(file({ Title: 'Old map', Artist: 'Unknown', LicenseShortName: 'Public domain', Copyrighted: 'False' })).eligible_for_selection, true);
  assert.equal(assessCommonsFileForReuse(file({ Title: 'Old map', Artist: 'Unknown', LicenseShortName: 'Public domain' })).eligible_for_selection, false);
  assert.equal(assessCommonsFileForReuse(file({ Title: 'Sky', Artist: 'B', LicenseShortName: 'CC0', LicenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' })).eligible_for_selection, true);
  assert.equal(assessCommonsFileForReuse(file(byFour, 'https://example.com/wiki/File:Example.jpg')).eligible_for_selection, false);
});

test('HTML in the metadata becomes plain text in the credit', () => {
  const answer = assessCommonsFileForReuse(file({ ...byFour, Artist: '<a href="https://example.com/u">A.&nbsp;Author</a>' }));
  assert.equal(answer.credit.author, 'A. Author');
  assert.ok(!answer.credit.text.includes('<'));
});

test('the row runs the command with the input as its argument, and its sample run gives what its verify says', () => {
  const row = JSON.parse(readFileSync(resolve(folder, 'records.json'), 'utf8')).things.map(thing => thing.payload)
    .find(payload => payload.id === 'tool:assess-wikimedia-commons-file-reuse');
  const sample = row.verify.find(item => item.kind === 'sample-run');
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(sample.input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: folder, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  const picked = sample.output_selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);
  assert.ok(JSON.stringify(picked).includes(sample.contains), `${sample.output_selector} contains ${sample.contains}`);
});
