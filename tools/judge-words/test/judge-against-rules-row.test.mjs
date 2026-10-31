// tools/judge-words: the row's own sample, run the way the tool container runs it (the input on standard input, the
// answer on the last line), gives what the row's verify says it gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, () => {
    for (const sample of row.verify.filter(item => item.kind === 'sample-run')) {
      const ran = spawnSync(process.execPath, row.invoke.argv.slice(1), { cwd: folder, input: JSON.stringify(sample.input), encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}

// Carried from bitfield-packages packages/content-gate/__tests__/local-consumer.test.ts: a malformed request gives no
// result, and an evidence row with its evidence missing fails closed through the command.
test('a request that is not JSON is refused with why, and gives no result', () => {
  const ran = spawnSync(process.execPath, ['do-work/judge-against-rules.mjs'], { cwd: folder, input: '{"rules": [', encoding: 'utf8' });
  assert.equal(ran.status, 1);
  const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.deepEqual([typeof answer.error, 'result' in answer], ['string', false]);
});

test('an evidence row whose evidence is missing fails closed through the command', () => {
  const input = { rules: [{ id: 'capture', evidence: 'inference-capture-qualification', says: 'No captured answers to trust.' }], artifact: { other: true } };
  const ran = spawnSync(process.execPath, ['do-work/judge-against-rules.mjs'], { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const { result } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.deepEqual([result.status, result.findings[0].found], ['failed', 'missing_capture']);
});

test('a rule row it cannot compile is refused with why, not judged', () => {
  const ran = spawnSync(process.execPath, ['do-work/judge-against-rules.mjs'], { cwd: folder, input: JSON.stringify({ rules: [{ id: 'bad', count_at_most: 1 }], text: 'x' }), encoding: 'utf8' });
  assert.equal(ran.status, 1);
  assert.match(JSON.parse(ran.stdout.trim().split('\n').at(-1)).error, /words, pattern, exact, check, groups, path or evidence/);
});
