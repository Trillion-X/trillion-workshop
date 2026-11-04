// tools/serve-command-line-mcp-servers-on-the-web/test/echo-mcp-server.mjs
//
// A made-up stdio MCP server for the folder's sample run: one JSON-RPC message per line on stdin, one reply per line
// on stdout. It answers initialize (protocol 2025-06-18, one tool), tools/list (the tool `echo`) and tools/call of
// `echo` (the text it was given, as text content and as structuredContent { text }); a notification is taken silently and any other request is answered
// "method not found". It reads no file, opens no connection and keeps nothing.
import { createInterface } from 'node:readline';

const TEXT = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
const TOOL = { name: 'echo', description: 'Answers the text it is given.', inputSchema: TEXT, outputSchema: TEXT };
const answer = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const refuse = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message?.id === undefined || message?.id === null || typeof message.method !== 'string') continue;
  const { id, method, params } = message;
  if (method === 'initialize') answer(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-sample', version: '1' } });
  else if (method === 'tools/list') answer(id, { tools: [TOOL] });
  else if (method === 'tools/call' && params?.name === 'echo') { const text = String(params?.arguments?.text ?? ''); answer(id, { content: [{ type: 'text', text }], structuredContent: { text } }); }
  else if (method === 'tools/call') refuse(id, -32602, `No tool ${JSON.stringify(params?.name)}; the tool is echo.`);
  else refuse(id, -32601, `Method not found: ${method}`);
}
