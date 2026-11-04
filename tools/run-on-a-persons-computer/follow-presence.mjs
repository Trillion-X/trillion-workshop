// computer/follow-presence.mjs
//
// Purpose
//   Keeps a native messaging host's manifest in step with the extension that uses it: the manifest is written into a
//   browser only while that browser's profiles hold the extension, and is taken away again (through the install ledger,
//   computer/install-ledger.mjs) once the browser no longer holds it, so no browser keeps a host file for an extension
//   the person removed. Each pass looks at the browsers installed on this computer; it installs nothing itself.
//
// Non-negotiable invariants
//   1. Hosts, extensions, browsers and folders are DATA (follow-presence.json); this file names none of them.
//   2. A host file is written only where `holds()` (computer/offer-in-browsers.mjs) says the extension is present.
//   3. Every file written is a ledger row in the state file, and removal deletes a file only while its bytes are still
//      the ones written; a file the person or the browser changed is left alone and named.
//   4. A state file that cannot be read as an object is not replaced by an empty one: the pass makes no change.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { holds } from './offer-in-browsers.mjs';
import { recordWrite, removeWrites } from './install-ledger.mjs';

const here = dirname(new URL(import.meta.url).pathname);
export const followSettings = () => JSON.parse(readFileSync(join(here, 'follow-presence.json'), 'utf8'));
const inHome = (path, home) => (path.startsWith('~/') ? join(home, path.slice(2)) : path);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

function loadState(stateFile) {
  if (!existsSync(stateFile)) return { ledger: [] };
  try {
    const value = JSON.parse(readFileSync(stateFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, stateFile);
}
const ownerOf = (browser, host) => `follow:${browser.id}:${host.id}`;

/**
 * One pass over every browser installed here: { wrote, withdrew, changed } lists of "browser:host" (changed lists paths).
 * `stateFile` holds the ledger.
 */
export function followPresence({ settings = followSettings(), home = homedir(), stateFile, log = () => {} } = {}) {
  const outcome = { wrote: [], withdrew: [], changed: [] };
  const state = loadState(stateFile);
  if (!state) return outcome;
  for (const browser of settings.browsers) {
    if (!existsSync(inHome(browser.app, home))) continue;
    const profiles = inHome(browser.profiles, home);
    for (const host of settings.hosts) {
      const owner = ownerOf(browser, host), tag = `${browser.id}:${host.id}`;
      const file = join(profiles, browser.hosts_in, `${host.name}.json`);
      const present = holds(profiles, host.extension_id);
      const written = (state.ledger ?? []).some(row => row.owner === owner);
      if (present && !written && !existsSync(file)) {
        const bytes = `${JSON.stringify({ name: host.name, description: host.description, path: host.path, type: 'stdio', allowed_origins: [fill(settings.origin_template, host)] }, null, 2)}\n`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        recordWrite(state, { path: file, owner, reason: 'let the extension reach its host', bytes });
        outcome.wrote.push(tag);
        log(fill(settings.words.wrote, { browser: browser.id, host: host.name }));
      } else if (!present && written) {
        const done = removeWrites(state, { owner });
        if (done.removed.length) { outcome.withdrew.push(tag); log(fill(settings.words.withdrew, { browser: browser.id, host: host.name })); }
        for (const path of done.changed) { outcome.changed.push(path); log(fill(settings.words.changed, { path })); }
      }
    }
  }
  if (outcome.wrote.length || outcome.withdrew.length) saveState(stateFile, state);
  return outcome;
}
