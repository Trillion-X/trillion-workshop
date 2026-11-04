// parts/receive-files-over-ftp/do-work/tell-the-account.mjs
//
// Purpose: what the receiver tells the person's account, through the account's own tools (its /mcp door, with the
// account key): the receiver's password kept in their Saved logins, and one row on their Waiting on you list per device
// saying exactly what to enter on it for this computer's current address, set Done once that device has sent a file.
// Only for a device this computer or the account has evidence of (know-which-devices.mjs), or all of them when the
// person turned the receiver on; a computer with no such device tells the account nothing and listens for nothing.
// The row's words are DATA (receive-settings.json `tell_the_account`).
//
// Non-Negotiable Invariants:
//   1. The password goes only into the person's Saved logins (save_login); a row names where it is, never the value.
//   2. A row is the same row every time (its id names the device), so telling again changes it, never adds one.
//   3. The account is told again only when this computer's address changes (the address told is kept in `stateFile`,
//      outside the folder files arrive in, so the receiver never takes it for a file a device sent), so a restart never reopens a step the person finished; a new address asks again, since the device
//      must be told it. A device seen sending on an address is remembered there too.
//   3a. A device seen (by name, with how: this Mac, the account) is kept in `stateFile` too and stays seen when it is
//      unplugged; a device newly seen at an address already told is told then, and each row carries `device`: its model id.
//   3b. A device this Mac saw, or all of them when the person turned the receiver on, is also reported as a fact of
//      this computer (report_device_facts, `cameras`: the model ids) before the rows are written, so the account has
//      evidence of the device its row is about; once per change of that set (kept), and a failure is logged and tried
//      again next round without stopping the rows.
//   4. A busy account is asked again after each wait; telling never stops the receiver.
//   5. A row is Done only for a device whose model id a file it sent names (read from that file with the reader
//      know-which-devices.mjs uses), and only once the account took that row (`done`, kept after put_list_rows
//      succeeded); a row the account did not take is written again on the next check.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devicesNamedIn } from './know-which-devices.mjs';

// A file's text is read in pieces this long; the last CARRY characters of a piece are read again with the next, so a
// model id cut by a piece's end is still found.
const PIECE = 4 * 1024 * 1024, CARRY = 256;

/** The model ids of the devices `file` names, read in pieces so a clip of any size is never held whole; it stops once
 *  every one of `devices` was found. */
async function modelsIn(file, devices) {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return [];
  const found = new Set();
  try {
    const buffer = Buffer.alloc(PIECE);
    let carry = '', at = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, PIECE, at);
      if (!bytesRead) break;
      at += bytesRead;
      const text = carry + buffer.toString('latin1', 0, bytesRead);
      for (const device of devicesNamedIn(text, devices, { names: false })) found.add(device.model_ids[0]);
      carry = text.slice(-CARRY);
      if (found.size === devices.length) break;
    }
  } catch { /* a file that cannot be read names no model */ } finally { await handle.close(); }
  return [...found];
}

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** One of the account's tools, called with the account key: answers its result, throws its words. */
export function accountTools({ origin, key, fetchImpl = fetch, waits = [5, 20, 60] }) {
  let next = 0;
  return async function call(name, args, attempt = 0) {
    const response = await fetchImpl(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await response.text();
    const line = text.includes('data:') ? text.split('\n').filter(item => item.startsWith('data:')).pop().slice(5) : text;
    const answer = JSON.parse(line || '{}');
    const failed = answer.error ?? (answer.result?.isError ? answer.result : null);
    if (!failed) return answer.result?.structuredContent ?? answer.result;
    const words = JSON.stringify(failed).slice(0, 400);
    if (attempt < waits.length && /busy|retryable|Wait for the service|timed out/i.test(words)) {
      await new Promise(resolve => setTimeout(resolve, waits[attempt] * 1000));
      return call(name, args, attempt + 1);
    }
    throw new Error(`${name}: ${words}`);
  };
}

/**
 * Tells the account about this receiver. `devices` from devices.json, `filled(device, values)` fills a device's steps;
 * `stateFile` keeps what was told. `password` is the text, or a function answering it once the receiver has one.
 * `deviceName` is this computer's name in the account's device facts. `turnedOn()` answers whether the person turned the receiver on (then every device in `devices` is wanted).
 * Returns { setUp(host), sent(host, deviceAddress), learn(device, how, onThisMac), listens(), lastChecked(name), markChecked(name, at) }:
 * setUp keeps the password and the row of each wanted device for this address (nothing when none is wanted) and marks Done
 * the rows the account has not yet taken Done for a device whose model a file here named; sent records a device other
 * than this computer sending a file (`file`, the arrived file, once it is complete) and then does the same; learn keeps a device as seen (answers whether
 * it is new); listens answers whether the receiver should be open (a device is wanted or has sent here before).
 */
export async function tellTheAccount({ settings, devices, filled, password, call, stateFile, turnedOn = async () => false, deviceName = os.hostname(), say = () => {} }) {
  const words = settings.tell_the_account;
  // { told: the address the account was last told, sent: { address: { from, at } } }
  const kept = JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '{}'));
  const seen = kept.sent ?? {};
  const seenDevices = kept.devices ??= {}; // { model id: { how, at } }
  const checks = kept.checked ??= {}; // { name: when it was last asked }
  const done = kept.done ??= {}; // { model id: { address, at } }: the account took its row Done for this address
  const keep = async () => { await fs.mkdir(path.dirname(stateFile), { recursive: true }); await fs.writeFile(stateFile, JSON.stringify({ ...kept, sent: seen }, null, 1)); };
  // A device with no model id is any camera that can send by FTP: its key is its name, its row id ends in `any_id`, and its row names no device.
  const modelOf = device => device.model_ids?.[0] ?? null;
  const keyOf = device => modelOf(device) ?? `any:${device.name}`;
  const rowId = device => `${words.row.id}-${(modelOf(device) ?? words.row.any_id).toLowerCase()}`;
  // The models this Mac saw, or every model when the person turned the receiver on: what is reported as `cameras`.
  const reportable = async () => ((await turnedOn()) ? devices : devices.filter(device => seenDevices[keyOf(device)]?.on_this_mac)).filter(modelOf).map(modelOf).join(',');
  const wanted = async () => { const on = await turnedOn(); return devices.filter(device => on || seenDevices[keyOf(device)]); };
  const today = () => new Date().toISOString().slice(0, 10);
  let host = null;
  const acknowledged = (device, address = host) => done[keyOf(device)]?.address === address;
  const rows = (these, doneOf = device => acknowledged(device)) => these.map(device => {
    const steps = filled(device, { host, port: settings.listen.port, user: settings.sign_in.user, password: fill(words.password_is, { title: words.login.title }) });
    const setup = device.setup_words ?? words.setup_words;
    const values = Object.fromEntries(Object.entries(words.row.values).map(([field, text]) => [field, fill(text, {
      device: device.short_name ?? device.name, host, how: device.how_it_sends, login: words.login.title, login_query: encodeURIComponent(words.login.title),
      setup,
      steps: steps.length ? steps.map((step, index) => `${index + 1}. ${step.where.join(' > ')}: ${step.value}`).join('\n') : setup,
    })]));
    return { id: rowId(device), values: { ...values, device: modelOf(device) ?? '', setup_words: setup, status: doneOf(device) ? 'Done' : 'Waiting', added: today() } };
  });
  // The wanted devices a file here named (kept in `seen` with this address) whose row the account has not taken Done for
  // this address. `done` is written only after put_list_rows succeeded, so a row it did not take is sent again on the
  // next check (setUp), and a model it took is never sent again.
  async function acknowledge() {
    const address = host;
    const named = seen[address]?.models ?? [];
    const these = (await wanted()).filter(device => named.includes(keyOf(device)) && !acknowledged(device, address));
    if (!these.length) return;
    try {
      await call('put_list_rows', { list_id: words.row.list_id, rows: rows(these, () => true) });
      for (const device of these) done[keyOf(device)] = { address, at: new Date().toISOString() };
      await keep();
      say(`a device at ${seen[address].from} sent here; its setup is done`);
    } catch (error) { say(`could not mark the setup done: ${error.message}`); }
  }
  return {
    async setUp(address) {
      host = address;
      const these = await wanted();
      const models = these.map(keyOf).join(',');
      const cameras = await reportable();
      const tell = kept.told !== address || kept.toldDevices !== models;
      const report = Boolean(cameras) && kept.reported !== cameras;
      if (!these.length || !(tell || report)) return acknowledge();
      try {
        if (tell) await call('save_login', { title: words.login.title, site: fill(words.login.site, { host, port: settings.listen.port }), user_name: settings.sign_in.user, fields: [{ label: words.login.field, value: typeof password === 'function' ? await password() : password }] });
        if (report) {
          try { await call('report_device_facts', { device: deviceName.slice(0, 60), facts: { cameras } }); kept.reported = cameras; }
          catch (error) { say(`could not report the camera this Mac has: ${error.message}`); }
        }
        if (tell) {
          await call('put_list_rows', { list_id: words.row.list_id, rows: rows(these) });
          kept.told = address;
          kept.toldDevices = models;
          say(`told the account how to send here at ${host}`);
        }
        await keep();
      } catch (error) { say(`could not tell the account how to send here: ${error.message}`); }
      await acknowledge();
    },
    // The receiver's password changed (it kept the one a device signs in with): Saved logins gets the new value.
    async passwordChanged() {
      if (!host || !(await wanted()).length) return;
      try { await call('save_login', { title: words.login.title, site: fill(words.login.site, { host, port: settings.listen.port }), user_name: settings.sign_in.user, fields: [{ label: words.login.field, value: typeof password === 'function' ? await password() : password }] }); }
      catch (error) { say(`could not keep the receiver's new password in Saved logins: ${error.message}`); }
    },
    async sent(address, from, file) {
      if (!address || from === address) return;
      // Only devices whose row the account has not yet taken Done here are looked for, so a clip is read only while one waits.
      const waiting = (await wanted()).filter(device => !acknowledged(device, address));
      // A row with a model is Done only for a file that names its model; a row with none is Done by any complete file that came in here.
      const named = file && waiting.length ? [...(await modelsIn(file, waiting.filter(modelOf))), ...waiting.filter(device => !modelOf(device)).map(keyOf)] : [];
      const before = seen[address] ?? { from, at: new Date().toISOString() };
      seen[address] = { ...before, models: [...new Set([...(before.models ?? []), ...named])] };
      await keep();
      host = address;
      await acknowledge();
    },
    async learn(device, how, onThisMac = false) {
      const before = seenDevices[keyOf(device)];
      if (before && (before.on_this_mac || !onThisMac)) return false;
      seenDevices[keyOf(device)] = { ...before, how: before?.how ?? how, at: before?.at ?? new Date().toISOString(), ...(onThisMac ? { on_this_mac: true } : {}) };
      await keep();
      return true;
    },
    async listens() { return (await wanted()).length > 0 || Object.keys(seen).length > 0; },
    lastChecked: name => checks[name] ?? null,
    async markChecked(name, at) { checks[name] = at; await keep(); },
  };
}
