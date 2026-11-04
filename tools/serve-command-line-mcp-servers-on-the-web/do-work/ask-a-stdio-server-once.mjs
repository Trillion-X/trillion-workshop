// tools/serve-command-line-mcp-servers-on-the-web/do-work/ask-a-stdio-server-once.mjs
//
// The gateway's one-off flow (gateway.mjs createGateway) as one run: a gateway is made for the one stdio MCP server the
// input names, one POST /<app>/mcp with no session id is handed to its request handler in this process (no port is
// opened), and the gateway starts the server in a fresh working folder of its own, initializes it, asks the request,
// stops it and removes the folder. What the gateway answered comes back. Nothing is kept after the run.
//
// Input:
//   cli               the command that runs the stdio server (e.g. "node")
//   args              its arguments; one that starts with ./ or ../ names a file in this run's working folder and is
//                     made absolute first, because the server itself starts in an empty folder of its own
//   env               more environment for the server (the gateway gives it only PATH, HOME, TMPDIR and LANG)
//   app               the app name in the path (lowercase letters, digits and -; "server" when left out)
//   request           the JSON-RPC request to ask: { method, params?, id? } (id "ask-1" when left out)
//   protocol_version  the MCP protocol version the gateway initializes with ("2025-06-18" when left out)
//   timeout_seconds   how long the server may take to answer (30 when left out, at most 120)
// Answers { app, status, reply }: the HTTP status the gateway gave and the JSON-RPC reply (a result or an error).
// Refuses a missing cli, args that are not a list of text, an app name the gateway's path would not take, and a
// request with no method or one that is initialize (the gateway initializes the server itself).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createGateway } from './gateway.mjs';

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The reply the gateway wrote: its status, and its body as JSON (or the one server-sent event's data).
function answerOf(status, text) {
  if (!text) return { status, reply: null };
  const event = /^data: (.*)$/m.exec(text);
  return { status, reply: JSON.parse(event ? event[1] : text) };
}

export async function askAStdioMcpServerOnce({ cli, args = [], env, app = 'server', request, protocol_version, timeout_seconds = 30 } = {}) {
  if (typeof cli !== 'string' || !cli) throw new Error('Give cli: the command that runs the stdio MCP server (e.g. "node").');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args is a list of text: the arguments the server is run with.');
  if (typeof app !== 'string' || !APP.test(app)) throw new Error('app is lowercase letters, digits and - (at most 63), starting with a letter or digit.');
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string'))) throw new Error('env is { NAME: "text" }.');
  if (typeof request?.method !== 'string' || !request.method) throw new Error('Give request: { method, params? }, the JSON-RPC request to ask the server.');
  if (request.method === 'initialize') throw new Error('The gateway initializes the server itself: ask the request after initialize (e.g. tools/list).');
  const seconds = Number(timeout_seconds);
  if (!(seconds > 0 && seconds <= 120)) throw new Error('timeout_seconds is more than 0 and at most 120.');

  const workRoot = mkdtempSync(join(tmpdir(), 'ask-a-stdio-server-'));
  const gateway = createGateway({
    apps: { [app]: { cli, args: args.map(arg => (/^\.\.?\//.test(arg) ? resolve(arg) : arg)), ...(env ? { env } : {}) } },
    workRoot, maxSessions: 1, queueMs: 0, requestTimeoutMs: seconds * 1000,
  });
  try {
    const message = { jsonrpc: '2.0', id: request.id ?? 'ask-1', method: request.method, ...(request.params !== undefined ? { params: request.params } : {}) };
    const incoming = Readable.from([Buffer.from(JSON.stringify(message))]);
    Object.assign(incoming, {
      method: 'POST', url: `/${app}/mcp`,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(protocol_version ? { 'mcp-protocol-version': String(protocol_version) } : {}) },
    });
    let status = 0;
    let text = '';
    await new Promise((done, failed) => {
      const response = {
        headersSent: false,
        writeHead(code) { status = code; this.headersSent = true; return this; },
        write(chunk) { text += chunk; return true; },
        end(chunk = '') { text += chunk; done(); },
      };
      gateway.handle(incoming, response).catch(failed);
    });
    return { app, ...answerOf(status, text) };
  } finally {
    gateway.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}
