// The unlabeled diagnostic builder on a made-up frozen document: only blocks the criterion applies to become rows,
// each with its verified byte span and two blocks of reader context; the rest are counted; a changed source is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3Hex } from '../do-work/evaluate-voice.mjs';

const builder = fileURLToPath(new URL('../do-work/build-unlabeled-diagnostic.mjs', import.meta.url));
const document = '# A made-up guide\n\nThe kettle boiled in four minutes, so we timed the pot.\n\n- one\n- two\n\n> A quoted line.\n\nThe bread sank because the oven was cold.\n';
const criterion = { id: 'wording-and-connections', primitive: 'one-of', question: 'Does it connect?', options: [{ name: 'pass', description: 'Yes.' }, { name: 'fail', description: 'No.' }],
  reference_context: 'A made-up reference.', applies_to: ['paragraph', 'list', 'quote', 'mixed'] };

function lay() {
  const folder = mkdtempSync(join(tmpdir(), 'voice-unlabeled-'));
  writeFileSync(join(folder, 'guide.md'), document);
  writeFileSync(join(folder, 'adoption.json'), '{"adopted":true}\n');
  const freeze = { schema: 'private-book-source-freeze-v1', status: 'frozen', sources: [{ name: 'Guide', source: join(folder, 'guide.md'), source_blake3: blake3Hex(document),
    adoption: join(folder, 'adoption.json'), adoption_blake3: blake3Hex('{"adopted":true}\n') }] };
  writeFileSync(join(folder, 'freeze.json'), JSON.stringify(freeze));
  writeFileSync(join(folder, 'criteria.json'), JSON.stringify({ schema: 'book-voice-decider-challenge-v3', criteria: [criterion], items: [] }));
  return folder;
}
const run = folder => spawnSync(process.execPath, [builder, '--freeze', join(folder, 'freeze.json'), '--criteria', join(folder, 'criteria.json'), '--out-dir', folder], { encoding: 'utf8' });

test('only applicable blocks become label-free rows bound to their bytes and the two blocks before', () => {
  const folder = lay();
  try {
    const result = run(folder);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.outputs[0].total_blocks, 5);
    assert.deepEqual(summary.outputs[0].unassessed_counts, { heading: 1 });
    const data = JSON.parse(readFileSync(summary.outputs[0].path, 'utf8'));
    assert.equal(data.items.length, 4);
    assert.ok(data.items.every(item => item.split === 'unlabeled' && item.checks === undefined && item.gold === undefined));
    const last = data.items.at(-1);
    assert.equal(Buffer.from(document).subarray(last.byte_start, last.byte_end_exclusive).toString(), last.text);
    assert.deepEqual(last.preceding_block_indices, [2, 3]);
    assert.equal(data.limits.gold_labels_present, false);
    assert.equal(run(folder).status, 1, 'an existing output is never replaced');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a source that differs from its freeze is refused', () => {
  const folder = lay();
  try {
    writeFileSync(join(folder, 'guide.md'), document + '\nA new paragraph.\n');
    const result = run(folder);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source differs from freeze.json/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
