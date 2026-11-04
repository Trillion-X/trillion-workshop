// parts/receive-files-over-ftp/do-work/know-which-devices.mjs
//
// Purpose: find out whether this person has a device the receiver serves (devices.json), so a Mac with no such device
// opens no FTP port and tells the account nothing. Three roads lead to a device, all read from the settings'
// `know_devices` (receive-settings.json); none names a model in code:
//   1. This Mac: a device of a listed model is, or was, connected (the settings' `this_mac` command names what is
//      attached; a model id or name appearing as a whole word in its answer is the device).
//   2. The account: a file of the person's whose kept `camera` fact names the model (the account's list_media, newest
//      `account.limit` rows, at most once per `account.every_seconds`).
//   3. The person turned it on: the file `turned_on_file_under_app_data` exists in this computer's app data, or the
//      launch agent set-up-this-computer.mjs made is installed. That wants every listed device.
// A device found by road 1 or 2 is kept by tell-the-account.mjs (`learn`), so it stays seen once it is unplugged.
//
// Non-Negotiable Invariants:
//   1. Looking only reads: the Mac's own device list and one read-only account tool; nothing is written but the kept
//      device and the time of the account read.
//   2. A model matches only as a whole word, in any letter case (ILCE-7M4 is not found inside ILCE-7M45).
//   3. A command or tool that fails finds nothing this time; it never stops the receiver or opens it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The devices among `devices` whose model id (and name, unless `names` is false) appears as a whole word in `text`, in any letter case.
 *  A device with no model id (any camera that can send by FTP) is named by no text; it is wanted by the person's turning it on. */
export function devicesNamedIn(text, devices, { names = true } = {}) {
  return devices.filter(device => (device.model_ids ?? []).length && [...device.model_ids, ...(names ? [device.name] : [])].some(name => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text)));
}

/** What a command printed on standard output (an empty answer when it fails or takes too long). */
export const printedBy = ([command, ...args]) => new Promise(resolve => {
  execFile(command, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/** Answers whether the person turned the receiver on: its file is in the app data, or the launch agent is installed. */
export function turnedOnBy({ settings, appData, exists = existsSync }) {
  const file = path.join(appData, settings.know_devices.turned_on_file_under_app_data);
  const agent = settings.launch?.label ? path.join(os.homedir(), 'Library', 'LaunchAgents', `${settings.launch.label}.plist`) : null;
  return async () => exists(file) || Boolean(agent && process.platform === 'darwin' && exists(agent));
}

/**
 * Looks for devices now and then: returns async look(), which keeps (told.learn) each device found on this Mac, and,
 * when the account was not read in the last `account.every_seconds`, each found in the account's files. `print(command)`
 * answers a command's output and `call(tool, args)` calls an account tool; both are replaceable.
 */
export function lookForDevices({ settings, devices, told, call, print = printedBy, now = () => new Date(), say = () => {} }) {
  const config = settings.know_devices;
  const learned = async (found, how, onThisMac = false) => {
    for (const device of found) if (await told.learn(device, how, onThisMac)) say(`found a ${device.name} (${how}); the receiver is for it`);
  };
  return async function look() {
    await learned(devicesNamedIn(await print(config.this_mac), devices), 'connected to this Mac', true);
    const last = told.lastChecked('account');
    if (last && now().getTime() - Date.parse(last) < config.account.every_seconds * 1000) return;
    await told.markChecked('account', now().toISOString());
    try {
      const answer = await call(config.account.tool, { limit: config.account.limit });
      const named = (answer?.rows ?? []).map(row => row?.facts?.[config.account.fact]).filter(fact => typeof fact === 'string').join('\n');
      await learned(devicesNamedIn(named, devices), 'in your files');
    } catch (error) { say(`could not read the account's files for a camera: ${error.message}`); }
  };
}
