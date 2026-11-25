// tools/serve-a-sites-pages-from-its-rows/do-work/door.ts
//
// PURPOSE
//   The two calls this program makes to other programs: `ask`, one HTTP request to an address that is a URL or a unix socket
//   (`unix:/path/to.sock`), and `runTool`, one tool run on the engine's door (`tools:run`, sent as the engine's /mcp tools/call of
//   do_one_thing_in_my_account), made as the caller whose pass is given. The tool holds its own keys in the engine; this program
//   holds only a pass.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A pass is only sent: it is never in an error, a log line or an answer.
//   2. A transport failure, a status other than 2xx, a reply with no answer, an engine error or a tool that did not finish throws
//      a DoorError; the caller decides what the person sees. Nothing is answered for a failed run.
//   3. Every call ends by its time limit.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export interface Asked {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface AskOptions {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export class DoorError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'DoorError';
    this.status = status;
  }
}

const UNIX = 'unix:';

/** One request to `address` (an http(s) URL or unix:/socket/path) for `path` (with its query). */
export function ask(address: string, path: string, { method = 'GET', headers = {}, body, timeoutMs = 30_000 }: AskOptions = {}): Promise<Asked> {
  return new Promise((resolve, reject) => {
    const target = address.startsWith(UNIX)
      ? { socketPath: address.slice(UNIX.length), path, agent: undefined as http.Agent | undefined }
      : (() => {
        const url = new URL(path, address);
        return { protocol: url.protocol, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}` };
      })();
    const send = (target as { protocol?: string }).protocol === 'https:' ? https.request : http.request;
    const request = send({ ...target, method, headers: { ...headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new DoorError(`No answer from ${address} in ${timeoutMs} ms.`, 504)));
    request.on('error', error => reject(error instanceof DoorError ? error : new DoorError(`${address} could not be reached: ${error.message}`)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export interface Door {
  /** The engine door's address: an http(s) URL or unix:/socket/path. */
  address: string;
}

export interface ToolRun {
  tool: string;
  input: unknown;
}

// The engine's /mcp answer: plain JSON, or one server-sent event per line. The reply with id 1 is this call's.
function replyOf(text: string): { result?: { structuredContent?: unknown; content?: { text: string }[] }; error?: unknown } | undefined {
  const replies = (() => {
    try { return [JSON.parse(text)]; } catch { return text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))); }
  })();
  return replies.find(reply => reply?.id === 1);
}

/** The tool's own answer out of the engine's envelope { tool, exit_code, result }; a run that did not finish throws. */
export function toolAnswerOf(envelope: unknown): unknown {
  const run = envelope as { tool?: unknown; exit_code?: unknown; error?: unknown; result?: unknown } | null;
  if (typeof run?.tool !== 'string' || !('result' in run)) throw new DoorError('The engine door answered something that is not a tool run.');
  if (run.exit_code !== 0 || run.error) throw new DoorError(`The engine ran ${run.tool} and it did not finish.`);
  return run.result;
}

/** Runs one tool on the door as the caller whose pass is `pass`, and answers the tool's own answer. */
export async function runTool(door: Door, pass: string, run: ToolRun, timeoutMs = 60_000): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'do_one_thing_in_my_account', arguments: { address: '@tools', method: 'tools:run', request_key: randomUUID(), input: run } },
  });
  const answer = await ask(door.address, '/mcp', {
    method: 'POST', body, timeoutMs,
    headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });
  const text = answer.body.toString('utf8');
  // The status and the start of the door's own words go into the error, so the log says why; the door never echoes the pass.
  if (answer.status < 200 || answer.status > 299) {
    throw new DoorError(`The engine door answered ${answer.status} for ${run.tool}: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`, answer.status === 401 || answer.status === 403 ? 403 : 502);
  }
  const reply = replyOf(text);
  if (!reply || reply.error || !reply.result) throw new DoorError(`The engine door gave no reply to ${run.tool}.`);
  const content = reply.result.structuredContent ?? JSON.parse(reply.result.content?.[0]?.text ?? 'null');
  return toolAnswerOf(content);
}
