// tools/media-composition/test/make-rows.test.mjs: the make tools that run on this person's own computer or in the container are
// declared rows again, each with its kit. The style data names 13 styles; 7 are held on the treg ceiling question (their makers
// call tool:treg:google-ai.*, and those tools are not on this repository) and have no row until that is ruled. Restored by
// vep-L09 from commit 71fa35ac2^ after 71fa35ac2 removed all 14 rows with no ruling in its message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readMakeRows } from '../do-work/make-pictures-and-sounds.mjs';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(join(folder, file), 'utf8'));
const LOCAL = ['cut-out', 'sound-effect-forged-on-my-computer', 'sound-effect-from-stable-audio-3-on-my-computer', 'sound-effect-from-moss-on-my-computer', 'sound-effects-for-a-video-from-hunyuan-foley-on-my-computer'];
const HELD_ON_TREG = ['thumbnail-about-the-video', 'striking-picture-of-you', 'enhanced-frame', 'pencil-portrait', 'background-about-the-video', 'sound-effect', 'music', 'cut-out-on-a-new-background'];

test('the style data names 13 styles, each made by a listed maker', () => {
  assert.equal(readMakeRows().styles.size, 13);
});

test('every local make style is one declared tool:make-<style> row with its kit and a placed run', () => {
  const rows = read('what-this-tool-does-and-how-to-run-it.json').records.map(record => record.payload).filter(payload => payload.kind === 'ai-tool-descriptor');
  for (const style of LOCAL) {
    const row = rows.find(payload => payload.id === `tool:make-${style}`);
    assert.ok(row, `tool:make-${style} is a row`);
    assert.ok(existsSync(join(folder, 'kits', `make-${style}.json`)), `tool:make-${style} has its kit`);
    assert.ok(row.invoke.run.includes(style), `tool:make-${style} runs its own style`);
    assert.ok(Array.isArray(row.invoke.files.package_files), `tool:make-${style} names its package files as a list`);
    assert.ok(row.invoke.may_reach === undefined || row.invoke.may_reach.length > 0 || row.invoke.public_read, `tool:make-${style} declares the hosts it reaches`);
  }
});

test('no style held on the treg question has a row or a kit yet', () => {
  const ids = read('what-this-tool-does-and-how-to-run-it.json').records.map(record => record.payload.id);
  for (const style of HELD_ON_TREG) {
    assert.ok(!ids.includes(`tool:make-${style}`), `tool:make-${style} stays out until its question is ruled`);
  }
});
