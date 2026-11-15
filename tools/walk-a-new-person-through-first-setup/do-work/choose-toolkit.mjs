// A toolkit is a row that lists tool ids. First setup offers the account's toolkit rows; the person picks one, drops some of
// its tool ids and adds others. This is the whole decision: the caller reads the toolkit rows from the person's own list and
// hands them in, and installs what comes back. Nothing here reads storage or writes.
//
//   toolkit row   { id, title?, description?, tools: ['tool:...', ...] }
//   choice        { toolkit: the id of an offered toolkit row, drop?: [tool ids], add?: [tool ids] }
//   known_tools   optional: every tool id the caller can install; an added id outside it is refused

const TOOL_ID = /^tool:\S+$/;

const idList = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && TOOL_ID.test(id))) {
    throw new Error(`${name} is a list of tool ids, each written tool: then the id.`);
  }
  return [...new Set(value)];
};

/** The toolkit rows as offered: id, title, description and their tool ids, each id once, in the row's order. */
export function offeredToolkits(rows) {
  if (!Array.isArray(rows)) throw new Error('toolkits is a list of toolkit rows: { id, title?, description?, tools }.');
  const seen = new Set();
  return rows.map((row, at) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) throw new Error(`toolkits[${at}] needs an id.`);
    if (seen.has(row.id)) throw new Error(`toolkits[${at}] repeats the toolkit id ${row.id}.`);
    seen.add(row.id);
    return {
      id: row.id,
      ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      tools: idList(row.tools, `toolkits[${at}].tools`),
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
