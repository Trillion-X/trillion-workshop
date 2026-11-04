import { egressRelaySettings, makeEgressRelay } from './egress-relay.mjs';
import { HANDOFF_RESULT_SOURCE } from './handoff-result-source.mjs';
import { startLocalSocket } from './local-socket.mjs';
import { nativeResultRetirer, nativeResultUploader, needsResultSource, prepareNativeResultSource } from './native-result-source.mjs';
// computer/mac-tools.mjs
//
// PURPOSE
//   Runs the Workshop tools this Mac keeps for its person's Trillion (a tool on placement:your-computer, whose executor hands
//   each run to the agent its DATA names, src/agent-tool-runs.mjs). It publishes that agent's card and capacity, holds
//   the account's live socket (/mcp/api/live, which carries only a revision), and on every revision takes the runs
//   handed to it by name and finishes each with the tool's answer. It replaces Trillion Media's trillion-tool-host.mjs,
//   which forwarded the same runs to that app's server, so the Mac's drives no longer need that app open.
//   It is a handler of harness/wake-sessions.mjs (it exports start and takes no events); `node computer/mac-tools.mjs`
//   runs it by itself with the key on the first line of stdin.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which tool runs which function is computer/mac-tools.json `tools`; a tool id not listed there is answered
//      in words, never guessed, and a handoff can never name a module or a path.
//   2. Every run is finished, with the tool's answer or `error` in words, so no run waits for its hold to run out; an
//      answer the account is too busy to take is sent again after each wait in live_retry_ms. A final HTTP client
//      refusal retains the completed result but pauses revision-triggered replay until the account offers its lease again.
//   3. Taking is serialized, while execution uses at most the capacity this Mac advertises. Jobs an earlier run of this
//      program took and never finished are taken again by id. An incomplete saved attempt is observed, never replayed;
//      its target must be checked before a mutation can be tried again. A long tool cannot keep
//      every other waiting tool out of the Mac. Revisions arriving during a run wake the taker without a polling loop.
//   4. The card lists the tools the account has installed for this Mac, and the programs the Mac runs are those the
//      account installed (computer/program-host.mjs, mac-tools.json `programs`). With no starting set installed, or the
//      account unreadable, the card and the programs are what they were before: a Mac never stops something on a failed read.
//   5. The exact-computer card (mac-tools.json `scoped_tools`) lists each scoped tool this Mac actually carries (its
//      `tools` row and that row's module in the app), whatever the installed set names: the harness installer is part of
//      the signed app (the app carries ../harness wholesale), not a program an installation switches on, so a set that
//      does not name it (trillion-your-computer does not) never hides it. A Mac without the module never lists it.
//
// SECURITY
//   The account key comes from the helper that started it, on stdin, and is only sent to the account's own
//   origin. Only modules this file's own folder names in its DATA are loaded.
//
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confinedEntry } from '../check-a-packages-declared-permissions/read-data/manifest-permissions.mjs';
import { makeProgramHost, registerHost, startedByApp } from './program-host.mjs';
import { makeStartupLeases } from './startup-lease.mjs';
import { decisionSettings, requireHooks } from './run-decision.mjs';
import { nativeOutputUploader, nativeResultOutbox } from './native-result-outbox.mjs';
import { policedLog } from './log-policy.mjs';
import { mayRetry, retriable } from './retry-policy.mjs';
import { expandFileArguments } from './file-arguments.mjs';
import { hostLog } from './host-log.mjs';
import { runIsolated } from './isolated-run.mjs';
import { makePlaces } from '../drive-the-screen/read-data/work-places.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settingsOf = () => JSON.parse(readFileSync(join(HERE, 'mac-tools.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// Keep provider cooldowns separate from the local backoff. Long waits are split below because a Node timer larger
// than its signed 32-bit limit fires almost immediately; splitting never permits an earlier request.
const accountRetryAfter = value => {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const said = value.trim();
  const hinted = /^\d+(?:\.\d+)?$/.test(said) ? Number(said) * 1000 : Date.parse(said) - Date.now();
  return Number.isFinite(hinted) && hinted > 0 && hinted <= Number.MAX_SAFE_INTEGER ? Math.ceil(hinted) : 0;
};

/** Resolves only a verified opaque user id; transient failures retain provider cooldowns through the last attempt. */
export async function verifiedAccountId(origin, key, fetchImpl = fetch, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), isStopped = () => false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isStopped()) return null;
    let cooldown = 0;
    try {
      const answer = await fetchImpl(`${String(origin).replace(/\/$/, '')}/mcp/api/account`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (answer.ok) {
        const body = await answer.json();
        return typeof body?.user_id === 'string' && body.user_id.trim() ? body.user_id.trim() : null;
      }
      if (answer.status < 500 && answer.status !== 429) return null;
      cooldown = accountRetryAfter(answer.headers?.get('retry-after'));
    } catch { /* retry a transient transport failure */ }
    if (isStopped()) return null;
    // The final response's cooldown is consumed before the host may start another admission cycle. The host supplies
    // its existing cancellable wait; stopping it settles this wait without another request.
    let remaining = Math.max(attempt < 2 ? 500 * (2 ** attempt) : 0, cooldown);
    while (remaining > 0 && !isStopped()) {
      const piece = Math.min(remaining, 0x7fffffff);
      await wait(piece);
      remaining -= piece;
    }
  }
  return null;
}

// An existing computer identity binds advertised native capabilities to one account-visible computer. Reading
// a missing identity never creates one; the computer reader remains its owner. Older hosts advertise no binding.
export function computerScopeSkill(settings, read = readFileSync, home = homedir()) {
  const scope = settings.computer_scope;
  if (!scope) return [];
  try {
    const id = JSON.parse(read(join(home, scope.file), 'utf8'))?.[scope.field];
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)
      ? [{ id: `${scope.skill_prefix}${id}`, name: `${scope.skill_prefix}${id}` }] : [];
  } catch { return []; }
}

// A tools (or on_start) row that names `workshop` runs a function of a Workshop tool folder: the trillion-workshop package
// this folder depends on (computer/package.json), carried in the app's node_modules beside computer/, so the code has one
// home and the Mac runs that copy. `workshop` is the module's path inside the package (tools/<folder>/...mjs) and
// `function` its exported function, called as fn(input, context) the way the Workshop's run-an-export.mjs calls it.
const WORKSHOP_MODULE = /^tools\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.mjs$/;
/** The file URL of a Workshop tool folder's module, or a throw when the path is not one (never a path out of tools/). */
export function workshopEntry(path) {
  if (typeof path !== 'string' || !WORKSHOP_MODULE.test(path)) throw new Error(`${path} is not a module of a Workshop tool folder.`);
  return import.meta.resolve(`trillion-workshop/${path}`);
}
const entryOf = row => (row.workshop ? workshopEntry(row.workshop) : pathToFileURL(confinedEntry(HERE, row.module)).href);
const functionOf = (module, row) => (row.workshop ? module[row.function] : module[row.export]?.[row.name]);
/** Whether this Mac carries a row's code: its module in computer/, or its Workshop module in the carried package. */
export function carriesRow(row) {
  try { return typeof row?.module === 'string' ? existsSync(join(HERE, row.module)) : typeof row?.workshop === 'string' && existsSync(fileURLToPath(workshopEntry(row.workshop))); }
  catch { return false; }
}

/** The function that answers `toolId`, from the settings' `tools` rows, or null when this Mac does not keep it. */
export async function toolFor(settings, toolId) {
  const row = Object.hasOwn(settings.tools, toolId) ? settings.tools[toolId] : null;
  if (!row) return null;
  const fn = functionOf(await import(entryOf(row)), row);
  return typeof fn === 'function' ? fn : null;
}

// The person's files as a Workshop function reads them (its `door.files(method, input)`), over the account's own tools
// with the key this host holds. Only the operations the row lists in `door` are answered; a row naming none gets no door.
// read_file reads a range of the address find_file hands out, so every kind of file arrives as the same base64 piece the
// Workshop's own door answers (the account's read_file answers a picture as an image block instead).
export function accountFilesDoor(context, allowed = [], { caller = null, fetchImpl = fetch } = {}) {
  let tools = null;
  const call = async (name, input) => {
    if (typeof context?.origin !== 'string' || typeof context?.key !== 'string') throw new Error('This computer holds no account key, so your files cannot be read here.');
    tools ??= (caller ?? (await import('./keep-drive-files.mjs')).toolCaller)(context.origin, context.key);
    return tools(name, input);
  };
  const found = new Map();
  const find = async name => {
    if (!found.has(name)) found.set(name, await call('find_file', { name_or_identity: name, seconds: 600 }));
    return found.get(name);
  };
  return {
    async files(method, input = {}) {
      if (!allowed.includes(method)) throw new Error(`This tool may not ${method} on your files here.`);
      if (method === 'find_file') return find(input.name_or_identity);
      if (method !== 'read_file') return call(method, input);
      const file = await find(input.name_or_identity);
      const offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
      const length = Number.isSafeInteger(input.length) && input.length > 0 ? input.length : 262144;
      const byte_length = Number(file?.byte_length);
      if (!file?.url || !Number.isSafeInteger(byte_length)) throw new Error(`${input.name_or_identity} could not be found in your files.`);
      if (offset >= byte_length) return { byte_length, offset, bytes_returned: 0, encoding: 'base64', content: '' };
      const answer = await fetchImpl(file.url, { headers: { range: `bytes=${offset}-${Math.min(offset + length, byte_length) - 1}` }, signal: AbortSignal.timeout(120_000) });
      if (!answer.ok) throw new Error(`the file answered ${answer.status}`);
      let bytes = Buffer.from(await answer.arrayBuffer());
      // An address that ignores the range answers the whole file; the piece asked for is cut from it.
      if (answer.status !== 206) bytes = bytes.subarray(offset, offset + length);
      return { byte_length, offset, bytes_returned: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    },
  };
}

/** The context a Workshop function is called with: the host's, the row's `door`, each `with` value read from a file
 *  beside this one ({ file, field }), so a function is handed what only this computer's DATA knows, and each `hand`
 *  function of a file beside this one ({ file, export }) as { module: its file URL, export }, so a Workshop function
 *  calls back into this host (a transfer tells own-writes.mjs each path it wrote) without importing it. */
export function workshopContext(row, context = {}, read = readFileSync) {
  if (!row?.workshop) return context;
  const handed = Object.fromEntries(Object.entries(row.with ?? {}).map(([name, from]) => [name, JSON.parse(read(confinedEntry(HERE, from.file), 'utf8'))?.[from.field] ?? null]));
  const functions = Object.fromEntries(Object.entries(row.hand ?? {}).map(([name, from]) => [name, { module: pathToFileURL(confinedEntry(HERE, from.file)).href, export: from.export }]));
  return { ...context, ...handed, ...functions, ...(Array.isArray(row.door) && row.door.length ? { door: accountFilesDoor(context, row.door) } : {}) };
}

/** One run: { tool_id, input } -> the tool's answer, or { error } in words. context ({ origin, key }) is the account's;
 *  `places` is computer/work-places.mjs makePlaces (a test passes its own). */
export async function runHere(settings, run, context = {}, { places = makePlaces } = {}) {
  const { tool_id, input } = run ?? {};
  const fn = await toolFor(settings, tool_id);
  if (!fn) return { error: fill(settings.words.not_kept, { tool: tool_id }) };
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) return { error: settings.words.not_an_object };
  const decision = decisionSettings();
  const told = (step, extra = {}) => requireHooks(decision, homedir(), { step, action: tool_id, ...extra });
  try { await told('before_tool_run'); }
  catch (error) { return { error: error.message }; }
  // A tools row with `isolate` runs in a worker of its own; only plain data crosses, so the host's callbacks stay out.
  const row = settings.tools[tool_id];
  const plain = Object.fromEntries(Object.entries(context).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
  const call = given => (row.isolate && !row.workshop ? runIsolated({ id: context.handoff_id ?? run.run_id ?? `${tool_id}:${Date.now()}:${Math.random()}`, module: pathToFileURL(join(HERE, row.module)).href,
    export: row.export, name: row.name, input: given, context: plain, isolate: row.isolate, words: settings.words }) : fn(given, workshopContext(row, context)));
  let answer;
  try {
    // A tool that acts on a place (its row's `place`, computer/work-places.mjs) is refused while the person has taken that
    // place over; the first action after they hand it back carries `told`, the words saying they had it.
    // The person's own recent input there holds it too, for a few seconds (input this run makes is marked as the AI's).
    const place = row.place ? places() : null;
    const told = place ? await place.handsOn(row.place) : null;
    // A file the input names is read here, at the boundary, and put in the name's place (computer/file-arguments.mjs).
    const { input: expanded } = await expandFileArguments(input ?? {});
    try { answer = (await call(expanded)) ?? {}; } finally { place?.acted(row.place); }
    if (told && answer && typeof answer === 'object' && !Array.isArray(answer)) answer = { ...answer, told };
    // A Workshop function answers as that repository's run-an-export.mjs prints it, { result }, which its row selects.
    if (row.workshop) answer = { result: answer };
  } catch (error) {
    // A refusal that names what the caller owes it (reaction: retry, ask_user, use_different_tool, stop) and whether the
    // action may have run (outcome: unknown) passes both on, so a model reacts to the class and not to the words.
    answer = { error: error.status ? error.message : fill(settings.words.failed, { error: error.message ?? error }),
      ...(typeof error.retry === 'boolean' ? { retry: error.retry } : {}), ...(Number.isFinite(error.retry_after_ms) ? { retry_after_ms: error.retry_after_ms } : {}),
      ...(error.reaction ? { reaction: error.reaction, reaction_said: error.reaction_said } : {}), ...(error.outcome ? { outcome: error.outcome } : {}),
      ...(error.status && typeof error.code === 'string' && typeof error.permission === 'string' ? { code: error.code, permission: error.permission } : {}) };
  }
  // Told afterwards: this step cannot undo the run, so what its hooks say is not read.
  await told('after_tool_run', { ok: !answer.error }).catch(() => {});
  return answer;
}

/** The host: publish the card, take and finish runs, hold the live socket. `call(path, body)` posts to /mcp/api. */
// installed() is the tool ids the account has installed for this Mac (computer/program-host.mjs), or null while the
// legacy set is in force: then the card lists every tool but those that only switch a program on, as it always did.
// refresh() looks at the account before each publish (begin and every renewal) and never throws.
export function macTools({ settings, call, connect, context = {}, execute = runHere, log: writeLog = () => {}, timers = { setTimeout, setInterval }, scopeSkills = () => computerScopeSkill(settings), installed = () => null, refresh = null, resultOutbox = null, uploadResult = nativeResultUploader(context), retireResult = nativeResultRetirer(context), uploadOutput = nativeOutputUploader(context), expire = ({ exit_code }) => process.exit(exit_code) }) {
  const log = policedLog(writeLog);
  const leases = makeStartupLeases({ settings: settings.startup_leases, expire, log, timers });
  let durableResults = resultOutbox;
  const cards = () => {
    const scope = scopeSkills();
    const scoped = settings.scoped_tools;
    const scopedIds = new Set(scoped?.tool_ids ?? []);
    const skills = ids => ids.map(id => ({ id, name: id }));
    const kept = installed();
    const published = Object.keys(settings.tools).filter(id => (kept ? kept.includes(id) : !settings.tools[id]?.program));
    const carried = id => Object.hasOwn(settings.tools, id) && carriesRow(settings.tools[id]);
    const legacy = { ...settings.agent, skills: skills(published.filter(id => !scopedIds.has(id))) };
    const marker = scope.find(row => row.id?.startsWith(settings.computer_scope?.skill_prefix));
    const id = marker?.id.slice(settings.computer_scope.skill_prefix.length);
    return [legacy, ...(scoped && id ? [{ ...settings.agent, agent_id: `${scoped.agent_prefix}${id}`,
      name: `${settings.agent.name} (${id})`, skills: [...skills(scoped.tool_ids.filter(carried)), marker] }] : [])];
  };
  const pendingPublishes = new Set();
  const publish = () => {
    if (stopped) return Promise.resolve();
    const request = (async () => {
    // The card lists every tool this Mac keeps, so Trillion counts it as a device that can take a job only when it runs
    // that job's tool (src/placement.mjs devicesAwake): a Mac on older code is never handed a tool it does not have.
    for (const card of cards()) {
      if (stopped) return;
      await call('/agents/publish', { ...card, takes_work: true });
      if (stopped) return;
      await call('/agents/capacity', { agent_id: card.agent_id, ...settings.capacity });
      if (stopped) return;
      await call('/agents/presence', { agent_id: card.agent_id });
    }
    })();
    pendingPublishes.add(request);
    return request.finally(() => pendingPublishes.delete(request));
  };
  // An account that cannot answer for a moment (busy, restarting, the network) is asked again after the waits in
  // live_retry_ms; any other refusal is final. Which failures those are, and the switch that turns retries off, are
  // src/retry-policy.json. A generic response body can hide its HTTP status: explicit client refusals remain final even
  // when their words mention busy; the words are a fallback for transport failures only.
  const passing = error => retriable(error);
  // A finished answer is sent until the account takes it, never dropped because the account was busy for a moment:
  // a dropped answer leaves the job held, and the model's work on it is done again later.
  const sendUntilTaken = async ask => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await ask(); }
      catch (error) {
        if (!mayRetry(error) || attempt >= settings.live_retry_ms.length) throw error;
        await new Promise(resolve => timers.setTimeout(resolve, settings.live_retry_ms[attempt]));
      }
    }
  };
  let taking = null;
  let socket = null;
  let renew = null;
  let reconnect = null;
  let stopped = false;
  const ownerDelays = new Set();
  const waitForOwner = ms => new Promise(resolve => {
    const row = { handle: null, finished: false };
    const finish = () => { row.finished = true; ownerDelays.delete(row); resolve(); };
    row.finish = finish;
    row.handle = timers.setTimeout(finish, ms);
    if (!row.finished) ownerDelays.add(row);
  });
  // The handoffs this program is running now, so a job held by an earlier run of it is told apart.
  const running = new Set();
  const completedInMemory = new Map();
  let sourceCapability = null, sourceCapabilityChecked = 0;
  const preservedResultBytes = row => new TextEncoder().encode(JSON.stringify(row.finish.result)).byteLength;
  const recoveryVersionOf = capability => capability.legacy_result_recovery?.version ?? capability.inline_history_recovery?.version ?? capability.transport_limit_recovery?.version;
  const sourceCapabilityFor = async row => {
    // The holder/fence admission always runs on the service. Only unsupported capability is locally cooled,
    // so a later batched deployment can recover old Request-too-large refusals without replaying effects.
    if (sourceCapability === false && Date.now() - sourceCapabilityChecked < HANDOFF_RESULT_SOURCE.capability_retry_ms) return null;
    sourceCapabilityChecked = Date.now();
    try { const capability = await call('/handoffs/result-source-capability', { handoff_id: row.handoff_id, agent_id: row.finish.agent_id, generation: row.generation, result_byte_length: preservedResultBytes(row) }); sourceCapability = true; return capability; }
    catch (error) { if (error.status === 404) { sourceCapability = false; return null; } throw error; }
  };
  const cleanupStored = async row => {
    if (row.cleanup_refusal) return false;
    if (row.result_source?.transport_name) {
      try { await retireResult(row.result_source); }
      catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && !passing(error)) {
          row = { ...row, cleanup_refusal: { status: error.status, at: new Date().toISOString() } };
          completedInMemory.set(row.handoff_id, row); durableResults?.put(row);
        }
        throw error;
      }
    }
    durableResults?.delete(row.handoff_id); completedInMemory.delete(row.handoff_id);
    return true;
  };
  const finishStored = async (row, { capability: checkedCapability = null, recoveryVersion: admittedRecoveryVersion = null } = {}) => {
    // A dispatch marker or partial step is evidence of an attempt, never a completed answer.
    if (row.execution?.state === 'started' && row.delivery_refusal) return false;
    if (row.delivery_ack) return cleanupStored(row);
    try {
    for (const effect of row.effect_updates ?? []) {
      await call('/handoffs/effect', effect);
      row = { ...row, effect_updates: row.effect_updates.filter(item => item !== effect) };
      completedInMemory.set(row.handoff_id, row);
      durableResults?.put(row);
    }
    if (row.execution?.state === 'started') return false;
    if (row.execution?.state === 'outputs') {
      if (!durableResults?.deliverOutputs) throw new Error('Retained app outputs need their authenticated native outbox.');
      // This existing endpoint admits the exact current holder/generation and settled effect fence.
      // Output retries can never use a stale lease or dispatch another app operation.
      await sendUntilTaken(() => durableResults.deliverOutputs(row.handoff_id, async request => {
        const current = durableResults.get(row.handoff_id);
        if (!(await sourceCapabilityFor(current))) throw new MacToolsHttpError('/handoffs/result-source-capability', 404, 'Current app output delivery lease could not be admitted.');
        return uploadOutput(request);
      }));
      row = durableResults.get(row.handoff_id);
      completedInMemory.set(row.handoff_id, row);
    }
    let wire = row.finish;
    if (row.result_source || needsResultSource(row)) {
      const capability = checkedCapability ?? await sourceCapabilityFor(row);
      if (!capability) {
        row = { ...row, delivery_refusal: { path: '/handoffs/result-source-capability', status: 404, at: new Date().toISOString(), checked_at: Date.now() } };
        completedInMemory.set(row.handoff_id, row); durableResults?.put(row);
        return false;
      }
      const prepared = await prepareNativeResultSource(row, { capability, upload: uploadResult, persist: kept => {
        completedInMemory.set(kept.handoff_id, kept); durableResults?.put(kept);
      } });
      row = prepared.row; wire = prepared.wire;
      const recoveryVersion = admittedRecoveryVersion ?? recoveryVersionOf(capability);
      if (typeof recoveryVersion === 'string' && recoveryVersion && row.result_recovery_attempted_version !== recoveryVersion) {
        // Persist admission attempt before finish; a differing-result refusal cannot repeat on every revision/restart.
        row = { ...row, result_recovery_attempted_version: recoveryVersion, delivery_refusal: null };
        completedInMemory.set(row.handoff_id, row); durableResults?.put(row);
      }
    }
    await sendUntilTaken(() => call('/handoffs/finish', wire));
    } catch (error) {
      // Output receipts can advance before a later file fails; never overwrite that completed prefix.
      row = durableResults?.get(row.handoff_id) ?? row;
      completedInMemory.set(row.handoff_id, row);
      // A client refusal is final for this submission, not a lost answer. Preserve
      // the outside effect/result, but store revisions must not replay it forever.
      // A newly offered lease below explicitly reopens delivery of the same answer.
      if (Number.isInteger(error?.status) && (error.native_output_refusal || error.status >= 400 && error.status < 500)
          && !passing(error) && (error.native_output_refusal || row.execution?.state === 'outputs' || error.local_result_transport || ['/handoffs/effect', '/handoffs/finish', '/handoffs/result-source-capability'].includes(error.path))) {
        row = { ...row, delivery_refusal: { path: error.path, status: error.status, at: new Date().toISOString(), checked_at: Date.now(), ...(row.result_source || error.local_result_transport ? { transport: 'result_source', local_max_bytes: HANDOFF_RESULT_SOURCE.max_bytes } : {}), ...(error.result_transport_code ? { code: error.result_transport_code } : {}), ...(error.result_transport_reason ? { reason: error.result_transport_reason, result_bytes: error.result_bytes, supported_max_bytes: error.supported_max_bytes, checked_at: Date.now() } : {}) } };
        completedInMemory.set(row.handoff_id, row);
        durableResults?.put(row);
      }
      throw error;
    }
    if (row.result_source?.transport_name || row.output_workspace) {
      row = { ...row, delivery_ack: { generation: row.generation, at: new Date().toISOString() } };
      completedInMemory.set(row.handoff_id, row); durableResults?.put(row);
      return cleanupStored(row);
    }
    durableResults?.delete(row.handoff_id); completedInMemory.delete(row.handoff_id);
    return true;
  };
  const drainResults = async () => {
    if (!durableResults) return;
    for (let row of durableResults.list()) {
      if (running.has(row.handoff_id)) continue;
      let capability = null, recoveryVersion = null;
      try {
        const refusal = row.delivery_refusal;
        if (!row.delivery_ack && refusal) {
          if (Date.now() - (refusal.checked_at ?? 0) < Math.max(60000, HANDOFF_RESULT_SOURCE.capability_retry_ms)) continue;
          // Exact read/request-size codes admit probing, never error-message substring guesses.
          const legacyInline = refusal.path === '/handoffs/finish' && refusal.transport !== 'result_source'
            && refusal.code === 'request_too_large' && [400, 413].includes(refusal.status) && needsResultSource(row);
          // Older source400 rows have no code. Only the server's live finished-root marker can admit their recovery.
          const legacySource = refusal.path === '/handoffs/finish' && refusal.transport === 'result_source'
            && [400, 413].includes(refusal.status) && row.result_source && !(row.effect_updates ?? []).length
            && (!refusal.code || refusal.code === 'record_read_too_large');
          const unsupported = refusal.path === '/handoffs/result-source-capability' && refusal.status === 404 && (needsResultSource(row) || row.execution?.state === 'outputs');
          const expandedLocal = refusal.path === '/handoffs/finish' && refusal.transport === 'result_source' && refusal.status === 422
            && Number.isSafeInteger(refusal.local_max_bytes) && refusal.local_max_bytes > 0 && refusal.local_max_bytes < HANDOFF_RESULT_SOURCE.max_bytes
            && preservedResultBytes(row) > refusal.local_max_bytes && needsResultSource(row);
          // An old local422 lacks a previous bound. This exact fenced live handoff must declare byte-bound recovery.
          const unknownLocalSize = refusal.path === '/handoffs/finish' && refusal.transport === 'result_source' && refusal.status === 422
            && !refusal.reason && !Number.isSafeInteger(refusal.local_max_bytes)
            && !(row.effect_updates ?? []).length && preservedResultBytes(row) > HANDOFF_RESULT_SOURCE.prior_max_bytes
            && preservedResultBytes(row) <= HANDOFF_RESULT_SOURCE.max_bytes;
          const waitingForService = refusal.reason === 'result_bytes_exceed_capability'
            && Number.isSafeInteger(refusal.result_bytes) && refusal.result_bytes <= HANDOFF_RESULT_SOURCE.max_bytes
            && refusal.supported_max_bytes < HANDOFF_RESULT_SOURCE.max_bytes;
          if (!legacyInline && !legacySource && !unsupported && !expandedLocal && !unknownLocalSize && !waitingForService) continue;
          row = { ...row, delivery_refusal: { ...refusal, checked_at: Date.now() } };
          completedInMemory.set(row.handoff_id, row); durableResults.put(row);
          // This endpoint always checks this handoff's current exact holder/generation and settled effects.
          capability = await sourceCapabilityFor(row);
          if (!capability || waitingForService && capability.max_bytes < refusal.result_bytes) continue;
          if (legacySource) {
            const version = capability.legacy_result_recovery?.version ?? capability.inline_history_recovery?.version;
            if (typeof version !== 'string' || !version || version === row.result_recovery_attempted_version) continue;
            recoveryVersion = version;
          }
          if (unknownLocalSize) {
            const recovery = capability.transport_limit_recovery, bytes = preservedResultBytes(row);
            if (typeof recovery?.version !== 'string' || !recovery.version || recovery.version === row.result_recovery_attempted_version
                || recovery.prior_max_bytes !== HANDOFF_RESULT_SOURCE.prior_max_bytes || recovery.result_byte_length !== bytes
                || recovery.max_bytes < bytes || capability.max_bytes < bytes) continue;
            recoveryVersion = recovery.version;
          }
          // Admission replaces the prior refusal. Lost replies/503s remain delivery retries; only a new final refusal fences them.
          row = { ...row, delivery_refusal: null };
          completedInMemory.set(row.handoff_id, row); durableResults.put(row);
        }
        await finishStored(row, { capability, recoveryVersion });
      } catch (error) { log({ mac_tools_result_send_failed: row.handoff_id, error: String(error.message ?? error) }); }
    }
  };
  // A renewed held lease is the same submission. A refusal remains final until the account actually offers a
  // different lease; avoid renewing/replaying a refused held job on every unrelated store revision.
  const refusedLease = (handoff_id, generation, agent_id) => {
    const row = completedInMemory.get(handoff_id) ?? durableResults?.get(handoff_id);
    // A later lease does not prove whether an interrupted native attempt changed its target.
    // Keep its original generation and evidence; do not execute or finish it under a new one.
    return row?.execution?.state === 'started' || Boolean(row?.delivery_refusal && row.generation === (generation ?? 0) && row.finish.agent_id === agent_id);
  };
  let queueCursor = 0;
  // Jobs an earlier run of this program held, by queue. The account names them only while the queue is full, so every
  // one it names is kept here and taken by name before new work: taking one frees no slot for the others to be named in.
  const earlier = new Map();
  const leftBy = (agent_id, held = []) => {
    const left = earlier.get(agent_id) ?? new Map();
    for (const item of held) left.set(item.handoff_id, item);
    for (const [id, item] of left) if (running.has(id) || refusedLease(id, item.generation, agent_id)) left.delete(id);
    earlier.set(agent_id, left);
    const [first] = left.values();
    if (first) left.delete(first.handoff_id);
    return first;
  };
  // Both address families share this one host, socket, renewal timer and execution limit. Round-robin queue
  // reads prevent either legacy work or exact-computer work from starving the other. A Mac never polls another ID.
  const takeOne = async () => {
    const queues = cards();
    for (let count = 0; count < queues.length; count++) {
      const { agent_id } = queues[queueCursor++ % queues.length];
      const kept = leftBy(agent_id);
      let answer = kept ? await call('/handoffs/take', { agent_id, handoff_id: kept.handoff_id }) : { handoff: null };
      if (!answer.handoff) answer = await call('/handoffs/take', { agent_id, only_mine: true });
      if (!answer.handoff) {
        const left = leftBy(agent_id, answer.held);
        if (left) answer = await call('/handoffs/take', { agent_id, handoff_id: left.handoff_id });
      }
      if (answer.handoff && !refusedLease(answer.handoff.handoff_id, answer.generation ?? answer.handoff.generation, agent_id))
        return { ...answer, agent_id };
    }
    return null;
  };
  let again = false;
  let wakeTaking = null;
  function takeAll() {
    if (stopped) return Promise.resolve();
    if (taking) { again = true; wakeTaking?.(); return taking; }
    taking = (async () => {
      const active = new Set();
      const limit = Math.max(1, Math.min(20, Number(settings.capacity?.max_concurrent) || 1));
      for (;;) {
        again = false;
        await drainResults();
        while (active.size < limit && !stopped) {
          const answer = await takeOne();
          if (!answer) {
            // takeOne also recovers jobs held by an earlier process before either queue is considered empty.
            break;
          }
          const id = answer.handoff.handoff_id;
          running.add(id);
          const work = (async () => {
            // The job's priority goes with it, so a tool that rests on failure rests only for work beneath this job.
            const handoff_id = answer.handoff.handoff_id;
            let row = completedInMemory.get(handoff_id) ?? durableResults?.get(handoff_id);
            if (row?.delivery_refusal) {
              const { delivery_refusal, ...retry } = row;
              row = retry;
              completedInMemory.set(handoff_id, row);
              durableResults?.put(row);
            }
            if (!row) {
              const effectUpdates = [];
              const save = value => {
                durableResults?.put(value);
                completedInMemory.set(handoff_id, value);
                row = value;
              };
              // Kept before dispatch: a lost reply or process stop cannot make this same host rerun an uncertain job.
              // Only the handoff/lease and fixed status are saved here, never its input or account credential.
              save({ handoff_id, generation: answer.generation ?? 0, finish: { handoff_id, agent_id: answer.agent_id,
                ...(answer.generation !== undefined ? { generation: answer.generation } : {}) },
                execution: { state: 'started', at: new Date().toISOString() }, effect_updates: [] });
              const result = await execute(settings, answer.handoff.input, { ...context, priority: answer.handoff.priority ?? 0,
                handoff_id, agent_id: answer.agent_id, generation: answer.generation,
                ...(durableResults?.createOutputWorkspace && durableResults?.stageOutputs ? { outputDelivery: {
                  createWorkspace: () => {
                    const workspace = durableResults.createOutputWorkspace(handoff_id, row.generation);
                    row = durableResults.get(handoff_id); completedInMemory.set(handoff_id, row);
                    return workspace;
                  },
                  stage: value => {
                    row = durableResults.stageOutputs(handoff_id, row.generation, value);
                    completedInMemory.set(handoff_id, row);
                  },
                } } : {}),
                recordProgress: progress => {
                  // Progress is fixed, bounded evidence only. App responses, arguments, paths and credentials stay out.
                  if (!['app-step-starting', 'app-step-returned', 'app-step-uncertain', 'app-output-saved'].includes(progress?.stage)) throw new Error('Native progress needs a known stage.');
                  const selected = { stage: progress.stage };
                  for (const name of ['step', 'total_steps', 'returned_steps', 'saved_outputs']) {
                    if (progress[name] !== undefined) {
                      if (!Number.isSafeInteger(progress[name]) || progress[name] < 0 || progress[name] > 32) throw new Error('Native progress counts must be within one app job.');
                      selected[name] = progress[name];
                    }
                  }
                  for (const name of ['ok', 'uncertain']) if (typeof progress[name] === 'boolean') selected[name] = progress[name];
                  if (progress.file !== undefined) {
                    if (!/^1f:[a-f0-9]{64}$/.test(progress.file?.identity) || !Number.isSafeInteger(progress.file?.bytes) || progress.file.bytes < 0) throw new Error('Native progress needs a saved file identity and byte count.');
                    selected.file = { identity: progress.file.identity, bytes: progress.file.bytes };
                  }
                  const execution = { ...row.execution, progress: selected };
                  if (selected.step !== undefined) {
                    execution.steps = [...(execution.steps ?? []).filter(item => item.step !== selected.step),
                      { step: selected.step, stage: selected.stage, ...(selected.ok !== undefined ? { ok: selected.ok } : {}), ...(selected.uncertain !== undefined ? { uncertain: selected.uncertain } : {}) }].sort((a, b) => a.step - b.step);
                  }
                  if (selected.file) execution.files = [...(execution.files ?? []), selected.file].slice(-32);
                  if (selected.uncertain === true) execution.uncertain = true;
                  save({ ...row, execution });
                },
                recordEffect: async effect => {
                  const request = { ...effect, handoff_id, agent_id: answer.agent_id, generation: answer.generation };
                  const settled = effect.state === 'done' || effect.state === 'failed';
                  if (settled) {
                    effectUpdates.push(request);
                    save({ ...row, effect_updates: effectUpdates.slice() });
                  }
                  try {
                    const recorded = await call('/handoffs/effect', request);
                    if (settled) {
                      effectUpdates.splice(effectUpdates.indexOf(request), 1);
                      save({ ...row, effect_updates: effectUpdates.slice() });
                    }
                    return recorded;
                  } catch (error) {
                    if (!settled) throw error;
                    return { pending: true };
                  }
                } });
              if (result?.uncertain === true || row.execution.uncertain === true
                  || row.execution.steps?.some(step => step.stage === 'app-step-starting' || step.uncertain === true)) {
                // No complete reply is retained or submitted for an uncertain attempt; fixed progress survives.
                save({ ...row, execution: { ...row.execution, state: 'started', uncertain: true }, effect_updates: effectUpdates.slice() });
              } else if (row.output_delivery && result?.output_delivery_pending === true) {
                save({ ...row, effect_updates: effectUpdates.slice() });
              } else if (row.output_workspace && !row.output_delivery && result?.error) {
                // A refused checkpoint cannot make already-produced bytes disposable or admit an app replay.
                save({ ...row, execution: { ...row.execution, state: 'started', output_staging_refused: true }, effect_updates: effectUpdates.slice() });
              } else save({ ...row, execution: { ...row.execution, state: 'returned' }, finish: { ...row.finish,
                result, summary: result.error ?? 'This Mac answered.' }, effect_updates: effectUpdates.slice() });
            } else if (answer.generation !== undefined && (row.generation !== answer.generation || row.finish.agent_id !== answer.agent_id)) {
              // A later lease may have a new generation. Reuse the completed result, but finish the current lease.
              row = { ...row, generation: answer.generation,
                finish: { ...row.finish, agent_id: answer.agent_id, generation: answer.generation },
                effect_updates: (row.effect_updates ?? []).map(effect => ({ ...effect, agent_id: answer.agent_id, generation: answer.generation })) };
              completedInMemory.set(handoff_id, row);
              durableResults?.put(row);
            }
            if (!(await finishStored(row))) return;
            const result = row.finish.result;
            log({ mac_tool: answer.handoff.input?.tool_id, ok: !result.error });
          })().catch(error => log({ mac_tools_take_failed: String(error.message ?? error) })).finally(() => running.delete(id));
          active.add(work);
          work.finally(() => active.delete(work));
        }
        if (again) continue;
        if (active.size === 0) break;
        if (active.size === limit) await Promise.race(active);
        else {
          const revision = new Promise(resolve => { wakeTaking = resolve; if (again) resolve(); });
          await Promise.race([Promise.race(active), revision]);
          wakeTaking = null;
        }
      }
    })().finally(() => {
      taking = null;
      wakeTaking = null;
      if (again) takeLater();
    });
    return taking;
  }
  // Every change to the person's store is a revision (an upload in progress makes several a second), so the take that
  // follows is held to one per take_gap_ms: one quiet take covers every revision that arrived while it waited.
  let takeSoon = null;
  let lastTake = 0;
  const takeLater = () => {
    if (stopped) return;
    if (takeSoon) return;
    takeSoon = timers.setTimeout(() => { takeSoon = null; lastTake = Date.now(); takeAll().catch(error => log({ mac_tools_take_failed: String(error.message ?? error) })); }, Math.max(0, lastTake + settings.take_gap_ms - Date.now()));
  };
  let attempt = 0;
  const listen = () => {
    if (stopped) return;
    socket = connect();
    socket.addEventListener('open', () => { attempt = 0; takeLater(); });
    socket.addEventListener('message', takeLater);
    socket.addEventListener('close', () => {
      if (stopped) return;
      const wait = settings.live_retry_ms[Math.min(attempt, settings.live_retry_ms.length - 1)];
      attempt += 1;
      reconnect = timers.setTimeout(() => {
        reconnect = null;
        if (stopped) return;
        publish().catch(() => {}).finally(() => { if (!stopped) listen(); });
      }, wait);
    });
    socket.addEventListener('error', () => {});
  };
  let beginning = null;
  function begin(initialize = null) {
    if (beginning) return beginning;
    beginning = beginOnce(initialize);
    return beginning;
  }
  async function beginOnce(initialize) {
    if (stopped) return;
    if (initialize) for (let attempt = 0;; attempt += 1) {
      if (stopped) return;
      try { await initialize({ isStopped: () => stopped, wait: waitForOwner }); break; }
      catch (error) {
        if (stopped) return;
        if (!error?.account_identity_unavailable) throw error;
        const delays = settings.account_identity_retry_ms ?? settings.live_retry_ms;
        const wait = delays[Math.min(attempt, delays.length - 1)];
        log({ mac_tools_identity_unavailable: String(error.message ?? error), again_in_ms: wait });
        await waitForOwner(wait);
      }
    }
    if (stopped) return;
    // Tools that pick up where they left off after a restart (settings.on_start), before any new run is taken.
    for (const row of settings.on_start ?? []) {
      if (stopped) return;
      const module = await import(entryOf(row));
      const fn = functionOf(module, row);
      await leases.lease('on_start', () => Promise.resolve().then(() => (row.workshop ? fn?.({}, workshopContext(row, context)) : fn?.()))).catch(error => log({ mac_tools_on_start_failed: row.name ?? row.function, error: String(error.message ?? error) }));
    }
    // What the account has installed decides the card and the programs; a look that fails leaves the legacy or saved set.
    if (refresh) await leases.lease('refresh', () => Promise.resolve().then(refresh)).catch(error => log({ mac_tools_refresh_failed: String(error.message ?? error) }));
    // A busy account during startup must not leave this helper silent until its process is restarted.
    for (let attempt = 0;; attempt += 1) {
      if (stopped) return;
      try { await publish(); break; }
      catch (error) {
        const message = String(error.message ?? error);
        if (!mayRetry(error)) throw error;
        const wait = settings.live_retry_ms[Math.min(attempt, settings.live_retry_ms.length - 1)];
        log({ mac_tools_publish_failed: message, again_in_ms: wait });
        await waitForOwner(wait);
      }
    }
    if (stopped) return;
    renew = timers.setInterval(() => {
      if (stopped) return;
      (refresh ? Promise.resolve().then(refresh).catch(error => log({ mac_tools_refresh_failed: String(error.message ?? error) })) : Promise.resolve())
        .then(() => (stopped ? undefined : publish())).then(() => { if (!stopped) return takeAll(); })
        .catch(error => log({ mac_tools_renew_failed: String(error.message ?? error) }));
    }, settings.renew_minutes * 60_000);
    listen();
    takeAll().catch(error => log({ mac_tools_take_failed: String(error.message ?? error) }));
  }
  async function stop() {
    stopped = true;
    if (takeSoon) timers.clearTimeout?.(takeSoon);
    if (renew) timers.clearInterval?.(renew);
    if (reconnect) timers.clearTimeout?.(reconnect);
    for (const row of ownerDelays) {
      timers.clearTimeout?.(row.handle);
      row.finish();
    }
    socket?.close();
    if (taking) await taking;
    if (pendingPublishes.size) await Promise.allSettled([...pendingPublishes]);
  }
  return { publish, takeAll, begin, stop, setResultOutbox: outbox => { durableResults = outbox; } };
}

// POST by default (every call the host makes sends a body); a GET sends none and gives up after thirty seconds, so a
// look at the account never holds the card back for long. Writes have the same deadline: a lost response must
// return to the existing retry and durable-result owners rather than freezing publication and taking forever.
export class MacToolsHttpError extends Error {
  constructor(path, status, message, reply = {}, retryAfter = null) {
    super(`${path}: ${message ?? status}`);
    this.name = 'MacToolsHttpError';
    this.path = path;
    this.status = status;
    // Only this response header crosses the account verifier adapter; no other header or credential is retained.
    this.retry_after = typeof retryAfter === 'string' ? retryAfter : null;
    if (['request_too_large', 'record_read_too_large'].includes(reply.result_transport_code)) this.result_transport_code = reply.result_transport_code;
  }
}

export const callerOf = (origin, key, fetchImpl = fetch) => async (path, body, method = body === undefined ? 'GET' : 'POST', { signal: callerSignal } = {}) => {
  const get = method === 'GET';
  const deadline = AbortSignal.timeout(30_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const answer = await fetchImpl(`${origin}/mcp/api${path}`, get
    ? { method, headers: { authorization: `Bearer ${key}` }, signal }
    : { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal });
  const value = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new MacToolsHttpError(path, answer.status, value.error, value, answer.headers?.get('retry-after'));
  return value;
};

/** Starts account-bound native work only after the existing caller verifies an opaque account id. */
export async function beginVerifiedMacHost({ origin, key, call, fetchImpl = fetch, wait, settings, setResultOutbox, begin, makeOutbox = nativeResultOutbox, isStopped = () => false }) {
  const accountFetch = call ? async (_url, init) => {
    try { return Response.json(await call('/account', undefined, 'GET', { signal: init.signal })); }
    catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 503,
      ...(typeof error.retry_after === 'string' ? { headers: { 'retry-after': error.retry_after } } : {}) }); }
  } : fetchImpl;
  const accountId = await verifiedAccountId(origin, key, accountFetch, wait, isStopped);
  if (isStopped()) return;
  if (!accountId) {
    const error = new Error('The Trillion account identity could not be verified.');
    error.account_identity_unavailable = true;
    throw error;
  }
  setResultOutbox(makeOutbox({ ...settings.result_outbox, accountId, origin }));
  if (isStopped()) return;
  return begin();
}

/** harness/wake-sessions.mjs handler entry: runs beside the connection with the helper's key and origin. */
export function start({ key, origin, log: plainLog = () => {}, argv = process.argv, call = null, spawn, settings = settingsOf(), home, egress = egressRelaySettings() }) {
  const log = hostLog({ settings, log: plainLog, ...(home ? { home } : {}) });
  const at = origin ?? settings.origin;
  const caller = call ?? callerOf(at, key);
  const programs = makeProgramHost({ settings, call: caller, key, manage: startedByApp(settings, argv), log: policedLog(log), ...(spawn ? { spawn } : {}) });
  registerHost(programs);
  const host = macTools({
    settings, call: caller, context: { origin: at, key }, log,
    installed: programs.toolIds, refresh: programs.reconcile,
    connect: () => new WebSocket(`${at.replace(/^http/, 'ws')}/mcp/api/live`, { headers: { authorization: `Bearer ${key}` } }),
  });
  host.begin(({ isStopped, wait }) => beginVerifiedMacHost({ origin: at, key, call: caller, settings, setResultOutbox: outbox => host.setResultOutbox(outbox), begin: programs.resume, isStopped, wait }))
    .catch(error => log({ mac_tools_start_failed: String(error.message ?? error) }));
  process.once('exit', programs.killAll);
  // The opt-in local road (computer/local-socket.json): the same runner the account's runs use, answered on a socket only this person's programs reach.
  const road = startLocalSocket({ run: request => runHere(settings, request, { origin: at, key }), log }).catch(error => { log({ local_socket_start_failed: String(error.message ?? error) }); return null; });
  // The opt-in "use my connection" relay (computer/egress-relay.json `on`) attaches beside the live connection.
  const relay = egress.on === true
    ? makeEgressRelay({ settings: egress, log, connect: headers => new WebSocket(`${at.replace(/^http/, 'ws')}${egress.path}`, { headers: { authorization: `Bearer ${key}`, ...headers } }) })
    : null;
  relay?.start();
  return { ...host, log, relay, stop: async () => { relay?.stop(); const stoppedHost = host.stop(); await programs.stop(); await stoppedHost; await (await road)?.close(); log.close(); } };
}

export const wants = () => false;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The app that starts this hands it the personal key on the first line of stdin; nothing here reads a key store.
  let key = '';
  for await (const chunk of process.stdin) { key += chunk; if (key.includes('\n')) break; }
  key = key.split('\n')[0].trim();
  if (!key) throw new Error('No personal key: give it on the first line of stdin.');
  start({ key, origin: settingsOf().origin, log: line => process.stderr.write(`${JSON.stringify(line)}\n`) });
}
