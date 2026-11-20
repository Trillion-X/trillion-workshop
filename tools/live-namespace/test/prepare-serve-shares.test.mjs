// The share route's prepare step (on-a-computer/prepare-serve-shares.mjs): the page folder becomes the unit's files under the path its
// settings name, a person's own folder replaces the shipped one, and a folder that is not there, a page path that is not absolute,
// or a folder outside the Workshop is refused in words. Synthetic units only.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../on-a-computer/prepare-serve-shares.mjs';

const unit = (extra = {}) => ({ unit: 'files-share-route.service', settings: { share_bytes: { page: '/etc/files-share-route/share-page' } }, ...extra });

test('the shipped page folder becomes the unit files under the settings page path', async () => {
  const { unit: prepared } = await prepare(unit({ files: [{ path: '/etc/other', text: 'kept' }] }));
  const paths = prepared.files.map(file => file.path);
  assert.deepEqual(paths, ['/etc/other', '/etc/files-share-route/share-page/assets/share-page.css', '/etc/files-share-route/share-page/assets/share-page.js',
    '/etc/files-share-route/share-page/items.json', '/etc/files-share-route/share-page/page.html']);
  assert.ok(prepared.files.every(file => file.then === undefined), 'a changed page file restarts the route');
  assert.equal(prepared.share_page, undefined);
});

test('a person\'s own page folder replaces the shipped one, a binary file kept as base64', async () => {
  const own = tempFolder(join(tmpdir(), 'own-page-'));
  writeFileSync(join(own, 'page.html'), '<p>{{title}}</p>');
  writeFileSync(join(own, 'items.json'), '{"": "{{name}}"}');
  mkdirSync(join(own, 'assets'));
  writeFileSync(join(own, 'assets', 'mark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const { unit: prepared } = await prepare(unit({ share_page: own }));
  const mark = prepared.files.find(file => file.path.endsWith('mark.png'));
  assert.deepEqual([mark.binary, Buffer.from(mark.text, 'base64')], [true, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])]);
  assert.equal(prepared.files.find(file => file.path.endsWith('page.html')).text, '<p>{{title}}</p>');
});

test('what cannot be a page is refused in words', async () => {
  await assert.rejects(prepare({ unit: 'x', share_page: '/somewhere' }), /names no place for it/);
  await assert.rejects(prepare(unit({ settings: { share_bytes: { page: 'relative' } } })), /absolute path/);
  await assert.rejects(prepare(unit({ share_page: '../../../etc' })), /leaves the Workshop/);
  await assert.rejects(prepare(unit({ share_page: '/no/such/folder' })), /is not a folder/);
  const empty = tempFolder(join(tmpdir(), 'empty-page-'));
  await assert.rejects(prepare(unit({ share_page: empty })), /no page.html and items.json/);
  assert.deepEqual(await prepare({ unit: 'y' }), { unit: { unit: 'y' } }, 'a unit with no page is left as it is');
});
