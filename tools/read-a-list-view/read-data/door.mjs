// tools/read-a-list-view/read-data/door.mjs
//
// Purpose: the person's own door, as readListView and refreshRowSources use it (read, list, run, write, filter),
// reached from their own computer: one JSON-RPC `tools/call` of `run_resource_operation` per operation, POSTed to the
// door's MCP address with the person's key as the Bearer token. The same transport as tools/export-records-as-list-rows' record_write_send.py.
//
// Non-Negotiable Invariants:
//   1. The config names the key's keychain item, never the key. The key is read with the computer's `security`
//      program when the door is opened, kept in memory, sent only in the Authorization header to the configured
//      address, and never written, logged or printed. An answer that holds it is refused and nothing of it is kept.
//   2. No address, operation or record kind is named here: the config's `records` ({ address, read_method,
//      list_method, write_method? }), `tools` ({ address, run_method }) and `filter` ({ tool }, the rule-filter tool) are.
//   3. A refusal comes back as an Error with the door's code; a run whose tool failed is an Error with the tool's words.
//   4. A call is sent again only with its own request key (the records door's contract, tools/records-door README).
//
//   openDoor({ transport: { url, credential: { keychain_item } }, records, tools, filter? }, { keyOf? }) → { read, list, run, write, filter }
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-06-18';
const BUSY_RETRIES = 5;
const FIRST_WAIT_MS = 200;
const wait = ms => new Promise(done => setTimeout(done, ms));
const say = (code, words) => Object.assign(new Error(words), { code });

/** The key a credential handle names: { keychain_item } is read with the computer's `security` program. */
export async function keychainKey(handle) {
  const item = handle?.keychain_item;
  if (typeof item !== 'string' || !item) throw say('bad_config', 'The credential handle is { "keychain_item": "<name>" }.');
  const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-s', item, '-w']).catch(() => ({ stdout: '' }));
  const key = stdout.trim();
  if (!key) throw say('bad_config', `No key is kept under the keychain item ${item}.`);
  return key;
}

// The JSON-RPC reply in a door's answer: the body, or the last `data:` line of a streamed answer.
function replyOf(text, contentType) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text);
  const line = text.split('\n').reverse().find(one => one.startsWith('data:'));
  return JSON.parse(line ? line.slice(5).trim() : '');
}

export async function openDoor(config, { keyOf = keychainKey } = {}) {
  const { transport, records, tools, filter } = config ?? {};
  if (!transport?.url?.startsWith('http') || !records?.address || !records.read_method || !records.list_method || !tools?.address || !tools.run_method) {
    throw say('bad_config', 'The door config is { transport: { url, credential }, records: { address, read_method, list_method }, tools: { address, run_method } }.');
  }
  const key = await keyOf(transport.credential);
  let step = 0;
  // A busy door (HTTP 503 or selected_owner_unavailable) and a call whose outcome is unknown are sent again with the
  // same request key after a growing wait, never a new key, so a call that did happen answers its first answer.
  const call = async (address, method, input, request_key = `read-a-list-view-${randomUUID()}`) => {
    for (let attempt = 0; ; attempt += 1) {
      step += 1;
      const again = attempt < BUSY_RETRIES;
      const body = JSON.stringify({ jsonrpc: '2.0', id: step, method: 'tools/call',
        params: { name: 'run_resource_operation', arguments: { address, method, request_key, input } } });
      const response = await fetch(transport.url, { method: 'POST', body, headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL } });
      const text = await response.text();
      if (text.includes(key)) throw say('key_in_answer', `The door's answer to ${method} held the key; nothing of it is kept.`);
      if (response.status === 503 && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      let reply;
      try { reply = replyOf(text, response.headers.get('content-type') ?? ''); } catch { throw say('not_json_rpc', `The door's answer to ${method} is not JSON-RPC (HTTP ${response.status}).`); }
      if (reply.error) throw say('refused', `${method}: ${JSON.stringify(reply.error).slice(0, 300)}`);
      const result = reply.result ?? {};
      const answer = result.structuredContent ?? result;
      if (!result.isError) return answer;
      if ((answer?.code === 'selected_owner_unavailable' || answer?.outcome === 'unknown') && again) { await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      throw say(answer?.code ?? 'refused', `${method} was refused: ${JSON.stringify(answer).slice(0, 300)}`);
    }
  };
  const run = async (tool, input) => {
    const answer = await call(tools.address, tools.run_method, { tool, input });
    if (answer?.error !== undefined || (answer?.exit_code ?? 0) !== 0) throw say('tool_failed', `${tool}: ${String(answer?.error ?? `exit ${answer?.exit_code}`).slice(0, 300)}`);
    return answer;
  };
  return {
    read: async (type, id) => (await call(records.address, records.read_method, { type, id }))?.value ?? null,
    list: query => call(records.address, records.list_method, query),
    run,
    // A refresh's write, sent with the key it names so a write sent again answers its first answer.
    write: async (rows, { key }) => {
      if (!records.write_method) throw say('bad_config', 'Refreshing a list writes its rows: records needs write_method.');
      return call(records.address, records.write_method, { records: rows }, key);
    },
    // From a computer the person's rule filter is their rule-filter tool, run through the door.
    filter: async request => {
      if (!filter?.tool) throw say('bad_config', 'A view with rules needs filter: { tool }, the person\'s rule-filter tool.');
      const answer = await run(filter.tool, request);
      return answer?.result ?? answer;
    },
  };
}
