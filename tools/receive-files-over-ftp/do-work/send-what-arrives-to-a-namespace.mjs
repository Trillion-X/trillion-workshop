#!/usr/bin/env node
// parts/receive-files-over-ftp/do-work/send-what-arrives-to-a-namespace.mjs
//
// Purpose: keep a receiver open on this computer that devices push files to over FTP (ftp-receiver.mjs), and send
// every file into the person's namespace while it arrives, through the shared chunked sender every uploader uses
// (live-namespace send-a-file-to-a-namespace.mjs). A clip is named in the namespace the moment the device starts
// sending it, its bytes can be read in the cloud a moment after they land here, and it is finished when the device
// finishes; the chunks a reader asks for go first.
//
//   node send-what-arrives-to-a-namespace.mjs [--settings <receive-settings.json>]
//
// What happens to one file:
//   1. The device starts sending it; it is given its namespace name (`names.under` / the day / its path) and an
//      `arriving` row goes into the ledger (<keep folder>/received.jsonl), so a resume or a restart keeps that name.
//   2. It is sent with sendFile as it is written (growingFileSource): an upload whose length is not known yet, 16
//      chunks in flight, finished under its length and BLAKE3 identity once the device finished.
//   3. A send that could not finish (the connection dropped, the service was away) leaves the row unsent; once the
//      device has finished the file it is sent whole, one file at a time, after each wait in `retry_after_seconds`
//      (the last one repeating). A device that broke off part way and resumes starts step 2 again under the same name;
//      chunks already held are not sent again.
//   4. Once the namespace holds it, a `sent` row (with its BLAKE3 identity) goes into the ledger and the copy on this
//      computer is deleted. The ledger still answers the device's "is this name taken", so a device set not to
//      overwrite keeps choosing new names. A file the device renames keeps its namespace file under the new name.
//   5. When this computer's network gives it a new address, the receiver's certificate is made again for it and the
//      log says the value to enter on each device (its host setting).
//
// Non-Negotiable Invariants:
//   1. The account key, the receiver's password and its certificate are read from the keychain by the names in the
//      settings and held only in memory (keychain.mjs).
//   2. A copy on this computer is deleted only after the namespace answered that it holds the file.
//   3. Names are chosen once (step 1) and never reused for another file: a name already in the namespace gets " (2)",
//      " (3)" and so on before its extension.
//   4. While this program runs, the computer does not fall asleep on its own (`stay_awake_command`), so a device that
//      finishes a recording finds the receiver.
//   5. Nothing listens, is kept in the keychain or is told to the account until this person has a device the receiver
//      serves, or turned it on (know-which-devices.mjs); until then it looks again every `know_devices.check_seconds`.
//   6. A password a device gives is kept only while the window `sign_in.adopt_after_remade` opened when the receiver's
//      own password was made again; only over a secured session, only with the receiver's user name, and only once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { randomInt, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFtpReceiver } from './ftp-receiver.mjs';
import { keepHeld, readHeld } from './keychain.mjs';
import { certificateNames, localAddress, makeCertificate } from './this-computers-address.mjs';
import { NamespaceRefused, fileSource, growingFileSource, sendFile } from '../../live-namespace/do-work/send-a-file-to-a-namespace.mjs';
import { loadChunking } from '../../live-namespace/do-work/content-chunks.mjs';
import { bearerControl, namespaceClient } from '../../live-namespace/do-work/namespace-client.mjs';
import { fetchWithoutCopies } from '../../live-namespace/do-work/send-without-copies.mjs';
import { accountTools, tellTheAccount } from './tell-the-account.mjs';
import { lookForDevices, printedBy, turnedOnBy } from './know-which-devices.mjs';
import { endWithTheApp } from '../../../computer/end-with-the-app.mjs';
import { appDataFolder } from '../../process-session/do-work/place-data-folder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SETTINGS = path.join(HERE, '..', 'receive-settings.json');
const DEVICES = path.join(HERE, '..', 'devices.json');

/** This place's folder for app data (one owner: parts/process-session/do-work/place-data-folder.mjs). */
export { appDataFolder };

/** The day a file arrived, in this computer's time zone: 2026-09-28. */
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const withNumber = (name, number) => { const extension = path.posix.extname(name); return `${name.slice(0, name.length - extension.length)} (${number})${extension}`; };
const sameText = (left, right) => { const a = Buffer.from(String(left)), b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); };

/**
 * Receive and send. `client` is a namespace client (namespace-client.mjs); `password` and `secure` ({ key, cert } or
 * null) come from the keychain; `folder` is where files wait while they are sent. Returns { port, close(), idle(),
 * setSecure(secure) } where idle() resolves once every file received so far has been sent (or has failed for now).
 */
export async function startSendingWhatArrives({ settings, client, chunking, password, secure, folder, now = () => new Date(), onReceived = () => {}, adopt = null, say = () => {} }) {
  await fs.mkdir(folder, { recursive: true });
  const ledgerFile = path.join(folder, 'received.jsonl');
  const rows = new Map();
  for (const line of (await fs.readFile(ledgerFile, 'utf8').catch(() => '')).split('\n')) { try { const row = JSON.parse(line); rows.set(row.path, row); } catch {} }
  // Rows are written in the order they were remembered, one after another.
  let writing = Promise.resolve();
  const remember = row => { rows.set(row.path, row); writing = writing.then(() => fs.appendFile(ledgerFile, `${JSON.stringify(row)}\n`)); return writing; };
  const namesTaken = new Set([...rows.values()].map(row => row.name));
  const waits = settings.retry_after_seconds ?? [30, 120, 600];
  const mediaTypeOf = file => settings.media_types?.[path.extname(file).toLowerCase()] ?? null;
  const localFile = inside => path.join(folder, ...inside.split('/').filter(Boolean));
  const queue = [];
  const live = new Map(); // path inside -> { sending: promise of true (sent) or false (not sent), identity }
  let running = null, idleWaiters = [], finishing = 0;
  const settleIdle = () => { if (!running && !live.size && !finishing) for (const resolve of idleWaiters.splice(0)) resolve(); };

  async function nameFor(inside, at) {
    const base = `${settings.names.under.replace(/\/$/, '')}${settings.names.folder_per_day ? `/${dayOf(at)}` : ''}${inside}`;
    for (let number = 1; ; number += 1) {
      const name = number === 1 ? base : withNumber(base, number);
      if (!namesTaken.has(name) && !(await client.file(name))) { namesTaken.add(name); return name; }
    }
  }

  // The namespace holds this file: remember it, and let the copy here go (a file sent while it arrived is let go once
  // the device is done with it, so a device that renames it right after finds it: onFile).
  async function held(row, identity, { keepCopy = false } = {}) {
    await remember({ ...row, state: 'sent', identity, sent_at: now().toISOString() });
    if (!keepCopy) await fs.rm(localFile(row.path)).catch(() => {});
  }

  // Send a file while the device is still writing it. Answers whether the namespace now holds it.
  async function sendWhileArriving(row, finished) {
    const entry = live.get(row.path) ?? {};
    const source = await growingFileSource(localFile(row.path), { finished });
    try {
      const sent = await sendFile({ client, source, name: row.name, modifiedAtMs: now().getTime(), mediaType: mediaTypeOf(row.path), chunking, parallel: 16, onGrowing: ({ growing }) => { entry.identity = growing; } });
      entry.identity = sent.identity;
      const current = rows.get(row.path) ?? row;
      await held({ ...current, size: sent.byte_length ?? current.size }, sent.identity, { keepCopy: true });
      say(`${sent.state === 'uploaded' ? 'sent while arriving' : 'already there'}  ${current.name}  ${sent.identity}`);
      return true;
    } catch (error) {
      say(`${error instanceof NamespaceRefused ? 'refused' : 'not sent while arriving'}  ${row.name}: ${error.message}`);
      return false;
    } finally { await source.close(); }
  }

  async function sendOne(row) {
    const file = localFile(row.path);
    const stat = await fs.stat(file);
    const source = await fileSource(file);
    try {
      const sent = await sendFile({ client, source, name: row.name, modifiedAtMs: stat.mtimeMs, mediaType: mediaTypeOf(file), chunking, parallel: 16 });
      await held(row, sent.identity);
      say(`${sent.state === 'uploaded' ? 'sent' : 'already there'}  ${row.name}  ${sent.identity}`);
    } finally { await source.close(); }
  }

  async function drain() {
    while (queue.length) {
      const row = queue.shift();
      try { await sendOne(row); }
      catch (error) {
        const attempt = (row.attempt ?? 0) + 1;
        const wait = waits[Math.min(attempt, waits.length) - 1];
        say(`${error instanceof NamespaceRefused ? 'refused' : 'not sent yet'}  ${row.name}: ${error.message} (trying again in ${wait} s)`);
        setTimeout(() => enqueue({ ...row, attempt }), wait * 1000).unref();
      }
    }
    running = null;
    settleIdle();
  }
  const enqueue = row => { queue.push(row); running ??= drain(); };

  async function finished(inside, size, attempt) {
    finishing += 1;
    try {
      await live.get(inside)?.named.catch(() => {});
      const before = rows.get(inside);
      if (before?.state !== 'sent') {
        const at = now();
        await remember({ ...(before ?? {}), path: inside, size, name: before?.name ?? await nameFor(inside, at), state: 'received', received_at: at.toISOString() });
      }
      await live.get(inside)?.sending;
      if (rows.get(inside)?.state === 'sent') { await fs.rm(localFile(inside)).catch(() => {}); return; }
      enqueue(rows.get(inside));
    } catch (error) {
      const wait = waits[Math.min(attempt + 1, waits.length) - 1];
      say(`could not start sending ${inside}: ${error.message} (trying again in ${wait} s)`);
      setTimeout(() => finished(inside, size, attempt + 1), wait * 1000).unref();
    } finally { finishing -= 1; settleIdle(); }
  }

  // A file still arriving when the receiver stopped never finished: its row is kept as interrupted, and it is never sent
  // as a finished file. When the device sends the same path again it goes through arriving → received as usual. A file
  // that arrived whole (transferred, kept before the device was told) is finished as received.
  for (const row of rows.values()) if (row.state === 'arriving') await remember({ ...row, state: 'interrupted', interrupted_at: now().toISOString() });
  for (const row of rows.values()) if (row.state === 'transferred' && (await fs.stat(localFile(row.path)).catch(() => null))?.size === row.size) finished(row.path, row.size, 0);
  // Files received before a restart and not sent yet go first, under the names they were given; a file here the ledger
  // never named (the service was away when it arrived) is named and sent too, once no device is sending into this
  // folder after the start.
  for (const row of rows.values()) if (row.state === 'received' && await fs.stat(localFile(row.path)).catch(() => null)) enqueue(row);
  for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const inside = `/${path.relative(folder, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')}`;
    if (inside === '/received.jsonl' || rows.has(inside)) continue;
    finished(inside, (await fs.stat(localFile(inside))).size, 0);
  }

  const receiver = await startFtpReceiver({
    folder, port: settings.listen.port, passivePorts: settings.listen.passive_ports, secure, requireSecure: Boolean(secure && settings.secure?.required),
    // A device set up before the password was made again gives the old one: `adopt` (when given) may keep it once.
    signIn: async (user, given) => {
      if (!sameText(user, settings.sign_in.user)) return false;
      if (sameText(given, password)) { await adopt?.close(); return true; }
      if (!adopt || !(await adopt.take(given))) return false;
      password = given;
      return true;
    },
    taken: {
      size: inside => (rows.get(inside)?.state === 'sent' ? rows.get(inside).size : null),
      names: folderPath => [...rows.values()].filter(row => row.state === 'sent' && path.posix.dirname(row.path) === folderPath).map(row => path.posix.basename(row.path)),
    },
    // The device started sending a file (or resumed one): name it once, and send it while it arrives.
    onArriving: ({ path: inside, finished }) => {
      const entry = { identity: null };
      live.set(inside, entry);
      entry.named = (async () => {
        const before = rows.get(inside);
        const at = now();
        const row = before && before.state !== 'sent' ? { ...before, state: 'arriving' } : { path: inside, name: await nameFor(inside, at), state: 'arriving', arriving_at: at.toISOString() };
        await remember(row);
        return row;
      })();
      entry.sending = entry.named.then(row => sendWhileArriving(row, finished))
        .catch(error => { say(`could not start sending ${inside}: ${error.message}`); return false; })
        .finally(() => { if (live.get(inside) === entry) live.delete(inside); settleIdle(); });
    },
    // Every byte arrived: kept as transferred before the device is told, so a restart finishes it instead of setting it aside.
    onTransferred: async ({ path: inside, size }) => {
      const row = await (live.get(inside)?.named ?? Promise.resolve(rows.get(inside)));
      if (row) await remember({ ...row, state: 'transferred', size, transferred_at: now().toISOString() });
    },
    // The device finished the file. It is remembered as whole (so a restart sends it), and sent whole only when
    // sending it while it arrived did not finish. Naming it can fail while the service is away; it is tried again
    // after each wait in `retry_after_seconds`, so a file is never left here unsent.
    onFile: ({ path: inside, size, from, file }) => { onReceived({ path: inside, from, file }); return finished(inside, size, 0); },

    // The device renamed a file: its namespace file takes the new name, and the old name goes.
    onRename: async ({ from, to }) => {
      try {
        const row = rows.get(from);
        if (!row) return;
        const name = await nameFor(to, new Date(row.arriving_at ?? row.received_at ?? now()));
        const identity = live.get(from)?.identity ?? row.identity;
        if (identity) await client.putNames([{ name, identity }, { name: row.name, remove: true }]);
        await remember({ ...row, state: 'renamed', renamed_to: to });
        rows.delete(from);
        const entry = live.get(from);
        if (entry) { live.delete(from); live.set(to, entry); }
        await remember({ ...row, path: to, name, renamed_from: row.name });
        say(`renamed  ${row.name}  to  ${name}`);
      } catch (error) { say(`could not rename ${from}: ${error.message}`); }
    },
    say,
  });
  return {
    port: receiver.port,
    close: receiver.close,
    setSecure: receiver.setSecure,
    idle: () => (running || live.size || finishing ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve()),
  };
}

/**
 * Follow this computer's address: when it is not the one the receiver's certificate names, make a certificate for it,
 * keep it in the keychain, hand it to the receiver, and say the value to enter on each device (`devices.json` steps
 * filled from the receiver's host). Checks now and every `every_seconds`. Returns a stop function.
 */
export function followThisComputersAddress({ settings, devices, receiver, held, say, address = localAddress, make = makeCertificate, keep = keepHeld, onAddress = () => {} }) {
  let current = held;
  let checking = null;
  const check = () => (checking ??= (async () => {
    const host = address();
    if (host) onAddress(host);
    if (!host || (current && certificateNames(current, host))) return;
    current = await make(host, settings.secure.days);
    await keep(settings.secure.keychain_service, Buffer.from(JSON.stringify(current)).toString('base64'));
    receiver.setSecure(current);
    say(`This computer's address is now ${host}; the receiver's certificate names it.`);
    for (const device of devices) {
      for (const step of device.steps.filter(item => item.value.from === 'receiver' && item.value.key === 'host')) say(`On the ${device.name}: ${step.where.join(' > ')}: ${host}`);
    }
  })().catch(error => say(`could not follow this computer's address: ${error.message}`)).finally(() => { checking = null; }));
  check();
  const timer = setInterval(check, (settings.address_check_seconds ?? 30) * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** A device's setup steps with every value filled in from `values` ({ host, port, user, password }). */
export function filledSteps(device, values) {
  return device.steps.map(step => ({ where: step.where, value: step.value.from === 'receiver' ? String(values[step.value.key]) : step.value.text }));
}

/**
 * The receiver's password and certificate from the keychain, each made and kept first when there is none (a password
 * of the settings' easy-to-type letters; a certificate for this computer's address). Answers { password, secure, made }.
 */
export async function heldOrMade(settings, { read = readHeld, keep = keepHeld, host = localAddress(), make = makeCertificate } = {}) {
  const { keychain_service: passwordName, length, alphabet } = settings.sign_in.password;
  const made = [];
  let password = await read(passwordName);
  if (!password) {
    password = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
    await keep(passwordName, password);
    made.push('password');
  }
  let secure = settings.secure ? await heldCertificate(settings.secure.keychain_service, read) : null;
  if (settings.secure && !secure && host) {
    secure = await make(host, settings.secure.days);
    await keep(settings.secure.keychain_service, Buffer.from(JSON.stringify(secure)).toString('base64'));
    made.push('certificate');
  }
  return { password, secure, made };
}

/**
 * The window in which the receiver keeps the password a device signs in with (`sign_in.adopt_after_remade`), opened by
 * `open()` when the receiver's own password was made again. Answers { open(), take(given), close() }: take keeps
 * `given` in the keychain (keep) and answers true only while the window is open, then closes it.
 */
export function adoptionWindow({ settings, stateFile, keep = keepHeld, now = () => new Date(), onKept = async () => {} }) {
  const rule = settings.sign_in.adopt_after_remade;
  const read = async () => JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => 'null'));
  const close = () => fs.rm(stateFile, { force: true });
  return {
    async open() {
      if (!rule) return;
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify({ until: new Date(now().getTime() + rule.hours * 3600_000).toISOString() }));
    },
    async take(given) {
      const state = await read();
      if (!rule || !state || !(Date.parse(state.until) > now().getTime())) return false;
      if (!given || /["\n\r\\]/.test(given)) return false;
      await keep(settings.sign_in.password.keychain_service, given);
      await close();
      await onKept(given);
      return true;
    },
    close,
  };
}

/** The receiver's certificate from the keychain: base64 of JSON { key, cert }, or null when none is kept. */
export async function heldCertificate(service, read = readHeld) {
  const held = await read(service);
  return held ? JSON.parse(Buffer.from(held, 'base64').toString('utf8')) : null;
}

// The first line of standard input: how the Trillion Mac app hands each of its programs the account key.
const firstLine = () => new Promise(resolve => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; const at = text.indexOf('\n'); if (at >= 0) { process.stdin.pause(); resolve(text.slice(0, at).trim()); } });
  process.stdin.on('end', () => resolve(text.trim()));
});

// Run by the Trillion Mac app (computer-reader.json `children`), the receiver is the app's own, so the launch agent an
// earlier set-up-this-computer.mjs made is stopped and its file put in the Trash: one receiver holds the port.
async function takeOverFromLaunchAgent(settings, say) {
  if (process.platform !== 'darwin' || !settings.launch?.label) return;
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${settings.launch.label}.plist`);
  if (!existsSync(plist)) return;
  const run = (command, args) => new Promise(resolve => execFile(command, args, () => resolve()));
  await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${settings.launch.label}`]);
  await run('/usr/bin/trash', [plist]);
  say('The Trillion app runs the receiver now; the one set up on its own was stopped.');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const settingsFile = argv.includes('--settings') ? argv[argv.indexOf('--settings') + 1] : DEFAULT_SETTINGS;
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const say = line => process.stdout.write(`${new Date().toISOString()}  ${line}\n`);
  try {
    const fromApp = argv.includes('--key-stdin');
    const key = fromApp ? await firstLine() : await readHeld(settings.account_key.keychain_service);
    if (!key) throw new Error(fromApp ? 'No account key came on standard input.' : `No account key is kept under "${settings.account_key.keychain_service}" on this computer.`);
    // Started by the app: ends with it (computer/end-with-the-app.mjs), so a replaced app never leaves two receivers.
    if (fromApp) endWithTheApp();
    const origin = settings.service_origin;
    const call = accountTools({ origin, key });
    const devices = JSON.parse(readFileSync(DEVICES, 'utf8')).devices;
    const held = {};
    const told = await tellTheAccount({ settings, devices, filled: filledSteps, password: () => held.password, call, stateFile: path.join(appDataFolder(), settings.tell_the_account.state_under_app_data), turnedOn: turnedOnBy({ settings, appData: appDataFolder() }), deviceName: (await printedBy(['/usr/sbin/scutil', '--get', 'ComputerName'])).trim() || os.hostname(), say });
    // Nothing is opened, kept in the keychain or told to the account until this person has a device it serves
    // (know-which-devices.mjs); it is looked for again every `check_seconds`.
    const look = lookForDevices({ settings, devices, told, call, say });
    await look();
    for (let waiting = false; !(await told.listens()); waiting = true) {
      if (!waiting) say('No device this receiver serves is known for this person yet, so it is not listening.');
      await new Promise(resolve => setTimeout(resolve, settings.know_devices.check_seconds * 1000));
      await look();
    }
    if (fromApp) await takeOverFromLaunchAgent(settings, say);
    const { password, secure, made } = await heldOrMade(settings);
    held.password = password;
    if (made.length) say(`Made the receiver's ${made.join(' and ')} and kept it in the keychain.`);
    const adopt = settings.sign_in.adopt_after_remade ? adoptionWindow({
      settings, stateFile: path.join(appDataFolder(), settings.sign_in.adopt_after_remade.state_under_app_data),
      onKept: async given => { held.password = given; say('kept the password a device signs in with as the receiver\'s own'); await told.passwordChanged(); },
    }) : null;
    if (made.includes('password')) await adopt?.open();
    if (settings.secure?.required && !secure) throw new Error('This computer is not on a network yet, so the receiver has no certificate; it starts again when it is.');
    const client = namespaceClient({ origin, control: bearerControl({ origin, authorization: async () => `Bearer ${key}`, fetchImpl: fetchWithoutCopies }), fetchImpl: fetchWithoutCopies });
    await client.lease('write');
    const folder = path.join(appDataFolder(), settings.keep_while_sending.under_app_data);
    const running = await startSendingWhatArrives({ settings, client, chunking: await loadChunking(), password, secure, folder, say, adopt, onReceived: ({ from, file }) => { void told.sent(localAddress(), from, file); } });
    let host = null;
    if (secure) followThisComputersAddress({ settings, devices, receiver: running, held: secure, say, onAddress: address => { host = address; void told.setUp(address); } });
    // A device found once the receiver is open gets its row at the address already known.
    setInterval(() => { void look().then(() => host && told.setUp(host)).catch(error => say(`could not look for devices: ${error.message}`)); }, settings.know_devices.check_seconds * 1000).unref();
    if (settings.stay_awake_command?.length) spawn(settings.stay_awake_command[0], [...settings.stay_awake_command.slice(1), String(process.pid)], { stdio: 'ignore', detached: true }).unref();
    say(`receiving on port ${running.port}, sending to ${origin} under ${settings.names.under}`);
  } catch (error) {
    say(`Stopped: ${error.message}`);
    process.exit(1);
  }
}
