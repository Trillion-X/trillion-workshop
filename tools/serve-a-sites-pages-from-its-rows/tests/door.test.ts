// The door's refusals are quoted, never hidden: a reply that is not a tool run, an engine refusal (isError) and a status other
// than 2xx each throw with the door's own code and words; and missingTools names, in one line, every tool this computer
// cannot run, with the door's words for each, asking tools:list at most eight at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { callDoor, doorWordsOf, missingTools, runTool, toolAnswerOf } from '../do-work/door.ts';

test('a reply that is not a tool run is quoted with its code and words', () => {
  assert.throws(() => toolAnswerOf({ code: 'tools_tool_unknown', detail: 'No tool has this id on this computer.' }),
    /The engine door answered this instead of a tool run: tools_tool_unknown: No tool has this id on this computer\./);
  assert.equal(doorWordsOf({ error: { code: 'door_pass_refused', message: 'This pass is not admitted here.' } }), 'door_pass_refused: This pass is not admitted here.');
  assert.equal(doorWordsOf({ text: 'x'.repeat(500) }).length, 400, 'at most 400 characters');
});

test('over a door: an engine refusal and a 401 throw with the door\'s own words', async () => {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization === 'Bearer refused-pass') {
      response.writeHead(401, { 'content-type': 'application/json' });
      return response.end('{"error":"This pass is not admitted at this door."}');
    }
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { code: 'tools_tool_unknown', detail: 'No tool has this id on this computer.' } } })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const door = { address: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  try {
    await assert.rejects(runTool(door, 'a-pass', { tool: 'tool:read-the-site-head', input: {} }),
      /The engine door refused tool:read-the-site-head: tools_tool_unknown: No tool has this id on this computer\./);
    await assert.rejects(callDoor(door, 'refused-pass', 'tools:list', { tool: 'tool:x' }),
      (error: Error & { status?: number }) => /answered 401 for tools:list: \{"error":"This pass is not admitted at this door\."\}/.test(error.message) && error.status === 403 && !error.message.includes('refused-pass'));
  } finally { server.close(); }
});

test('missingTools names every tool this computer cannot run, grouped by the door\'s words, at most eight asked at a time', async () => {
  let asking = 0;
  let most = 0;
  const call = async (method: string, input: unknown) => {
    assert.equal(method, 'tools:list');
    asking += 1;
    most = Math.max(most, asking);
    await new Promise(resolve => setTimeout(resolve, 5));
    asking -= 1;
    const id = (input as { tool: string }).tool;
    if (id.startsWith('tool:gone')) throw new Error('The engine door refused tools:list: tools_tool_unknown: No tool has this id on this computer.');
    return { id, runs_here: id !== 'tool:elsewhere' };
  };
  const ids = [...Array.from({ length: 12 }, (_, i) => `tool:here-${i}`), 'tool:gone-a', 'tool:gone-b', 'tool:elsewhere', 'tool:here-0'];
  assert.equal(await missingTools(ids, call),
    'This computer cannot run 3 of the tools the site names: tool:elsewhere (it does not run on this computer); tool:gone-a, tool:gone-b (The engine door refused tools:list: tools_tool_unknown: No tool has this id on this computer.)');
  assert.ok(most <= 8, `at most eight at a time (${most})`);
  assert.equal(await missingTools(['tool:here-1'], call), null);
});
