// tools/records-door/read-data/records-door.mjs
//
// The client a Workshop tool uses to reach the person's own records through the door its run was handed. A row that
// declares `invoke.records: { fd, rights: [{ at, id, operations }] }` gets, on that descriptor, one JSON line
// { url, capability, secrets_resource?, tools_resource? } (trillion-rust account_rights/run_capability.rs). Each right
// names its own address (`at`), so the descriptor names none: a call that names no address goes to @own-records, the
// address a right names when it names no other; a descriptor that does name `resource` (an older engine, a test) is
// kept. Every call is one `do_one_thing_in_my_account` at that address, sent to the door's loopback address with the
// capability as its bearer. The capability is never printed, logged or returned.
//
//   const door = openRecordsDoor();                       reads descriptor 3
//   await door.readRecord('post', 'post:abc')              -> { type, value }, or null
//   await door.read('post', 'post:abc')                   -> the value, or null
//   await door.readWorkspace(['screen-look'])               -> { records: { 'screen-look': rawValue } }
//   for await (const record of door.list({ type: 'post' })) ...   every record of a kind, page after page
//                                                          (`fields: [..]` narrows each value to those top-level fields;
//                                                          `where: { field: value }` keeps the rows whose fields equal it)
//   await door.search({ question, type?, limit? })        -> records:search's ranked answer over the records
//   await door.write([{ id, type, value, expected? }], { key }) -> receipt; value null removes, expected checks prior
//   await door.files('list_files', { folder: '/notes/' })   -> the files door's answer, at `files_resource`, which the
//                                                          descriptor holds when the row declares a `files` right
//   await door.writeLarge(name, source, { mediaType })     -> the finish answer; a file above the piece bound, kept in raw
//                                                          pieces (writeLargeFile below, raw-pieces.mjs; source from whole-file.mjs bufferSource or the sender's fileSource)
//   await door.operation(method, input, { key, at })       -> one operation a right names (wake:arrive at @own-records;
//                                                          tools:update at door.toolsAddress, the Workshop's address)
//   await door.run('tool:x', { ... }, { key })              -> another Workshop tool's run (`tools:run` at the Workshop's
//                                                          address, `tools_resource`, else @tools), only for a
//                                                          tool id the row declares in `runs`; the engine refuses others.
//                                                          Its result, never the engine's answer around it; a run that
//                                                          failed throws RecordsDoorError `tool_run_failed`
//
// A busy account (503, selected_owner_unavailable, or a source answer that began no effect), a throttled 429 and a call
// whose outcome is unknown are sent again with the same request key after a growing wait: the same key answers the receipt
// it already made, so an effect is never repeated under a new key. Safe reads also retry fetch/body transport failures;
// writes do not. result() reconciles records:write only, with its exact original command; file effects require their own
// admitted result owner and remain unknown until that owner proves the outcome. A refusal comes back as RecordsDoorError
// with the door's code and outcome. Large answers use byte pages (read-data/byte-pages.mjs).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pagedCall } from './byte-pages.mjs';
import { settledWrite } from './settled-write.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { keepInRawPieces } from './raw-pieces.mjs';

const PROTOCOL = '2025-06-18';
const BUSY_RETRIES = 5;
// A door that throttles (429) is asked again more times, each after a jittered wait that honours its Retry-After.
const RATE_RETRIES = 8;
const FIRST_WAIT_MS = 200;
const MAX_WAIT_MS = 30_000;
const PAGE = 999;
// The calling method selects its semantics. Do not infer safety from an operation's spelling or an HTTP status.
const READ = Object.freeze({ retryAmbiguous: true });
const EFFECT = Object.freeze({ retryAmbiguous: false });
const TRANSPORT_FAILURES = new WeakSet();

/** Only this transport's observed network failures, never a server-supplied code or caller cancellation. */
export function isRecordsDoorTransportFailure(error) {
  return error !== null && typeof error === 'object' && TRANSPORT_FAILURES.has(error);
}

/** A transport failure this client observed, as the error every records door caller throws: registered as a real
 * network failure only when `cause` is one (isRecordsDoorTransportFailure above), never for a server code or a cancellation. */
export function transportUnavailable(message, cause, outcome = 'unknown') {
  const error = new RecordsDoorError('transport_unavailable', message, outcome);
  if (isTransportFailure(cause)) TRANSPORT_FAILURES.add(error);
  return error;
}

// The engine takes a request key of at most this many bytes (trillion-rust src/mcp/settings.json `request_key_bytes`: Stripe's
// idempotency-key floor, 255 characters). A longer key is sent as its own BLAKE3 identity: the same key always gives the same
// name, two keys never share one, and a key within the bound is sent unchanged.
const REQUEST_KEY_BYTES = 255;
export function requestKeyOf(key) {
  return Buffer.byteLength(key) <= REQUEST_KEY_BYTES ? key : `key:${makeHashCodeHexFromBytes(Buffer.from(key))}`;
}

// The door answers a refusal with its code and, when the engine has them, its own words for it (`detail`: trillion-rust
// tool_runs/tools/computer/words.json, passed on as the refusal's structuredContent.detail); a refusal is said in those words,
// else in these, the words a tool says for each code (found by the gauntlet's generated cases, Nov 18 2026: a workflow run
// read "The records door refused the call." where the engine had said why).
const WORDS = {
  current_workspace_rights_refused: 'This tool may not reach those records.',
  original_input_refused: 'The records door refused the request as written.',
  original_workspace_source_unavailable: 'The person\'s records cannot be reached right now.',
  original_workspace_read_unavailable: 'The selected workspace returned a read answer this tool could not verify.',
  selected_owner_unavailable: 'The person\'s records stayed busy; try again shortly.',
  capability_gone: 'This run\'s records door has closed.',
  no_files: 'This run was not handed the person\'s files: its row declares no files right.',
  original_command_conflict: 'The records changed while this tool was running. Read them again before continuing.',
  write_pending: 'The write was kept, but the person\'s records have not settled it yet. Read them again before answering again.',
  refused: 'The records door refused the call.',
};

// How the engine answers `tools:run`, read in this one place: `run()` below hands its caller the answer's `result`, and
// throws `tool_run_failed` with the answer's `error` when it holds one; test/fake-door.mjs answers its nested runs from
// `finished` and `failed`, so no caller unwraps and no test types the answer in by hand. The shapes are the engine's
// own: trillion-rust src/tool_runs/tools/container.rs answers a finished run `{ tool, exit_code, result, replayed }` and
// one whose process failed `{ tool, exit_code, error, cause, replayed }`; http.rs `answered` the same with `status` in
// place of `exit_code`. `finished` has the keys of the answer the engine gave on 2026-11-14 for
// tool:see-what-is-left-to-set-up on a fresh scratch account. An answer with neither field (a session's state,
// sessions.rs; a run handed to another computer, `how`) is the run's answer itself.
export const TOOL_RUN_ANSWER = Object.freeze({
  result: 'result',
  error: 'error',
  finished: (tool, result) => ({ tool, exit_code: 0, result, replayed: false }),
  failed: (tool, error) => ({ tool, exit_code: 1, error, cause: 'process_exit_unsuccessful', replayed: false }),
});

export function resultOfRun(tool, answer) {
  if (answer && typeof answer === 'object' && Object.hasOwn(answer, TOOL_RUN_ANSWER.error)) {
    const said = answer[TOOL_RUN_ANSWER.error];
    throw Object.assign(new RecordsDoorError('tool_run_failed', `${tool} did not finish: ${String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 300)}`, 'committed'),
      { tool, cause: answer.cause ?? null, status: answer.status ?? null, said });
  }
  return answer && typeof answer === 'object' && Object.hasOwn(answer, TOOL_RUN_ANSWER.result) ? answer[TOOL_RUN_ANSWER.result] : answer;
}

const pause = ms => new Promise(done => setTimeout(done, ms));

export class RecordsDoorError extends Error {
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
  if (!data) throw new RecordsDoorError('no_answer', 'The records door sent an empty event stream.');
  return JSON.parse(data.slice(5).trim());
}

// The cause the door named in a refusal body, or a plain note when it named none. The capability itself is never read here.
async function refusedBy(response) {
  try { const cause = JSON.parse(await response.text()).cause; return typeof cause === 'string' && cause ? cause : 'no cause named'; }
  catch { return 'no readable cause'; }
}
function isTransportFailure(error) {
  if (!(error instanceof TypeError) && error?.name !== 'AbortError' && error?.name !== 'TimeoutError') return false;
  const code = error?.cause?.code;
  if (['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_PROTOCOL', 'ERR_INVALID_HEADER_VALUE', 'ERR_HTTP_INVALID_HEADER_VALUE'].includes(code)) return false;
  return !/failed to parse url|invalid url|invalid argument|invalid header/i.test(String(error?.message ?? ''));
}

// Descriptor and operator-config clients share this HTTP/retry owner. The caller
// owns any deadline; a retry never creates another budget.
export function openBearerCall({ url, resource, capability, fetchImpl = fetch,
  wait = (ms, callerSignal) => delay(ms, undefined, { signal: callerSignal }), signal, rejectCredentialInAnswer = false } = {}) {
  if (typeof url !== 'string' || typeof resource !== 'string' || typeof capability !== 'string') {
    throw new RecordsDoorError('no_door', 'This run was not handed a records door.');
  }

  const interrupted = outcome => Object.assign(
    new RecordsDoorError('transport_unavailable', 'The records door request was interrupted.', outcome),
    { callerInterrupted: true });
  const unavailable = (message, cause) => transportUnavailable(message, cause);
  const within = operation => {
    if (!signal) return Promise.resolve().then(operation);
    if (signal.aborted) return Promise.reject(interrupted('unknown'));
    return new Promise((resolve, reject) => {
      const aborted = () => reject(interrupted('unknown'));
      signal.addEventListener('abort', aborted, { once: true });
      const finish = handler => value => { signal.removeEventListener('abort', aborted); handler(value); };
      Promise.resolve().then(operation).then(finish(resolve), finish(reject));
    });
  };
  const pause = async milliseconds => {
    try { await within(() => wait(milliseconds, signal)); }
    catch (error) { if (signal?.aborted) throw interrupted('unknown'); throw error; }
  };

  // A record too big for one message comes as pages of its own bytes; the same call with the same request key and
  // after_byte reads on. The engine serves later pages only to the key that made the answer.
  const paged = pagedCall(callOnce);
  async function call(method, input, key = `${method}:${randomUUID()}`, address = resource, retryTransport = false) {
    // Hold the wire value before an await; later pages cannot pick up a caller's
    // concurrent edit under the original command's key.
    const captured = JSON.parse(JSON.stringify({ input }));
    const answer = await paged(method, captured.input, key, address, retryTransport);
    if (rejectCredentialInAnswer && capability && JSON.stringify(answer).includes(capability)) {
      throw new RecordsDoorError('key_in_answer', "The door's answer held the key; nothing of it is kept.", 'unknown');
    }
    return answer;
  }

  async function callOnce(method, input, key, address, retryTransport = false, retryBusy = true) {
    // Keep the existing boolean call interface for injected clients and byte-page consumers.
    const policy = retryTransport ? READ : EFFECT;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { address, method, request_key: requestKeyOf(key), input } } });
    if (signal?.aborted) throw interrupted('not_started');
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw interrupted('unknown');
      const again = retryBusy && attempt < BUSY_RETRIES;
      let response;
      try {
        response = await within(() => fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
          body,
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        if (signal?.aborted) throw interrupted('unknown');
        if (policy.retryAmbiguous && isTransportFailure(error) && again) { await pause(FIRST_WAIT_MS * 2 ** attempt); continue; }
        if (!policy.retryAmbiguous || isTransportFailure(error)) throw unavailable('The records door connection failed.', error);
        throw error;
      }
      if (!response.ok && response.status !== 401 && typeof response.body?.cancel === 'function') {
        // No error body is needed for the closed status result. Release its socket
        // before a safe read retries, bounded by the same caller signal. A 401 body names its cause and is read below.
        try { await within(() => response.body.cancel()); }
        catch (error) { if (signal?.aborted) throw interrupted('unknown'); }
      }
      // A door at its dispatch limit answers 503: asked again after a jittered wait, so clients that were refused together do
      // not retry together. A throttled call (429) began nothing and is asked again more times.
      if (response.status === 503 && again) { await pause(throttledWait(response.headers?.get?.('retry-after'), attempt)); continue; }
      if (response.status === 429 && retryBusy && attempt < RATE_RETRIES) { await pause(throttledWait(response.headers?.get?.('retry-after'), attempt)); continue; }
      // The door names the check that refused the run (its cause, in the 401 body), so the run can say which one.
      if (response.status === 401) throw new RecordsDoorError('capability_gone', `${WORDS.capability_gone} Refused by: ${await refusedBy(response)}`);
      if (!response.ok) throw new RecordsDoorError(`http_${response.status}`, `The records door answered ${response.status}.`, 'unknown');
      let text;
      try { text = await within(() => response.text()); }
      catch (error) {
        if (signal?.aborted) throw interrupted('unknown');
        if (policy.retryAmbiguous && isTransportFailure(error) && again) { await pause(FIRST_WAIT_MS * 2 ** attempt); continue; }
        if (!policy.retryAmbiguous || isTransportFailure(error)) throw unavailable('The records door response could not be read.', error);
        throw error;
      }
      if (rejectCredentialInAnswer && capability && text.includes(capability)) {
        throw new RecordsDoorError('key_in_answer', "The door's answer held the key; nothing of it is kept.", 'unknown');
      }
      let answer;
      try { answer = answerOf(text, response.headers.get('content-type')); }
      catch (error) {
        if (!policy.retryAmbiguous) throw new RecordsDoorError('invalid_answer', 'The records door returned an invalid answer.', 'unknown');
        throw error;
      }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        throw new RecordsDoorError('invalid_answer', 'The records door returned an invalid answer.', 'unknown');
      }
      if (answer.error) throw new RecordsDoorError('rpc_error', WORDS.refused, 'unknown');
      const result = answer.result;
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'structuredContent')) {
        throw new RecordsDoorError('invalid_answer', 'The records door returned an invalid answer.', 'unknown');
      }
      if (!result.isError) return result.structuredContent;
      const { code = 'refused', outcome, detail } = result.structuredContent ?? {};
      // A busy owner, or a call whose effect is unknown, is sent again with the same request key, never a new one. The
      // engine answers a write that found its record store busy as the source unavailable, with nothing begun.
      const busy = code === 'selected_owner_unavailable' || (code === 'original_workspace_source_unavailable' && outcome === 'not_started');
      if ((busy || outcome === 'unknown') && again) {
        await pause(FIRST_WAIT_MS * 2 ** attempt); continue;
      }
      // Missing/malformed outcome metadata never proves an effect did not start.
      const knownOutcome = outcome === 'not_started' || outcome === 'unknown' ? outcome : 'unknown';
      // A busy account that is still busy after the door's own retries is retryable: the caller may ask later under its own key.
      const said = typeof detail === 'string' && detail.trim() ? detail : (WORDS[code] ?? WORDS.refused);
      throw Object.assign(new RecordsDoorError(code, said, knownOutcome), { retryable: busy });
    }
  }

  return { call, callOnce };
}

const OWN_RECORDS = '@own-records';

// What a run is told when its door's descriptor holds no door: the engine mounts one only for a row's invoke.records or the
// rights of its top-level stored list (trillion-rust container.rs records_of), so a row that names neither, or keeps its stored
// list under invoke, gets nothing there and a bare read answered "EINVAL: invalid argument, read" (tool:read-published-clips,
// Nov 24-25 2026).
const NO_DOOR = descriptor => `No run door is on descriptor ${descriptor}: the engine hands one only for the row's invoke.records or the rights of its top-level stored list, and this row's run was given neither.`;

/** The door descriptor's JSON line, or the NO_DOOR refusal when nothing readable is there. */
function doorLine(descriptor) {
  let text;
  try {
    text = readFileSync(descriptor, 'utf8');
  } catch (error) {
    throw new Error(`${NO_DOOR(descriptor)} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${NO_DOOR(descriptor)} (it holds no door line)`);
  }
}

export function openBearerDoor({ descriptor = 3, ...options } = {}) {
  const { url, resource = OWN_RECORDS, capability, files_resource: filesResource, tools_resource: toolsResource,
    computer_actions: computerActions, protected_actions: protectedActions } = doorLine(descriptor);
  return { ...openBearerCall({ ...options, url, resource, capability }),
    url, capability, filesResource, resource, toolsResource, computerActions, protectedActions };
}

export function openRecordsDoor(options = {}) {
  const { call, url, capability, filesResource, resource, toolsResource } = openBearerDoor(options);
  return withLargeFiles(call, { url, capability, filesResource, resource, toolsResource, fetchImpl: options.fetchImpl ?? fetch, wait: options.wait ?? pause });
}

// The same door for a program that holds the person's own key and the account's address instead of a run's descriptor
// (the Trillion helper on their computer): { url, resource, capability } as the descriptor carries them.
export function openRecordsDoorAt({ url, resource, capability, filesResource, toolsResource, fetchImpl = fetch, wait = pause } = {}) {
  const { call } = openBearerCall({ url, resource, capability, fetchImpl, wait });
  return withLargeFiles(call, { url, capability, filesResource, resource, toolsResource, fetchImpl, wait });
}

// A file above the piece bound is kept in raw pieces through this door's own files right (writeLargeFile below).
function withLargeFiles(call, { url, capability, filesResource, resource, toolsResource, fetchImpl, wait }) {
  // The door keeps its read-only `resource`: writeLarge is added to it, never spread into a copy.
  return Object.assign(recordsDoorFromCall(call, { filesResource, resource, toolsResource, wait }), {
    writeLarge: (name, source, options) => writeLargeFile({ url, capability, filesResource, toolsResource, fetchImpl }, name, source, options),
  });
}

// The wait before a throttled call is sent again: the door's Retry-After (in seconds) when it gives one, else the backoff;
// then a random half-to-whole of that, so calls from several lanes do not return together.
export function throttledWait(retryAfter, attempt) {
  const hinted = Number(retryAfter) * 1000;
  const base = Number.isFinite(hinted) && hinted > 0 ? hinted : FIRST_WAIT_MS * 2 ** attempt;
  return Math.min(base, MAX_WAIT_MS) * (0.5 + Math.random() / 2);
}

// A file above the piece bound, kept in raw pieces through this run's own files right (read-data/raw-pieces.mjs): the
// Files tool's write_file_start, each piece as a raw octet-stream body, then write_file_finish, all at the door's url with
// the run's capability as the bearer. Until Nov 20 2026 this was a lease road (/namespace/leases) the engine no longer serves.
export async function writeLargeFile({ url, capability, filesResource, toolsResource, fetchImpl }, name, source, { mediaType = null, uploadId } = {}) {
  return keepInRawPieces({ url, capability, filesTool: filesResource, toolsAddress: toolsResource, fetchImpl }, name, source,
    { mediaType: mediaType ?? undefined, ...(uploadId ? { uploadId } : {}) });
}

// The record store can answer a record as its stored body, { kind, sequence, stored, meta, protected }, with the value kept as JSON
// text in `stored`, where a caller expects the value itself (a decision root read this way looks unanswered, with no lists).
// Every read and list row passes through here, so a tool sees the value however the store answered; only a body with exactly
// those five fields and a `stored` text that parses is unwrapped, and anything else is returned as it came.
const STORED_BODY = ['kind', 'meta', 'protected', 'sequence', 'stored'];
export function recordValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const names = Object.keys(value).sort();
  if (names.length !== STORED_BODY.length || names.some((name, at) => name !== STORED_BODY[at]) || typeof value.stored !== 'string') return value;
  try { return JSON.parse(value.stored); } catch { return value; }
}

// One native admitted request may hand its exact installed controller this
// additional route on the SAME capability descriptor. Route words confer no
// authority: the native live entry must hold the retained typed parent owner.
// Values received by native intake are represented only by opaque handles.
export function openProtectedActions(options) {
  const { call, callOnce, filesResource, resource, toolsResource, protectedActions } = openBearerDoor(options);
  if (!protectedActions || typeof protectedActions.resource !== 'string' || !protectedActions.resource
    || typeof protectedActions.operation !== 'string' || !protectedActions.operation
    || typeof protectedActions.request_key !== 'string' || !protectedActions.request_key) {
    throw new RecordsDoorError('no_protected_actions', 'This run was not handed native protected actions.', 'not_started');
  }
  return {
    records: recordsDoorFromCall(call, { filesResource, resource, toolsResource }),
    requestKey: protectedActions.request_key,
    async call(method, input, key) {
      if (typeof method !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(method)
        || !input || typeof input !== 'object' || Array.isArray(input) || typeof key !== 'string' || !key) {
        throw new RecordsDoorError('original_input_refused', WORDS.original_input_refused, 'not_started');
      }
      // Never retry a protected effect after busy, unknown, fetch failure or
      // malformed response. Recovery is an explicit original-owner operation.
      return callOnce(protectedActions.operation, { method, input }, key, protectedActions.resource, false, false);
    },
  };
}

// Shared record operations for a bearer door or an operator's authenticated MCP client.
const WORKSHOP_TOOLS = '@tools';
const SECRETS = '@secrets';

export function recordsDoorFromCall(call, { filesResource, resource, toolsResource = WORKSHOP_TOOLS, wait = pause } = {}) {
  async function readRecord(type, id) {
    const record = await call('records:read', { id, type }, undefined, resource, true);
    return record.value === null || record.value === undefined ? null : {
      type: record.type, value: recordValue(record.value),
      ...(typeof record.identity === 'string' && record.identity.length ? { identity: record.identity } : {}),
    };
  }

  // The selected workspace has its own source and admission owner, reached through the same run bearer at this door.
  // Keep this operation explicit: every call must name a nonempty set of exact labels, with no prefix or whole-view
  // fallback. The server's content is JSON text inside its established HTTP result envelope.
  async function readWorkspace(labels) {
    if (!Array.isArray(labels) || labels.length < 1 || labels.length > 64
      || labels.some(label => typeof label !== 'string' || !label || label.length > 300)
      || new Set(labels).size !== labels.length) {
      throw new RecordsDoorError('original_input_refused', WORDS.original_input_refused, 'not_started');
    }
    const answer = await call('workspace:read', { selection: { labels, prefixes: [] } }, undefined, resource, true);
    if (!answer || answer.status !== 200 || typeof answer.content_type !== 'string'
      || !/^application\/json(?:\s*;|$)/i.test(answer.content_type) || typeof answer.text !== 'string') {
      throw new RecordsDoorError('original_workspace_read_unavailable', 'The selected workspace returned an invalid read answer.', 'unknown');
    }
    let body;
    try { body = JSON.parse(answer.text); }
    catch { throw new RecordsDoorError('original_workspace_read_unavailable', 'The selected workspace returned invalid JSON.', 'unknown'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.records
      || typeof body.records !== 'object' || Array.isArray(body.records)
      || Object.keys(body.records).some(label => !labels.includes(label))) {
      throw new RecordsDoorError('original_workspace_read_unavailable', 'The selected workspace returned an invalid record set.', 'unknown');
    }
    return body;
  }

  // Every page the query names, in the door's order: { records, next }, next null on the last page. One page is one door
  // call, so a caller that must count or stop on calls (read-data/read-many.mjs) reads pages. A short page that names a
  // next page is not the end.
  async function* listPages({ type, order, prefix, above, below, reverse, fields, where, limit = PAGE } = {}) {
    const query = Object.fromEntries(Object.entries({ type, order, prefix, above, below, reverse, fields, where, limit }).filter(([, value]) => value !== undefined));
    for (let after; ;) {
      const page = await call('records:list', after === undefined ? query : { ...query, after }, undefined, resource, true);
      const next = page.next === null || page.next === undefined ? null : page.next;
      yield { records: page.records.map(record => ({ ...record, value: recordValue(record.value) })), next };
      if (next === null) return;
      after = next;
    }
  }

  return {
    // The runner's selected resource is metadata, never an authority supplied by tool input.
    get resource() { return resource; },
    readRecord,
    readWorkspace,
    async read(type, id) {
      return (await readRecord(type, id))?.value ?? null;
    },
    listPages,
    // Every record the query names, in the door's order.
    async *list(query = {}) {
      for await (const page of listPages(query)) yield* page.records;
    },
    // Native completes the whole query and keeps its witness in this run. The
    // returned reference is opaque: the client never constructs or interprets
    // it, and a partial/older list answer cannot stand in for a snapshot.
    async snapshot(query = {}) {
      const fields = new Set(['type', 'order', 'prefix', 'above', 'below', 'reverse', 'fields', 'where', 'limit']);
      if (!query || typeof query !== 'object' || Array.isArray(query)
        || Object.keys(query).some(field => !fields.has(field))) {
        throw new RecordsDoorError('original_input_refused', WORDS.original_input_refused, 'not_started');
      }
      const answer = await call('records:list', { ...query, snapshot: true }, undefined, resource, true);
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)
        || Object.keys(answer).some(field => !['records', 'next', 'query'].includes(field))
        || !Array.isArray(answer.records) || answer.next !== null
        || typeof answer.query !== 'string' || answer.query.length === 0) {
        throw new RecordsDoorError('original_workspace_read_unavailable', WORDS.original_workspace_read_unavailable, 'unknown');
      }
      return { records: answer.records, query: answer.query };
    },
    // One question over the records (records:search { question, type?, limit? }): { question, terms, results, unavailable,
    // pending }, each result with its score and the address that reads it. A run reaches only the kind its right names.
    async search(input) {
      return call('records:search', input, undefined, resource, true);
    },
    // `key` makes the write safe to send again: the same key answers the receipt it already saved, and a write the door
    // keeps pending is asked again under that key until it settles. Keep `key` with the original body for explicit result
    // recovery. An ambiguous answer never repeats this effect under a new key.
    async write(records, { key = `records:write:${randomUUID()}`, queries } = {}) {
      if (queries !== undefined && (!Array.isArray(queries)
        || Array.from(queries).some(query => typeof query !== 'string' || query.length === 0))) {
        throw new RecordsDoorError('original_input_refused', WORDS.original_input_refused, 'not_started');
      }
      return settledWrite(answerKey => call('records:write', { records, ...(queries === undefined ? {} : { queries }) }, answerKey), key, {
        sleep: wait,
        expired: () => new RecordsDoorError('write_pending', WORDS.write_pending, 'unknown'),
      });
    },
    // Read the protected receipt of one original write; this never executes that command. Its original key and
    // body remain inside `original`; `key` is only this read's delivery identity. Native admission independently
    // checks the original operation's current rights, source and retained result before disclosing its bytes.
    async result(original, { key } = {}) {
      return call('records:result', original, key, resource, true);
    },
    // One or more of the person's workspace labels written whole (`workspace:write { writes: [{ address_label, payload }] }`),
    // for a row that declares `{ kind: "@own-records", id: "<label>", operations: ["workspace:write"] }` per label. `key` makes it
    // safe to send again: the same key answers the write it already made. A conflict keeps both versions (policy preserve).
    async writeWorkspace(writes, { key = `workspace:write:${randomUUID()}` } = {}) {
      if (!Array.isArray(writes) || writes.length < 1 || writes.length > 64
        || writes.some(write => !write || typeof write.address_label !== 'string' || !write.address_label || write.address_label.length > 300 || !('payload' in write))
        || new Set(writes.map(write => write.address_label)).size !== writes.length) {
        throw new RecordsDoorError('original_input_refused', WORDS.original_input_refused, 'not_started');
      }
      return call('workspace:write', { writes, conflict_policy: 'preserve' }, key, resource);
    },
    // One operation on the person's run grants at this door's resource (trillion-rust src/account_rights/share-grant.json
    // `act`: its keep and list operations, the input each takes), for a row that declares `{ grant: "<label>", operations }`;
    // the engine narrows each call to that one label. `key` makes a keep safe to send again.
    async sharing(method, input, { key } = {}) {
      return call(method, input, key, resource);
    },
    // One operation the run's door answers by its method (a workflow step's door ask, such as wake:arrive), for a right
    // the row declares; the engine finds the method's owner and holds the call to the run's rights. `at` is the address the
    // right names when it is not this door's own (`toolsAddress` for the Workshop's: an install of a source by its label).
    async operation(method, input, { key, at = resource } = {}) {
      return call(method, input, key, at);
    },
    // The Workshop's own address (the descriptor's `tools_resource`, else @tools), for `operation`'s `at`.
    toolsAddress: toolsResource,
    // One operation on the person's Namespace files (list_files, read_file, find_file ...), at the files resource the run
    // was handed when its row declares a `files` right; a run handed none is refused before anything is sent.
    async files(method, input, { key } = {}) {
      if (typeof filesResource !== 'string') throw new RecordsDoorError('no_files', WORDS.no_files);
      return call(method, input, key, filesResource);
    },
    // One operation at the person's vault, for a key the row names in its rights ({ at: "@secrets", id: <name>,
    // operations: ["secrets:sign"] }): the vault answers what it made with the key (a signature), never the key.
    async secrets(method, input, { key } = {}) {
      return call(method, input, key, SECRETS);
    },
    // Another Workshop tool's run (the brief's contract A): `tools:run` { tool, input } at the Workshop's address, for a
    // tool id the row declares in `runs`. The engine holds it to this run's grant and deadline and derives its
    // idempotency key from this run's; `key` names it within this run, so the same nested run sent again is one run.
    // Answers the run's result (resultOfRun above), and throws `tool_run_failed` for a run that failed.
    async run(tool, input = {}, { key } = {}) {
      return resultOfRun(tool, await call('tools:run', { tool, input }, key, toolsResource));
    },
  };
}
