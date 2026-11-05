import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const records = JSON.parse(readFileSync(new URL(import.meta.resolve('../records.json')), 'utf8'));
const descriptor = vendor => records.things.find(item => item.payload?.vendor === vendor)?.payload;

test('Apple Photos offers the real iPhone path without overstating full-library import', () => {
  const photos = descriptor('apple-photos');
  assert.match(photos.instructions, /iPhone without a Mac/);
  assert.ok(photos.connectGuide.some(step => /Full Access/.test(step)));
  assert.ok(photos.connectGuide.some(step => /held only in iCloud is downloaded/.test(step)));
  assert.ok(photos.connectGuide.some(step => /Older library items are not imported automatically yet/.test(step)));
  assert.doesNotMatch(photos.instructions, /Use the photos on your Mac\./);
});

test('Notes and Voice Memos expose the existing device share route honestly', () => {
  for (const vendor of ['apple-notes', 'apple-voice-memos']) {
    const item = descriptor(vendor);
    assert.match(item.instructions, /iPhone or iPad without needing the Mac app/);
    assert.ok(item.connectGuide.some(step => /share action/.test(step) && /Trillion/.test(step)));
    assert.ok(item.connectGuide.some(step => /does not offer Trillion a full/.test(step)));
  }
});
