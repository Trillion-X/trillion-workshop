// computer/managed-settings.mjs
//
// Purpose
//   Reads the policy a company deploys to its Macs through a configuration profile (managed preferences) so the app can
//   obey it and tell the person who set it: allowed AIs, sign-in methods, updates, usage data, local models.
//
// Non-negotiable invariants
//   1. Which files are read, which keys count, their types and who acts on them are DATA (computer/managed-settings.json);
//      this file names none. A new key is a row there.
//   2. With no profile (no file, unreadable file, not a dictionary) nothing is managed: the answer has no settings and
//      nothing is refused. A profile never makes a key it does not set behave differently.
//   3. A value of the wrong type, or a key that is not listed, is ignored and named, never coerced.
//   4. Each setting carries its source. Of two sources naming one key, the earlier source in the DATA wins.
//   5. Property lists are read with the system's plutil (no parser here); nothing is written.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
export const managedSettingsData = () => JSON.parse(readFileSync(join(HERE, 'managed-settings.json'), 'utf8'));
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));

const TYPES = {
  boolean: value => typeof value === 'boolean',
  string: value => typeof value === 'string',
  'string-list': value => Array.isArray(value) && value.every(item => typeof item === 'string'),
};

/** One source file as an object, or null when it is not there or not a dictionary. */
async function readSource(source, { home, domain, plutil }) {
  const file = fill(source.file, { domain }).replace(/^~(?=\/)/, home);
  try {
    const text = source.json ? readFileSync(file, 'utf8') : (await plutil(file)).stdout;
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * { settings: { key: { value, source } }, ignored: [words] }. `plutil(file)` and `data` are parameters for tests.
 */
export async function readManagedSettings({ data = managedSettingsData(), home = homedir(),
  plutil = file => execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]) } = {}) {
  const settings = {};
  const ignored = [];
  for (const source of data.sources) {
    const found = await readSource(source, { home, domain: data.domain, plutil });
    if (!found) continue;
    for (const [key, value] of Object.entries(found)) {
      const row = data.keys[key];
      if (!row) { ignored.push(fill(data.words.ignored_key, { key })); continue; }
      if (!TYPES[row.type]?.(value)) { ignored.push(fill(data.words.ignored_type, { key, type: row.type })); continue; }
      if (!Object.hasOwn(settings, key)) settings[key] = { value, source: source.id };
    }
  }
  return { settings, ignored };
}

/** The sentence telling the person a boolean setting their organisation turned off, or null when it is not off. */
export function turnedOff(read, key, data = managedSettingsData()) {
  const setting = read.settings[key];
  return setting && setting.value === false ? fill(data.words.off, { key, source: setting.source }) : null;
}
