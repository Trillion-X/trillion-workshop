// The door's refusals are quoted, never hidden: a reply that is not a tool run, an engine refusal (isError) and a status other
// than 2xx each throw with the door's own code and words, and never the pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { doorWordsOf, runTool, toolAnswerOf } from '../do-work/door.ts';

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
    await assert.rejects(runTool(door, 'refused-pass', { tool: 'tool:x', input: {} }),
      (error: Error & { status?: number }) => /answered 401 for tool:x: \{"error":"This pass is not admitted at this door\."\}/.test(error.message) && error.status === 403 && !error.message.includes('refused-pass'));
  } finally { server.close(); }
});
