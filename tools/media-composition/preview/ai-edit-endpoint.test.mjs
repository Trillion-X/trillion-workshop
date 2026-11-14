import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { aiEditPlugin, decodePreviewLibrary, libraryRows } from './ai-edit-endpoint.mjs';

const clips = [
  { id: 'clip-a', file: '/owner-mounted/clip-a.mp4', label: 'Opening', dur: 4.5 },
  { id: 'clip-b', file: '/owner-mounted/clip-b.mp4', label: 'Explanation', dur: 8, thumb: '/thumb-b.jpg' },
];

test('preview library is selected entirely from caller DATA', () => {
  const library = decodePreviewLibrary({ clips });
  assert.deepEqual(libraryRows(library), [
    { id: 'clip-a', label: 'Opening', dur: 4.5, thumb: '/thumbs/clip-a.jpg' },
    { id: 'clip-b', label: 'Explanation', dur: 8, thumb: '/thumb-b.jpg' },
  ]);
  assert.equal(aiEditPlugin({
    library: clips,
    aiCommand: ['provider-ai'],
    composeCommand: ['provider-compose'],
    probeCommand: ['provider-probe'],
  }).name, 'ai-edit-endpoint');
});

test('preview library refuses missing locators, invalid durations and duplicate ids', () => {
  assert.throws(() => decodePreviewLibrary([{ id: 'a', label: 'A', dur: 1 }]), /owner-resolved file locator/);
  assert.throws(() => decodePreviewLibrary([{ id: 'a', file: '/a', label: 'A', dur: 0 }]), /positive duration/);
  assert.throws(() => decodePreviewLibrary([
    { id: 'a', file: '/a', label: 'A', dur: 1 },
    { id: 'a', file: '/b', label: 'B', dur: 1 },
  ]), /duplicated/);
});

test('generic preview source contains no founder, campaign, mounted-volume or fixed provider coupling', async () => {
  const endpoint = await readFile(new URL('./ai-edit-endpoint.mjs', import.meta.url), 'utf8');
  const surface = await readFile(new URL('./main.tsx', import.meta.url), 'utf8');
  const forbidden = /\/Volumes\/|\b(?:zz-name-one|zz-name-two|zz-name-three)\b|zz-folder-name|execFileP\(\s*['"](?:claude|ffmpeg|node)['"]/i;
  assert.doesNotMatch(endpoint, forbidden);
  assert.doesNotMatch(surface, forbidden);
});
