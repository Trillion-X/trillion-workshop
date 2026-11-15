// Baseline of the already-carried owner before the durable adapter is changed.
// These synthetic names never reach an account or a byte store.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteArchiveAndPutBack } from '../do-work/delete-archive-and-put-back.mjs';

const identity = `1f:${'a'.repeat(64)}`;
test('the carried original archives, restores a whole folder and advances retention without deleting bytes', () => {
  const answer = deleteArchiveAndPutBack({
    files: [{ name: '/note.txt', identity }, { name: '/folder/a.txt', identity }, { name: '/folder/b.txt', identity }],
    now: '2026-11-01T00:00:00Z',
    steps: [
      { op: 'delete', items: [{ name: '/note.txt' }] },
      { op: 'archive', items: [{ name: '/folder' }] },
      { op: 'put_back', items: ['folder'] },
      { op: 'sweep', at: '2026-12-02T00:00:00Z' },
    ],
  });
  assert.deepEqual(answer.names, ['/folder/a.txt', '/folder/b.txt']);
  assert.deepEqual(answer.gone, [identity]);
  assert.deepEqual(answer.set_aside, []);
  assert.equal(answer.steps[2].results[0].put_back, true);
});

test('the carried original changes Archived to Recently Deleted, then forgets it at the next retention boundary', () => {
  const answer = deleteArchiveAndPutBack({ files: [{ name: '/note.txt', identity }], now: '2026-11-01T00:00:00Z', steps: [
    { op: 'archive', items: [{ name: '/note.txt' }] },
    { op: 'sweep', at: '2026-12-01T00:00:00Z' },
    { op: 'sweep', at: '2026-12-31T00:00:00Z' },
  ] });
  assert.equal(answer.steps[1].moved[0].to, 'deleted');
  assert.equal(answer.steps[2].removed.length, 1);
  assert.deepEqual(answer.gone, [identity]);
});
