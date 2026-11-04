import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNewItems } from '../computer/read-new-items.mjs';

for (const kind of ['refused', 'failed']) test(`a moving cursor retains a ${kind} item past its reread window and a restart`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trillion-continuity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  let clock = Date.parse('2026-10-07T10:00:00Z'), broken = true;
  const items = [{ source_id: 'first', at: '2026-10-07T10:01:00.000Z', text: 'kept words' }, { source_id: 'second', at: '2026-10-07T10:02:00.000Z', text: 'later words' }];
  const sent = [], attempted = [];
  const create = () => readNewItems({
    carriers: [{ route: 'A moving reader', reader: 'sqlite', cursor: 'moves', reread_minutes: 1, settle_seconds: 0 }],
    stateFile, now: () => new Date(clock), turnedAway: { ask_again_minutes: 1 },
    readers: { sqlite: async (_carrier, since) => items.filter(item => Date.parse(item.at) > since.getTime() && Date.parse(item.at) <= clock) },
    keep: async () => {}, account: async (_route, { body }) => {
      attempted.push(body.source_id);
      if (body.source_id === 'first' && broken) {
        if (kind === 'failed') throw new Error('item could not be prepared');
        return { status: 400, body: { error: 'temporarily unsupported media type' } };
      }
      sent.push(body.source_id); return { status: 200, body: { arrival_id: `arrival:${body.source_id}` } };
    },
  });
  let reader = create(); await reader.tick();
  clock = Date.parse('2026-10-07T10:10:00Z'); await reader.tick();
  assert.deepEqual(sent, ['second'], 'one bad item does not block the item after it');
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['A moving reader'].since) < Date.parse(items[0].at), 'strict > readers must keep the cursor before the unsent item');
  clock = Date.parse('2026-10-07T12:00:00Z'); broken = false; reader = create(); await reader.tick();
  assert.deepEqual(sent, ['second', 'first'], 'the original item survives elapsed time and reader restart');
  assert.equal(attempted.filter(id => id === 'first').length, 2);
  await reader.tick(); assert.deepEqual(sent, ['second', 'first'], 'delivery remains idempotent');
});
