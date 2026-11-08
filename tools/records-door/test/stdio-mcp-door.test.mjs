import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStdioRecordsDoor } from '../read-data/stdio-mcp-door.mjs';
const fixture = fileURLToPath(new URL('./stdio-client-fixture.mjs', import.meta.url));
const open = (mode, options = {}) => openStdioRecordsDoor({ argv: [process.execPath, fixture, mode ?? 'normal'], ...options });

test('a busy account retries with the same write key and input', async () => {
  const door = open('busy-once');
  try { assert.deepEqual(await door.write([{ id: 'note:retry', type: 'note', value: { n: 1 } }], { key: 'stable-write' }), { write_count: 1, request_key: 'stable-write' }); }
  finally { await door.close(); }
});

test('real stdio client preserves exact record values, stable write keys and short-page continuation', async () => {
  const door = open();
  try {
    assert.equal(await door.read('note', 'missing'), null);
    const rows = [{ id: 'note:1', type: 'note', value: { text: '雪 🌍' } }, { id: 'note:2', type: 'note', value: { n: 2 } }];
    assert.deepEqual(await door.write(rows, { key: 'same-write' }), { write_count: 2, request_key: 'same-write' });
    assert.deepEqual(await door.readRecord('note', 'note:1'), { type: 'note', value: rows[0].value });
    const listed = [];
    for await (const row of door.list({ type: 'note' })) listed.push(row);
    assert.deepEqual(listed, rows);
  } finally { await door.close(); }
});

test('a timed-out write keeps the client available for the same-key receipt and exact readback', async () => {
  const door = open('slow-write-once', { timeout_ms: 1000 });
  const rows = [{ id: 'note:slow', type: 'note', value: { text: 'retained after an unknown outcome' } }];
  try {
    const first = assert.rejects(door.write(rows, { key: 'slow-stable-write' }),
      error => error.code === 'mcp_client_timeout' && error.outcome === 'unknown');
    await new Promise(resolve => setTimeout(resolve, 800));
    const peer = door.read('note', 'note:slow').then(value => ({ value }), error => ({ error }));
    await first;
    assert.deepEqual(await door.write(rows, { key: 'slow-stable-write' }),
      { write_count: 1, request_key: 'slow-stable-write', applied: 1 });
    assert.deepEqual(await peer, { value: rows[0].value });
    assert.deepEqual(await door.read('note', 'note:slow'), rows[0].value);
  } finally { await door.close(); }
});

test('closing the owned client leaves pending outcomes unknown and later requests not started', async () => {
  const door = open('wait');
  const pending = assert.rejects(door.read('note', 'pending'),
    error => error.code === 'mcp_client_closed' && error.outcome === 'unknown');
  await door.close();
  await pending;
  await assert.rejects(door.read('note', 'after-close'),
    error => error.code === 'mcp_client_closed' && error.outcome === 'not_started');
});

for (const [mode, code] of [['refuse', 'current_workspace_rights_refused'], ['exit', 'mcp_client_closed'], ['invalid', 'mcp_invalid_answer'], ['wait', 'mcp_client_timeout']]) {
  test(`stdio ${mode} remains a failure with explicit outcome`, async () => {
    const door = open(mode, { timeout_ms: mode === 'wait' ? 100 : 3000 });
    try {
      await assert.rejects(door.read('note', 'a'), error => error.code === code && error.outcome === (mode === 'refuse' ? 'not_started' : 'unknown'));
    } finally { await door.close(); }
  });
}
