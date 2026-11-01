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
//   await door.write([{ id, type, value, expected? }], { key }) -> receipt; value null removes, expected checks prior
//   await door.files('list_files', { folder: '/notes/' })   -> the files door's answer, at `files_resource`, which the
//                                                          descriptor holds when the row declares a `files` right
//
// A busy account (503, or selected_owner_unavailable) and a call whose outcome is unknown are sent again with the same
// request key after a growing wait. Safe reads also retry fetch/body transport failures; writes do not. A refusal comes
// back as RecordsDoorError with the door's code and outcome. Large answers use byte pages (read-data/byte-pages.mjs).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { wholeAnswer } from './byte-pages.mjs';

const PROTOCOL = '2025-06-18';
const BUSY_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const PAGE = 999;

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

export function openRecordsDoor({ descriptor = 3, fetchImpl = fetch, wait = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const { url, resource, capability, files_resource: filesResource } = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (typeof url !== 'string' || typeof resource !== 'string' || typeof capability !== 'string') {
    throw new RecordsDoorError('no_door', 'This run was not handed a records door.');
  }

  // A record too big for one message comes as pages of its own bytes; the same call with after_byte reads on.
  async function call(method, input, key = `${method}:${randomUUID()}`, address = resource, retryTransport = false) {
    return wholeAnswer(await callOnce(method, input, key, address, retryTransport), after => callOnce(method, { ...input, after_byte: after }, `${method}:${randomUUID()}`, address, retryTransport));
  }

  async function callOnce(method, input, key, address, retryTransport = false) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_resource_operation', arguments: { address, method, request_key: key, input } } });
    for (let attempt = 0; ; attempt += 1) {
      const again = attempt < BUSY_RETRIES;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
          body,
        });
      } catch (error) {
        if (retryTransport && isTransportFailure(error) && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
        if (retryTransport && isTransportFailure(error)) throw new RecordsDoorError('transport_unavailable', 'The records door connection failed after repeated attempts.');
        throw error;
      }
      if (response.status === 503 && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      if (response.status === 401) throw new RecordsDoorError('capability_gone', WORDS.capability_gone);
      if (!response.ok) throw new RecordsDoorError(`http_${response.status}`, `The records door answered ${response.status}.`);
      let text;
      try { text = await response.text(); }
      catch (error) {
        if (retryTransport && isTransportFailure(error) && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
        if (retryTransport && isTransportFailure(error)) throw new RecordsDoorError('transport_unavailable', 'The records door response could not be read after repeated attempts.');
        throw error;
      }
      const answer = answerOf(text, response.headers.get('content-type'));
      if (answer.error) throw new RecordsDoorError('rpc_error', String(answer.error.message ?? WORDS.refused));
      const result = answer.result ?? {};
      if (!result.isError) return result.structuredContent;
      const { code = 'refused', outcome } = result.structuredContent ?? {};
      // A busy owner, or a call whose effect is unknown, is sent again with the same request key, never a new one.
      if ((code === 'selected_owner_unavailable' || outcome === 'unknown') && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      throw new RecordsDoorError(code, WORDS[code] ?? WORDS.refused, outcome);
    }
  }

  return recordsDoorFromCall(call, { filesResource, resource });
}

// Shared record operations for a bearer door or an operator's authenticated MCP client.
export function recordsDoorFromCall(call, { filesResource, resource } = {}) {
  async function readRecord(type, id) {
    const record = await call('records:read', { id, type }, undefined, resource, true);
    return record.value === null || record.value === undefined ? null : { type: record.type, value: record.value };
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
    // `key` makes the write safe to send again: the same key answers the receipt it already saved.
    async write(records, { key } = {}) {
      return call('records:write', { records }, key);
    },
    // One operation on the person's Namespace files (list_files, read_file, find_file ...), at the files resource the run
    // was handed when its row declares a `files` right; a run handed none is refused before anything is sent.
    async files(method, input) {
      if (typeof filesResource !== 'string') throw new RecordsDoorError('no_files', WORDS.no_files);
      return call(method, input, undefined, filesResource);
    },
  };
}
