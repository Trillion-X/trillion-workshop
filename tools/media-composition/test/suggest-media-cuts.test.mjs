// tool:suggest-media-cuts (do-work/suggest-media-cuts.mjs): the container run of read-data/auto-edit.mjs. The caller keeps the
// answer, the container keeps nothing; the row's sample runs as the container runs it. Every value here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { suggestMediaCuts } from '../do-work/suggest-media-cuts.mjs';

const word = (word, start, end) => ({ word, start, end });
const transcript = { segments: [{ words: [word('hello', 0, 0.5), word('um', 0.6, 0.9), word('world', 3, 3.5)] }] };
const ID = `1f:${'a'.repeat(64)}`;

test('a first ask returns the proposals and the entry to keep; handed that entry back, it answers from it', async () => {
  const first = await suggestMediaCuts({ identity: ID, mode: 'filler_words', transcript });
  assert.deepEqual(first.lines.at(-1).proposals.map(item => [item.start, item.end, item.reason]), [[0.6, 0.9, 'filler']]);
  assert.equal(first.keep.id, `${ID}:filler_words`);
  assert.deepEqual(first.modes, ['silent_pauses', 'filler_words']);
  const again = await suggestMediaCuts({ identity: ID, mode: 'filler_words', transcript, kept: first.keep.entry });
  assert.deepEqual(again.lines.map(line => [line.type, line.cached]), [['complete', true]]);
  assert.equal(again.keep, null);
});

test('the row sample runs as the container runs it', () => {
  const rows = JSON.parse(readFileSync(new URL('../records.json', import.meta.url))).things;
  const row = rows.find(thing => thing.payload.id === 'tool:suggest-media-cuts').payload;
  const run = spawnSync('node', ['do-work/suggest-media-cuts.mjs'], { cwd: new URL('..', import.meta.url), input: JSON.stringify(row.verify[0].input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).result.lines.at(-1).proposals[0].reason, row.verify[0].contains);
});
