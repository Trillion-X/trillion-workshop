// src/space-capabilities.mjs
//
// Purpose: the space parts that are Workshop tools like any other a space adds (a leaderboard, points and levels,
// rewards, a streak, a classroom, votes on messages, matching, email digests, a board): adding one to a space
// (grant_space_tool, a space's Tools place) turns it on, taking it out turns it off. Each is a row of
// records/workshop-space-tool-records.json whose `space_capability` holds the configuration keys that together are it, what it needs on first, and what it starts with. The configuration itself is the one row per
// space src/community.mjs keeps; these functions only read and rewrite that configuration, so a project, a group and a
// community switch the same things in the same way. Which tools a space has installed (src/spaces.mjs
// space_tool_grants) is kept in step with what is on here (src/community.mjs keepConfiguration).
//
// Non-Negotiable Invariants:
//   1. Nothing here names a capability: every rule reads the row's own keys, requires and starts_with. A new
//      capability is a DATA row.
//   2. A capability is on exactly when every one of its keys is in the configuration.
//   3. Turning one on turns on what it requires first; turning one off turns off, first, what requires it.
//   4. Turning one off never deletes: its keys move into `set_aside.<id>`, and turning it on again puts them back as
//      they were, so a course, a reward or a level table a space wrote survives being switched off.
//   5. Pure: a configuration goes in and a new one comes out; the input is never changed.
//
import spaceTools from '../records/workshop-space-tool-records.json' with { type: 'json' };

/** The Workshop rows a space installs, as written (each `ai-tool-descriptor` with `invoke.capability` and `space_capability`). */
export const SPACE_TOOL_ROWS = spaceTools.records.map(record => record.payload).filter(row => row?.space_capability);
const ROWS = SPACE_TOOL_ROWS.map(tool => ({ ...tool.space_capability, id: tool.invoke.capability, tool_id: tool.id, label: tool.label, about: tool.description }));
const BY_ID = new Map(ROWS.map(row => [row.id, row]));
const BY_TOOL = new Map(ROWS.map(row => [row.tool_id, row]));

/** The capability a space tool turns on (`tool:space-<id>`), or null for any other tool. */
export const capabilityOfTool = toolId => BY_TOOL.get(toolId)?.id ?? null;
/** The tool that is one capability. */
export const toolOfCapability = id => rowOf(id).tool_id;
/** The capabilities on in a configuration, by id. */
export const capabilitiesOnIn = (config = {}) => ROWS.filter(row => capabilityOn(config, row)).map(row => row.id);
/**
 * The parts on in a space that keep their own records somewhere other than the space's items (`kept_records.store`
 * names the binding of the store that holds them, which answers keptRecords()). read_space hands these to the
 * reader beside the items (src/spaces.mjs), so whatever a part keeps is readable by members' AIs too.
 */
export const keptRecordsOn = (config = {}) => ROWS.filter(row => row.kept_records?.store && capabilityOn(config, row)).map(row => ({ id: row.id, tool_id: row.tool_id, label: row.label, store: row.kept_records.store }));

const read = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);
const has = (value, path) => read(value, path) !== undefined;
function put(value, path, next) {
  let at = value;
  for (const key of path.slice(0, -1)) {
    if (!at[key] || typeof at[key] !== 'object') at[key] = {};
    at = at[key];
  }
  at[path.at(-1)] = next;
}
function drop(value, path) {
  const parent = read(value, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete parent[path.at(-1)];
}

const rowOf = id => {
  const row = BY_ID.get(id);
  if (!row) throw new Error(`"${id}" is not something a pursuit can turn on. These can be: ${ROWS.map(one => one.id).join(', ')}.`);
  return row;
};

/** Whether a capability row is on in a configuration: all of its keys are there. */
export const capabilityOn = (config, row) => row.keys.every(path => has(config, path));

/** Every part a space can have, each with whether it is on here: what the part tools answer after a run. */
export function capabilitiesOf(config = {}) {
  return ROWS.map(row => ({ id: row.id, tool_id: row.tool_id, label: row.label, icon: row.icon, about: row.about, requires: row.requires ?? [], on: capabilityOn(config, row) }));
}

function turnOn(config, row) {
  for (const needed of row.requires ?? []) turnOn(config, rowOf(needed));
  if (capabilityOn(config, row)) return;
  const kept = config.set_aside?.[row.id];
  for (const path of row.keys) {
    if (has(config, path)) continue;
    if (has(kept, path)) put(config, path, read(kept, path));
    else if (has(row.starts_with, path)) put(config, path, structuredClone(read(row.starts_with, path)));
  }
  if (config.set_aside) {
    delete config.set_aside[row.id];
    if (!Object.keys(config.set_aside).length) delete config.set_aside;
  }
}

function turnOff(config, row) {
  for (const other of ROWS) if ((other.requires ?? []).includes(row.id) && capabilityOn(config, other)) turnOff(config, other);
  const kept = {};
  for (const path of row.keys) {
    if (!has(config, path)) continue;
    put(kept, path, read(config, path));
    drop(config, path);
  }
  if (Object.keys(kept).length) config.set_aside = { ...(config.set_aside ?? {}), [row.id]: kept };
}

/** A new configuration with one capability turned on or off (and what it needs, or what needs it, with it). */
export function switchCapability(config, id, on) {
  const next = structuredClone(config ?? {});
  (on ? turnOn : turnOff)(next, rowOf(id));
  return next;
}
