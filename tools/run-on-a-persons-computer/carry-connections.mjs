// computer/carry-connections.mjs
//
// Purpose
//   The Trillion helper on a person's own computer (a client program like agent-receiver.mjs, extension/ and ios/, never
//   part of the hosted service). It carries the connections only this computer can reach, such as iMessage in Messages
//   on a Mac or a WhatsApp linked device, so the person's AIs can send and read messages through them:
//     1. It publishes itself as an agent on the person's account whose skills name what it carries
//        (connection:<vendor>) or can connect (connectable:<vendor>), and renews its capacity.
//     2. It holds the account's live socket (/mcp/api/live, which carries only a revision) and, whenever the account
//        changes, takes the work handed to it by name (take_work only_mine) and finishes it with what happened.
//   The hosted side (src/carried-connections.mjs) hands it { connection, verb, ...fields } when an AI calls send_message
//   or read_recent_messages; this program runs that verb on the named connection's module and nothing else.
//
//   node computer/carry-connections.mjs                          carry every connection this computer can
//   node computer/carry-connections.mjs --link whatsapp --phone <digits>   link WhatsApp once (shows the phone code)
//   node computer/carry-connections.mjs --adopt whatsapp --from <folder>   take over a session linked here before
//   [--origin https://app.gettrillion.ai] [--keychain-item <name>]
//
// Non-negotiable invariants
//   1. The personal key is read from the macOS Keychain (or the first line of stdin), held in memory, and sent only in
//      the Authorization header.
//   2. Only work addressed to this computer is taken, and only a verb its connection module has runs; anything else is
//      finished with words saying so, never left hanging.
//   3. A request older than stale_after_minutes is never sent; a request already done here (kept by handoff id) is
//      finished again with its kept result, never sent twice.
//   4. No service is named in this file: connections, verbs' modules and words are DATA in carry-connections.json.
//
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { accountCaller, fileKeeper } from './read-this-computer.mjs';
import { endWithTheApp } from './end-with-the-app.mjs';
import { reconcile } from './reconcile-fields.mjs';
import { accountKeyOrNull } from '../harness/account-key.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const home = path => String(path).replace(/^~(?=\/|$)/, homedir());

/**
 * The carrier's core, with every outside effect handed in (so tests run it with fakes).
 * settings:    carry-connections.json
 * connections: Map vendor → { row, module }   (module: start, send/read..., optional carried())
 * call:        (path, body) → answer JSON     (the account's /mcp/api routes)
 * computer:    this computer's name
 * kept:        { get(handoff_id), put(handoff_id, result) }   results already done here
 */
export function makeCarrier({ settings, connections, call, computer, kept, now = () => Date.now(), log = () => {} }) {
  const agent_id = `${settings.agent_id_prefix}${computer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const state = new Map();
  // The card the account last accepted from this computer.
  let heldCard = null;

  // A module that knows moment to moment (a socket that can drop) says so itself; otherwise what start() found holds.
  const carried = () => [...connections].filter(([vendor, { module }]) => (module.carried ? module.carried() : state.get(vendor)?.carried === true));

  // Starts every connection, or (again: true) only those not carried yet whose modules cannot say so themselves, so a
  // permission granted after the helper started (Automation for Messages) is picked up at the next renewal.
  async function start({ again = false } = {}) {
    for (const [vendor, { module }] of connections) {
      if (again && state.has(vendor) && (state.get(vendor).carried || module.carried?.())) continue;
      const answer = await module.start().catch(error => ({ carried: false, why: String(error.message ?? error) }));
      state.set(vendor, answer);
      log({ connection: vendor, ...answer });
    }
  }

  async function publish() {
    await start({ again: true });
    const now_carried = carried();
    const skills = [
      ...now_carried.map(([vendor, { row }]) => ({ id: `${settings.skill_prefix}${vendor}`, name: row.label, description: state.get(vendor)?.account ?? row.label })),
      ...[...connections].filter(([, { module }]) => typeof module.connect === 'function').map(([vendor, { row }]) => ({ id: `${settings.connect_skill_prefix}${vendor}`, name: `Connect ${row.label}`, description: `Can start ${row.label} setup on ${computer}` })),
    ];
    const card = {
      agent_id,
      name: fill(settings.agent_name, { computer }),
      description: fill(settings.agent_description, { computer, carried: now_carried.map(([, { row }]) => row.label).join(', ') || '-' }),
      skills, where: computer, harness: settings.harness, takes_work: true, capacity: settings.capacity,
    };
    // The card goes again only when the account does not already hold it (computer/reconcile-fields.mjs); presence is the renewal.
    const difference = reconcile(card, heldCard);
    if (!difference.holds) { await call('/agents/publish', card); heldCard = structuredClone(card); }
    await call('/agents/presence', { agent_id });
    log({ published: agent_id, carries: now_carried.map(([vendor]) => vendor), card_changed: difference.changed });
  }

  // One job: run its verb on its connection, answer in words when it cannot.
  async function run(handoff) {
    const input = handoff.input ?? {};
    const earlier = kept.get(handoff.handoff_id);
    if (earlier) return earlier;
    const { connection: vendor, verb, ...fields } = input;
    const entry = connections.get(vendor);
    const operation = Object.hasOwn(settings.verbs ?? {}, verb) ? settings.verbs[verb] : null;
    if (!operation || !entry || !Object.hasOwn(entry.module, verb) || typeof entry.module[verb] !== 'function') {
      return { sent: false, error: fill(settings.words.unknown_verb, { verb, vendor }) };
    }
    if (operation.availability === 'connectable' ? typeof entry.module.connect !== 'function' : !carried().some(([name]) => name === vendor)) {
      return { sent: false, error: fill(settings.words.not_carried, { vendor, why: state.get(vendor)?.why ?? '' }) };
    }
    if (now() - Date.parse(handoff.handed_at ?? 0) > settings.stale_after_minutes * 60_000) return { sent: false, error: fill(settings.words.too_old, { minutes: settings.stale_after_minutes }) };
    try {
      const result = await entry.module[verb](fields);
      if (operation.cache !== false) kept.put(handoff.handoff_id, result);
      return result;
    } catch (error) {
      return { sent: false, error: fill(settings.words.failed, { error: String(error.message ?? error) }) };
    }
  }

  // Take and finish everything addressed here, one at a time.
  let taking = null;
  let again = false;
  async function takeAll() {
    if (taking) { again = true; return taking; }
    taking = (async () => {
      do {
        again = false;
        for (;;) {
          const answer = await call('/handoffs/take', { agent_id, only_mine: true });
          if (!answer.handoff) break;
          const result = await run(answer.handoff);
          await call('/handoffs/finish', { handoff_id: answer.handoff.handoff_id, agent_id, result });
          log({ finished: answer.handoff.handoff_id, verb: answer.handoff.input?.verb, connection: answer.handoff.input?.connection, ok: result.sent !== false && !result.error });
        }
      } while (again);
    })().finally(() => { taking = null; });
    return taking;
  }

  return { agent_id, start, publish, takeAll, run, carried };
}

/** Results already done on this computer, kept in a small file by handoff id (newest `limit`). */
export function keptResults(file, limit) {
  let items = [];
  try { items = JSON.parse(readFileSync(file, 'utf8')); } catch { items = []; }
  return {
    get: id => items.find(item => item.handoff_id === id)?.result ?? null,
    put(id, result) {
      items = [...items.filter(item => item.handoff_id !== id), { handoff_id: id, result }].slice(-limit);
      writeFileSync(file, JSON.stringify(items));
    },
  };
}

/** The modules DATA names, each made with its own row. */
export async function loadConnections(settings, helpers) {
  const found = new Map();
  for (const row of settings.connections) {
    const made = (await import(new URL(row.module, import.meta.url)))[row.export];
    found.set(row.vendor, { row, module: made(row, helpers) });
  }
  return found;
}

async function main(argv) {
  const settings = JSON.parse(readFileSync(new URL('./carry-connections.json', import.meta.url), 'utf8'));
  const pairs = Object.fromEntries(argv.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), argv[index + 1]?.startsWith('--') ? 'true' : argv[index + 1] ?? 'true']] : [])));
  const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const folder = home(settings.state_folder);
  mkdirSync(folder, { recursive: true });
  let carrier = null;
  let keepVoiceNote = async () => { throw new Error('The computer has not connected to Trillion yet.'); };
  const keepVoiceNoteBridge = file => keepVoiceNote(file);
  keepVoiceNoteBridge.readCached = name => keepVoiceNote.readCached?.(name) ?? null;
  const connections = await loadConnections(settings, { log, keepFile: keepVoiceNoteBridge, changed: () => carrier?.publish().catch(error => log({ publish_failed: String(error.message) })) });

  if (pairs.adopt) {
    log({ adopt: pairs.adopt, ...connections.get(pairs.adopt).module.adopt(pairs.from) });
    return;
  }
  if (pairs.link) {
    const answer = await connections.get(pairs.link).module.link({ phone: pairs.phone, onCode: code => log({ link: pairs.link, code, where: 'On your phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then type this code.' }) });
    log({ link: pairs.link, ...answer });
    process.exit(answer.open ? 0 : 1);
  }

  const origin = (pairs.origin ?? settings.origin).replace(/\/$/, '');
  const item = pairs['keychain-item'] ?? settings.keychain_item;
  let key;
  if (pairs['key-stdin']) {
    for await (const line of createInterface({ input: process.stdin })) { key = line.trim(); break; }
  } else {
    key = accountKeyOrNull({ item, timeout: 0 });
    if (!key) {
      for await (const line of createInterface({ input: process.stdin })) { key = line.trim(); break; }
    }
  }
  if (!key) throw new Error(`No personal key: put one in the Keychain item ${item}, or give it on the first line of stdin.`);
  // Started by the app: ends with it (computer/end-with-the-app.mjs).
  if (pairs['key-stdin']) endWithTheApp();
  const lock = join(folder, 'carrier.lock');
  const takeLock = () => {
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(lock, 'utf8'));
      if (holder && holder !== process.pid) {
        try { process.kill(holder, 0); return false; }
        catch (failure) { if (failure.code === 'EPERM') return false; }
      }
      unlinkSync(lock);
      return takeLock();
    }
  };
  if (!takeLock()) {
    log({ carrier: 'already_running' });
    return;
  }
  process.on('exit', () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) unlinkSync(lock); } catch {} });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => process.exit(0));
  const call = async (path, body) => {
    const answer = await fetch(`${origin}/mcp/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const value = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(`${path}: ${value.error ?? answer.status}`);
    return value;
  };
  const keepFile = fileKeeper(accountCaller(origin, key), '/WhatsApp voice notes', { origin, key });
  keepVoiceNote = async file => {
    const local = join(folder, 'voice-notes', file.name);
    mkdirSync(join(folder, 'voice-notes'), { recursive: true, mode: 0o700 });
    if (!existsSync(local)) writeFileSync(local, file.bytes, { mode: 0o600 });
    const stored = await keepFile({ path: local, name: file.name, media_type: file.media_type });
    unlinkSync(local);
    return stored;
  };
  keepVoiceNote.readCached = name => {
    const local = join(folder, 'voice-notes', name);
    return existsSync(local) ? readFileSync(local) : null;
  };
  let computer = hostname();
  try { computer = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim() || computer; } catch { /* not a Mac: the host name */ }
  carrier = makeCarrier({ settings, connections, call, computer, kept: keptResults(join(folder, 'done.json'), settings.kept_results), log });
  await carrier.publish();
  await carrier.takeAll();
  setInterval(() => carrier.publish().then(() => carrier.takeAll()).catch(error => log({ renew_failed: String(error.message) })), settings.renew_every_minutes * 60_000);

  // The live socket: every revision means "something changed", so ask for this computer's work.
  let attempt = 0;
  let takeSoon = null;
  let lastTake = 0;
  const listen = () => {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/mcp/api/live`, { headers: { authorization: `Bearer ${key}` } });
    socket.addEventListener('open', () => { attempt = 0; log({ live: 'open' }); });
    // Every change to the person's store is a revision (an upload in progress makes several a second), so the take
    // that follows is held to one per take_gap_ms: one quiet take covers every revision that arrived while it waited.
    socket.addEventListener('message', () => {
      if (takeSoon) return;
      takeSoon = setTimeout(() => { takeSoon = null; lastTake = Date.now(); carrier.takeAll().catch(error => log({ take_failed: String(error.message) })); }, Math.max(0, lastTake + settings.take_gap_ms - Date.now()));
    });
    socket.addEventListener('close', () => {
      const wait = settings.live_retry_ms[Math.min(attempt, settings.live_retry_ms.length - 1)];
      attempt += 1;
      log({ live: 'closed', retry_in_ms: wait });
      setTimeout(listen, wait);
    });
    socket.addEventListener('error', () => {});
  };
  listen();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
}
