// A toolkit is a list row of type record:toolkit that lists tool ids. First setup offers the account's toolkit rows; the person
// picks one, drops some of its tool ids and adds others. This is the whole decision: the caller reads the rows with
// TOOLKITS_READ (records:list at the person's own records, the same read every list uses) and hands them in as they come, and
// installs what comes back. The Workshop ships starter toolkits as rows of this type (toolkits/), the way it ships tool rows.
// Nothing here reads storage or writes.
//
//   toolkit row   { id, type: 'record:toolkit', value: { title?, description?, tools: ['tool:...', ...] } }
//   choice        { toolkit: the id of an offered toolkit row, drop?: [tool ids], add?: [tool ids] }
//   known_tools   optional: every tool id the caller can install; an added id outside it is refused

const TOOL_ID = /^tool:\S+$/;
const TOOLKIT_TYPE = 'record:toolkit';

/** The one read that finds the toolkit rows: every list is read with records:list at the person's own records. */
export const TOOLKITS_READ = { address: '@own-records', method: 'records:list', input: { type: TOOLKIT_TYPE } };

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
  return rows.map((row, at) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) throw new Error(`toolkits[${at}] needs an id.`);
    if (row.type !== TOOLKIT_TYPE) throw new Error(`toolkits[${at}] is type ${row.type}, not ${TOOLKIT_TYPE}.`);
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error(`toolkits[${at}] needs a value: { title?, description?, tools }.`);
    if (seen.has(row.id)) throw new Error(`toolkits[${at}] repeats the toolkit id ${row.id}.`);
    seen.add(row.id);
    const { title, description, tools } = row.value;
    return {
      id: row.id,
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      tools: idList(tools, `toolkits[${at}].value.tools`),
    };
  });
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
  return { toolkit: toolkit.id, tools: [...kept, ...added], dropped: drop, added };
}
