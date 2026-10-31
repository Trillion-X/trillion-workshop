// tools/records-door/read-data/records-door.mjs
//
// The client a Workshop tool uses to reach the person's own records through the door its run was handed. A row that
// declares `invoke.records: { fd, rights: [{ kind, operations }] }` gets, on that descriptor, one JSON line
// { url, resource, capability }. Every call is one `run_resource_operation` at that resource, sent to the door's
// loopback address with the capability as its bearer. The capability is never printed, logged or returned.
//
//   const door = openRecordsDoor();                       reads descriptor 3
//   await door.read('post', 'post:abc')                   -> the value, or null
//   for await (const record of door.list({ type: 'post' })) ...   every record of a kind, page after page
//   await door.write([{ id, type, value }], { key })      -> { changed, write_count }; value null removes
//   await door.files('list_files', { folder: '/notes/' })   -> the files door's answer, at `files_resource`, which the
//                                                          descriptor holds when the row declares a `files` right
//
// A busy account (503, or selected_owner_unavailable) and a call whose outcome is unknown are sent again with the same
// request key after a growing wait. A refusal comes back as RecordsDoorError with the door's code and outcome.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-06-18';
const BUSY_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const PAGE = 999;

// The door answers a refusal with a code and no words; these are the words a tool says for each.
const WORDS = {
  current_workspace_rights_refused: 'This tool may not reach those records.',
  original_input_refused: 'The records door refused the request as written.',
  original_workspace_source_unavailable: 'The person\'s records cannot be reached right now.',
  selected_owner_unavailable: 'The person\'s records stayed busy; try again shortly.',
  capability_gone: 'This run\'s records door has closed.',
  no_files: 'This run was not handed the person\'s files: its row declares no files right.',
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

export function openRecordsDoor({ descriptor = 3, fetchImpl = fetch, wait = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const { url, resource, capability, files_resource: filesResource } = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (typeof url !== 'string' || typeof resource !== 'string' || typeof capability !== 'string') {
    throw new RecordsDoorError('no_door', 'This run was not handed a records door.');
  }

  async function call(method, input, key = `${method}:${randomUUID()}`, address = resource) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_resource_operation', arguments: { address, method, request_key: key, input } } });
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
        body,
      });
      const again = attempt < BUSY_RETRIES;
      if (response.status === 503 && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      if (response.status === 401) throw new RecordsDoorError('capability_gone', WORDS.capability_gone);
      if (!response.ok) throw new RecordsDoorError(`http_${response.status}`, `The records door answered ${response.status}.`);
      const answer = answerOf(await response.text(), response.headers.get('content-type'));
      if (answer.error) throw new RecordsDoorError('rpc_error', String(answer.error.message ?? WORDS.refused));
      const result = answer.result ?? {};
      if (!result.isError) return result.structuredContent;
      const { code = 'refused', outcome } = result.structuredContent ?? {};
      // A busy owner, or a call whose effect is unknown, is sent again with the same request key, never a new one.
      if ((code === 'selected_owner_unavailable' || outcome === 'unknown') && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      throw new RecordsDoorError(code, WORDS[code] ?? WORDS.refused, outcome);
    }
  }

  return {
    async read(type, id) {
      return (await call('records:read', { id, type })).value ?? null;
    },
    // Every record the query names, in the door's order. A short page that names a next page is not the end.
    async *list({ type, order, prefix, above, below, reverse, limit = PAGE } = {}) {
      const query = Object.fromEntries(Object.entries({ type, order, prefix, above, below, reverse, limit }).filter(([, value]) => value !== undefined));
      for (let after; ;) {
        const page = await call('records:list', after === undefined ? query : { ...query, after });
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
