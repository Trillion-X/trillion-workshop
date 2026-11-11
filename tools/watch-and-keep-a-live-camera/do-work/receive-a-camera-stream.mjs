#!/usr/bin/env node
// parts/receive-a-camera-stream/do-work/receive-a-camera-stream.mjs
//
// Purpose: take a camera's live stream on this computer and send it where the person's own rows say. Run by the
// Trillion Mac app as one of its children (macos/computer-reader.json), it reads four lists in the person's account
// (stream-settings.json `lists`): the kinds, the ways in (the one address a camera is set to), the destinations, and
// the cameras. For each camera this computer takes, it opens the camera's way in, picks its destination (the
// Destination cell, or the first ready one of Automatic) and runs that destination's capability, a module in
// `capabilities_folder` named by the kind's Capability cell. Changing the cell switches where the stream goes at the
// next read of the cameras list (`read_rows_every_seconds.cameras`); the other lists are read every
// `read_rows_every_seconds.all` (the store is shared, so a quiet computer asks it little); the camera keeps its address.
//
//   node receive-a-camera-stream.mjs --key-stdin [--settings <stream-settings.json>]
//
// Non-Negotiable Invariants:
//   1. The lists and the starting rows are made only when missing: a row the person changed is never written back
//      over, except its Now cell and the address cells this computer is the source of (a way in's address).
//   2. A capability is only ever a carried module in `capabilities_folder` whose name is the kind's Capability cell
//      (letters, digits and dashes); nothing named by a row is fetched or run from anywhere else.
//   3. A camera's stream key is made once, kept in this computer's keychain and in the person's Saved logins, and
//      never written in a row or a log; a stream sent with another key is cut off (take-a-stream.mjs).
//   4. One listener per camera at a time: switching stops the running capability before the next starts.
//   5. A receiver set up by hand on this computer (`take_over_launch_agents`) is stopped and its file put in the
//      Trash once this program is about to listen, and the pieces it left are sent into the person's files too.
//   6. A busy or unanswering account leaves everything running as it was; rows are read again next round.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keepHeld, readHeld } from '../../receive-files-over-ftp/do-work/keychain.mjs';
import { accountTools } from '../../receive-files-over-ftp/do-work/tell-the-account.mjs';
import { loadChunking } from '../../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { bearerControl, namespaceClient } from '../../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { fetchWithoutCopies } from '../../browse-and-upload-my-files/do-work/send-without-copies.mjs';
import { endWithTheApp } from '../../../computer/end-with-the-app.mjs';
import { piecesSender } from './capabilities/file-pieces-into-trillion.mjs';
import { appDataFolder } from '../../process-session/do-work/computer-data-folder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SETTINGS = path.join(HERE, '..', 'stream-settings.json');

export const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const filled = (value, values) => (Array.isArray(value) ? value.map(item => filled(item, values)) : typeof value === 'string' ? fill(value, values) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, values)])) : value);
export const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** The row ids a link cell holds: one id, a list of ids, or rows. */
export const linked = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => (item && typeof item === 'object' ? item.id : item)).filter(Boolean);
const turnedOn = row => row && row.values.turned_on !== 'Off';
const run = (command, args) => new Promise(resolve => execFile(command, args, { encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : stdout.trim())));
/** An account tool's answer as data: its structured content, or the JSON its text holds. */
export const answerOf = result => { if (!result?.content) return result; const text = result.content.map(item => item.text ?? '').join(''); try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { text }; } };

/** This computer's names: { computer: short id for row ids, computer_name: what the person calls it }. */
export async function computerNames() {
  const name = (process.platform === 'darwin' ? await run('/usr/sbin/scutil', ['--get', 'ComputerName']) : '') || os.hostname();
  const local = (process.platform === 'darwin' ? await run('/usr/sbin/scutil', ['--get', 'LocalHostName']) : '') || os.hostname();
  return { computer: slug(local), computer_name: name };
}

/** The carried capability module `name` (stream-settings.json `capabilities_folder`), or null when none is carried. */
export function capabilities(settings, folder = path.join(HERE, '..', settings.capabilities_folder)) {
  const loaded = new Map();
  return async name => {
    if (!/^[a-z0-9-]+$/.test(String(name ?? ''))) return null;
    if (!loaded.has(name)) {
      const file = path.join(folder, `${name}.mjs`);
      loaded.set(name, existsSync(file) ? await import(pathToFileURL(file).href) : null);
    }
    return loaded.get(name);
  };
}

/**
 * Picks where a camera's stream goes now: the first destination in its Automatic cell that is turned on and ready,
 * when that cell is filled; otherwise its Destination cell, when that row is turned on. `ready` is a Map of row id to
 * true/false. Answers the destination row or null.
 */
export function chooseDestination(camera, destinations, ready) {
  const automatic = linked(camera.values.automatic);
  if (automatic.length) return automatic.map(id => destinations.get(id)).find(row => turnedOn(row) && ready.get(row.id)) ?? null;
  const row = destinations.get(linked(camera.values.destination)[0]);
  return turnedOn(row) ? row : null;
}

/** Keeps the four lists and the starting rows this computer can serve, each only when missing. Answers the rows. */
export async function keepTheLists({ settings, call, names, capabilityOf, ctx }) {
  const have = new Map((answerOf(await call('list_lists', {})).lists ?? []).map(list => [list.id, list]));
  for (const list of Object.values(settings.lists)) {
    const kept = have.get(list.id);
    if (!kept) {
      const made = answerOf(await call('save_list', { label: list.label, fields: list.fields, row_type: list.row_type, title_field: list.title_field, icon: list.icon, about: list.about }));
      const id = made?.list?.id ?? made?.id;
      if (id && id !== list.id) throw new Error(`The list "${list.label}" was kept as ${id}, not ${list.id}.`);
    } else {
      const missing = list.fields.filter(field => !kept.fields.some(item => item.id === field.id));
      if (missing.length) await call('save_list', { id: list.id, fields: [...kept.fields, ...missing] });
    }
  }
  const rows = await readRows({ settings, call });
  const values = { computer: names.computer, computer_name: names.computer_name };
  const start = settings.starting_rows;
  const kinds = start.kinds.filter(row => !rows.kinds.has(row.id));
  if (kinds.length) await call('put_list_rows', { list_id: settings.lists.kinds.id, rows: kinds });
  for (const side of ['ways_in', 'destinations']) {
    const adding = [];
    for (const row of start[side]) {
      const id = fill(row.id, values);
      if (rows[side].has(id)) continue;
      const capability = await capabilityOf(start.kinds.find(kind => kind.id === row.kind)?.values.capability);
      if (!capability || !(await capability.available(ctx))) continue;
      adding.push({ id, values: { ...filled(row.values, values), kind: [row.kind], computer: names.computer } });
    }
    if (adding.length) await call('put_list_rows', { list_id: settings.lists[side].id, rows: adding });
  }
  if (noCameraYet(rows.cameras)) {
    const after = await readRows({ settings, call });
    const camera = filled(start.camera, values);
    const wayIn = camera.way_in_first.find(id => after.ways_in.has(id));
    if (wayIn && after.destinations.has(camera.destination)) await call('put_list_rows', { list_id: settings.lists.cameras.id, rows: [{ id: camera.id, values: { ...camera.values, way_in: [wayIn], destination: [camera.destination], computer: names.computer } }] });
  }
  return readRows({ settings, call });
}
// A person with no camera row yet gets one; a person who has camera rows (on any computer) keeps exactly those.
const noCameraYet = cameras => cameras.size === 0;

/** The rows of the four lists, each a Map of row id to row; with `kept`, only the cameras list is read again. */
export async function readRows({ settings, call, kept = null }) {
  const read = async list => new Map((answerOf(await call('read_list', { list_id: list.id })).rows ?? []).map(row => [row.id, row]));
  if (kept) return { ...kept, cameras: await read(settings.lists.cameras) };
  const [kinds, ways_in, destinations, cameras] = await Promise.all([settings.lists.kinds, settings.lists.ways_in, settings.lists.destinations, settings.lists.cameras].map(read));
  return { kinds, ways_in, destinations, cameras };
}

/** A camera's stream key: kept in this computer's keychain, made once and kept in the person's Saved logins too. */
export async function cameraKey({ settings, camera, call, address, read = readHeld, keep = keepHeld }) {
  const rule = settings.listen.key;
  const service = `${rule.keychain_service}.${camera.id}`;
  const held = await read(service);
  if (held) return held;
  const key = Array.from({ length: rule.length }, () => rule.alphabet[randomInt(rule.alphabet.length)]).join('');
  await keep(service, key);
  await call('save_login', { title: fill(rule.login_title, { camera: camera.values.camera }), site: address ?? 'rtmp', user_name: rule.login_user, fields: [{ label: rule.field, value: key }] });
  return key;
}

/** Stops each hand-made receiver (`take_over_launch_agents`) and answers the folders its pieces are in. */
export async function takeOverLaunchAgents({ settings, say, home = os.homedir(), runImpl = run }) {
  const folders = [];
  for (const label of settings.take_over_launch_agents?.labels ?? []) {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsSync(plist)) continue;
    let args = [];
    try { args = JSON.parse(await runImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).ProgramArguments ?? []; } catch {}
    const last = args.at(-1);
    if (last && path.isAbsolute(last)) folders.push(path.dirname(last));
    await runImpl('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    await runImpl('/usr/bin/trash', [plist]);
    say(`The Trillion app takes camera streams now; the receiver set up by hand (${label}) was stopped and its file put in the Trash.`);
  }
  if (folders.length) await new Promise(resolve => setTimeout(resolve, 2000));
  return folders;
}

/**
 * The round that makes this computer match the rows: each camera it takes (its Computer cell is this computer, or
 * empty) on its own port, its way in open, its destination's capability running. `keyStore` { read, keep } holds
 * each camera's stream key (this computer's keychain). Answers { round(), stop() }.
 */
export function followTheRows({ settings, ctx, call, names, capabilityOf, keyStore = { read: readHeld, keep: keepHeld } }) {
  const sessions = new Map(); // camera id -> { signature, running, state }
  const doors = new Map(); // way in id -> { port, opened }
  const written = new Map(); // list id + row id -> JSON of the values last written
  const words = settings.words;

  async function write(list, id, values) {
    const key = `${list.id}/${id}`, json = JSON.stringify(values);
    if (written.get(key) === json) return;
    await call('put_list_rows', { list_id: list.id, rows: [{ id, values }] });
    written.set(key, json);
  }

  let kept = null, keptAt = 0;
  const ready = new Map(); // destination row id -> whether its capability is ready
  async function round() {
    const whole = !kept || Date.now() - keptAt >= settings.read_rows_every_seconds.all * 1000;
    const rows = await readRows({ settings, call, kept: whole ? null : kept });
    if (whole) { kept = rows; keptAt = Date.now(); }
    const mine = [...rows.cameras.values()].filter(camera => !camera.values.computer || camera.values.computer === names.computer).sort((a, b) => a.id.localeCompare(b.id));
    const capabilityFor = async row => capabilityOf(linked(row?.values.kind).map(id => rows.kinds.get(id)?.values.capability).find(Boolean));
    // Whether each destination is ready is asked again only with the whole read (a relay asks the account for its key).
    if (whole) ready.clear();
    for (const row of rows.destinations.values()) {
      if (ready.has(row.id)) continue;
      if (!turnedOn(row) || (row.values.computer && row.values.computer !== names.computer)) { ready.set(row.id, false); continue; }
      const capability = await capabilityFor(row);
      ready.set(row.id, Boolean(capability && (await capability.ready({ ctx, row, settings })).ready));
    }
    const wanted = new Set();
    for (const [index, camera] of mine.entries()) {
      const port = settings.listen.first_port + index;
      if (!camera.values.computer) await write(settings.lists.cameras, camera.id, { computer: names.computer });
      // Its way in: the one address the camera is set to.
      const way = rows.ways_in.get(linked(camera.values.way_in)[0]);
      let address = null;
      if (way && turnedOn(way) && (!way.values.computer || way.values.computer === names.computer)) {
        wanted.add(way.id);
        const capability = await capabilityFor(way);
        const door = capability ? await capability.open({ ctx, port }) : { address: null, state: words.no_way_in, close: async () => {} };
        doors.set(way.id, { port, opened: door });
        address = door.address;
        const key = fill(settings.listen.key.login_title, { camera: camera.values.camera });
        await write(settings.lists.ways_in, way.id, { address: door.address ?? '', protocol: door.protocol ?? '', key: `Saved logins: "${key}"`, state: door.state ?? '' });
      }
      const key = await cameraKey({ settings, camera, call, address, ...keyStore });
      // Its destination: the one cell, or the first ready of Automatic.
      const destination = chooseDestination(camera, rows.destinations, ready);
      const capability = destination ? await capabilityFor(destination) : null;
      const signature = destination && capability ? JSON.stringify([destination.id, port, destination.values.kind, destination.values.address, destination.values.key]) : null;
      const session = sessions.get(camera.id);
      if (session?.signature !== signature) {
        session?.running.stop();
        sessions.delete(camera.id);
        if (signature) {
          const state = { destination, text: fill(words.waiting, { address: address ?? '' }) };
          const next = { signature, state, running: { stop() {} } };
          sessions.set(camera.id, next);
          next.running = await capability.start({ ctx, camera, row: destination, port, key, onState: change => { next.state.text = describe(change, destination, address); void report(camera, next).catch(() => {}); } });
          ctx.say(`${camera.values.camera}: now going to ${destination.values.name}`);
        }
      }
      await report(camera, sessions.get(camera.id) ?? { state: { text: words.no_destination } });
    }
    for (const [id, session] of sessions) if (!mine.some(camera => camera.id === id)) { session.running.stop(); sessions.delete(id); }
    for (const [id, door] of doors) if (!wanted.has(id)) { await door.opened.close(); doors.delete(id); const way = rows.ways_in.get(id); if (way) await write(settings.lists.ways_in, id, { state: words.off }); }
  }

  function describe(change, destination, address) {
    const at = date => (date ? new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    if (change.why) return change.why;
    if (change.refused) return fill(words.refused_key, { at: at(change.refused) });
    if (change.receiving && change.since) return fill(words.receiving, { since: at(change.since), pieces: change.pieces, lands_in: destination.values.lands_in ?? '', last: change.last || '-' });
    if (change.ended) return fill(words.last_stream, { address: address ?? '', ended: at(change.ended), pieces: change.pieces, lands_in: destination.values.lands_in ?? '', last: change.last || '-' });
    if (change.relaying) return fill(words.relaying, { address: destination.values.address, since: at(change.since) });
    if (destination.values.address && change.relaying === false) return fill(words.relay_waiting, { address: destination.values.address });
    return fill(words.waiting, { address: address ?? '' });
  }

  async function report(camera, session) {
    const { text, destination } = session.state;
    await write(settings.lists.cameras, camera.id, { state: destination ? `${destination.values.name}: ${text}` : text });
    if (destination) await write(settings.lists.destinations, destination.id, { state: text });
  }

  return { round, stop: async () => { for (const session of sessions.values()) session.running.stop(); for (const door of doors.values()) await door.opened.close(); } };
}

// The first line of standard input: how the Trillion Mac app hands each of its programs the account key.
const firstLine = () => new Promise(resolve => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; const at = text.indexOf('\n'); if (at >= 0) { process.stdin.pause(); resolve(text.slice(0, at).trim()); } });
  process.stdin.on('end', () => resolve(text.trim()));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const settingsFile = argv.includes('--settings') ? argv[argv.indexOf('--settings') + 1] : DEFAULT_SETTINGS;
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const say = line => process.stdout.write(`${new Date().toISOString()}  ${line}\n`);
  try {
    const fromApp = argv.includes('--key-stdin');
    const key = fromApp ? await firstLine() : await readHeld(settings.account_key.keychain_service);
    if (!key) throw new Error(fromApp ? 'No account key came on standard input.' : `No account key is kept under "${settings.account_key.keychain_service}" on this computer.`);
    if (fromApp) endWithTheApp();
    const origin = settings.service_origin;
    const tools = accountTools({ origin, key });
    const call = async (name, args) => answerOf(await tools(name, args));
    const client = namespaceClient({ origin, control: bearerControl({ origin, authorization: async () => `Bearer ${key}`, fetchImpl: fetchWithoutCopies }), fetchImpl: fetchWithoutCopies });
    await client.lease('write');
    const names = await computerNames();
    const ctx = { settings, call, client, chunking: await loadChunking(), appData: appDataFolder(), say, fill, names };
    const capabilityOf = capabilities(settings);
    let rows = null;
    for (let wait = 5; !rows; wait = Math.min(wait * 2, 300)) {
      try { rows = await keepTheLists({ settings, call, names, capabilityOf, ctx }); }
      catch (error) { say(`could not keep the stream lists yet: ${error.message}`); await new Promise(resolve => setTimeout(resolve, wait * 1000)); }
    }
    // A receiver set up by hand gives up the port, and the pieces it left go into the person's files too.
    const left = await takeOverLaunchAgents({ settings, say });
    const first = [...rows.cameras.values()].find(camera => !camera.values.computer || camera.values.computer === names.computer);
    if (left.length && first) {
      const sender = await piecesSender({ client, chunking: ctx.chunking, folder: path.join(ctx.appData, settings.keep_while_sending.under_app_data, first.id), pieces: settings.pieces, camera: first.values.camera, retryAfter: settings.retry_after_seconds, say });
      void (async () => { for (const folder of left) for (const name of (await fs.readdir(folder).catch(() => [])).filter(item => item.endsWith('.mp4')).sort()) await sender.send(path.join(folder, name), { keep: true }); })();
    }
    const follow = followTheRows({ settings, ctx, call, names, capabilityOf });
    const again = async () => {
      try { await follow.round(); } catch (error) { say(`could not follow the stream rows this round: ${error.message}`); }
      setTimeout(again, settings.read_rows_every_seconds.cameras * 1000);
    };
    await again();
    say(`following ${settings.lists.cameras.label} for ${names.computer_name}`);
  } catch (error) {
    say(`Stopped: ${error.message}`);
    process.exit(1);
  }
}
