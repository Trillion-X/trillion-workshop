// Ported from old trillion test/connections-tools.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test drove list_connections in the retired src/tools.mjs makeTools({ call }),
// which only turned its input into GET /connections?after=&limit=&connection_id=; the route that answers that request
// today is this tool's nativeConnectionList (src/native-connection-list.mjs), driven here with its query and stand-in
// owners. The schema's limit bounds (1..100) are checked as the route's clamp. Left out: the MCP tool definition's own
// inputSchema types and readOnlyHint annotation, which no running code declares (searched list_connections across
// trillion-workshop tools, trillion-rust src and trillion-apps: only instruction text, tool-name lists and old copies).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeConnectionList } from '../src/native-connection-list.mjs';
import { connectionOwner } from '../../find-and-keep-my-connections/src/connection-records.mjs';

function route(answer = async () => ({ connections: [], next_after: null }), rows = []) {
  const calls = [];
  const list = nativeConnectionList({
    owner: () => connectionOwner({}),
    page: async input => { calls.push({ page: input }); return answer(input); },
    listed: async id => { calls.push({ listed: id }); return rows.find(row => row.connection_id === id) ?? null; },
    carried: async () => [],
    relations: row => row,
    sharedPage: async () => { throw new Error('not shared'); },
    readShared: async () => null,
  });
  return { list, calls };
}

test('connection listing carries opaque page cursors and exact account ids through the shared route', async () => {
  const id = 'service_connection:example/account?one&two';
  const { list, calls } = route(undefined, [{ connection_id: id, vendor: 'example', service: 'Example', status: 'connected' }]);
  await list({});
  const after = 'opaque+cursor/&?=one';
  await list({ after, limit: '25' });
  const exact = await list({ connection_id: id });
  assert.deepEqual(calls[0], { page: { after: '', limit: 100 } });
  assert.deepEqual(calls[1], { page: { after, limit: 25 } });
  assert.deepEqual(calls[2], { listed: id }, 'an exact id reads that account, not a page');
  assert.equal(exact.connections[0].connection_id, id);
  // The old schema's limit minimum 1 and maximum 100.
  await list({ limit: '500' });
  await list({ limit: '0' });
  assert.equal(calls[3].page.limit, 100);
  assert.equal(calls[4].page.limit, 1);
});

test('a client can read the first, middle and final page without an automatic whole-catalog request', async () => {
  const rows = ['account:first', 'account:middle', 'account:last'];
  const { list, calls } = route(async ({ after, limit }) => {
    assert.equal(limit, 1);
    const position = Number(after || 0);
    return { connections: [{ connection_id: rows[position], vendor: 'v', service: 'S', status: 'connected' }], next_after: position + 1 < rows.length ? String(position + 1) : null };
  });
  const observed = [];
  let after;
  do {
    const page = await list({ after, limit: '1' });
    observed.push(...page.connections.map(row => row.connection_id));
    after = page.next_after;
  } while (after);
  assert.deepEqual(observed, rows);
  assert.equal(calls.length, 3);
});

test('cached connection catalog continuation named next uses the same bounded endpoint', async () => {
  const { list, calls } = route(async () => ({ connections: [], next_after: null, next: null }));
  const next = 'stored:service_connection:example/account';
  await list({ next, limit: '7' });
  assert.equal(calls[0].page.after, next);
  await list({ after: 'preferred', next: 'older-alias', limit: '7' });
  assert.equal(calls[1].page.after, 'preferred');
});
