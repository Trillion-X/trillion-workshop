// src/item-links.mjs
//
// Purpose
//   Every tool answer an AI reads names things in the person's Trillion (a decision, a job handed to an AI, a space's
//   message, a Waiting on you row, a file). This puts each one's own link beside it (`open_url`, a whole address on
//   the service's origin), so any AI the person talks to (Claude, ChatGPT, Codex, Muse) can hand them one click that
//   lands on that exact thing, the same address a notice, a widget or an email opens.
//
// Non-negotiable invariants
//   1. Which fields name a thing is DATA (src/item-links.json); nothing here names a kind of thing, a tool or a field.
//   2. The address is the one shape every surface uses (src/workspace/addresses.mjs thingAddress), so the link an AI
//      gives and the screen that opens can never disagree.
//   3. A link the answer already carries is kept, and nothing under a `not_under` key (a suggested call's arguments)
//      is touched; only objects naming a thing a screen opens are given one, and the
//      answer's own fields are never changed or removed.
//   4. `missingLinks` lists every object that names a thing and still has no link, so a test can refuse an answer
//      that would leave the person without one click to it.
//
// Security
//   Only the person's own ids are turned into addresses on Trillion's own origin; an address field pointing anywhere
//   else is never copied into the link.
//

import settings from './item-links.json' with { type: 'json' };
import screens from '../../shared-code/src/workspace/screens.mjs';
import { thingAddress } from './workspace/addresses.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const filled = value => (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value));
const patterns = new Map(settings.things.filter(row => row.matches).map(row => [row, new RegExp(row.matches)]));

/** The thing row an object names, or null. */
function thingOf(value) {
  return settings.things.find(row => filled(value[row.id]) && (!patterns.has(row) || patterns.get(row).test(String(value[row.id])))) ?? null;
}

/** The object's own address, as a path, when one of its address fields already holds one on Trillion's own origin. */
function ownAddressOf(value) {
  for (const field of settings.own_address_fields) {
    const said = value[field];
    if (typeof said !== 'string') continue;
    if (/^\/(?![/\\])/.test(said)) return said;
    const origin = settings.own_origins.find(own => said === own || said.startsWith(`${own}/`));
    if (origin) return said.slice(origin.length) || '/';
  }
  return null;
}

/** The link one object should carry, as a path, or null when it names nothing a screen opens. */
export function linkOf(value) {
  if (!object(value)) return null;
  const own = ownAddressOf(value);
  if (own) return own;
  const row = thingOf(value);
  return row ? thingAddress(screens, row.kind, value[row.id], row.item ? value[row.item] : null) : null;
}

/** The answer with `open_url` beside every thing it names (invariant 3). Returns the same value when nothing changed. */
export function withItemLinks(value, origin) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => { const linked = withItemLinks(item, origin); if (linked !== item) changed = true; return linked; });
    return changed ? next : value;
  }
  if (!object(value)) return value;
  let next = value;
  for (const [key, child] of Object.entries(value)) {
    if (settings.not_under.includes(key)) continue;
    const linked = withItemLinks(child, origin);
    if (linked !== child) { if (next === value) next = { ...value }; next[key] = linked; }
  }
  if (filled(value[settings.open_field])) return next;
  const path = linkOf(value);
  if (!path) return next;
  return { ...next, [settings.open_field]: `${origin}${path}` };
}

/** Every object in `value` that names a thing and has no link: its path in the answer and what it names (invariant 4). */
export function missingLinks(value, at = []) {
  if (Array.isArray(value)) return value.flatMap((item, index) => missingLinks(item, [...at, index]));
  if (!object(value)) return [];
  const own = Object.entries(value).filter(([key]) => !settings.not_under.includes(key)).flatMap(([key, child]) => missingLinks(child, [...at, key]));
  const row = thingOf(value);
  return row && !filled(value[settings.open_field]) ? [{ at, kind: row.kind, id: String(value[row.id]) }, ...own] : own;
}
