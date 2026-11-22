// harness/account-call.mjs
//
// Purpose
//   The one road the task runner (take-open-work.mjs) and the connection its AI runs receive (account-mcp-bridge.mjs) use
//   to reach the account. One engine operation (do_one_thing_in_my_account: address, method, input, request_key) is sent
//   by the credential take-open-work.json `account.credential` names, and every operation is pinned to the computers in
//   `account.pins` (the Mac, so an operation never reaches another computer first). Two sources are declared:
//     - { "from": "kept sign-in", "command": [...] }: the person's own command (`op METHOD - --address A --pin ID --json`, run by the
//       command the source names) holds the sign-in; this program holds no key and never sees one.
//     - { "from": "keychain", "item": NAME, "origin": URL }: the kept account key, read from the Keychain item NAME at each
//       call and sent only in the Authorization header of an https request to origin/mcp.
//     - { "from": "vault", "item": NAME, "origin": URL }: the same request with the key read from this computer's vault
//       value NAME (vault-value.mjs, the command the computer's config names) at each call.
//   Which of the two the runner acts as is the data owner's decision; this file only carries out what the data names.
//
// Non-negotiable invariants
//   1. A key is read only for the keychain or vault source, only at the call, and is placed only in the Authorization header. It is
//      never put in argv, the environment, a file, an error or a log.
//   2. An operation with no pin is refused before anything is sent or started.
//   3. The input goes on standard input for the command (never argv) and in the JSON body for the request.
//   4. A refusal is raised as AccountCallError carrying the engine's code; an operation that does not finish in time is
//      stopped and raised with the code `timeout`; an unknown source is refused by name.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accountKeyOrNull } from './account-key.mjs';
import { readVaultValue } from './vault-value.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export class AccountCallError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = 'AccountCallError';
    this.code = code;
  }
}

/** The account with the command's `{brand}` placeholder filled from the word the caller names (the marks word this computer
 *  keeps, passed in by take-open-work.mjs). */
export function accountWithWord(account, word) {
  const credential = account?.credential ?? {};
  const command = Array.isArray(credential.command) ? credential.command.map(part => String(part).replaceAll('{brand}', word ?? '')) : credential.command;
  return { ...account, credential: { ...credential, ...(command ? { command } : {}) } };
}

const SAID_LIMIT = 800;
const TOOL = 'do_one_thing_in_my_account';

/** The arguments of one `op` run after the command's program name. Throws when no pin or no address is named. */
export function opArguments({ method, address, pins, requestKey = null }) {
  requirePins(pins);
  if (typeof address !== 'string' || !address || typeof method !== 'string' || !method) throw new AccountCallError('An operation needs an address and a method.', { code: 'operation_incomplete' });
  return ['op', method, '-', '--address', address, '--json', ...pins.flatMap(pin => ['--pin', pin]), ...(requestKey ? ['--request-key', requestKey] : [])];
}

const requirePins = pins => {
  if (!Array.isArray(pins) || pins.length === 0) throw new AccountCallError('An operation needs at least one pin, the computer to meet it at.', { code: 'pin_absent' });
};

/** The person's command: one run of `op`, the input on standard input, the answer read from standard output. */
export function runWithSignIn({ account, env, address, method, input, requestKey, spawnImpl }) {
  const [program, ...lead] = account.credential.command ?? [];
  if (typeof program !== 'string' || !program) throw new AccountCallError('The sign-in credential names no command.', { code: 'command_absent' });
  const args = [...lead, ...opArguments({ method, address, pins: account.pins, requestKey })];
  const timeoutMs = (account.timeout_seconds ?? 120) * 1000;
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(new AccountCallError(`The person's command could not start (${error.code ?? error.message}).`, { code: 'command_absent' })); return; }
    let out = '', err = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { child.kill?.('SIGTERM'); finish(new AccountCallError(`The operation ${method} did not finish in ${account.timeout_seconds ?? 120} seconds.`, { code: 'timeout' })); }, timeoutMs);
    child.stdout?.on('data', chunk => { out += chunk; });
    child.stderr?.on('data', chunk => { err += chunk; });
    child.on('error', error => finish(new AccountCallError(`The person's command failed (${error.code ?? error.message}).`, { code: 'command_failed' })));
    child.on('close', code => {
      if (code === 0) {
        try { finish(null, JSON.parse(out)); } catch { finish(new AccountCallError(`The operation ${method} answered unreadable output.`, { code: 'unreadable' })); }
        return;
      }
      // With --json a refusal is {code, message} on the error output; anything else is its words, cut short.
      try {
        const refusal = JSON.parse(err);
        finish(new AccountCallError(String(refusal.message ?? `The operation ${method} was refused.`), { code: refusal.code ?? 'refused' }));
      } catch {
        finish(new AccountCallError(err.trim().slice(0, SAID_LIMIT) || `The operation ${method} failed (exit ${code}).`, { code: 'failed' }));
      }
    });
    child.stdin?.end(JSON.stringify(input ?? {}));
  });
}

// The reply of one MCP request: a JSON object, or the data line of an event stream.
const replyOf = text => {
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const line = trimmed.split('\n').find(row => row.startsWith('data:'));
  return line ? JSON.parse(line.slice(5)) : null;
};

/** The kept account key, sent as one request: the key is read at this call and held only in the Authorization header. */
export async function runWithKey({ account, address, method, input, requestKey, fetchImpl, readKey }) {
  requirePins(account.pins);
  if (typeof address !== 'string' || !address || typeof method !== 'string' || !method) throw new AccountCallError('An operation needs an address and a method.', { code: 'operation_incomplete' });
  const { item, origin } = account.credential;
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new AccountCallError('The account address must be https.', { code: 'origin_refused' });
  const key = readKey(item);
  if (!key) throw new AccountCallError(`No account key is kept under ${item}.`, { code: 'key_absent' });
  const message = { jsonrpc: '2.0', id: requestKey, method: 'tools/call', params: { name: TOOL, arguments: { address, method, input: input ?? {}, request_key: requestKey, pins: account.pins } } };
  let response;
  try {
    response = await fetchImpl(`${url.origin}/mcp`, { method: 'POST', signal: AbortSignal.timeout((account.timeout_seconds ?? 120) * 1000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify(message) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AccountCallError(`The operation ${method} did not finish in ${account.timeout_seconds ?? 120} seconds.`, { code: 'timeout' });
    throw new AccountCallError(`The account did not answer (${error?.cause?.code ?? error?.code ?? 'no answer'}).`, { code: 'unreachable' });
  }
  if (!response.ok) throw new AccountCallError(`The account answered HTTP ${response.status}.`, { code: 'http_status' });
  const reply = replyOf(await response.text());
  if (!reply) throw new AccountCallError('The account answered nothing readable.', { code: 'unreadable' });
  if (reply.error) throw new AccountCallError(String(reply.error.message ?? 'The account refused the call.'), { code: 'rpc_error' });
  const result = reply.result ?? {};
  if (result.isError) throw new AccountCallError(result.content?.find(row => row.type === 'text')?.text ?? 'The operation was refused.', { code: 'refused' });
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find(row => row.type === 'text')?.text;
  try { return JSON.parse(text); } catch { throw new AccountCallError('The operation answered unreadable output.', { code: 'unreadable' }); }
}

/**
 * One engine operation through the source take-open-work.json `account.credential` names. `deps` (env, spawnImpl,
 * fetchImpl, readKey) are the process's own by default. Resolves to the operation's answer; rejects with AccountCallError.
 */
export async function runOperation({ account, address, method, input = {}, requestKey = randomUUID(), env = process.env, spawnImpl = spawn, fetchImpl = fetch, readKey = item => accountKeyOrNull({ item, timeout: 2000 }) }) {
  const from = account?.credential?.from;
  if (from === 'kept sign-in') return runWithSignIn({ account, env, address, method, input, requestKey, spawnImpl });
  if (from === 'keychain') return runWithKey({ account, address, method, input, requestKey, fetchImpl, readKey });
  if (from === 'vault') return runWithKey({ account, address, method, input, requestKey, fetchImpl, readKey: item => readVaultValue(account.vault, item) });
  throw new AccountCallError(`The account credential names no known source (${String(from)}).`, { code: 'credential_unknown' });
}

/**
 * The transport a task runner calls the account through: `resource(address, method, input, requestKey)` answers the
 * operation (runOperation). The legacy HTTP routes are not reached this way.
 */
export function operationCaller(account, deps = {}) {
  const call = path => { throw new AccountCallError(`${path} is a legacy HTTP route; it is not reached through the account's one road.`, { code: 'legacy_route' }); };
  call.resource = async (address, method, input, requestKey = randomUUID()) => {
    const send = extra => runOperation({ ...deps, account, address, method, input: { ...(input ?? {}), ...extra }, requestKey });
    return wholeAnswer(await send({}), at => send({ after_byte: at }), method);
  };
  return call;
}

// At most this many pages make one answer (a page is at most what one reply holds).
const MOST_PAGES = 1000;

/**
 * The whole of an answer the engine sent as byte pages (`{byte_page: {offset, length, total, next_after_byte, blake3,
 * base64}}`, src/mcp.rs), else the answer as it came. Each further page is the same operation under the same request
 * key with `after_byte` (`next`), answered from the first call's receipt; every page must continue where the last ended
 * and name the first page's total and BLAKE3, and the joined bytes must hash to it, or nothing is answered. The bytes
 * are read as JSON, else answered as text. The always-on's taker read every listing of its tasks as a page and took
 * nothing (from 3:57 AM CST Nov 22 2026: "answered no rows: {byte_page: …}").
 */
export async function wholeAnswer(first, next, method = 'the operation') {
  const head = first && typeof first === 'object' && first.byte_page && typeof first.byte_page === 'object' ? first.byte_page : null;
  if (!head) return first;
  const broken = why => new AccountCallError(`The answer to ${method} came in pages that do not join: ${why}.`, { code: 'byte_page_broken' });
  const { total, blake3 } = head;
  if (!Number.isInteger(total) || total < 0 || typeof blake3 !== 'string' || !/^[0-9a-f]{64}$/i.test(blake3)) throw broken('its first page names no size or BLAKE3');
  const parts = [];
  let page = head, at = 0;
  for (let count = 1; ; count += 1) {
    if (page.offset !== at) throw broken(`a page starts at byte ${page.offset}, not ${at}`);
    if (page.total !== total || String(page.blake3).toLowerCase() !== blake3.toLowerCase()) throw broken('a page belongs to another answer');
    const bytes = Buffer.from(typeof page.base64 === 'string' ? page.base64 : '', 'base64');
    if (bytes.length !== page.length || (!bytes.length && at < total)) throw broken(`a page at byte ${at} holds ${bytes.length} bytes, not ${page.length}`);
    parts.push(bytes);
    at += bytes.length;
    if (at > total) throw broken(`the pages hold more than ${total} bytes`);
    if (at === total) break;
    if (page.next_after_byte !== at) throw broken(`next_after_byte is ${page.next_after_byte ?? 'null'} at byte ${at} of ${total}`);
    if (count >= MOST_PAGES) throw broken(`more than ${MOST_PAGES} pages`);
    const answer = await next(at);
    page = answer && typeof answer === 'object' && answer.byte_page && typeof answer.byte_page === 'object' ? answer.byte_page : null;
    if (!page) throw broken(`the page after byte ${at} is not a byte_page`);
  }
  const joined = Buffer.concat(parts);
  if (makeHashCodeHexFromBytes(joined).slice('1f:'.length) !== blake3.toLowerCase()) throw broken('the joined bytes do not hash to the BLAKE3 the pages name');
  const text = joined.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}
