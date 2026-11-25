// tools/serve-a-sites-pages-from-its-rows/do-work/door.ts
//
// PURPOSE
//   The two calls this program makes to other programs: `ask`, one HTTP request to an address that is a URL or a unix socket
//   (`unix:/path/to.sock`), and `runTool`, one tool run on the engine's door (`tools:run`, sent as the engine's /mcp tools/call of
//   do_one_thing_in_my_account), made as the caller whose pass is given. The tool holds its own keys in the engine; this program
//   holds only a pass. A local run on a person's own computer may instead run each tool as that computer's own signed-in
//   command (`cli:<command>`, through use-your-tools-from-a-shell's door-op), so it holds no pass at all.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A pass is only sent: it is never in an error, a log line or an answer.
//   2. A transport failure, a status other than 2xx, a reply with no answer, an engine error or a tool that did not finish throws
//      a DoorError that quotes what the door said (its status, code and words, at most 400 characters); the caller decides what
//      the person sees. Nothing is answered for a failed run.
//   3. Every call ends by its time limit.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  /** The tool that refused, and its own words for why (a run that did not finish and said why); null for any other failure. */
  refusal: { tool: string; words: string } | null;
  constructor(message: string, status = 502, refusal: { tool: string; words: string } | null = null) {
    super(message);
    this.name = 'DoorError';
    this.status = status;
    this.refusal = refusal;
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
function replyOf(text: string): { result?: { structuredContent?: unknown; content?: { text: string }[]; isError?: boolean }; error?: unknown } | undefined {
  const replies = (() => {
    try { return [JSON.parse(text)]; } catch { return text.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } }); }
  })();
  return replies.find(reply => reply?.id === 1);
}

const MOST_QUOTED = 400;
const quoted = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MOST_QUOTED);

/**
 * The door's own words for what it answered: its code, then its words (the engine's `detail`, an error's message, or the text),
 * at most 400 characters. The door never echoes a pass, so its words may be logged.
 */
export function doorWordsOf(answer: unknown): string {
  const said = answer as { code?: unknown; detail?: unknown; error?: { code?: unknown; message?: unknown } | unknown; text?: unknown; cause?: unknown } | null;
  const error = said?.error && typeof said.error === 'object' ? said.error as { code?: unknown; message?: unknown } : null;
  const code = typeof said?.code === 'string' ? said.code : typeof error?.code === 'string' ? error.code : null;
  const detail = typeof said?.detail === 'string' ? said.detail : (said?.detail as { words?: unknown } | null)?.words;
  const words = [detail, error?.message, typeof said?.error === 'string' ? said.error : null, said?.text].find(word => typeof word === 'string' && word.trim() !== '');
  return quoted(`${code ? `${code}: ` : ''}${typeof words === 'string' ? words : JSON.stringify(answer)}`);
}

/** The tool's own answer out of the engine's envelope { tool, exit_code, result }; a run that did not finish throws. */
export function toolAnswerOf(envelope: unknown): unknown {
  const run = envelope as { tool?: unknown; exit_code?: unknown; error?: unknown; result?: unknown } | null;
  if (typeof run?.tool !== 'string') throw new DoorError(`The engine door answered this instead of a tool run: ${doorWordsOf(envelope)}`);
  if (run.exit_code !== 0 || run.error) {
    const words = typeof run.error === 'string' ? quoted(run.error) : '';
    throw new DoorError(`The engine ran ${run.tool} and it did not finish${words ? `: ${words}` : ''}`, 502, words ? { tool: run.tool, words } : null);
  }
  if (!('result' in run)) throw new DoorError(`The engine ran ${run.tool} and it answered nothing.`);
  return run.result;
}

/**
 * One operation on the door (`tools:run`, `tools:list`, ...) as the caller whose pass is `pass`, and its structured answer. A
 * refusal throws with the door's own status, code and words, so the log says why. `what` names the call in those words.
 */
async function callDoor(door: Door, pass: string, method: string, input: unknown, what = method, timeoutMs = 60_000): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'do_one_thing_in_my_account', arguments: { address: '@tools', method, request_key: randomUUID(), input } },
  });
  const answer = await ask(door.address, '/mcp', {
    method: 'POST', body, timeoutMs,
    // An empty pass is the site's own OS user on the engine's vault socket: the engine knows it by the socket, so none is sent.
    headers: { ...(pass ? { authorization: `Bearer ${pass}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });
  const text = answer.body.toString('utf8');
  if (answer.status < 200 || answer.status > 299) {
    // A door that is busy or timed out (503, 504) says so, so a page may try again; a refused pass is 403; anything else is 502.
    const status = answer.status === 401 || answer.status === 403 ? 403 : answer.status === 503 || answer.status === 504 ? answer.status : 502;
    throw new DoorError(`The engine door answered ${answer.status} for ${what}: ${quoted(text)}`, status);
  }
  const reply = replyOf(text);
  if (!reply) throw new DoorError(`The engine door gave no reply to ${what}: ${quoted(text)}`);
  if (reply.error || !reply.result) throw new DoorError(`The engine door refused ${what}: ${doorWordsOf(reply.error ?? reply)}`);
  const content = reply.result.structuredContent ?? (() => {
    const said = (reply.result!.content ?? []).map(item => item?.text ?? '').join('\n');
    try { return JSON.parse(said); } catch { return { text: said }; }
  })();
  if (reply.result.isError) throw new DoorError(`The engine door refused ${what}: ${doorWordsOf(content)}`);
  return content;
}

/** Runs one tool on the door as the caller whose pass is `pass`, and answers the tool's own answer. */
export async function runTool(door: Door, pass: string, run: ToolRun, timeoutMs = 60_000): Promise<unknown> {
  return toolAnswerOf(await callDoor(door, pass, 'tools:run', run, run.tool, timeoutMs));
}

/** The command a `cli:<command>` door address names, or null for a door reached over HTTP. */
export function commandOf(address: string): string | null {
  const command = /^cli:([a-z][a-z0-9-]*)$/.exec(address)?.[1];
  return command ?? null;
}

/**
 * A door that is this computer's own command: its name, the pins its reads run with, and, on a computer with no Mac app door
 * (a Linux server), the engine it calls (`origin`) and the owner's key (`key`, read from the unit's credentials).
 */
export interface CommandDoor {
  command: string;
  pins: string[];
  origin?: string;
  key?: string;
}

/**
 * The environment name a command reads its key from on a computer with no Keychain or key file: command.json's env.key of
 * use-your-tools-from-a-shell, {CLI} being the command in capitals (its - as _), as that command spells it.
 */
export function keyNameOf(doorOp: string, command: string): string {
  const rules = JSON.parse(readFileSync(join(dirname(doorOp), 'command.json'), 'utf8')) as { env: { key: string } };
  return rules.env.key.replaceAll('{CLI}', command.toUpperCase().replace(/-/g, '_'));
}

/**
 * One operation as this computer's own command (door-op.mjs of the Workshop this program runs from), with the pins given, and
 * its answer. It carries the computer owner's rights, so the site uses it only for its own reads. A key given is handed to the
 * command only in its environment, never in an argument, the request or a log.
 */
function callAsCommand(doorOp: string, door: CommandDoor, method: string, input: unknown, what = method, timeoutMs = 120_000): Promise<unknown> {
  const { command, pins } = door;
  return new Promise((resolve, reject) => {
    const env = door.key === undefined ? process.env : { ...process.env, [keyNameOf(doorOp, command)]: door.key };
    const child = spawn(process.execPath, [doorOp], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(new DoorError(`${command} could not be started: ${error.message}`)); });
    child.on('close', status => {
      clearTimeout(timer);
      if (status !== 0) return reject(new DoorError(`${command} ran ${what} and stopped (${status}): ${quoted(Buffer.concat(err).toString('utf8'))}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch { reject(new DoorError(`${command} answered ${what} with something that is not JSON.`)); }
    });
    child.stdin.end(JSON.stringify({ cli: command, kind: 'op', method, input, ...(pins.length ? { pins } : {}), ...(door.origin ? { origin: door.origin } : {}), request_key: randomUUID() }));
  });
}

/** Runs one tool as this computer's own command, and answers the tool's own answer. */
export async function runToolAsCommand(doorOp: string, door: CommandDoor, run: ToolRun, timeoutMs = 120_000): Promise<unknown> {
  return toolAnswerOf(await callAsCommand(doorOp, door, 'tools:run', run, run.tool, timeoutMs));
}
