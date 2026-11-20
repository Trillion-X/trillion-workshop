// A toolkit is a list row of type record:toolkit that lists tool ids. First setup offers the account's toolkit rows; the person
// picks one, drops some of its tool ids and adds others. This is the whole decision: the caller reads the rows with
// TOOLKITS_READ (records:list at the person's own records, the same read every list uses) and hands them in as they come, and
// installs what comes back. The Workshop ships starter toolkits as rows of this type (toolkits/), the way it ships tool rows.
// Nothing here reads storage or writes.
//
//   toolkit row   { id, type: 'record:toolkit', value: { title?, description?, tools: ['tool:...', ...], default?: true,
//                   stack?: { slot: [pointer, ...] } } }   (the stack and its pointers: toolkit-stack.mjs)
//   choice        { toolkit: the id of an offered toolkit row, drop?: [tool ids], add?: [tool ids],
//                   swap?: { slot: [pointer, ...] } }   any part swapped: each named slot takes these pointers instead (a slot
//                   the toolkit lacks is added); checked as a stack is (toolkit-stack.mjs), and no slot name is known here
//   default       the one offered row marked `default: true` is the cart of a person who picks nothing (fillCart)
//   known_tools   optional: every tool id the caller can install; an added id outside it is refused

import { readStack, readToolkitStack } from './toolkit-stack.mjs';
import starterToolkits from '../toolkits/starter-toolkits.json' with { type: 'json' };
import starterSwaps from '../swaps/starter-swaps.json' with { type: 'json' };

const TOOL_ID = /^tool:\S+$/;
const TOOLKIT_TYPE = 'record:toolkit';

const SWAP_TYPE = 'record:toolkit-swap';
const SWAP_ID = /^toolkit-swap:[a-z0-9-]+$/;

// The starter rows this tool ships (toolkits/ and swaps/, listed by its row sources) travel with it, so it reads them itself:
// no store is asked for them. The person's own rows are handed in from wherever they keep them, in the same shape.
const asRow = type => ({ payload }) => ({ id: payload.id, type, value: payload });
export const STARTER_TOOLKITS = starterToolkits.records.map(asRow(TOOLKIT_TYPE));
export const STARTER_SWAPS = starterSwaps.records.map(asRow(SWAP_TYPE));

/** The person's rows, then each starter row they hold no row of that id for: a person's copy of a starter stands in its place.
 *  When a row of theirs is marked default, a starter's default stands down, so one toolkit is still the default. */
export function withStarters(own, starters) {
  if (!Array.isArray(own)) throw new Error('Hand in the rows the person keeps as a list ([] when they keep none).');
  const held = new Set(own.map(row => row?.id));
  const theirsIsDefault = own.some(row => row?.value?.default === true);
  const kept = starters.filter(row => !held.has(row.id)).map(row => (theirsIsDefault && row.value.default ? { ...row, value: { ...row.value, default: undefined } } : row));
  return [...own, ...kept];
}

/** A choice's swap as pointers: a swap row's id is that row's value.swap, from the person's swap rows or the starters. */
export function swapOf(swap, swapRows) {
  if (typeof swap !== 'string') return swap;
  if (!SWAP_ID.test(swap)) throw new Error(`swap is { slot: [pointer] } or the id of a swap row (toolkit-swap: then the id), not ${JSON.stringify(swap)}.`);
  const row = swapRows.find(candidate => candidate?.id === swap && candidate.type === SWAP_TYPE);
  if (!row) throw new Error(`swap ${swap} is not offered; the offered swaps are ${swapRows.map(candidate => candidate.id).join(', ') || 'none'}.`);
  return row.value.swap;
}

const idList = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && TOOL_ID.test(id))) {
    throw new Error(`${name} is a list of tool ids, each written tool: then the id.`);
  }
  return [...new Set(value)];
};

/** The toolkit rows as offered: id, title, description and their tool ids, each id once, in the row's order. */
export function offeredToolkits(rows) {
  if (!Array.isArray(rows)) throw new Error(`toolkits is a list of ${TOOLKIT_TYPE} rows: { id, type, value: { title?, description?, tools } }.`);
  const seen = new Set();
  const offered = rows.map((row, at) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) throw new Error(`toolkits[${at}] needs an id.`);
    if (row.type !== TOOLKIT_TYPE) throw new Error(`toolkits[${at}] is type ${row.type}, not ${TOOLKIT_TYPE}.`);
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error(`toolkits[${at}] needs a value: { title?, description?, tools }.`);
    if (seen.has(row.id)) throw new Error(`toolkits[${at}] repeats the toolkit id ${row.id}.`);
    seen.add(row.id);
    const { title, description, tools } = row.value;
    const stack = readToolkitStack(row.value, `toolkits[${at}].value`);
    if (row.value.default !== undefined && row.value.default !== true) throw new Error(`toolkits[${at}].value.default is true or left out.`);
    return {
      id: row.id,
      ...(row.value.default === true ? { default: true } : {}),
      ...(stack ? { stack } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      tools: idList(tools, `toolkits[${at}].value.tools`),
    };
  });
  const defaults = offered.filter(row => row.default);
  if (defaults.length > 1) throw new Error(`${defaults.map(row => row.id).join(', ')} are all marked default; one toolkit is the default.`);
  return offered;
}

/** What first setup installs for the person's choice: the toolkit's tool ids without the dropped ones, then the added ones.
 *  Refuses a toolkit that is not offered, a drop of an id the toolkit does not list, an id both dropped and added, and
 *  (when known_tools is handed in) an added id that is not installable. */
export function chooseToolkit({ toolkits, choice, knownTools = null }) {
  const offered = offeredToolkits(toolkits);
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || typeof choice.toolkit !== 'string') {
    throw new Error('toolkit_choice is { toolkit, drop?, add? }, with the id of one offered toolkit.');
  }
  const toolkit = offered.find(row => row.id === choice.toolkit);
  if (!toolkit) throw new Error(`toolkit ${choice.toolkit} is not offered; the offered toolkits are ${offered.map(row => row.id).join(', ') || 'none'}.`);
  const drop = idList(choice.drop, 'drop');
  const add = idList(choice.add, 'add');
  const notListed = drop.filter(id => !toolkit.tools.includes(id));
  if (notListed.length) throw new Error(`${notListed.join(', ')} cannot be dropped: ${toolkit.id} does not list it.`);
  const both = add.filter(id => drop.includes(id));
  if (both.length) throw new Error(`${both.join(', ')} is both dropped and added.`);
  if (knownTools !== null) {
    const known = new Set(idList(knownTools, 'known_tools'));
    const unknown = add.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`${unknown.join(', ')} cannot be added: no such tool is installable here.`);
  }
  const kept = toolkit.tools.filter(id => !drop.includes(id));
  const added = add.filter(id => !kept.includes(id));
  // Any part is swapped as tools are: the named slots take the chosen pointers, the others stay as the toolkit has them.
  const swap = choice.swap === undefined ? {} : readStack(choice.swap, 'swap');
  const swapped = Object.keys(swap);
  const stack = toolkit.stack || swapped.length ? readStack({ ...(toolkit.stack ?? {}), ...swap }, `${toolkit.id} with its swaps`) : null;
  return { toolkit: toolkit.id, tools: [...kept, ...added], dropped: drop, added, ...(swapped.length ? { swapped } : {}), ...(stack ? { stack } : {}) };
}

/** The cart first setup fills for a new account: the person's choice when they made one, else the one toolkit marked default,
 *  as it stands. Refuses when nothing is picked and no offered toolkit is the default. */
export function fillCart({ toolkits, choice = null, knownTools = null }) {
  if (choice) return { ...chooseToolkit({ toolkits, choice, knownTools }), picked: true };
  const standing = offeredToolkits(toolkits).find(row => row.default);
  if (!standing) throw new Error('Nothing was picked and no offered toolkit is marked default.');
  return { ...chooseToolkit({ toolkits, choice: { toolkit: standing.id }, knownTools }), picked: false };
}
