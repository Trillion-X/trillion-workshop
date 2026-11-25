// tools/forward-a-fact-to-my-computer/do-work/forward-a-fact.mjs
//
// Purpose: Tell one fact this computer heard to another of the person's own computers, so a fact only this computer can see
// (a message on this Mac, a volume attached to it, one of its checkouts) is handled where the person's work now runs. The
// run is woken by the fact (the row's wakes, one per kind); it calls the gateway's door with the fact as the door's own
// `wake:arrive`, pinned to the computer the wake's input names (`to`), and the meeting point there passes it on. The far
// computer takes it as told by a sender, so its wakes hear it as they hear any sender's fact. The gateway's door is the
// person's own address, given in the wake's input (`door`), so this shared tool names no product.
//
// Non-Negotiable Invariants:
// - The fact goes as it came: the same kind, event id and payload, nothing added and nothing left out. Its request key is
//   `fact:<event id>` (one longer than the door takes is named by its identity, tools/content-identity
//   `requestKeyForEngine`), so the same fact told again is the same call, and the far computer admits a sender's fact once
//   per event id whatever the request key.
// - The key is the held value on descriptor 3 (the row's credential_mounts): a key made for wake:arrive alone and kept with
//   the gateway's host alone (read-data/forward.json `key_name`). Its value is never written to the answer, an error or a
//   line; a refusal names the key by its held name.
// - A run that told the fact answers what the far computer said: kept, and by how many wakes it is heard, or that no wake
//   there hears it (`no_wake_hears`), which is an answer and not a failure, so it is never asked again. Every other outcome
//   fails the run with words that say why: the gateway refused the key (401), the gateway or the far computer did not
//   answer, or the meeting point carries no computer by that name. The wake's own retry asks a failed run again, and once
//   its attempts are spent the wake is failed with that cause.
// - The fact carries the wake's `forwarded_from` in its payload (read-data/forward.json `tag_field`), so the far computer's wake
//   hears only forwarded facts by matching that field; a fact that already holds the field is refused, never changed.
// - A fact is told only while no wake of another tool on this computer hears the same kind from the same teller (its own
//   door's wake:list): otherwise the work would run here and there, so the run is refused, naming that wake.
// - This tool's own failures are never forwarded (read-data/forward.json `not_forwarded_when`): a wake-failed fact that names
//   this tool is answered `forwarded: false` with no call, so a gateway that stays down cannot turn each failed forward into
//   another forward of that failure.
//
// Key Concepts: `forward` (one fact to one computer through one fetch), `factOf` (the woken run's fact, checked), `answerOf`
// (the door's JSON or event-stream answer), `SETTINGS` (read-data/forward.json).
//
// Security Considerations: the bearer goes only to the `door` address, over https, through the run's proxy, which the engine
// opens only to the hosts the key is kept with: a `door` elsewhere is never reached with the key. The answer is read to at
// most `answer_most_bytes`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestKeyForEngine } from '../../content-identity/read-data/identity.mjs';

export const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/forward.json', import.meta.url), 'utf8'));

/** The descriptor the row mounts the key on. */
const KEY_DESCRIPTOR = 3;

/** This tool's own id: its own wakes are never a consumer of what it forwards. */
const OWN_TOOL = 'tool:forward-a-fact-to-my-computer';

/** The request key of a fact with `eventId`: `fact:<event id>`, as the door takes it. */
export const requestKeyOf = eventId => requestKeyForEngine(`${SETTINGS.request_key_prefix}${eventId}`);

/** Whether `to` is a computer name the door takes as a pin (trillion-rust src/tool_runs/reach.rs `computer_id_valid`). */
export const computerNameOk = to => typeof to === 'string' && to.length > 0 && to.length <= 128 && /^[A-Za-z0-9_-]+$/.test(to);

/** Whether `tag` is a label the far wake can match: lower-case letters, digits and -. */
export const tagOk = tag => typeof tag === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tag);

/** `told` with `tag` under the tag field, or words that say why it cannot carry it. */
export const tagged = (told, tag) => {
  if (Object.hasOwn(told.payload, SETTINGS.tag_field)) {
    throw new Error(`The fact ${told.kind} ${told.event_id} already holds ${SETTINGS.tag_field} in its payload, so it cannot be marked as forwarded; it is not told.`);
  }
  if (Object.keys(told.payload).length + 1 > SETTINGS.payload_most_fields) {
    throw new Error(`The fact ${told.kind} ${told.event_id} has ${Object.keys(told.payload).length} payload fields; with ${SETTINGS.tag_field} it would pass the ${SETTINGS.payload_most_fields} a fact may hold, so it is not told.`);
  }
  return { ...told, payload: { ...told.payload, [SETTINGS.tag_field]: tag } };
};

/**
 * The wakes of another tool on this computer that are switched on and hear `kind` from `teller`, read through the run's own
 * `door` ({url, resource, capability}, descriptor 4) with `fetchImpl`: their `tool id` names, or throws words that say the
 * wakes could not be read (the run is then asked again, and nothing is told blind).
 */
export const consumersHere = async ({ door, kind, teller, fetchImpl = fetch }) => {
  if (typeof door?.url !== 'string' || typeof door?.capability !== 'string') {
    throw new Error(`This run was handed no door on descriptor ${SETTINGS.door_descriptor}, so it cannot see whether a wake here still hears ${kind}; nothing is told.`);
  }
  const found = [];
  let after = null;
  for (let page = 0; page < 64; page += 1) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: page + 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
      arguments: { address: door.resource ?? '@own-records', method: 'wake:list', request_key: `forward-consumers:${kind}:${Date.now().toString(36)}:${page}`,
        input: { kind, ...(after === null ? {} : { after }) } } } });
    let raw;
    try {
      const response = await fetchImpl(door.url, { method: 'POST', body, signal: AbortSignal.timeout(SETTINGS.door_timeout_ms),
        headers: { authorization: `Bearer ${door.capability}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': SETTINGS.protocol_version } });
      raw = { type: response.headers.get('content-type'), text: await response.text() };
    } catch (error) {
      throw new Error(`This computer's door did not answer wake:list (${error?.message ?? error}), so it is not known whether a wake here still hears ${kind}; nothing is told.`);
    }
    const answer = answerOf(raw.type, raw.text);
    const listed = answer?.result?.structuredContent;
    if (!answer || answer.error || answer.result?.isError || !Array.isArray(listed?.wakes)) {
      throw new Error(`This computer's door did not list its ${kind} wakes (${listed?.code ?? answer?.error?.message ?? 'no list'}); nothing is told.`);
    }
    for (const wake of listed.wakes) {
      const heard = wake?.on?.fact;
      if (wake?.tool !== OWN_TOOL && wake?.switched_on === true && heard?.kind === kind && Array.isArray(heard.from) && heard.from.includes(teller)) {
        found.push(`${wake.tool} ${wake.id}`);
      }
    }
    if (typeof listed.next !== 'string' || listed.next === '') return found;
    after = listed.next;
  }
  throw new Error(`This computer's ${kind} wakes run past 64 pages; nothing is told.`);
};

/** Whether `door` is an https address with a host and no credentials in it: the gateway's door a wake's input names. */
export const doorOk = door => {
  try { const url = new URL(door); return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''; } catch { return false; }
};

/** The fact a woken run was handed (the task's cause.detail): its kind, event id and text payload, checked. */
export const factOf = detail => {
  const text = value => typeof value === 'string' && value.length > 0;
  if (detail === null || typeof detail !== 'object' || !text(detail.kind) || !text(detail.event_id)) {
    throw new Error('This run was not woken by a fact: a forward runs from a fact one of its wakes heard, with its kind and event id.');
  }
  const payload = detail.payload ?? {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !Object.values(payload).every(value => typeof value === 'string')) {
    throw new Error(`The fact ${detail.kind} ${detail.event_id} has a payload that is not text fields, so it is not a fact a door takes.`);
  }
  return { kind: detail.kind, event_id: detail.event_id, payload };
};

/** Why `told` is answered without a call (read-data/forward.json `not_forwarded_when`), or null when it is told. */
export const notForwarded = told => {
  const rule = SETTINGS.not_forwarded_when.find(rule => rule.kind === told.kind
    && Object.entries(rule.payload ?? {}).every(([field, value]) => told.payload[field] === value));
  return rule ? `${told.kind} of ${Object.values(rule.payload ?? {}).join(', ')} is this tool's own: it is kept here and never forwarded, so a forward that failed never forwards its own failure again` : null;
};

/** The door's JSON-RPC answer in a body of `type`: the JSON itself, or the last `data:` line of an event stream. */
export const answerOf = (type, body) => {
  const data = String(type ?? '').includes('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).at(-1)
    : body.trim();
  try { return JSON.parse(data ?? ''); } catch { return null; }
};

/**
 * Tell `fact` to the computer `to` through `door`, with `key` as the bearer and `fetchImpl` as the way out. Answers what the
 * far computer said ({to, computer, kind, event_id, request_key, kept, heard_by?, starts?, not_heard?}), or throws words that
 * say why it was not told.
 */
export const forward = async ({ fact, to, door, key, tag, here, fetchImpl = fetch, doorFetch = fetch, anyDoor = false }) => {
  const heard = factOf(fact);
  const kept = notForwarded(heard);
  if (kept) return { to, kind: heard.kind, event_id: heard.event_id, forwarded: false, why: kept };
  if (!tagOk(tag)) throw new Error(`The wake's input names no forwarded_from: it is ${JSON.stringify(tag)}, and it is a label of lower-case letters, digits and - (for example mac).`);
  const told = tagged(heard, tag);
  if (!computerNameOk(to)) throw new Error(`The wake's input names no computer: \`to\` is ${JSON.stringify(to)}, and a computer name is letters, digits, - and _.`);
  if (!anyDoor && !doorOk(door)) throw new Error(`The wake's input names no gateway door: \`door\` is ${JSON.stringify(door)}, and a door is your gateway's https address (https://<host>/mcp).`);
  if (typeof key !== 'string' || key === '') throw new Error(`No key was handed on descriptor ${KEY_DESCRIPTOR}: keep ${SETTINGS.key_name} in the vault with your gateway's host as its only host.`);
  const consumers = await consumersHere({ door: here, kind: told.kind, teller: fact.from, fetchImpl: doorFetch });
  if (consumers.length > 0) throw new Error(`${consumers.join(', ')} ${SETTINGS.consumer_words}; ${told.kind} ${told.event_id} was not told to ${to}.`);
  const requestKey = requestKeyOf(told.event_id);
  const body = JSON.stringify({ jsonrpc: '2.0', id: requestKey, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
    arguments: { method: 'wake:arrive', request_key: requestKey, input: told, pins: [to] } } });
  let response;
  try {
    response = await fetchImpl(door, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(SETTINGS.timeout_ms), body,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': SETTINGS.protocol_version, authorization: `Bearer ${key}` } });
  } catch (error) {
    throw new Error(`The gateway did not answer (${error?.message ?? 'no answer'}), so ${told.kind} ${told.event_id} was not told to ${to}; the wake asks again.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The gateway refused the key ${SETTINGS.key_name} (${response.status}): it is expired, revoked or not a key for wake:arrive. Make a new one and keep it under that name.`);
  }
  const text = (await response.text()).slice(0, SETTINGS.answer_most_bytes);
  if (!response.ok) throw new Error(`The gateway answered ${response.status}, so ${told.kind} ${told.event_id} was not told to ${to}; the wake asks again.`);
  const answer = answerOf(response.headers.get('content-type'), text);
  if (answer === null) throw new Error(`The gateway's answer is not the door's answer, so it is not known whether ${to} was told ${told.kind} ${told.event_id}; the wake asks again.`);
  if (answer.error) throw new Error(`The door refused the call (${answer.error.code ?? 'no code'}: ${answer.error.message ?? ''}), so ${told.kind} ${told.event_id} was not told to ${to}.`);
  const said = answer.result?.structuredContent ?? {};
  if (answer.result?.isError) {
    if (SETTINGS.computer_refused_codes.includes(said.code)) {
      throw new Error(`The meeting point carries no computer of yours named ${to} (${said.code}${typeof said.detail === 'string' ? `: ${said.detail}` : ''}). Name one of your computers in the wake's \`to\`.`);
    }
    throw new Error(`${to} did not keep ${told.kind} ${told.event_id} (${said.code ?? 'no code'}${typeof said.detail === 'string' ? `: ${said.detail}` : ''}); the wake asks again.`);
  }
  const answered = { to, computer: said.computer ?? to, kind: told.kind, event_id: told.event_id, request_key: requestKey, kept: said.kept === true };
  for (const field of ['heard_by', 'starts', 'not_heard']) if (said[field] !== undefined) answered[field] = said[field];
  return answered;
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let key = '';
  try {
    const { input, fact } = JSON.parse(readFileSync(0, 'utf8'));
    // The fact and the computer are checked before the descriptor is read, so a call that would be refused reads no key.
    factOf(fact);
    if (!computerNameOk(input?.to)) throw new Error('The wake\'s input names no computer: give `to`, one of your computers\' names.');
    if (!doorOk(input?.door)) throw new Error('The wake\'s input names no gateway door: give `door`, your gateway\'s https address.');
    if (!tagOk(input?.forwarded_from)) throw new Error('The wake\'s input names no forwarded_from: give a label such as mac, which the far wake matches.');
    let here = null;
    try { here = JSON.parse(readFileSync(SETTINGS.door_descriptor, 'utf8')); } catch { here = null; }
    try { key = readFileSync(KEY_DESCRIPTOR, 'utf8').trim(); } catch { key = ''; }
    const { nodePublicFetch } = await import('../../http-client/do-work/node-public-fetch.mjs');
    const told = await forward({ fact, to: input.to, door: input.door, key, tag: input.forwarded_from, here,
      fetchImpl: nodePublicFetch({ maxBytes: SETTINGS.answer_most_bytes, timeoutMs: SETTINGS.timeout_ms }) });
    console.log(JSON.stringify(told));
  } catch (error) {
    const said = String(error?.message ?? error);
    console.error(key ? said.split(key).join('[held]') : said);
    process.exitCode = 1;
  }
}
