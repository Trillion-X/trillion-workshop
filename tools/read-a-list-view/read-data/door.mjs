// tools/read-a-list-view/read-data/door.mjs
//
// Purpose: the person's own door, as readListView and refreshRowSources use it (read, list, run, write), reached
// from their own computer: one JSON-RPC `tools/call` of `run_resource_operation` per operation, POSTed to the door's
// MCP address with the person's key as the Bearer token (the same transport as tools/export-records-as-list-rows'
// record_write_send.py). A tool the config lists in `local_tools` runs here, on the person's computer, instead.
//
// Non-Negotiable Invariants:
//   1. The config names where the computer keeps the key, never the key: a keychain item, read with the computer's
//      `security` program, or a key file the person names, read on any place. The key is read when the door is
//      opened, kept in memory, sent only in the Authorization header to the configured
//      address, and never written, logged or printed. An answer that holds it is refused and nothing of it is kept.
//   2. No address, operation or record kind is named here: the config's `records` ({ address, read_method,
//      list_method, write_method? }), `tools` ({ address, run_method }) and `local_tools` are.
//   3. A refusal comes back as an Error with the door's code; a run whose tool failed is an Error with the tool's words.
//   4. A call is sent again only with its own request key (the records door's contract, tools/records-door README).
//
//   openDoor({ transport: { url, credential: { keychain_item } | { key_file } }, records, tools, local_tools? }, { keyOf? })
//     → { read, list, run, write, history? }; records may name write_method and history_method
//   local_tools: { <tool id>: { module, export, input? } }: the module's path under the Workshop's tools folder, the
//   function it exports, and the input every run of it gets; its answer is the run's result.
//   `run` answers a run's result, never the engine's answer around it (tools/records-door records-door.mjs resultOfRun).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import listView from './list-view.json' with { type: 'json' };
import { wholeAnswer } from '../../records-door/read-data/byte-pages.mjs';
import { resultOfRun } from '../../records-door/read-data/records-door.mjs';

const PROTOCOL = '2025-06-18';
// The wait before a busy call is sent again, and how many times: list-view.json door_retry, with the measurement beside it.
const { retries: BUSY_RETRIES, first_wait_ms: FIRST_WAIT_MS } = listView.door_retry;
// Refusals that say the write never started because the store was busy: write_deadline_exceeded (the door's own time ran out
// before the write began) and original_workspace_source_unavailable (the store answered DatabaseBusy: another writer held it,
// seen refreshing the Library on Nov 13 under load 18). Only with outcome not_started: nothing was written, the same key is safe.
// current_workspace_rights_refused is on the list because the busy log caught it as a transient: a records:list refused with it
// landed 20 s later on the same key (Nov 13, load 20 to 30), and a Library refresh write was refused with it, never started.
const WAIT_AND_SEND_AGAIN = new Set(['write_deadline_exceeded', 'original_workspace_source_unavailable', 'current_workspace_rights_refused']);
// The Workshop's tools folder, where a local tool's module is found.
const TOOLS = new URL('../', new URL('../', import.meta.url));
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

/** The key a credential handle names: { key_file } is the one file the person names, read on any place. */
export async function keyFileKey(handle) {
  const file = handle?.key_file;
  if (typeof file !== 'string' || !file) throw say('bad_config', 'The credential handle is { "key_file": "<path>" }.');
  const key = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!key) throw say('bad_config', `No key is kept in the key file ${file}.`);
  return key;
}

// Where a computer may keep the key, by the one name the handle holds; a computer without a keychain names a key file.
const KEY_READERS = { keychain_item: keychainKey, key_file: keyFileKey };

/** The key the credential handle names, from the one key store it names. */
export async function credentialKey(handle) {
  const named = Object.keys(handle ?? {}).filter(name => Object.hasOwn(KEY_READERS, name));
  if (named.length !== 1 || Object.keys(handle).length !== 1)
    throw say('bad_config', `The credential handle names one of ${Object.keys(KEY_READERS).map(name => `{ "${name}" }`).join(' or ')}.`);
  return KEY_READERS[named[0]](handle);
}

// The JSON-RPC reply in a door's answer: the body, or the last `data:` line of a streamed answer.
function replyOf(text, contentType) {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text);
  const line = text.split('\n').reverse().find(one => one.startsWith('data:'));
  return JSON.parse(line ? line.slice(5).trim() : '');
}

export async function openDoor(config, { keyOf = credentialKey } = {}) {
  const { transport, records, tools, local_tools: localTools = {} } = config ?? {};
  if (!transport?.url?.startsWith('http') || !records?.address || !records.read_method || !records.list_method || !tools?.address || !tools.run_method) {
    throw say('bad_config', 'The door config is { transport: { url, credential }, records: { address, read_method, list_method }, tools: { address, run_method } }.');
  }
  const key = await keyOf(transport.credential);
  let step = 0;
  // A busy door (HTTP 503 or selected_owner_unavailable), a write that ran out of the door's time before it started, a call whose outcome is unknown and a call over the key's rate
  // (sign_in_too_many_calls, after the wait it names) are sent again with the
  // same request key after a growing wait, never a new key, so a call that did happen answers its first answer.
  // Each call that was sent again for a busy answer is one line of config.busy_log (when it names one): the refusal codes,
  // how long the call waited in all, and whether it landed. The retry budget in list-view.json is read from these lines.
  const callOnce = async (address, method, input, request_key) => {
    const episode = { codes: [], began: Date.now() };
    try {
      const answer = await callBusy(address, method, input, request_key, episode);
      await noted(episode, method, 'landed');
      return answer;
    } catch (error) {
      await noted(episode, method, error.code ?? 'refused');
      throw error;
    }
  };
  const noted = async (episode, method, outcome) => {
    if (!episode.codes.length || !config.busy_log) return;
    const line = JSON.stringify({ at: new Date().toISOString(), method, codes: episode.codes, waited_ms: Date.now() - episode.began, outcome });
    await appendFile(config.busy_log, `${line}\n`).catch(() => {});
  };
  const callBusy = async (address, method, input, request_key, episode) => {
    for (let attempt = 0; ; attempt += 1) {
      step += 1;
      const again = attempt < BUSY_RETRIES;
      const body = JSON.stringify({ jsonrpc: '2.0', id: step, method: 'tools/call',
        params: { name: 'run_resource_operation', arguments: { address, method, request_key, input } } });
      let response, text;
      try {
        response = await fetch(transport.url, { method: 'POST', body, headers: {
          Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL } });
        text = await response.text();
      } catch (error) {
        // The connection closed before the answer was whole ("terminated", "fetch failed": seen Nov 13 ending a Library refresh
        // after 9 minutes of paging). Whether the door did the call is unknown; the same request key makes sending it again
        // safe, as with any unknown outcome.
        if (!again) throw error;
        episode.codes.push('connection_closed');
        await wait(FIRST_WAIT_MS * 2 ** attempt);
        continue;
      }
      if (text.includes(key)) throw say('key_in_answer', `The door's answer to ${method} held the key; nothing of it is kept.`);
      if (response.status === 503 && again) { episode.codes.push('http_503'); await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      let reply;
      try { reply = replyOf(text, response.headers.get('content-type') ?? ''); } catch { throw say('not_json_rpc', `The door's answer to ${method} is not JSON-RPC (HTTP ${response.status}).`); }
      if (reply.error) throw say('refused', `${method}: ${JSON.stringify(reply.error).slice(0, 300)}`);
      const result = reply.result ?? {};
      const answer = result.structuredContent ?? result;
      if (!result.isError) return answer;
      if ((answer?.code === 'selected_owner_unavailable' || answer?.outcome === 'unknown') && again) { episode.codes.push(answer?.code ?? 'outcome_unknown'); await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      // A write that ran past the door's own bound for one call (legacy_records Bounds elapsed, 5 s; a write measured 4 s
      // whatever its size, 1 row or 64) and says it never started wrote nothing: it is sent again with the same key. Splitting
      // it into smaller writes would only add calls, each paying the same fixed cost against the same bound.
      if (WAIT_AND_SEND_AGAIN.has(answer?.code) && answer?.outcome === 'not_started' && again) { episode.codes.push(answer.code); await wait(FIRST_WAIT_MS * 2 ** attempt); continue; }
      // A door that counts this key's calls (sign_in_too_many_calls) says how long to wait; the same call is sent after it.
      if (answer?.code === 'sign_in_too_many_calls' && again) { await wait(1000 * (Number(answer.detail?.retry_after_seconds) || 60)); continue; }
      throw say(answer?.code ?? 'refused', `${method} was refused: ${JSON.stringify(answer).slice(0, 300)}`);
    }
  };
  // A record too big for one message comes as pages of its own bytes (tools/records-door byte-pages.mjs); the same
  // call with after_byte reads on, and the joined answer is held to the same rule as any answer: it never holds the key.
  const call = async (address, method, input, request_key = `read-a-list-view-${randomUUID()}`) => {
    const first = await callOnce(address, method, input, request_key);
    const whole = await wholeAnswer(first, after => callOnce(address, method, { ...input, after_byte: after }, `read-a-list-view-${randomUUID()}`));
    if (whole !== first && JSON.stringify(whole).includes(key)) throw say('key_in_answer', `The door's answer to ${method} held the key; nothing of it is kept.`);
    return whole;
  };
  const run = async (tool, input) => {
    const local = localTools[tool];
    if (local) {
      const ran = (await import(new URL(local.module, TOOLS)))[local.export];
      if (typeof ran !== 'function') throw say('bad_config', `local_tools: ${local.module} exports no ${local.export}.`);
      return ran({ ...(local.input ?? {}), ...input });
    }
    // The run's result, read out of the engine's answer where the records door reads it (records-door.mjs resultOfRun).
    try { return resultOfRun(tool, await call(tools.address, tools.run_method, { tool, input })); }
    catch (error) { throw error?.code === 'tool_run_failed' ? say('tool_failed', error.message) : error; }
  };
  return {
    read: async (type, id) => (await call(records.address, records.read_method, { type, id }))?.value ?? null,
    list: query => call(records.address, records.list_method, query),
    // A record's newest versions with their times, for the two-way sync of a list that is the original (list-copy.mjs);
    // absent when the config names no history_method, and the sync then decides nothing by time.
    ...(records.history_method ? { history: id => call(records.address, records.history_method, { id, limit: 2 }) } : {}),
    run,
    // A refresh's write, sent with the key it names so a write sent again answers its first answer.
    write: async (rows, { key }) => {
      if (!records.write_method) throw say('bad_config', 'Refreshing a list writes its rows: records needs write_method.');
      return call(records.address, records.write_method, { records: rows }, key);
    },
  };
}
