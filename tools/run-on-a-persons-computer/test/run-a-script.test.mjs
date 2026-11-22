// The your-Mac runner of tool:run-on-a-persons-computer: a script's call() is one tools:run through the person's door (a real
// local HTTP door here), and the script cannot reach the network. The door's own answers are the test's fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runAScript } from '../run-a-script.mjs';

const rows = {
  'tool:list-rows': () => ({ items: [{ id: 'a', open: true }, { id: 'b', open: false }, { id: 'c', open: true }] }),
  'tool:get-row': input => ({ id: input.id, name: `Row ${input.id}` }),
  'tool:count': input => ({ n: input.ids.length }),
};

/** A door that answers initialize, notifications/initialized and tools/call (do_one_thing_in_my_account: tools:run). */
function startDoor() {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      const reply = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
      if (message.method === 'initialize') return reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
      if (message.method === 'notifications/initialized') { response.statusCode = 202; return response.end(); }
      const { method, request_key, input } = message.params.arguments;
      seen.push({ authorization: request.headers.authorization, method, request_key, tool: input.tool });
      const value = rows[input.tool](input.input);
      return reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('a script makes three chained tool calls, each one tools:run through the door with the account key, and returns its answer', async () => {
  const door = await startDoor();
  try {
    const answer = await runAScript({ code: `
      const rows = await call('tool:list-rows', {});
      const first = rows.items.find(row => row.open);
      const named = await call('tool:get-row', { id: first.id });
      const count = await call('tool:count', { ids: rows.items.filter(row => row.open).map(row => row.id) });
      return { first: named.name, count: count.n };` }, { origin: door.origin, key: 'test-key' });
    assert.deepEqual(answer, { result: { first: 'Row a', count: 2 } });
    assert.deepEqual(door.seen.map(call => call.tool), ['tool:list-rows', 'tool:get-row', 'tool:count']);
    assert.ok(door.seen.every(call => call.method === 'tools:run' && call.authorization === 'Bearer test-key'));
    assert.equal(new Set(door.seen.map(call => call.request_key)).size, 3, 'each call has its own request key');
  } finally {
    door.server.close();
  }
});

test('a script cannot reach the network: a fetch to example.com fails inside the sandbox', async () => {
  const door = await startDoor();
  try {
    const answer = await runAScript({ code: `
      try { await fetch('https://example.com/'); return 'reached'; } catch (error) { return 'refused'; }` }, { origin: door.origin, key: 'test-key' });
    assert.deepEqual(answer, { result: 'refused' });
  } finally {
    door.server.close();
  }
});
