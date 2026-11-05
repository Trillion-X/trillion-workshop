import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send } from '../listen.mjs';
import sources from '../../bring-in-new-items-from-this-computer/computer/computer-sources.json' with { type: 'json' };
const listen = sources.sources.find(row => row.id === 'listening').listen;
const input = count => Array.from({ length: count }, (_, index) => ({ index, moment: { id: 'large-moment', computer: 'fixture-mac' },
  turn: { text: `Kept speech fixture ${index}`, start_ms: Date.parse('2026-10-10T02:00:00Z') + index * 1000, end_ms: Date.parse('2026-10-10T02:00:00Z') + index * 1000 + 500, who: { name: 'Fixture speaker', me: false }, score: 1 } }));

test('the existing listening sender splits a large moment without changing source identity or order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'listening-batch-'));
  try {
    const sizes = [], ids = [];
    const status = { sent: 0, left_out: 0, waiting: 0 };
    const account = async (route, { body }) => {
      assert.equal(route, '/inbound');
      sizes.push(body.items.length);
      assert.ok(body.items.length <= 100);
      ids.push(...body.items.map(item => item.source_id));
      return { status: 200, body: { items: body.items.map(item => ({ message_id: `kept:${item.source_id}` })) } };
    };
    assert.equal(await send(input(235), { listen, account, log: () => {}, status, waiting: join(dir, 'waiting.json'), classify: async () => 'context' }), 235);
    assert.deepEqual(sizes, [100, 100, 35]);
    assert.deepEqual(ids, input(235).map(({ index }) => `large-moment#${index + 1}`));
    assert.equal(status.rejected ?? 0, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'waiting.json'))), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a busy second chunk keeps its exact original queue and clock for the retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'listening-batch-'));
  try {
    const waiting = join(dir, 'waiting.json');
    const status = { sent: 0, left_out: 0, waiting: 0 };
    let clock = Date.parse('2026-10-10T02:00:00Z'), calls = 0;
    const account = async (route, { body }) => {
      assert.equal(route, '/inbound');
      assert.ok(body.items.length <= 100);
      if (++calls === 2) return { status: 503, body: { error: 'busy for a moment' } };
      return { status: 200, body: { items: body.items.map(item => ({ message_id: `kept:${item.source_id}` })) } };
    };
    await assert.rejects(send(input(235), { listen, account, log: () => {}, status, waiting, now: () => clock, random: () => 0, classify: async () => 'context' }), /busy for a moment/);
    assert.equal(calls, 2);
    const held = JSON.parse(readFileSync(waiting));
    assert.deepEqual(held.map(item => item.source_id), input(235).slice(100).map(({ index }) => `large-moment#${index + 1}`));
    const originalClock = held[0].clock;
    clock += 3600000;
    const retry = async (route, { body }) => {
      assert.equal(route, '/inbound');
      assert.ok(body.items.length <= 100);
      if (body.items[0].source_id === 'large-moment#101') assert.deepEqual(body.items[0].clock, originalClock);
      return { status: 200, body: { items: body.items.map(item => ({ message_id: `kept:${item.source_id}` })) } };
    };
    assert.equal(await send([], { listen, account: retry, log: () => {}, status, waiting, now: () => clock }), 135);
    assert.equal(status.sent, 235);
    assert.equal(status.rejected ?? 0, 0);
    assert.deepEqual(JSON.parse(readFileSync(waiting)), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
