// extension/native-host/engine-door.mjs
//
// PURPOSE
//   How the native messaging host (browser-native-host.mjs) asks the person's own Trillion: one MCP JSON-RPC
//   `tools/call` of `do_one_thing_in_my_account` at the engine's door on this computer (http://127.0.0.1:<port>/mcp), the
//   port the engine the Mac app starts was adopted on (its private descriptor, `engine_door.adoption_file`), signed with
//   the account key the Mac app's own key store keeps (this Mac's Keychain item `engine_door.keychain_item`, read through
//   /usr/bin/security exactly as macos/App/ComputerReader.swift reads it).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The key is read from the Keychain item at the moment of the call and held only in memory: never taken from argv,
//      the environment or a file, never written, logged or put in an answer or an error.
//   2. The door is only ever http://127.0.0.1 on the descriptor's port (1024-65535); a missing or malformed descriptor
//      or key is a refusal in words, never a fallback to another address.
//   3. Which resource address and method an action reaches is DATA (`native_hosts[].door_actions`); the browser's
//      message supplies only an object `input` and, optionally, its `request_key`.
//   4. Bounded: the request by `engine_door.most_request_bytes`, the answer by `engine_door.most_answer_bytes`, the
//      wait by `engine_door.timeout_seconds`.
//
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const inHome = (path, home) => path.startsWith('~/') ? join(home, path.slice(2)) : (path.startsWith('/') ? path : join(home, path));
const goodKey = key => typeof key === 'string' && key.length >= 16 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key);

/** The port the engine was adopted on, from its descriptor; null when there is none to trust. */
export function doorPort(door, { home = homedir(), read = readFileSync } = {}) {
  let descriptor;
  try { descriptor = JSON.parse(read(inHome(door.adoption_file, home), 'utf8')); } catch { return null; }
  const port = descriptor?.port;
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** The port this computer's own report names `name` under (`engine_door.computer_report`, `report.local_ports`); null when
 *  it names none, so no number is ever guessed or copied. */
export function reportedPort(door, name, { home = homedir(), read = readFileSync } = {}) {
  let computer;
  try { computer = JSON.parse(read(inHome(door.computer_report, home), 'utf8')); } catch { return null; }
  const port = computer?.report?.local_ports?.[name];
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** The public half (hex) of the vault key held under `name`, asked of the vault through the door (`secrets:public`); null
 *  when the vault holds no such key or cannot be asked. */
export async function vaultPublicKey(door, name, options = {}) {
  try {
    const answer = await askDoor({ door, address: '@secrets', method: 'secrets:public', input: { name }, ...options });
    return typeof answer?.public_key === 'string' && /^[0-9a-f]{64}$/.test(answer.public_key) ? answer.public_key : null;
  } catch { return null; }
}

/** The account key in the Mac app's Keychain item, through /usr/bin/security's standard output; null when absent. */
export const keychainKey = door => new Promise(done => {
  execFile('/usr/bin/security', ['find-generic-password', '-s', door.keychain_item, '-w'], { timeout: 10_000, maxBuffer: 16_384 },
    (error, stdout) => done(error ? null : String(stdout).trim() || null));
});

/** The JSON-RPC message in an MCP answer, JSON or an event stream; null when it is neither. */
const messageOf = (text, contentType) => {
  const type = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const body = type === 'text/event-stream' ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).at(-1)?.slice(5).trim()
    : (type === 'application/json' || type.endsWith('+json')) ? text : null;
  try { const message = body ? JSON.parse(body) : null; return message?.jsonrpc === '2.0' && message.id === 1 ? message : null; } catch { return null; }
};

/**
 * Runs one resource operation at the engine's door: { address, method } from DATA, `input` and `request_key` from the
 * message. Returns what the operation answered (its structured content, else its text read as JSON); throws an Error in
 * words a person may read.
 */
export async function askDoor({ door, address, method, input = {}, requestKey = randomUUID(), home = homedir(),
  port = doorPort(door, { home }), readKey = keychainKey, fetch = globalThis.fetch } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A Trillion request needs an object input.');
  if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 256) throw new Error('A Trillion request needs a request key.');
  if (!port) throw new Error('Trillion is not running on this computer.');
  const key = await readKey(door);
  if (!goodKey(key)) throw new Error('Trillion on this computer is not signed in.');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'do_one_thing_in_my_account', arguments: { address, method, request_key: requestKey, input } } });
  if (Buffer.byteLength(body) > door.most_request_bytes) throw new Error('The request is too large for Trillion.');
  let response, text;
  try {
    response = await fetch(`http://127.0.0.1:${port}${door.path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(door.timeout_seconds * 1000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'cache-control': 'no-store', 'mcp-protocol-version': door.protocol_version, 'mcp-method': 'tools/call', 'mcp-name': 'do_one_thing_in_my_account' },
      body,
    });
    text = await response.text();
  } catch { throw new Error('Trillion on this computer did not answer.'); }
  if (response.status === 401 || response.status === 403) throw new Error('Trillion on this computer refused this computer\'s sign-in.');
  if (response.status !== 200) throw new Error(`Trillion on this computer answered ${response.status}.`);
  if (Buffer.byteLength(text) > door.most_answer_bytes) throw new Error('Trillion\'s answer is too large for the browser.');
  const message = messageOf(text, response.headers.get('content-type'));
  if (!message) throw new Error('Trillion on this computer gave an answer that is not MCP.');
  const result = message.result;
  const said = result?.content?.find(part => part?.type === 'text')?.text;
  if (message.error || result?.isError) throw new Error(String(message.error?.message ?? said ?? 'Trillion refused the request.').slice(0, 300));
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  try { return JSON.parse(said); } catch { return { said: said ?? null }; }
}

/** One action per `door_actions` row of a host: each asks the door for its DATA-named address and method, and answers
 *  { answer } so nothing the operation returns can stand in for the host's own `ok` or `action`. */
export const doorAnswers = (settings, host, options = {}) => Object.fromEntries(Object.entries(host?.door_actions ?? {}).map(([action, row]) =>
  [action, async message => {
    const answer = await askDoor({ door: settings.engine_door, address: row.address, method: row.method,
      input: message?.input ?? {}, ...(message?.request_key === undefined ? {} : { requestKey: message.request_key }), ...options });
    return { answer };
  }]));
