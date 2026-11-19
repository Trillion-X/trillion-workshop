// tools/workflows/read-data/host-actions.mjs
//
// The host actions a run gets from its native parent, read from the run's private descriptor (`parent_actions: { fd }`): one
// JSON line { url, capability, files_resource?, computer_actions?: { resource, trash_source } } (trillion-rust
// account_rights/run_capability.rs). A host action is the computer's work for the run, not a records operation, so this
// module opens no records door and reads no record.
//
//   const host = openHostActions({ descriptor: 3 });        // reads nothing yet
//   await host.parentActions.trashSource({ path, expected_generation })  -> { outcome: 'moved' }; one attempt, never retried
//   await host.readWholeFile(name, { readBytes?, mostBytes? })           -> { title, size, bytes } (bytes null when above mostBytes)
//
// readWholeFile needs the run's files right (the descriptor holds files_resource); without it the call is refused with
// `no_files` before anything is sent. The descriptor is read at the first use of either action, so a function that uses
// neither never reads it. A refusal the native side made before any effect is a HostActionError with outcome `not_started`;
// every other failure of a physical action is outcome `unknown`, and the caller stops without retrying. The capability is a
// bearer: it is never printed, logged or returned, and no error carries a transport or RPC message.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-06-18';
const READ_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const MAX_WAIT_MS = 30_000;
const READ_BYTES = 4 * 1024 * 1024;
const MOST_BYTES = 512 * 1024 * 1024;
const NOT_STARTED_CODES = ['computer_action_refused', 'current_workspace_rights_refused', 'original_input_refused', 'capability_gone'];
const TRASH_UNKNOWN = 'The Trash move outcome is unknown. Stop without retrying.';

export class HostActionError extends Error {
  constructor(code, message, outcome = null) {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}

// An answer is JSON, or an event stream whose last `data:` line is the JSON answer.
function answerOf(text, contentType) {
  if (!/text\/event-stream/.test(contentType ?? '')) return JSON.parse(text);
  const data = text.split('\n').filter(line => line.startsWith('data:')).at(-1);
  if (!data) throw new Error('empty event stream');
  return JSON.parse(data.slice(5).trim());
}

function trashInputOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'path') || !Object.hasOwn(input, 'expected_generation')
    || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.includes('\0') || Buffer.byteLength(input.path) > 4096
    || typeof input.expected_generation !== 'string' || !input.expected_generation || Buffer.byteLength(input.expected_generation) > 16 * 1024 * 1024) {
    throw new HostActionError('original_input_refused', 'Supply only an absolute path and its exact generation observation.', 'not_started');
  }
  return { path: input.path, expected_generation: input.expected_generation };
}

// One call to the native side. `retry` (reads only) asks again after a busy answer, a throttle or a lost connection, with the
// same request key; a physical action is asked once.
async function ask(route, fetchImpl, wait, { address, method, input, retry }) {
  const key = `${retry ? 'read' : 'action'}:${randomUUID()}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'do_one_thing_in_my_account', arguments: { address, method, request_key: key, input } } });
  const headers = { authorization: `Bearer ${route.capability}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
  for (let attempt = 0; ; attempt += 1) {
    const again = retry && attempt < READ_RETRIES;
    let response;
    try { response = await fetchImpl(route.url, { method: 'POST', headers, body }); }
    catch {
      if (again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      throw new HostActionError('transport_unavailable', 'The native side could not be reached.', 'unknown');
    }
    if (again && (response.status === 503 || response.status === 429)) {
      await wait(throttledWait(response.headers?.get?.('retry-after'), attempt));
      continue;
    }
    if (response.status === 401) throw new HostActionError('capability_gone', "This run's native parent has closed.", 'not_started');
    if (!response.ok) throw new HostActionError(`http_${response.status}`, `The native side answered ${response.status}.`, 'unknown');
    let answer;
    try { answer = answerOf(await response.text(), response.headers.get('content-type')); }
    catch { throw new HostActionError('invalid_answer', 'The native side returned an invalid answer.', 'unknown'); }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.error) {
      throw new HostActionError('rpc_error', 'The native side returned an error.', 'unknown');
    }
    const result = answer.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'structuredContent')) {
      throw new HostActionError('invalid_answer', 'The native side returned an invalid answer.', 'unknown');
    }
    if (!result.isError) return result.structuredContent;
    const { code, outcome } = result.structuredContent ?? {};
    if (retry && code === 'selected_owner_unavailable' && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
    throw new HostActionError(typeof code === 'string' && code ? code : 'refused', 'The native side refused the request.',
      outcome === 'not_started' ? 'not_started' : 'unknown');
  }
}

// The door's own wait rule for a throttled answer: its Retry-After in seconds when given, else the backoff; then half to whole.
function throttledWait(retryAfter, attempt) {
  const hinted = Number(retryAfter) * 1000;
  const base = Number.isFinite(hinted) && hinted > 0 ? hinted : FIRST_WAIT_MS * 2 ** attempt;
  return Math.min(base, MAX_WAIT_MS) * (0.5 + Math.random() / 2);
}

// One of the person's files read whole (find_file, then read_file page by page). A file above `mostBytes` is never read past
// its first page: the answer says so with bytes null.
async function readWholeFile(files, name, { readBytes = READ_BYTES, mostBytes = MOST_BYTES } = {}) {
  const found = await files('find_file', { name_or_identity: name });
  const title = String(found.names?.[0] ?? found.name ?? name).split('/').pop();
  const parts = [];
  let offset = 0;
  for (;;) {
    const piece = await files('read_file', { name_or_identity: name, offset, length: readBytes });
    if (piece.byte_length > mostBytes) return { title, size: piece.byte_length, bytes: null };
    parts.push(Buffer.from(piece.content ?? '', piece.encoding === 'base64' ? 'base64' : 'utf8'));
    offset += piece.bytes_returned;
    if (!piece.bytes_returned || offset >= piece.byte_length) return { title, size: offset, bytes: Buffer.concat(parts) };
  }
}

/** The run's host actions. Nothing is read until the first use; each use reads the same descriptor once. */
export function openHostActions({ descriptor = 3, fetchImpl = fetch, wait = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  let route;
  const current = () => {
    if (route) return route;
    let read;
    try { read = JSON.parse(readFileSync(descriptor, 'utf8')); }
    catch { throw new HostActionError('no_host_actions', 'This run was not handed its host actions.', 'not_started'); }
    if (typeof read?.url !== 'string' || !read.url || typeof read?.capability !== 'string' || !read.capability) {
      throw new HostActionError('no_host_actions', 'This run was not handed its host actions.', 'not_started');
    }
    route = read;
    return route;
  };
  const files = async (method, input) => {
    const address = current().files_resource;
    if (typeof address !== 'string' || !address) throw new HostActionError('no_files', 'This run was not handed a files right.', 'not_started');
    return ask(current(), fetchImpl, wait, { address, method, input, retry: true });
  };
  return {
    parentActions: {
      async trashSource(input) {
        const sent = trashInputOf(input);
        const actions = current().computer_actions;
        if (typeof actions?.resource !== 'string' || !actions.resource || typeof actions.trash_source !== 'string' || !actions.trash_source) {
          throw new HostActionError('no_parent_actions', 'This run was not handed native parent actions.', 'not_started');
        }
        let answer;
        try { answer = await ask(current(), fetchImpl, wait, { address: actions.resource, method: actions.trash_source, input: sent, retry: false }); }
        catch (error) {
          if (error instanceof HostActionError && error.outcome === 'not_started' && NOT_STARTED_CODES.includes(error.code)) throw error;
          throw new HostActionError('computer_action_unknown', TRASH_UNKNOWN, 'unknown');
        }
        if (answer?.outcome === 'moved') return { outcome: 'moved' };
        throw new HostActionError('computer_action_unknown', TRASH_UNKNOWN, 'unknown');
      },
    },
    readWholeFile: (name, options) => readWholeFile(files, name, options),
  };
}
