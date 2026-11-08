// tools/records-door/read-data/records-door.mjs
//
// The client a Workshop tool uses to reach the person's own records through the door its run was handed. A row that
// declares `invoke.records: { fd, rights: [{ kind, operations }] }` gets, on that descriptor, one JSON line
// { url, resource, capability }. Every call is one `run_resource_operation` at that resource, sent to the door's
// loopback address with the capability as its bearer. The capability is never printed, logged or returned.
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
//   await door.run('tool:x', { ... }, { key })              -> another Workshop tool's run (`tools:run` at the Workshop's
//                                                          address, `tools_resource`, else @workshop-tools), only for a
//                                                          tool id the row declares in `runs`; the engine refuses others
//
// A read may retry a busy or interrupted answer with the same request key. An effect may retry only an explicit
// selected_owner_unavailable/not_started refusal; an unknown outcome, HTTP 503 or broken transport never proves
// that an effect did not happen. result() reconciles records:write only, with its exact original command;
// file effects require their own admitted result owner and remain unknown until that owner proves the outcome. A refusal comes
// back as RecordsDoorError with the door's code and outcome. Large answers use byte pages (read-data/byte-pages.mjs).
// openParentActions({ descriptor: 3 }) uses the same transport for a native run's declared computer_actions route;
// its trashSource({ path, expected_generation }) makes one attempt and never retries or reads byte pages.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pagedCall } from './byte-pages.mjs';

const PROTOCOL = '2025-06-18';
const BUSY_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const PAGE = 999;
// The calling method selects its semantics. Do not infer safety from an operation's spelling or an HTTP status.
const READ = Object.freeze({ retryAmbiguous: true });
const EFFECT = Object.freeze({ retryAmbiguous: false });
const TRANSPORT_FAILURES = new WeakSet();

/** Only this transport's observed network failures, never a server-supplied code or caller cancellation. */
export function isRecordsDoorTransportFailure(error) {
  return error !== null && typeof error === 'object' && TRANSPORT_FAILURES.has(error);
}

// The door answers a refusal with a code and no words; these are the words a tool says for each.
const WORDS = {
  current_workspace_rights_refused: 'This tool may not reach those records.',
  original_input_refused: 'The records door refused the request as written.',
  original_workspace_source_unavailable: 'The person\'s records cannot be reached right now.',
  original_workspace_read_unavailable: 'The selected workspace returned a read answer this tool could not verify.',
  selected_owner_unavailable: 'The person\'s records stayed busy; try again shortly.',
  capability_gone: 'This run\'s records door has closed.',
  no_files: 'This run was not handed the person\'s files: its row declares no files right.',
  original_command_conflict: 'The records changed while this tool was running. Read them again before continuing.',
  refused: 'The records door refused the call.',
};

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
  const unavailable = (message, cause) => {
    const error = new RecordsDoorError('transport_unavailable', message, 'unknown');
    if (isTransportFailure(cause)) TRANSPORT_FAILURES.add(error);
    return error;
  };
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
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_resource_operation', arguments: { address, method, request_key: key, input } } });
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
      if (!response.ok && typeof response.body?.cancel === 'function') {
        // No error body is needed for the closed status result. Release its socket
        // before a safe read retries, bounded by the same caller signal.
        try { await within(() => response.body.cancel()); }
        catch (error) { if (signal?.aborted) throw interrupted('unknown'); }
      }
      if (response.status === 503 && policy.retryAmbiguous && again) { await pause(FIRST_WAIT_MS * 2 ** attempt); continue; }
      if (response.status === 401) throw new RecordsDoorError('capability_gone', WORDS.capability_gone);
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
      const { code = 'refused', outcome } = result.structuredContent ?? {};
      const notStartedBusy = code === 'selected_owner_unavailable' && outcome === 'not_started';
      if ((notStartedBusy || (policy.retryAmbiguous && (code === 'selected_owner_unavailable' || outcome === 'unknown'))) && again) {
        await pause(FIRST_WAIT_MS * 2 ** attempt); continue;
      }
      // Missing/malformed outcome metadata never proves an effect did not start.
      const knownOutcome = outcome === 'not_started' || outcome === 'unknown' ? outcome : 'unknown';
      throw new RecordsDoorError(code, WORDS[code] ?? WORDS.refused, knownOutcome);
    }
  }

  return { call, callOnce };
}

function openBearerDoor({ descriptor = 3, ...options } = {}) {
  const { url, resource, capability, files_resource: filesResource, tools_resource: toolsResource,
    computer_actions: computerActions, protected_actions: protectedActions } = JSON.parse(readFileSync(descriptor, 'utf8'));
  return { ...openBearerCall({ ...options, url, resource, capability }),
    filesResource, resource, toolsResource, computerActions, protectedActions };
}

export function openRecordsDoor(options) {
  const { call, filesResource, resource, toolsResource } = openBearerDoor(options);
  return recordsDoorFromCall(call, { filesResource, resource, toolsResource });
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

// The native runner hands this route through the same private pipe as a records door. Route metadata is not
// authority: the parent independently checks this exact live run and its current folder grant at the effect.
// Physical actions never use byte pages or any busy, unknown, fetch or response-body retry policy.
export function openParentActions(options) {
  let door;
  try { door = openBearerDoor(options); }
  catch { throw new RecordsDoorError('no_parent_actions', 'This run was not handed native parent actions.', 'not_started'); }
  const { callOnce, computerActions } = door;
  if (typeof computerActions?.resource !== 'string' || !computerActions.resource
    || typeof computerActions.trash_source !== 'string' || !computerActions.trash_source) {
    throw new RecordsDoorError('no_parent_actions', 'This run was not handed native parent actions.', 'not_started');
  }
  return {
    async trashSource(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'path') || !Object.hasOwn(input, 'expected_generation')
        || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.includes('\0')
        || Buffer.byteLength(input.path) > 4096 || typeof input.expected_generation !== 'string'
        || !input.expected_generation || Buffer.byteLength(input.expected_generation) > 16 * 1024 * 1024) {
        throw new RecordsDoorError('original_input_refused', 'Supply only an absolute path and its exact generation observation.', 'not_started');
      }
      try {
        const answer = await callOnce(computerActions.trash_source, input,
          `trash-source:${randomUUID()}`, computerActions.resource, false, false);
        if (answer?.outcome === 'moved') return { outcome: 'moved' };
      } catch (error) {
        if (error instanceof RecordsDoorError && error.outcome === 'not_started'
          && ['computer_action_refused', 'current_workspace_rights_refused', 'original_input_refused'].includes(error.code)) {
          throw new RecordsDoorError(error.code, 'The native parent refused the Trash move.', 'not_started');
        }
        if (error instanceof RecordsDoorError && error.code === 'capability_gone') {
          throw new RecordsDoorError('capability_gone', 'This run\'s native parent has closed.', 'not_started');
        }
      }
      // A missing, malformed or lost answer cannot establish that the effect did not happen. Never echo a
      // transport/RPC error: it can contain private descriptor bytes. The caller must stop without retrying.
      throw new RecordsDoorError('computer_action_unknown', 'The Trash move outcome is unknown. Stop without retrying.', 'unknown');
    },
  };
}

// Shared record operations for a bearer door or an operator's authenticated MCP client.
const WORKSHOP_TOOLS = '@workshop-tools';

export function recordsDoorFromCall(call, { filesResource, resource, toolsResource = WORKSHOP_TOOLS } = {}) {
  async function readRecord(type, id) {
    const record = await call('records:read', { id, type }, undefined, resource, true);
    return record.value === null || record.value === undefined ? null : {
      type: record.type, value: record.value,
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

  return {
    // The runner's selected resource is metadata, never an authority supplied by tool input.
    get resource() { return resource; },
    readRecord,
    readWorkspace,
    async read(type, id) {
      return (await readRecord(type, id))?.value ?? null;
    },
    // Every record the query names, in the door's order. A short page that names a next page is not the end.
    async *list({ type, order, prefix, above, below, reverse, fields, where, limit = PAGE } = {}) {
      const query = Object.fromEntries(Object.entries({ type, order, prefix, above, below, reverse, fields, where, limit }).filter(([, value]) => value !== undefined));
      for (let after; ;) {
        const page = await call('records:list', after === undefined ? query : { ...query, after }, undefined, resource, true);
        yield* page.records;
        if (page.next === null || page.next === undefined) return;
        after = page.next;
      }
    },
    // One question over the records (records:search { question, type?, limit? }): { question, terms, results, unavailable,
    // pending }, each result with its score and the address that reads it. A run reaches only the kind its right names.
    async search(input) {
      return call('records:search', input, undefined, resource, true);
    },
    // Keep `key` with the original body for explicit result recovery. An ambiguous answer never repeats this effect.
    async write(records, { key } = {}) {
      return call('records:write', { records }, key);
    },
    // Read the protected receipt of one original write; this never executes that command. Its original key and
    // body remain inside `original`; `key` is only this read's delivery identity. Native admission independently
    // checks the original operation's current rights, source and retained result before disclosing its bytes.
    async result(original, { key } = {}) {
      return call('records:result', original, key, resource, true);
    },
    // One operation on the person's Namespace files (list_files, read_file, find_file ...), at the files resource the run
    // was handed when its row declares a `files` right; a run handed none is refused before anything is sent.
    async files(method, input, { key } = {}) {
      if (typeof filesResource !== 'string') throw new RecordsDoorError('no_files', WORDS.no_files);
      return call(method, input, key, filesResource);
    },
    // Another Workshop tool's run (the brief's contract A): `tools:run` { tool, input } at the Workshop's address, for a
    // tool id the row declares in `runs`. The engine holds it to this run's grant and deadline and derives its
    // idempotency key from this run's; `key` names it within this run, so the same nested run sent again is one run.
    async run(tool, input = {}, { key } = {}) {
      return call('tools:run', { tool, input }, key, toolsResource);
    },
  };
}
