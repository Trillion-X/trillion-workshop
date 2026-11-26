// The door's refusals are quoted, never hidden: a reply that is not a tool run, an engine refusal (isError) and a status other
// than 2xx each throw with the door's own code and words, and never the pass. A command door on a computer with no Mac app
// door hands door-op its engine in the request and the owner's key only in the command's own environment name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorWordsOf, keyNameOf, runTool, runToolAsCommand, toolAnswerOf } from '../do-work/door.ts';

test('a reply that is not a tool run is quoted with its code and words', () => {
  assert.throws(() => toolAnswerOf({ code: 'tools_tool_unknown', detail: 'No tool has this id on this computer.' }),
    /The engine door answered this instead of a tool run: tools_tool_unknown: No tool has this id on this computer\./);
  assert.equal(doorWordsOf({ error: { code: 'door_pass_refused', message: 'This pass is not admitted here.' } }), 'door_pass_refused: This pass is not admitted here.');
  assert.equal(doorWordsOf({ text: 'x'.repeat(500) }).length, 400, 'at most 400 characters');
});

test('a run that did not finish carries the tool\'s own refusal status (400 to 499) when it named one, else 502', () => {
  const thrown = (error: string) => { try { toolAnswerOf({ tool: 'tool:keep', exit_code: 1, error, result: null }); } catch (caught) { return caught as { status: number; refusal: unknown }; } throw new Error('no throw'); };
  for (const status of [400, 401, 403, 409, 422, 499]) {
    assert.deepEqual([thrown(JSON.stringify({ error: 'Sign in first.', status })).status, thrown(JSON.stringify({ error: 'Sign in first.', status })).refusal], [status, { tool: 'tool:keep', words: 'Sign in first.' }], `${status} is the tool's own`);
  }
  for (const error of ['Sign in first.', JSON.stringify({ error: 'x', status: 500 }), JSON.stringify({ error: 'x', status: 302 }), JSON.stringify({ error: 'x', status: 401.5 }), JSON.stringify({ status: 401 }), '[401]']) {
    assert.equal(thrown(error).status, 502, `${error}: plain words or a status that is not a refusal's is a 502`);
  }
  assert.deepEqual(thrown('Sign in first.').refusal, { tool: 'tool:keep', words: 'Sign in first.' }, 'plain words stay the refusal\'s words');
});

test('over a door: an engine refusal and a 401 throw with the door\'s own words', async () => {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization === 'Bearer busy-pass' || request.headers.authorization === 'Bearer slow-pass') {
      response.writeHead(request.headers.authorization === 'Bearer busy-pass' ? 503 : 504, { 'content-type': 'text/plain' });
      return response.end('Not ready.');
    }
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
    await assert.rejects(runTool(door, 'busy-pass', { tool: 'tool:x', input: {} }), (error: Error & { status?: number }) => error.status === 503, 'a busy door stays 503, so a page tries again');
    await assert.rejects(runTool(door, 'slow-pass', { tool: 'tool:x', input: {} }), (error: Error & { status?: number }) => error.status === 504);
  } finally { server.close(); }
});

test('a command door names its engine in the request and hands the key only in the command\'s environment name', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cd-'));
  try {
    // A stand-in door-op beside a command.json naming the key's environment name, as use-your-tools-from-a-shell's does.
    writeFileSync(join(folder, 'command.json'), JSON.stringify({ env: { key: '{CLI}_KEY' } }));
    writeFileSync(join(folder, 'door-op.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "const request = JSON.parse(readFileSync(0, 'utf8'));",
      "const key = process.env.EXAMPLE_SITE_KEY;",
      "process.stdout.write(JSON.stringify({ tool: request.input.tool, exit_code: 0, result: { origin: request.origin ?? null, pins: request.pins ?? null, key_given: key === 'owner-key-value', request_holds_key: JSON.stringify(request).includes('owner-key-value'), argv_holds_key: process.argv.join(' ').includes('owner-key-value') } }));",
    ].join('\n'));
    const doorOp = join(folder, 'door-op.mjs');
    assert.equal(keyNameOf(doorOp, 'example-site'), 'EXAMPLE_SITE_KEY');
    const answer = await runToolAsCommand(doorOp, { command: 'example-site', pins: ['p1'], origin: 'http://127.0.0.1:7190', key: 'owner-key-value' }, { tool: 'tool:x', input: {} });
    assert.deepEqual(answer, { origin: 'http://127.0.0.1:7190', pins: ['p1'], key_given: true, request_holds_key: false, argv_holds_key: false });
    const mac = await runToolAsCommand(doorOp, { command: 'example-site', pins: [] }, { tool: 'tool:x', input: {} });
    assert.deepEqual(mac, { origin: null, pins: null, key_given: false, request_holds_key: false, argv_holds_key: false }, 'with no origin or key, the command finds its own door and key');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('use-your-tools-from-a-shell names the key the way keyNameOf reads it', () => {
  const doorOp = join(import.meta.dirname, '..', '..', 'use-your-tools-from-a-shell', 'do-work', 'door-op.mjs');
  assert.equal(JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'use-your-tools-from-a-shell', 'do-work', 'command.json'), 'utf8')).env.key, '{CLI}_KEY');
  assert.equal(keyNameOf(doorOp, 'a-command'), 'A_COMMAND_KEY');
});
