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
//   await host.files(method, input)                                      -> one files-right operation (list_files, write_file_start ...)
//   await host.run(tool, input, { key? })                                -> another Workshop tool's result (tools:run; a failed run throws)
//   await host.operation(method, input, { key? })                        -> one door method at the run's own address (wake:arrive, tools:list ...)
//   await host.writeLarge(name, source, { mediaType? })                  -> a file above the piece bound, over the lease road
//
// readWholeFile needs the run's files right (the descriptor holds files_resource); without it the call is refused with
// `no_files` before anything is sent. The descriptor is read at the first use of either action, so a function that uses
// neither never reads it. A refusal the native side made before any effect is a HostActionError with outcome `not_started`;
// every other failure of a physical action is outcome `unknown`, and the caller stops without retrying. The capability is a
// bearer: it is never printed, logged or returned, and no error carries a transport or RPC message.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { readWholeFile } from './whole-file.mjs';

const PROTOCOL = '2025-06-18';
const READ_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const MAX_WAIT_MS = 30_000;
const READ_BYTES = 4 * 1024 * 1024;
const MOST_BYTES = 512 * 1024 * 1024;
const NOT_STARTED_CODES = ['computer_action_refused', 'current_workspace_rights_refused', 'original_input_refused', 'capability_gone'];
const TRASH_UNKNOWN = 'The Trash move outcome is unknown. Stop without retrying.';
// The engine takes a request key of at most this many bytes (trillion-rust src/mcp/settings.json `request_key_bytes`). A longer
// key is sent as its own BLAKE3 identity: the same key always gives the same name, and two keys never share one.
const REQUEST_KEY_BYTES = 255;
// The Workshop's own address for tool runs, when the descriptor names none (`tools_resource`).
const WORKSHOP_TOOLS = '@tools';
// How the engine answers `tools:run`: a finished run `{ tool, exit_code, result, replayed }`, one whose process failed
// `{ tool, exit_code, error, cause, replayed }` (trillion-rust src/tool_runs/tools/container.rs). `run()` hands its caller the
// `result`, and a failed run throws `tool_run_failed` with the engine's cause; an answer with neither field is the answer itself.
const TOOL_RUN_RESULT = 'result';
const TOOL_RUN_ERROR = 'error';

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
async function ask(route, fetchImpl, wait, { address, method, input, retry, key = `${retry ? 'read' : 'action'}:${randomUUID()}` }) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'do_one_thing_in_my_account', arguments: { address, method, request_key: requestKeyOf(key), input } } });
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

function requestKeyOf(key) {
  return Buffer.byteLength(key) <= REQUEST_KEY_BYTES ? key : `key:${makeHashCodeHexFromBytes(Buffer.from(key))}`;
}

// The engine's answer to `tools:run`, read in this one place (see TOOL_RUN_RESULT above).
export function resultOfRun(tool, answer) {
  if (answer && typeof answer === 'object' && Object.hasOwn(answer, TOOL_RUN_ERROR)) {
    const said = answer[TOOL_RUN_ERROR];
    throw new HostActionError('tool_run_failed', `${tool} did not finish: ${String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 300)}`, 'committed');
  }
  return answer && typeof answer === 'object' && Object.hasOwn(answer, TOOL_RUN_RESULT) ? answer[TOOL_RUN_RESULT] : answer;
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
    // One operation on the person's Namespace files at the run's files right (find_file, read_file, write_file_start ...).
    files,
    // Another Workshop tool's run: `tools:run` { tool, input } at the descriptor's tools address (else @tools), held to this
    // run's grant and deadline. `key` names it within this run, so the same nested run sent again is one run. Answers the
    // run's result; a run that failed throws `tool_run_failed`. A run is asked once, never retried by this owner.
    async run(tool, input = {}, { key = `tools:run:${randomUUID()}` } = {}) {
      const answer = await ask(current(), fetchImpl, wait, { address: current().tools_resource ?? WORKSHOP_TOOLS, method: 'tools:run',
        input: { tool, input }, key, retry: false });
      return resultOfRun(tool, answer);
    },
    // One operation the run's own door answers by its method (a workflow step's door ask: wake:arrive, tools:list, tools:run
    // at a server's address), at the descriptor's own address (`resource`, else @own-records). Sent once; the engine holds it
    // to this run's rights.
    async operation(method, input, { key = `${method}:${randomUUID()}` } = {}) {
      return ask(current(), fetchImpl, wait, { address: current().resource ?? '@own-records', method, input, key, retry: false });
    },
    // A file above the piece bound, kept over the lease road by the Workshop's one chunked sender, with this run's own
    // capability as its authorization (the bearer is never printed, logged or returned).
    async writeLarge(name, source, { mediaType = null } = {}) {
      const route = current();
      const { bearerControl, namespaceClient } = await import('../../browse-and-upload-my-files/do-work/namespace-client.mjs');
      const { loadChunking } = await import('../../browse-and-upload-my-files/do-work/content-chunks.mjs');
      const { sendFile } = await import('../../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs');
      const origin = new URL(route.url).origin;
      const control = bearerControl({ origin, authorization: async () => `Bearer ${route.capability}`, fetchImpl });
      const client = namespaceClient({ origin, control, fetchImpl });
      return sendFile({ client, source, name, mediaType, chunking: await loadChunking() });
    },
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
    readWholeFile: (name, options) => readWholeFile({ files }, name, options),
  };
}
