import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeWaiting } from '../do-work/say-why-for-files.mjs';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-waiting-'));
  const request = { waiting_file: join(dir, 'waiting.json'), judgments_file: join(dir, 'judgments.json'), batch_size: 1, models: { writing: { model: 'test-judge' } } };
  writeFileSync(request.waiting_file, JSON.stringify(['first', 'second'].map(term => ({ vocabulary: 'property', term, says: term,
    candidates: [{ term: `${term}-candidate`, says: 'candidate meaning' }] }))));
  return request;
};

test('judgments checkpoint per batch, resume, and retain exact candidate sets', async () => {
  const request = fixture();
  let calls = 0;
  await assert.rejects(judgeWaiting(request, async ({ schema }) => {
    calls += 1;
    assert.deepEqual(schema.properties.j0.properties.choice.enum, [0, 1]);
    if (calls === 2) throw new Error('server stopped');
    return { j0: { why: 'Same meaning', choice: 1 } };
  }, 'same means interchangeable'), /server stopped/);
  const kept = JSON.parse(readFileSync(request.judgments_file));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].chosen, 'first-candidate');
  assert.deepEqual(kept[0].among, ['first-candidate']);
  const resumed = await judgeWaiting(request, async ({ user }) => {
    assert.equal(user.j0.proposed.term, 'second');
    return { j0: { why: 'Different meaning', choice: 0 } };
  }, 'same means interchangeable');
  assert.deepEqual(resumed, { judged: 1, remaining: 0, saved: 2 });
  assert.equal(JSON.parse(readFileSync(request.judgments_file))[1].chosen, '');
});

test('schema-ignoring invalid answer cannot enter the recorded judgments', async () => {
  const request = fixture();
  writeFileSync(request.judgments_file, '[]');
  await assert.rejects(judgeWaiting(request, async () => ({ j0: { why: 'invalid', choice: 2 } }), ''), /Invalid judgment/);
  assert.deepEqual(JSON.parse(readFileSync(request.judgments_file)), []);
});
