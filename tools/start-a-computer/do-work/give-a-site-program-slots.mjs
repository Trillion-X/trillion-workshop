// give-a-site-program-slots.mjs COMPUTER_JSON SITE [start|retire] [--slots a,b]: makes the program that serves SITE on its socket
// (the unit whose runtime_directory is sites/<SITE>) into slots, each on its own socket, so a release starts beside the running
// one and the front door sends SITE to the first socket that answers. It edits the computer row file (its `runs`) in place and
// prints each change; run again, it changes nothing.
//   start   The unit gets `slots` (each slot's environment and check_command with the unit's socket made the slot's own,
//           /run/sites/<SITE>-slots/http-<slot>.sock), that folder (`sites/<SITE>-slots`, kept whole: runtime_preserve yes),
//           and the front door's `site_sockets` sends SITE to every slot's socket, then to the old one. The old unit leaves the
//           row but keeps running, untouched, as the last socket tried until a slot answers.
//   retire  Once start's apply has switched: the old unit's file goes in runs.absent (the apply stops, disables and removes it),
//           and site_sockets drops its socket. A slot answers first the whole time, so its stop costs no request.
// Why two applies and a folder of the slots' own (Nov 21 2026): the apply removes what runs.absent names before it switches
// slots and before the front door reloads, so one apply would leave SITE with no program while a slot starts; and the old
// unit's stop removes its /run folder (RuntimeDirectoryPreserve=restart) with every socket in it.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SLOT = /^[a-z0-9]{1,8}$/;
const swapped = (value, from, to) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value).replaceAll(from, to)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `runs` with SITE's program made into slots (`start`) or its old unit retired (`retire`), and each change in words. */
export function giveASiteProgramSlots(given, { site, slots = ['a', 'b'], phase = 'start' }) {
  if (!['start', 'retire'].includes(phase)) throw new Error(`the phase is start or retire, not ${phase}`);
  if (slots.length < 2 || !slots.every(slot => SLOT.test(slot)) || new Set(slots).size !== slots.length) {
    throw new Error('slots are two or more different short words of small letters and digits');
  }
  const runs = structuredClone(given), changed = [];
  const folder = `sites/${site}`, slotFolder = `${folder}-slots`, oldSocket = `/run/${folder}/http.sock`;
  const serving = runs.units.filter(unit => [folder, slotFolder].includes(unit.runtime_directory));
  if (serving.length !== 1) throw new Error(`${serving.length} units serve ${site} from /run/${folder} or /run/${slotFolder}; one is needed`);
  const [unit] = serving, oldFile = `/etc/systemd/system/${unit.unit}`;
  const set = (on, key, value, where) => {
    if (same(on[key], value)) return;
    changed.push(`${where} ${key}: ${JSON.stringify(on[key]) ?? 'none'} -> ${JSON.stringify(value) ?? 'none'}`);
    if (value === undefined) delete on[key]; else on[key] = value;
  };
  if (unit.slots === undefined) {
    if (phase === 'retire') throw new Error(`${unit.unit} has no slots yet: run start, and apply it, first`);
    if (!JSON.stringify(unit.environment ?? '').includes(oldSocket)) throw new Error(`${unit.unit}'s environment names no ${oldSocket}`);
    const socket = slot => `/run/${slotFolder}/http-${slot}.sock`;
    set(unit, 'slots', Object.fromEntries(slots.map(slot => [slot, Object.fromEntries(['environment', 'check_command']
      .filter(key => unit[key] !== undefined).map(key => [key, swapped(unit[key], oldSocket, socket(slot))]))])), unit.unit);
    set(unit, 'environment', undefined, unit.unit);
    set(unit, 'check_command', undefined, unit.unit);
  }
  set(unit, 'runtime_directory', slotFolder, unit.unit);
  set(unit, 'runtime_preserve', 'yes', unit.unit);
  // Each slot's socket, read from the slots themselves, so a later run (retire) needs no slot names.
  const sockets = Object.values(unit.slots).map(values => JSON.stringify(values.environment).match(new RegExp(`/run/${slotFolder.replace(/\./g, '\\.')}/[^"\\s]+\\.sock`))?.[0]);
  if (sockets.some(socket => !socket)) throw new Error(`every slot of ${unit.unit} names its socket in /run/${slotFolder}`);
  const doors = runs.units.filter(door => door.site?.site_file);
  if (doors.length !== 1) throw new Error(`${doors.length} front doors with a site_file in this row; one is needed`);
  const door = doors[0].site;
  set(door.site_sockets ??= {}, site, [...sockets, ...(phase === 'start' ? [oldSocket] : [])], `${doors[0].unit} site.site_sockets`);
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
