// tools/run-tools-in-my-signed-in-browser/ask-my-browser.mjs
//
// PURPOSE
//   The command the tool rows read-a-page-in-my-browser, act-in-my-browser and drive-my-browser run on the person's own
//   computer (what-this-tool-does-and-how-to-run-it.json): it asks the door for a nonce, has the vault sign it, posts the run's input to the browser relay door on this computer (browser-relay.mjs,
//   at the port the engine fills in from this computer's report, the same name the row's `local_doors` lists) and prints
//   { result } or { error } as its last line.
//
//     node ask-my-browser.mjs <tool id> <port> < input.json
//
// NON-NEGOTIABLE INVARIANTS
//   1. It reaches only the loopback host browser-relay.json names, at the port it was given (1024-65535; any other is
//      refused in `no_port` words, never guessed), and passes the tool id it was given; the door refuses a tool it does not list.
//   2. With no browser connected (nothing listens, or the door says so) the answer is `error` in the door's words, never a hang;
//      the wait is bounded by the door's `most_seconds` plus a few seconds.
//   3. Only an answer of at most `most_answer_bytes` is read.
//   4. It proves itself to the door with the engine's own way: the run's records door (descriptor 3, the row's right names the
//      one key `key_name` and the one operation `secrets:sign`) signs the door's nonce with the person's vault key; the key
//      never leaves the vault, and the run's capability is never printed, logged or put in an answer.
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, 'browser-relay.json'), 'utf8'));
const GRACE_SECONDS = 5;
const DESCRIPTOR_FD = 3;

/** The run's records door, from the descriptor the engine wrote on fd 3; null when this run was handed none. */
export function readDoor(descriptor = DESCRIPTOR_FD) {
  try {
    const door = JSON.parse(readFileSync(descriptor, 'utf8'));
    return typeof door.url === 'string' && typeof door.capability === 'string' ? door : null;
  } catch { return null; }
}

/** Signs `payload` with the vault key `key_name` through the run's door (`secrets:sign`); answers the signature in hex. */
export async function signWithVault(payload, { door = readDoor(), fetcher = fetch, name = config.key_name } = {}) {
  if (!door) throw new Error(config.words.no_proof.replace('{path}', config.challenge_path).replace('{key}', name));
  const response = await fetcher(door.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${door.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { address: '@secrets', method: 'secrets:sign', request_key: `sign:${randomUUID()}`, input: { name, payload } } } }),
  });
  if (!response.ok) throw new Error(`The records door answered ${response.status}.`);
  const text = await response.text();
  const body = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text;
  const result = JSON.parse(body).result ?? {};
  const hex = result.structuredContent?.signature;
  if (result.isError || typeof hex !== 'string' || !/^[0-9a-f]{128}$/.test(hex)) throw new Error(`The vault refused to sign: ${result.structuredContent?.code ?? 'refused'}.`);
  return hex;
}

/** Asks the browser through the relay door: { result } or { error }. */
export async function askMyBrowser(tool, input, { port, fetcher = fetch, door = config, sign = signWithVault } = {}) {
  let answer;
  const number = Number(port);
  if (!/^\d+$/.test(String(port ?? '')) || number < 1024 || number > 65535) return { error: door.words.no_port.replaceAll('{name}', door.port_name) };
  const at = path => `http://${door.host}:${number}${path}`;
  const post = (path, body) => fetcher(at(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout((door.most_seconds + GRACE_SECONDS) * 1000) });
  const unreached = error => ({ error: error?.name === 'TimeoutError' ? door.words.too_slow.replace('{seconds}', String(door.most_seconds)) : door.words.no_browser });
  let challenge;
  try { challenge = JSON.parse(await (await post(door.challenge_path, {})).text()); } catch (error) { return error instanceof SyntaxError ? { error: door.words.not_json } : unreached(error); }
  if (typeof challenge?.nonce !== 'string') return typeof challenge?.error === 'string' ? { error: challenge.error } : { error: door.words.not_json };
  const proof = input ?? {};
  let signature;
  try { signature = await sign(`${challenge.nonce}\n${tool}\n${JSON.stringify(proof)}`); } catch (error) { return { error: String(error?.message ?? error) }; }
  try { answer = await post(door.path, { tool, input: proof, nonce: challenge.nonce, signature }); } catch (error) { return unreached(error); }
  const body = await answer.text();
  if (Buffer.byteLength(body) > door.most_answer_bytes) return { error: door.words.too_large_answer.replace('{bytes}', String(door.most_answer_bytes)) };
  try { return JSON.parse(body); } catch { return { error: door.words.not_json }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const given = JSON.parse((await text(process.stdin)) || '{}');
    const answered = await askMyBrowser(process.argv[2] ?? '', given, { port: process.argv[3] });
    console.log(JSON.stringify(answered));
    if (answered.error !== undefined) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
