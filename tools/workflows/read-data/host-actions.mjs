// tools/workflows/read-data/host-actions.mjs
//
// The host actions a run gets from its native parent, read from the run's private descriptor (`parent_actions: { fd }`): one
// JSON line { url, capability, tools_resource?, files_resource?, computer_actions?: { resource, trash_source } } (trillion-rust
// account_rights/run_capability.rs). `files_resource` names the Files session tool (tool:your-files) the run's files right
// may call, when its row asks for one ({files: <folder>, operations} in its stored list); each files operation is one call
// of that tool, `tools:run` { tool, call: { name, arguments } } at the tools address, held by the engine to the operations
// and folder the row named. A host action is the computer's work for the run, not a records operation, so this module opens
// no records door and reads no record.
//
//   const host = openHostActions({ descriptor: 3 });        // reads nothing yet
//   await host.parentActions.trashSource({ path, expected_generation })  -> { outcome: 'moved' }; one attempt, never retried
//   await host.readWholeFile(name, { readBytes?, mostBytes? })           -> { title, size, bytes } (bytes null when above mostBytes)
//   await host.files(method, input)                                      -> one files-right operation (list_files, write_file_start ...):
//                                                                           the Files tool's structuredContent; its refusal throws its code
//   await host.run(tool, input, { key? })                                -> another Workshop tool's result (tools:run; a failed run throws;
//                                                                           an answer sent as byte pages is joined and checked first)
//   await host.operation(method, input, { key? })                        -> one door method at the run's own address (wake:arrive, tools:list ...)
//   await host.writeLarge(name, source, { mediaType? })                  -> a file above the piece bound, in raw pieces through the files right
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
import { keepInRawPieces } from '../../records-door/read-data/raw-pieces.mjs';

const PROTOCOL = '2025-06-18';
const READ_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const MAX_WAIT_MS = 30_000;
// A Files call the store said it could not answer (its byte or record store did not answer, or the store is not open yet) is
// asked again, at most READ_RETRIES times, waiting STORE_FIRST_WAIT_MS and then twice as long each time up to MAX_WAIT_MS,
// when asking again writes nothing twice: a read, or a step of a write whose upload id is its own (a start asked again answers
// the same upload, a piece at an offset already taken is answered only for the same bytes, a finish answers the finished
// file). Any other call keeps its refusal. Nov 21 2026, 5:32-5:39 PM CST: three publish_site runs were refused
// namespace_source_unavailable while the store's writes came back minutes later, and a run sent again at 5:46 published.
const STORE_UNANSWERED = new Set(['namespace_source_unavailable', 'namespace_unavailable']);
const ASKED_AGAIN_SAFELY = new Set(['list_files', 'find_file', 'show_file', 'read_file', 'read_file_span', 'find_names', 'bounds',
  'search', 'recent_files', 'read_file_results', 'read_file_result_fields', 'read_file_results_many', 'list_file_results',
  'write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
const STORE_FIRST_WAIT_MS = 1_000;
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
// How the engine answers a call of a session tool (`tools:run` with `call`, trillion-rust src/tool_runs/tools/sessions.rs
// `call`): `{ tool, result }` with the session's own MCP result `{ structuredContent, isError }`, or `{ tool, error }` when its
// process answered a JSON-RPC error. A refused call's structuredContent is `{ code, outcome }`.
const SESSION_CALL = 'call';

// An answer too big for one message is sent as pages of its own JSON bytes (trillion-rust src/mcp.rs `byte_page`):
// `{ byte_page: { total, blake3, offset, length, base64, next_after_byte } }`. Each further page is the same call under the same
// request key with `after_byte`, which the engine answers from the first call's receipt and never runs again. Until Nov 20 2026
// a paged answer was handed on as it was: tool:list-running-programs with commands (about 635 KB) reached the next step of
// workflow:stop-programs-left-running as a page with no `programs`, and every run of it failed from 12:30 AM CST.
async function wholeOf(first, next) {
  const head = first && typeof first === 'object' && !Array.isArray(first) ? first.byte_page : null;
  if (!head || typeof head !== 'object') return first;
  const broken = why => new HostActionError('byte_page_broken', `The paged answer could not be joined: ${why}.`, 'unknown');
  const { total, blake3 } = head;
  if (!Number.isInteger(total) || total < 0 || total > MOST_BYTES) throw broken('it names no whole size this owner takes');
  if (typeof blake3 !== 'string' || !/^[0-9a-f]{64}$/i.test(blake3)) throw broken('it names no BLAKE3');
  const parts = [];
  let page = head;
  let at = 0;
  for (;;) {
    if (page.offset !== at || page.total !== total || String(page.blake3).toLowerCase() !== blake3.toLowerCase()) throw broken(`a page does not continue at byte ${at}`);
    const bytes = Buffer.from(typeof page.base64 === 'string' ? page.base64 : '', 'base64');
    if (bytes.length !== page.length || (!bytes.length && at < total)) throw broken(`a page at byte ${at} holds ${bytes.length} bytes`);
    parts.push(bytes);
    at += bytes.length;
    if (at > total) throw broken(`the pages hold more than ${total} bytes`);
    if (at === total) break;
    if (page.next_after_byte !== at) throw broken(`next_after_byte is ${page.next_after_byte ?? 'null'} at byte ${at}`);
    const answer = await next(at);
    page = answer && typeof answer === 'object' ? answer.byte_page : null;
    if (!page || typeof page !== 'object') throw broken(`the answer after byte ${at} is not a page`);
  }
  const joined = Buffer.concat(parts);
  if (makeHashCodeHexFromBytes(joined) !== `1f:${blake3.toLowerCase()}`) throw broken('the joined bytes do not hash to its BLAKE3');
  try { return JSON.parse(joined.toString('utf8')); } catch { throw broken('the joined bytes are not JSON'); }
}

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

// The engine's answer to one call of the Files session tool, read in this one place (see SESSION_CALL above): its
// structuredContent, or its refusal as a HostActionError with the tool's own code. The refusal's words name the call that
// was refused and the store's own words for it (its `detail.words`), and keep the store's reference when it gives one: from
// 3:58 PM CST Nov 21 2026 two keeps of page screenshots said only "The files tool refused the request.", so no one could tell
// which call or why.
export function resultOfCall(answer, method = null) {
  const reply = answer && typeof answer === 'object' ? answer[TOOL_RUN_RESULT] : null;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || Object.hasOwn(answer, TOOL_RUN_ERROR)) {
    throw new HostActionError('rpc_error', 'The files tool returned an error.', 'unknown');
  }
  if (reply.isError) {
    const { code, outcome, detail, reference } = reply.structuredContent ?? {};
    const words = typeof detail?.words === 'string' ? detail.words : typeof detail === 'string' ? detail : null;
    const said = `The files tool refused ${method ? `${method}` : 'the request'}${words ? `: ${words}` : ''}.`;
    throw Object.assign(new HostActionError(typeof code === 'string' && code ? code : 'refused', said,
      outcome === 'not_started' ? 'not_started' : 'unknown'), { call: method, ...(typeof reference === 'string' ? { reference } : {}) });
  }
  return reply.structuredContent;
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
    const tool = current().files_resource;
    if (typeof tool !== 'string' || !tool) throw new HostActionError('no_files', 'This run was not handed a files right.', 'not_started');
    const address = current().tools_resource ?? WORKSHOP_TOOLS;
    for (let attempt = 0; ; attempt += 1) {
      const answer = await ask(current(), fetchImpl, wait,
        { address, method: 'tools:run', input: { tool, [SESSION_CALL]: { name: method, arguments: input } }, retry: true });
      try {
        return resultOfCall(answer, method);
      } catch (error) {
        if (!STORE_UNANSWERED.has(error.code) || !ASKED_AGAIN_SAFELY.has(method) || attempt >= READ_RETRIES) throw error;
        await wait(Math.min(STORE_FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS));
      }
    }
  };
  return {
    // One operation on the person's Files through the run's files right (find_file, read_file, write_file_start ...).
    files,
    // Another Workshop tool's run: `tools:run` { tool, input } at the descriptor's tools address (else @tools), held to this
    // run's grant and deadline. `key` names it within this run, so the same nested run sent again is one run. Answers the
    // run's result; a run that failed throws `tool_run_failed`. A run is asked once, never retried by this owner.
    async run(tool, input = {}, { key = `tools:run:${randomUUID()}` } = {}) {
      const address = current().tools_resource ?? WORKSHOP_TOOLS;
      const first = await ask(current(), fetchImpl, wait, { address, method: 'tools:run', input: { tool, input }, key, retry: false });
      // The later pages read the first call's receipt under its key, so asking for them again is safe.
      const answer = await wholeOf(first, at => ask(current(), fetchImpl, wait, { address, method: 'tools:run', input: { tool, input, after_byte: at }, key, retry: true }));
      return resultOfRun(tool, answer);
    },
    // One operation the run's own door answers by its method (a workflow step's door ask: wake:arrive, tools:list, tools:run
    // at a server's address), at the descriptor's own address (`resource`, else @own-records). Sent once; the engine holds it
    // to this run's rights.
    async operation(method, input, { key = `${method}:${randomUUID()}` } = {}) {
      const address = current().resource ?? '@own-records';
      const first = await ask(current(), fetchImpl, wait, { address, method, input, key, retry: false });
      return wholeOf(first, at => ask(current(), fetchImpl, wait, { address, method, input: { ...input, after_byte: at }, key, retry: true }));
    },
    // A file above the piece bound, kept in raw pieces through this run's files right (records-door raw-pieces.mjs): the Files
    // tool's write_file_start, each piece as a raw octet-stream body, write_file_finish, with this run's own capability as the
    // bearer (never printed, logged or returned). Until Nov 20 2026 this was a lease road the engine no longer serves.
    async writeLarge(name, source, { mediaType = null, uploadId } = {}) {
      const route = current();
      const tool = route.files_resource;
      if (typeof tool !== 'string' || !tool) throw new HostActionError('no_files', 'This run was not handed a files right.', 'not_started');
      return keepInRawPieces({ url: route.url, capability: route.capability, filesTool: tool, toolsAddress: route.tools_resource ?? WORKSHOP_TOOLS, fetchImpl, wait },
        name, source, { mediaType: mediaType ?? undefined, ...(uploadId ? { uploadId } : {}) });
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
