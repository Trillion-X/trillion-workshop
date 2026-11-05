// A stdio Model Context Protocol server for tests: newline-delimited JSON-RPC on stdin and stdout.
// argv[2] names what it lists as its one tool's description, so one fixture stands for many apps.
import { createInterface } from 'node:readline';
const label = process.argv[2] ?? 'fake';
const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
const waiting = new Map();
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) { waiting.get(message.id)?.(message); return; }
  if (message.method === 'notifications/initialized') { initialized = true; return; }
  if (message.id === undefined) return;
  const reply = result => out({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } });
  if (message.method === 'tools/list') return reply({ tools: [
    { name: 'echo', title: 'Echo', description: `Echoes text back (${label}).`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'whoami', description: 'Reports the process cwd and environment names.', inputSchema: { type: 'object' } },
  ] });
  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params;
    if (name === 'echo') return reply({ content: [{ type: 'text', text: JSON.stringify({ said: args.text, initialized }) }] });
    if (name === 'whoami') return reply({ content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), env: Object.keys(process.env).sort() }) }] });
    if (name === 'slow') return undefined;
    if (name === 'die') process.exit(3);
    if (name === 'notify') { out({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } }); return reply({ content: [{ type: 'text', text: 'sent' }] }); }
    if (name === 'ask-client') {
      const asked = 'srv-1';
      return new Promise(resolve => { waiting.set(asked, resolve); out({ jsonrpc: '2.0', id: asked, method: 'sampling/createMessage', params: {} }); }).then(answer => reply({ content: [{ type: 'text', text: JSON.stringify(answer.error ?? answer.result) }] }));
    }
  }
  return out({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
});
