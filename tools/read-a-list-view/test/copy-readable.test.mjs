// When a list's file copy may be read (read-data/copy-readable.mjs), through the real door (door.mjs) over HTTP to a
// stand-in records door for a made-up bakery: readable only when the list answers "unavailable" or nothing answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDoor } from '../read-data/door.mjs';
import { copyReadable } from '../read-data/copy-readable.mjs';

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const CONFIG = port => ({ transport: { url: `http://127.0.0.1:${port}/mcp`, credential: { keychain_item: 'made-up' } },
  records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
  tools: { address: '@workshop-tools', run_method: 'tools:run' } });

async function standIn(answer) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: answer(call.params.arguments) }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server;
}
const doorAt = port => openDoor(CONFIG(port), { keyOf: async () => 'made-up-key-for-the-bakery' });

test('a list that answers keeps its copy closed, with or without its record', async () => {
  const server = await standIn(({ input }) => ({ structuredContent: { id: input.id, value: input.id === 'list:notes' ? { label: 'Notes' } : null } }));
  try {
    const door = await doorAt(server.address().port);
    assert.equal((await copyReadable({ names: NAMES, list: 'notes' }, door)).readable, false);
    assert.equal((await copyReadable({ names: NAMES, list: 'no-such-list' }, door)).readable, false);
  } finally { server.close(); }
});

test('a list that answers unavailable opens its copy, read-only; another refusal does not', async () => {
  let code = 'original_workspace_source_unavailable';
  const server = await standIn(() => ({ isError: true, structuredContent: { code } }));
  try {
    const door = await doorAt(server.address().port);
    const open = await copyReadable({ names: NAMES, list: 'notes' }, door);
    assert.equal(open.readable, true);
    assert.equal(open.code, 'original_workspace_source_unavailable');
    code = 'current_workspace_rights_refused';
    const closed = await copyReadable({ names: NAMES, list: 'notes' }, door);
    assert.equal(closed.readable, false);
    assert.equal(closed.code, 'current_workspace_rights_refused');
  } finally { server.close(); }
});

test('a door nothing listens on opens the copy', async () => {
  const server = await standIn(() => ({ structuredContent: {} }));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  const door = await doorAt(port);
  const answer = await copyReadable({ names: NAMES, list: 'notes' }, door);
  assert.equal(answer.readable, true);
  assert.equal(answer.code, 'unreachable');
});
