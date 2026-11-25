// tools/start-a-computer/do-work/render-what-a-computer-runs.mjs
//
// Renders the files one computer runs: each service unit, its drop-ins and the files it reads. What it runs is the `runs` of
// that computer's own row (request.computer_row, handed in with the request); a unit's template, script and drop-ins are files
// a row names by path, the program's own text with a {field} for each value a computer declares. A field the row does not give
// is refused, so a template never renders half-filled. A unit's settings object is written as JSON to its settings_file. A
// program's own grammar (a web server's site file, a database's access file) is its own kit's `prepare` module, never this tool's.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fill } from './fill-fields.mjs';
import { WAYS, renderMeetingPoint } from '../../carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs';

// The Workshop this tool runs from: a path a row names is read inside it, at the commit the tool runs at.
const WORKSHOP = fileURLToPath(new URL('../../../', import.meta.url));
/** The text of a file a row names (a unit's `template`, `script` or `drop_ins`): the program's own file, published by its
 *  owner. A relative path is read inside this Workshop (it may not leave it); an absolute path is the person's own file. The
 *  tool keeps no list of programs: whatever file a row names is what the computer runs. */
export const publishedFile = (path, where) => {
  if (typeof path !== 'string' || !path) throw new Error(`${where} names no file`);
  const file = isAbsolute(path) ? path : resolve(WORKSHOP, path);
  if (!isAbsolute(path) && (relative(WORKSHOP, file).startsWith('..') || isAbsolute(relative(WORKSHOP, file)))) throw new Error(`${where} names a file outside the Workshop: ${path}`);
  if (!existsSync(file)) throw new Error(`${where} names a file that does not exist: ${path}`);
  return file;
};
const publishedText = (path, where) => readFileSync(publishedFile(path, where), 'utf8');
// The values a unit's template reads when its row gives none (read-data/settings.json `unit_defaults`): the build link it
// runs (`current`) and how long its stop may take (`stop_seconds`).
const UNIT_DEFAULTS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8')).unit_defaults;
const SYSTEMD = '/etc/systemd/system';
/** The name a drop-in file a unit lists is written under: its file's name without the extension. */
export const dropInName = path => path.split('/').pop().replace(/\.[^.]*$/, '');
/** A unit's settings as the file it reads at its `settings_file`: its `settings_lines`, one line each, or its `settings` object as JSON
 * (an engine's computer config is one: trillion-rust src/native_entry/computer.rs). */
const unitSettings = (unit, where) => {
  if (typeof unit.settings_file !== 'string') throw new Error(`${where} gives settings and needs settings_file`);
  return { path: unit.settings_file, text: unit.settings_lines ? `${unit.settings_lines.join('\n')}\n` : `${JSON.stringify(unit.settings, null, 2)}\n` };
};

/** A computer's `runs` with each unit that names `prepare` handed to that file first: the program's own module (a path read
 * like a template), which knows its program and answers { unit, firewall_allow? }. The unit it answers is the one the computer
 * runs (its `files` are written beside it), and the ports it opens join the row's. `given` is what the request hands every
 * module (the pages a web server answers, `pages`). start-a-computer knows no program: whatever a unit's own module says is
 * what runs. */
export async function withPrepared(runs, given = {}) {
  const units = [], firewall = [];
  for (const row of runs.units ?? []) {
    if (row.prepare === undefined) { units.push(row); continue; }
    const { prepare: path, ...unit } = row;
    const where = `unit ${row.unit} prepare`;
    const { prepare } = await import(pathToFileURL(publishedFile(path, where)).href);
    if (typeof prepare !== 'function') throw new Error(`${where}: ${path} exports no prepare`);
    const answer = await prepare(unit, given);
    units.push(answer.unit);
    firewall.push(...(answer.firewall_allow ?? []));
  }
  const machine = { ...runs.machine };
  if (firewall.length) {
    if (machine.firewall_allow === null) throw new Error('a unit opens a port, and this computer\'s firewall is kept by another program (machine.firewall_allow null)');
    machine.firewall_allow = [...(machine.firewall_allow ?? []), ...firewall];
  }
  return { ...runs, units, machine };
}

/** A computer's `runs` with each unit that names `slots` made into one unit per slot, so a new release starts beside the
 * running one and takes over only once it answers (start-a-computer's apply switches between them; plan "a deploy never drops
 * anything"). `slots` maps each slot's name to the values that slot has of its own, each at its dotted path in the unit
 * (`settings.listen`, `health_listen`): the port it serves on, say. Each slot's unit is the unit's name with `-<slot>` before
 * its extension, its settings file the same, and the build it runs is `current-<slot>` in the unit's builds folder; every
 * other value is the one unit's. Each slot unit carries `slot`: the unit it came from (`of`) and the units of every slot (`units`). */
export function withSlots(runs) {
  const units = [];
  const named = (path, slot) => path.replace(/(\.[A-Za-z0-9]+)?$/, ext => `-${slot}${ext}`);
  for (const given of runs.units ?? []) {
    if (given.slots === undefined) { units.push(given); continue; }
    const where = `unit ${given.unit} slots`;
    const names = Object.keys(given.slots ?? {});
    if (given.slots === null || typeof given.slots !== 'object' || names.length < 2 || !names.every(name => /^[a-z0-9]{1,8}$/.test(name))) {
      throw new Error(`${where} names two or more slots, each a short word of small letters and digits, with the values that slot has of its own`);
    }
    const { slots, ...unit } = given;
    const unitsOf = names.map(name => named(unit.unit, name));
    // `live_links` maps a fixed path to the path of the slot that runs, with `{slot}` where the slot's name goes: the apply
    // points each link at the running slot's own file once that slot serves (a socket, a settings file, a build link), so
    // whoever reads the fixed path reaches the slot that runs and never a stopped one's file.
    const links = Object.entries(unit.live_links ?? {});
    if (unit.live_links !== undefined && (unit.live_links === null || typeof unit.live_links !== 'object' || Array.isArray(unit.live_links) ||
        !links.every(([link, target]) => /^\/[A-Za-z0-9._\/-]+$/.test(link) && typeof target === 'string' && /^\/[A-Za-z0-9._\/{}-]+$/.test(target) && target.includes('{slot}')))) {
      throw new Error(`${where}: live_links maps absolute paths to absolute paths that name {slot}`);
    }
    for (const name of names) {
      const slot = structuredClone(unit);
      Object.assign(slot, { unit: named(unit.unit, name), current: `current-${name}`, slot: { of: unit.unit, units: unitsOf, name } });
      if (links.length) slot.live_links = Object.fromEntries(links.map(([link, target]) => [link, target.replaceAll('{slot}', name)]));
      if (typeof unit.settings_file === 'string') slot.settings_file = named(unit.settings_file, name);
      for (const [path, value] of Object.entries(slots[name] ?? {})) {
        const keys = path.split('.');
        if (keys.some(key => !/^[A-Za-z0-9_]+$/.test(key)) || ['unit', 'slot', 'current'].includes(keys[0])) throw new Error(`${where} ${name} sets ${path}, which is not a value of the unit a slot may have of its own`);
        let at = slot;
        for (const key of keys.slice(0, -1)) {
          if (at[key] === null || typeof at[key] !== 'object') at[key] = {};
          at = at[key];
        }
        at[keys.at(-1)] = value;
      }
      units.push(slot);
    }
  }
  return { ...runs, units };
}

/** A unit's `credentials` ({ vault_key, name, file, env? }) as its template's fields: `credential_lines`, one
 * LoadCredentialEncrypted line each, and `credential_env`, each one that names an `env` read into that variable before the
 * program starts. A credential with no `env` is read by the program itself from its credentials folder, by its name.
 * A unit's `files_read_at_start` ({ name, file }) are files another program on this computer keeps (the front door's
 * certificate and key): `file_lines`, one LoadCredential line each, so systemd copies each into the unit's credentials
 * folder at its start (/run/credentials/<unit>/<name>, readable by the unit's user only) and the unit's user needs no
 * right to the owner's folder. A file that changes later reaches the unit at its next start. */
const NAME = /^[A-Za-z0-9._-]+$/, ENV = /^[A-Z][A-Z0-9_]*$/;
const withCredentials = (unit, where) => {
  const credentials = unit.credentials ?? [], files = unit.files_read_at_start ?? [];
  for (const { name, file, env } of credentials) {
    if (!NAME.test(name ?? '') || !String(file ?? '').startsWith('/') || (env !== undefined && !ENV.test(env))) throw new Error(`${where} credentials need a name, an absolute file and, when given, an env of capitals`);
  }
  for (const { name, file } of files) {
    if (!NAME.test(name ?? '') || !/^\/[A-Za-z0-9._/-]+$/.test(file ?? '')) throw new Error(`${where} files_read_at_start need a name and an absolute file`);
  }
  return {
    ...unit,
    credential_lines: credentials.map(({ name, file }) => `LoadCredentialEncrypted=${name}:${file}`).join('\n'),
    credential_env: credentials.filter(({ env }) => env).map(({ name, env }) => `${env}="$(cat "$CREDENTIALS_DIRECTORY/${name}")" && export ${env} && `).join(''),
    file_lines: files.map(({ name, file }) => `LoadCredential=${name}:${file}`).join('\n'),
  };
};

/** Every file a computer's `runs` declares: { path, text, binary?, check?, then? }. A unit's drop-ins are the files it lists in
 * `drop_ins`. A unit with no `template` is one whose unit file the computer already has (a package's own); only its drop-ins and
 * files are written. The machine's own files (`machine.files`: a file that decides how a package installs) are rendered too, so
 * `differences` compares them and an apply writes one that changed: set-up writes them only when it runs, so a file added to
 * the row of a computer already set up was never written while the apply exited 0 (Nov 25 2026, 8:47 AM CST:
 * /etc/apt/apt.conf.d/99-no-automatic-reboot). */
export function renderWhatItRuns(given) {
  const runs = withSlots(given);
  const files = [];
  // A meeting point (`meeting_point`: { way, values }) runs the host half of that way row
  // (tools/carry-a-computer-to-a-meeting-point read-data/ways.json), the same for every computer carried to it: its files are
  // written like every other, and its commands (`then`) run, in order, after one of them changed.
  if (runs.meeting_point) {
    const way = WAYS.find(row => row.id === runs.meeting_point.way);
    if (!way) throw new Error(`meeting_point names an unknown way ${runs.meeting_point.way}`);
    const { steps } = renderMeetingPoint({ way, relay_host: { hostname: runs.meeting_point.values?.host ?? 'localhost' }, computers: [], values: runs.meeting_point.values ?? {} });
    const then = steps.filter(step => step.run).map(step => step.run);
    files.push(...steps.filter(step => step.file).map(step => ({ path: step.file.path, text: step.file.text, then })));
  }
  for (const file of runs.machine?.files ?? []) {
    if (typeof file?.path !== 'string' || !file.path.startsWith('/') || typeof file.text !== 'string') throw new Error('machine.files takes { path, text }: an absolute path and its text');
    files.push({ path: file.path, text: file.text });
  }
  for (const unit of runs.units ?? []) {
    const where = `unit ${unit.unit}`;
    if (unit.workshop_commit !== undefined && !/^[0-9a-f]{40}$/.test(unit.workshop_commit)) throw new Error(`${where} workshop_commit must be a full commit id`);
    if (unit.template !== undefined) files.push({ path: `${SYSTEMD}/${unit.unit}`, text: fill(publishedText(unit.template, `${where} template`), withCredentials({ ...UNIT_DEFAULTS, ...unit }, where), where) });
    if (unit.settings !== undefined || unit.settings_lines !== undefined) files.push(unitSettings(unit, where));
    if (unit.script !== undefined) files.push({ path: fill('{script_file}', unit, where), text: publishedText(unit.script, `${where} script`) });
    files.push(...(unit.files ?? []));
    for (const path of unit.drop_ins ?? []) {
      const name = dropInName(path);
      files.push({ path: `${SYSTEMD}/${unit.unit}.d/${name}.conf`, text: fill(publishedText(path, `${where} drop-in`), unit, `${where} drop-in ${path}`) });
    }
  }
  // A file several units name (one script two jobs run) is one file; two different texts for one path are refused.
  const byPath = new Map();
  for (const file of files) {
    const seen = byPath.get(file.path);
    if (seen && seen.text !== file.text) throw new Error(`two units render different text at ${file.path}`);
    if (!seen) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

/** The files whose live text is not what the computer row renders: { path, reason }. Empty means the computer matches. */
export function differences(rendered, live) {
  return rendered.flatMap(({ path, text }) => {
    if (live[path] === undefined) return [{ path, reason: 'missing on the computer' }];
    return live[path] === text ? [] : [{ path, reason: 'differs from the computer row' }];
  });
}
