// harness/account-mcp-bridge.mjs
//
// Purpose
//   The MCP connection a task's AI run receives (take-open-work.json work_mcp.bridge). It is a stdio MCP server with one
//   tool, do_one_thing_in_my_account (the engine's one operation tool: address, method, input, request_key). Each call is
//   answered through the source take-open-work.json `account.credential` names, pinned to `account.pins` (account-call.mjs).
//
// Non-negotiable invariants
//   1. The key, when the source is the keychain, is read by account-call.mjs at each call and placed only in its request's
//      Authorization header; nothing here writes, logs or passes a key.
//   2. Every call is pinned (account.pins); a call with no address or method is answered as an error and never sent.
//   3. A call that is refused or fails is answered as an MCP tool error with the engine's words, never silently dropped.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { AccountCallError, runOperation } from './account-call.mjs';

const PROTOCOL = '2025-06-18';
const TOOL = {
  name: 'do_one_thing_in_my_account',
  description: "One engine operation as the account, at this computer's pinned computers.",
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'The engine address the operation is for, such as @tools.' },
      method: { type: 'string', description: 'The operation method, such as tools:run.' },
      input: { description: 'The operation input (any JSON).' },
      request_key: { type: 'string', description: 'A key that makes a repeated call the same call.' },
    },
    required: ['address', 'method', 'input'],
  },
};

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** The answer to one message from the AI's client, or null for a notification. */
export async function answer(message, { account, run = runOperation, env = process.env } = {}) {
  const { id, method, params } = message ?? {};
  if (id === undefined) return null;
  if (method === 'initialize') return ok(id, { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'account', version: '1' } });
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: [TOOL] });
  if (method !== 'tools/call') return fail(id, -32601, `Method not found: ${method}`);
  if (params?.name !== TOOL.name) return fail(id, -32602, `No tool named ${params?.name}.`);
  const args = params.arguments ?? {};
  try {
    const result = await run({ account, env, address: args.address, method: args.method, input: args.input ?? {}, requestKey: args.request_key ?? randomUUID() });
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
  } catch (error) {
    const words = error instanceof AccountCallError ? error.message : `The operation could not be sent (${error.message}).`;
    return ok(id, { isError: true, content: [{ type: 'text', text: words }] });
  }
}

/** Serves the MCP messages read from `input`, one JSON object per line, answering on `output`. */
export async function runBridge({ account, run = runOperation, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (!Array.isArray(account?.pins) || account.pins.length === 0) throw new Error('The account names no pinned computer.');
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { output.write(`${JSON.stringify(fail(null, -32700, 'Unreadable message.'))}\n`); continue; }
    const reply = await answer(message, { account, run, env });
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { accountOfSettings } = await import('./take-open-work.mjs');
  const settings = JSON.parse(readFileSync(new URL('./take-open-work.json', import.meta.url), 'utf8'));
  runBridge({ account: accountOfSettings(settings) }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
