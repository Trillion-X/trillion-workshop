// computer/native-messaging.mjs
//
// PURPOSE
//   Installs, reads and removes the manifest that lets a browser extension start a program on this computer and talk to it over
//   standard input and output (the browser's own native-messaging way), for every browser the DATA lists.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: browsers, folders and the key that names allowed extensions are rows in computer/native-messaging.json.
//   2. Only the named extensions are allowed; there is no wildcard. The host program is an absolute path to a file that exists.
//   3. A manifest this module wrote carries `_written_by`; one it did not write is never overwritten or removed.
//   4. Writing is atomic (a temp file renamed into place) and only below the browser folders named in DATA.
//
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const nativeMessagingSettings = () => JSON.parse(readFileSync(join(HERE, 'native-messaging.json'), 'utf8'));
const WRITER = 'trillion computer/native-messaging.mjs';
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status = 400) => Object.assign(new Error(message), { status, retry: false });

export function makeNativeMessaging({ settings = nativeMessagingSettings(), home = homedir() } = {}) {
  const chosen = browsers => {
    const ids = browsers?.length ? browsers : settings.browsers.map(row => row.id);
    return ids.map(id => settings.browsers.find(row => row.id === id) ?? (() => { throw refusal(fill(settings.words.unknown_browser, { browser: id }), 404); })());
  };
  const fileFor = (row, name) => join(home, row.folder, `${name}.json`);
  const ours = file => { try { return JSON.parse(readFileSync(file, 'utf8'))._written_by === WRITER; } catch { return false; } };

  return {
    /** Joins `host` to the browsers; skips a browser whose folder holds a manifest of that name that is not ours. */
    install({ name, description = '', path, extensions, browsers } = {}) {
      if (!new RegExp(settings.name_pattern).test(name ?? '')) throw refusal(fill(settings.words.bad_name, { name }));
      if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw refusal(settings.words.bad_path);
      if (!Array.isArray(extensions) || !extensions.length || extensions.some(id => typeof id !== 'string' || !/^[A-Za-z0-9@._-]+$/.test(id))) throw refusal(settings.words.no_extensions);
      const done = [];
      const skipped = [];
      for (const row of chosen(browsers)) {
        const file = fileFor(row, name);
        if (existsSync(file) && !ours(file)) { skipped.push({ browser: row.id, said: fill(settings.words.refused_foreign, { file }) }); continue; }
        mkdirSync(dirname(file), { recursive: true });
        const manifest = { name, description, path, type: 'stdio', [row.allow_key]: extensions.map(id => fill(row.allow_format, { id })), _written_by: WRITER };
        const next = `${file}.next`;
        writeFileSync(next, `${JSON.stringify(manifest, null, 2)}\n`);
        renameSync(next, file);
        done.push(row.id);
      }
      return { installed: done, skipped, said: fill(settings.words.installed, { name, browsers: done.join(', ') || 'no browser' }) };
    },
    /** The state of `name` in each browser: absent, ours with its allowed extensions, or someone else's. */
    read({ name, browsers } = {}) {
      return { name, browsers: chosen(browsers).map(row => {
        const file = fileFor(row, name);
        if (!existsSync(file)) return { browser: row.id, state: 'absent' };
        try {
          const manifest = JSON.parse(readFileSync(file, 'utf8'));
          return { browser: row.id, state: manifest._written_by === WRITER ? 'ours' : 'foreign', path: manifest.path, allowed: manifest[row.allow_key] ?? [] };
        } catch { return { browser: row.id, state: 'foreign' }; }
      }) };
    },
    /** Removes the manifests this module wrote; others stay. */
    remove({ name, browsers } = {}) {
      const gone = [];
      for (const row of chosen(browsers)) {
        const file = fileFor(row, name);
        if (existsSync(file) && ours(file)) { rmSync(file); gone.push(row.id); }
      }
      return { removed: gone, said: fill(settings.words.removed, { name, browsers: gone.join(', ') || 'no browser' }) };
    },
  };
}
