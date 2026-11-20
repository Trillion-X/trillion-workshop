// tools/media-composition/test/make-rows.test.mjs: the make tools are declared rows again. Every style in
// do-work/make-pictures-and-sounds.json is one tool:make-<style> record in tool-rows.json, and each has its kit. The styles were
// dropped by 48da049bf (a sidebar clean-up) without a ruling; this pins them so a later edit cannot drop them silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(join(folder, file), 'utf8'));

test('every make style is one declared tool:make-<style> row with its kit', () => {
  const styles = read('do-work/make-pictures-and-sounds.json').things
    .map(thing => thing.payload).filter(payload => payload.kind === 'media-generation-style');
  const makeIds = read('tool-rows.json').records.map(record => record.payload)
    .filter(payload => payload.kind === 'ai-tool-descriptor' && payload.id.startsWith('tool:make-')).map(payload => payload.id).sort();
  assert.equal(styles.length, 13, 'the style file names 13 styles');
  assert.equal(makeIds.length, styles.length, 'one row per style');
  for (const id of makeIds) {
    assert.ok(existsSync(join(folder, 'kits', `${id.slice('tool:'.length)}.json`)), `${id} has its kit`);
  }
});
