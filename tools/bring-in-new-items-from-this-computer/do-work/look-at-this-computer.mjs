// do-work/look-at-this-computer.mjs
//
// Purpose: one look, as a Workshop run on the person's own computer (tool:look-for-the-places-on-this-computer, run at
// the local door's tools:run with the read-a-folder grant): which of the places computer/computer-sources.json lists
// are under the folder the person granted (their home folder), and which need a switch before they can be read. The
// same look the Trillion helper runs (computer-sources.mjs lookHere), confined to the grant.
//
//   node do-work/look-at-this-computer.mjs <granted folder>   request on stdin, answer as the last line
//
// Invariants:
// - Read only, and never what a place holds: a place is checked by whether it is there and whether it may be opened.
// - Only places under the granted folder are looked at (a row's `~` is that folder). A row's places outside it (an app
//   in /Applications, a drive in /Volumes) are never looked for; a row with none under it is answered could_not_check
//   with that reason.
// - Which places there are, where they live and how each is checked are rows; this file names none.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {lookHere, LOOKS} from '../computer/computer-sources.mjs';

const ROWS = new URL('../computer/computer-sources.json', import.meta.url);
const UNDER_HOME = /^~(?:\/|$)/;

// The row with only its places under the folder (`~`), or null when it names none there.
function underHome(row) {
  const [kind, places] = Object.entries(row.look ?? {}).find(([key]) => Object.hasOwn(LOOKS, key)) ?? [];
  if (!kind) return null;
  const kept = kind === 'browser_sites'
    ? places.map(store => ({...store, paths: (store.paths ?? []).filter(place => UNDER_HOME.test(place))})).filter(store => store.paths.length)
    : [places].flat().filter(place => UNDER_HOME.test(place));
  if (!kept.length) return null;
  return {...row, look: {...row.look, [kind]: kind === 'entries' ? kept[0] : kept}};
}

/** One look under `home` for the request `{ places?, services? }` against `rows`: { said, sources, browser_sites }. */
export function lookAtThisComputer(request = {}, home, {rows = JSON.parse(readFileSync(ROWS, 'utf8'))} = {}) {
  if (typeof home !== 'string' || !home.startsWith('/')) throw new Error('Give the folder to look in (the read-a-folder grant) as the first argument.');
  const wanted = request.places === undefined ? null : new Set(request.places);
  if (wanted && ![...wanted].every(id => typeof id === 'string')) throw new Error('places lists row ids, each a string.');
  const domains = request.services ?? [];
  if (!Array.isArray(domains) || !domains.every(service => typeof service?.vendor === 'string' && Array.isArray(service.domains))) {
    throw new Error('services lists { vendor, domains: [host] }, the services the account offers.');
  }
  const chosen = rows.sources.filter(row => !wanted || wanted.has(row.id));
  const unknown = wanted ? [...wanted].filter(id => !chosen.some(row => row.id === id)) : [];
  if (unknown.length) throw new Error(`No place is called ${unknown.join(', ')}; the places are ${rows.sources.map(row => row.id).join(', ')}.`);
  const inside = [], outside = [];
  for (const row of chosen) { const here = underHome(row); if (here) inside.push(here); else outside.push(row); }
  const found = lookHere({rows: inside, home, domains});
  const order = new Map(chosen.map((row, at) => [row.id, at]));
  const rowOf = id => order.get(id) ?? order.get(String(id).split(':')[0]) ?? chosen.length;
  const sources = [...found.sources, ...outside.map(row => ({id: row.id, label: row.label, category: row.category, state: 'could_not_check', detail: 'It lives outside the folder this look was given.'}))]
    .sort((left, right) => rowOf(left.id) - rowOf(right.id));
  const count = state => sources.filter(source => source.state === state).length;
  return {
    said: `${count('found')} found, ${count('needs_switch')} need a switch, ${count('could_not_check')} not checked, of ${chosen.length} places.`,
    sources,
    browser_sites: found.browser_sites,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    process.stdout.write(`${JSON.stringify(lookAtThisComputer(text.trim() ? JSON.parse(text) : {}, process.argv[2]))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({error: String(error.message ?? error)})}\n`);
    process.exitCode = 1;
  }
}
