// computer/offer-in-browsers.mjs
//
// Purpose
//   Puts Trillion's browser extensions where the person's browsers will offer them: for each browser installed on this
//   computer that does not already hold an extension, one small file in the folder that browser reads offers from, so
//   the next time it opens it asks the person whether to add it. Nobody has to find the extension in a store.
//
// Non-negotiable invariants
//   1. Browsers, extensions and folders are DATA (offer-in-browsers.json); this file names none of them.
//   2. Each extension is offered once per browser (`offered` in the state file): an extension the person turned down,
//      or a browser they removed it from, is never offered again.
//   3. Nothing is installed here: the browser asks the person, and only its own answer adds the extension.
//   4. A native messaging host manifest (`native_hosts`) lets only the extensions its row names start the program this
//      computer carries (computer/browser-native-host.mjs): `allowed_origins` is exactly their pinned ids, never a
//      pattern. Placing is idempotent (a file is written only when its bytes differ), and removing takes away exactly
//      the manifests and launcher placed here and keeps them away (`native_hosts_removed` in the state file) until the
//      person places them again (`node computer/offer-in-browsers.mjs place-native-hosts`).
//   5. Every file written into a browser's folder is a row in the state file's install ledger (computer/install-ledger.mjs),
//      so withdrawOffers removes exactly those files, and only while they are unchanged.
//
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordWrite, removeWrites } from './install-ledger.mjs';
import { readSettingsFile, writeSettingsFile } from './settings-file.mjs';

const here = dirname(new URL(import.meta.url).pathname);
const settingsOf = () => JSON.parse(readFileSync(join(here, 'offer-in-browsers.json'), 'utf8'));
// Settings paths are home-relative unless they explicitly name ~/... or an absolute location. In particular, the
// native-host launcher directory is `.trillion/...`; resolving it against cwd made the reader crash when launched from
// a directory that did not contain `.trillion`.
const inHome = (path, home) => path.startsWith('~/') ? join(home, path.slice(2)) : (path.startsWith('/') ? path : join(home, path));
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const acceptState = value => value && typeof value === 'object' && !Array.isArray(value);
// A state file that cannot be understood is never replaced by an empty one (computer/settings-file.mjs): the pass runs
// on a fresh state and its write is refused with the reason.
const ledgerState = stateFile => {
  const found = readSettingsFile(stateFile, { accept: acceptState });
  return found.state === 'ok' ? { offered: {}, ...found.value } : { offered: {} };
};
const saveState = (stateFile, state) => writeSettingsFile(stateFile, state, { accept: acceptState });

/** Whether any profile of the browser already holds the extension. */
export function holds(profiles, extensionId) {
  if (!existsSync(profiles)) return false;
  return readdirSync(profiles, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(profiles, entry.name, 'Extensions', extensionId)));
}

/**
 * One pass: offers each extension in each installed browser that does not hold it and was not offered it before.
 * Returns the offers made now, as [{ browser, offer }].
 */
export function offerInBrowsers({ settings = settingsOf(), home = homedir(), stateFile, log = () => {} } = {}) {
  const state = ledgerState(stateFile);
  const made = [];
  for (const browser of settings.browsers) {
    if (!existsSync(inHome(browser.app, home))) continue;
    const profiles = inHome(browser.profiles, home);
    for (const offer of settings.offers) {
      const key = `${browser.id}:${offer.id}`;
      if (state.offered[key] || holds(profiles, offer.extension_id)) continue;
      const folder = join(profiles, browser.offers_from);
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `${offer.extension_id}.json`);
      if (!existsSync(file)) {
        const bytes = `${JSON.stringify({ external_update_url: offer.update_url }, null, 2)}\n`;
        writeFileSync(file, bytes);
        recordWrite(state, { path: file, owner: `${browser.id}:${offer.id}`, reason: 'offer the extension in this browser', bytes });
      }
      state.offered[key] = new Date().toISOString();
      made.push({ browser: browser.id, offer: offer.id });
      log(`This computer: ${browser.id} will offer ${offer.id} the next time it opens.`);
    }
  }
  const placed = state.native_hosts_removed ? [] : placeNativeHosts({ settings, home, log, state });
  if (made.length || placed.some(row => row.state === 'placed')) saveState(stateFile, state);
  return made;
}

/** Removes the offer files this reader wrote, exactly those and only while unchanged: { removed, gone, changed }. */
export function withdrawOffers({ stateFile, owner } = {}) {
  const state = ledgerState(stateFile);
  const outcome = removeWrites(state, { owner });
  saveState(stateFile, state);
  return outcome;
}

/** Writes `text` to `file` only when its bytes differ; true when it wrote. */
const writeIfChanged = (file, text, mode) => {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, mode ? { mode } : undefined);
  if (mode) chmodSync(file, mode);
  return true;
};

// One shell word, whatever the path holds (single quotes, each inner one closed, escaped and reopened).
const quoted = text => `'${String(text).replaceAll("'", "'\\''")}'`;
const launcherOf = (settings, home, host) => join(inHome(settings.native_host_launchers, home), host.name);

/** The manifest a browser reads for one host row: only the extensions the row names, by their exact ids. */
export function nativeHostManifest(settings, host, launcher) {
  const origins = settings.offers.filter(offer => host.offers.includes(offer.id))
    .map(offer => `chrome-extension://${offer.extension_id}/`);
  return { name: host.name, description: host.description, path: launcher, type: 'stdio', allowed_origins: origins };
}

/**
 * Places each native messaging host in each installed browser: the launcher that starts the carried program on this
 * computer's runtime, and one manifest per browser, each manifest written a row of `state`'s install ledger when a state
 * is given. Returns [{ browser, host, state: placed | unchanged }].
 */
export function placeNativeHosts({ settings = settingsOf(), home = homedir(), runtime = process.execPath, log = () => {}, state } = {}) {
  const placed = [];
  for (const host of settings.native_hosts ?? []) {
    const launcher = launcherOf(settings, home, host);
    const program = join(here, host.entry);
    writeIfChanged(launcher, `#!/bin/sh\nexec ${[runtime, program, host.name].map(quoted).join(' ')} "$1"\n`, 0o755);
    const manifest = `${JSON.stringify(nativeHostManifest(settings, host, launcher), null, 2)}\n`;
    for (const browser of settings.browsers) {
      if (!browser.native_hosts_from || !existsSync(inHome(browser.app, home))) continue;
      const file = join(inHome(browser.profiles, home), browser.native_hosts_from, `${host.name}.json`);
      const wrote = writeIfChanged(file, manifest);
      if (wrote && state) recordWrite(state, { path: file, owner: `${browser.id}:${host.name}`, reason: 'let Trillion\'s extension start this computer\'s program', bytes: manifest });
      placed.push({ browser: browser.id, host: host.name, state: wrote ? 'placed' : 'unchanged' });
      if (wrote) log(`This computer: ${browser.id} may now start ${host.name} for Trillion's extension.`);
    }
  }
  return placed;
}

/** Where each host stands in each browser: [{ browser, host, placed, pinned_to }], read from the files themselves. */
export function nativeHosts({ settings = settingsOf(), home = homedir() } = {}) {
  return (settings.native_hosts ?? []).flatMap(host => settings.browsers.filter(browser => browser.native_hosts_from).map(browser => {
    const kept = readJson(join(inHome(browser.profiles, home), browser.native_hosts_from, `${host.name}.json`));
    return { browser: browser.id, host: host.name, placed: Boolean(kept), pinned_to: kept?.allowed_origins ?? [] };
  }));
}

/**
 * Removes exactly the manifests whose launcher this computer placed, and the launchers, and keeps them removed until
 * placed again. Returns [{ browser, host }] removed.
 */
export function removeNativeHosts({ settings = settingsOf(), home = homedir(), stateFile } = {}) {
  const state = ledgerState(stateFile);
  const removed = [], removedFiles = new Set();
  for (const host of settings.native_hosts ?? []) {
    const launcher = launcherOf(settings, home, host);
    for (const browser of settings.browsers) {
      if (!browser.native_hosts_from) continue;
      const file = join(inHome(browser.profiles, home), browser.native_hosts_from, `${host.name}.json`);
      if (readJson(file)?.path !== launcher) continue;
      rmSync(file, { force: true });
      removedFiles.add(file);
      removed.push({ browser: browser.id, host: host.name });
    }
    rmSync(launcher, { force: true });
  }
  state.ledger = (state.ledger ?? []).filter(row => !removedFiles.has(row.path));
  saveState(stateFile, { ...state, native_hosts_removed: new Date().toISOString() });
  return removed;
}

/** Places the hosts again after a removal, and lets the reader's pass keep them placed. */
export function restoreNativeHosts({ settings = settingsOf(), home = homedir(), stateFile, log } = {}) {
  const { native_hosts_removed: _removed, ...state } = ledgerState(stateFile);
  const placed = placeNativeHosts({ settings, home, log, state });
  saveState(stateFile, state);
  return placed;
}

// The person's own command line: node computer/offer-in-browsers.mjs native-hosts | place-native-hosts | remove-native-hosts
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stateFile = join(homedir(), settingsOf().state_file);
  const commands = { 'native-hosts': () => nativeHosts(), 'place-native-hosts': () => restoreNativeHosts({ stateFile }), 'remove-native-hosts': () => removeNativeHosts({ stateFile }) };
  const command = commands[process.argv[2]];
  if (!command) { process.stderr.write(`Use ${Object.keys(commands).join(', ')}.\n`); process.exitCode = 1; }
  else process.stdout.write(`${JSON.stringify(command(), null, 2)}\n`);
}
