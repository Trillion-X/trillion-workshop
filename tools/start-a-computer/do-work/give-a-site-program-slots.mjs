// give-a-site-program-slots.mjs COMPUTER_JSON SITE [start|retire] [--slots a,b]: makes the program that serves SITE on its socket
// (the unit whose runtime_directory lists sites/<SITE>) into slots, each on its own socket for every name the unit serves, so a
// release starts beside the running one and the front door sends each name to the first socket that answers. A unit may serve
// more than one name (runtime_directory "sites/<A> sites/<B>", SOCKET listing one socket per name). It edits the computer row
// file (its `runs`) in place and prints each change; run again, it changes nothing.
//   start   The unit gets `slots` (each slot's environment and check_command with the unit's sockets made the slot's own:
//           /run/sites/<SITE>-slots/http-<slot>.sock for SITE, /run/sites/<SITE>-slots/<name>-http-<slot>.sock for each other
//           name), that folder (`sites/<SITE>-slots`, kept whole: runtime_preserve yes), and the front door's `site_sockets`
//           sends each name to every slot's socket, then to the old one. The old unit leaves the row but keeps running,
//           untouched, as the last socket tried until a slot answers.
//   retire  Once start's apply has switched: the old unit's file goes in runs.absent (the apply stops, disables and removes it),
//           and site_sockets drops every name's old socket. A slot answers first the whole time, so its stop costs no request.
// Why two applies and a folder of the slots' own (Nov 21 2026): the apply removes what runs.absent names before it switches
// slots and before the front door reloads, so one apply would leave SITE with no program while a slot starts; and the old
// unit's stop removes its /run folder (RuntimeDirectoryPreserve=restart) with every socket in it.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SLOT = /^[a-z0-9]{1,8}$/;
const swapped = (value, pairs) => (value === undefined ? undefined : JSON.parse(pairs.reduce((text, [from, to]) => text.replaceAll(from, to), JSON.stringify(value))));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `runs` with SITE's program made into slots (`start`) or its old unit retired (`retire`), and each change in words. */
export function giveASiteProgramSlots(given, { site, slots = ['a', 'b'], phase = 'start' }) {
  if (!['start', 'retire'].includes(phase)) throw new Error(`the phase is start or retire, not ${phase}`);
  if (slots.length < 2 || !slots.every(slot => SLOT.test(slot)) || new Set(slots).size !== slots.length) {
    throw new Error('slots are two or more different short words of small letters and digits');
  }
  const runs = structuredClone(given), changed = [];
  const folder = `sites/${site}`, slotFolder = `${folder}-slots`, slotPath = slotFolder.replace(/\./g, '\\.');
  const oldSocket = name => `/run/sites/${name}/http.sock`;
  const socketOf = (name, slot) => `/run/${slotFolder}/${name === site ? '' : `${name}-`}http-${slot}.sock`;
  const socketsIn = text => [...String(text ?? '').matchAll(new RegExp(`/run/${slotPath}/[^"\\s,]+\\.sock`, 'g'))].map(match => match[0]);
  const nameOf = path => {
    const name = path.match(new RegExp(`^/run/${slotPath}/(?:(.+)-)?http-[a-z0-9]{1,8}\\.sock$`));
    if (!name) throw new Error(`${path} is not a slot socket of /run/${slotFolder}`);
    return name[1] ?? site;
  };
  const serving = runs.units.filter(unit => (unit.runtime_directory ?? '').split(' ').some(dir => [folder, slotFolder].includes(dir)));
  if (serving.length !== 1) throw new Error(`${serving.length} units serve ${site} from /run/${folder} or /run/${slotFolder}; one is needed`);
  const [unit] = serving, oldFile = `/etc/systemd/system/${unit.unit}`;
  const set = (on, key, value, where) => {
    if (same(on[key], value)) return;
    changed.push(`${where} ${key}: ${JSON.stringify(on[key]) ?? 'none'} -> ${JSON.stringify(value) ?? 'none'}`);
    if (value === undefined) delete on[key]; else on[key] = value;
  };
  if (unit.slots === undefined) {
    if (phase === 'retire') throw new Error(`${unit.unit} has no slots yet: run start, and apply it, first`);
    const dirs = unit.runtime_directory.split(' ');
    if (!dirs.every(dir => dir.startsWith('sites/'))) throw new Error(`${unit.unit} runtime_directory lists sites/<name> folders only`);
    const names = dirs.map(dir => dir.slice('sites/'.length));
    for (const name of names) {
      if (!JSON.stringify(unit.environment ?? '').includes(oldSocket(name))) throw new Error(`${unit.unit}'s environment names no ${oldSocket(name)}`);
    }
    set(unit, 'slots', Object.fromEntries(slots.map(slot => [slot, Object.fromEntries(['environment', 'check_command']
      .filter(key => unit[key] !== undefined).map(key => [key, swapped(unit[key], names.map(name => [oldSocket(name), socketOf(name, slot)]))]))])), unit.unit);
    set(unit, 'environment', undefined, unit.unit);
    set(unit, 'check_command', undefined, unit.unit);
  }
  set(unit, 'runtime_directory', slotFolder, unit.unit);
  set(unit, 'runtime_preserve', 'yes', unit.unit);
  // Each name's socket in every slot, read from the slots themselves, so a later run (retire) needs no slot names.
  const socketsOfName = new Map();
  for (const values of Object.values(unit.slots)) {
    for (const socket of socketsIn(values.environment)) socketsOfName.set(nameOf(socket), [...(socketsOfName.get(nameOf(socket)) ?? []), socket]);
  }
  if (!socketsOfName.size || [...socketsOfName.values()].some(list => list.length !== Object.keys(unit.slots).length)) {
    throw new Error(`every slot of ${unit.unit} names its socket in /run/${slotFolder}`);
  }
  const doors = runs.units.filter(door => door.site?.site_file);
  if (doors.length !== 1) throw new Error(`${doors.length} front doors with a site_file in this row; one is needed`);
  const door = doors[0].site;
  for (const [name, sockets] of socketsOfName) {
    set(door.site_sockets ??= {}, name, [...sockets, ...(phase === 'start' ? [oldSocket(name)] : [])], `${doors[0].unit} site.site_sockets`);
  }
  const absent = runs.absent ?? [];
  if (phase === 'retire' && !absent.includes(oldFile)) set(runs, 'absent', [...absent, oldFile], 'runs');
  if (phase === 'start' && absent.includes(oldFile)) set(runs, 'absent', absent.filter(path => path !== oldFile), 'runs');
  return { runs, changed };
}

async function main() {
  const args = process.argv.slice(2), at = args.indexOf('--slots');
  const slots = at >= 0 ? args.splice(at, 2)[1].split(',') : undefined;
  const [file, site, phase = 'start'] = args;
  if (!file || !site) throw new Error('give-a-site-program-slots.mjs COMPUTER_JSON SITE [start|retire] [--slots a,b]');
  const row = JSON.parse(readFileSync(file, 'utf8'));
  const { runs, changed } = giveASiteProgramSlots(row.runs, { site, phase, ...(slots ? { slots } : {}) });
  writeFileSync(file, `${JSON.stringify({ ...row, runs }, null, 1)}\n`);
  process.stdout.write(`${phase} ${site}: ${changed.length ? `\n${changed.join('\n')}` : 'nothing to change'}\n`);
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(2); });
