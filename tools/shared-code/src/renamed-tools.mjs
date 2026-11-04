// Former ids of tools, agents and Marketplace configurations, mapped to their current ids.
// Released device apps and saved install rows may still name a former id, so readers
// go through these helpers instead of comparing ids directly.
import renamed from '../../keep-and-wake-ai-sessions-on-this-computer/src/renamed-tools.json' with { type: 'json' };

const toolMap = renamed.tools;
const agentMap = renamed.agents;
const prefixMap = renamed.agent_prefixes;
const configurationMap = renamed.configurations;

const invert = (map) => {
  const out = {};
  for (const [former, current] of Object.entries(map)) {
    out[current] = [...(out[current] ?? []), former];
  }
  return out;
};

const formerTools = invert(toolMap);
const formerAgents = invert(agentMap);

export function currentToolId(id) {
  return toolMap[id] ?? id;
}

export function formerToolIds(id) {
  return formerTools[id] ?? [];
}

// A whole former agent id, or a former agent id under a former prefix (the table in renamed-tools.json holds both).
export function currentAgentId(id) {
  if (typeof id !== 'string') return id;
  if (agentMap[id]) return agentMap[id];
  for (const [former, current] of Object.entries(prefixMap)) {
    if (id.startsWith(former)) return current + id.slice(former.length);
  }
  return id;
}

export function formerAgentIds(id) {
  if (typeof id !== 'string') return [];
  const out = [...(formerAgents[id] ?? [])];
  for (const [former, current] of Object.entries(prefixMap)) {
    if (id.startsWith(current)) out.push(former + id.slice(current.length));
  }
  return out;
}

export function currentConfigurationSlug(slug) {
  return configurationMap[slug] ?? slug;
}

const placementMap = renamed.placements ?? {};
const operationMap = Object.fromEntries(Object.entries(renamed.operations ?? {}).filter(([name]) => !name.startsWith('_')));

// An MCP operation merged into another (renamed-tools.json operations): { to, input(given), answer(result) } for a former
// name, so a caller that still sends it is answered by the current operation in the shape it was written for; null otherwise.
export function formerOperation(name) {
  const row = Object.hasOwn(operationMap, name) ? operationMap[name] : null;
  if (!row) return null;
  const renamed = (value, names = {}) => Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [names[key] ?? key, item]));
  const filled = item => (item && typeof item === 'object' && !Array.isArray(item)
    ? { ...Object.fromEntries(Object.entries(row.row_fills ?? {}).map(([field, from]) => [field, item[field] ?? item[from]])), ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== null)) }
    : item);
  return {
    to: row.to,
    input: given => ({ ...(row.input ?? {}), ...renamed(given, row.input_names) }),
    answer: result => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const out = renamed(result, row.answer_names);
      for (const key of Object.values(row.answer_names ?? {})) if (Array.isArray(out[key])) out[key] = out[key].map(filled);
      return out;
    },
  };
}

// A placement id as its current id. Licence classes from the shared package may still name a former placement id.
export function currentPlacement(id) {
  return placementMap[id] ?? id;
}

// The install row with its configuration slug and removed tool ids moved to current ids.
export function currentInstallRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if (typeof out.follows === 'string') out.follows = currentConfigurationSlug(out.follows);
  if (Array.isArray(out.without)) out.without = out.without.map(currentToolId);
  return out;
}

// The skill a card lists for a tool: the current id first, then any former id.
// Returns null when the card lists neither.
export function cardSkillFor(card, tool_id) {
  const skills = Array.isArray(card?.skills) ? card.skills : [];
  const current = currentToolId(tool_id);
  for (const id of [current, ...formerToolIds(current)]) {
    const skill = skills.find((item) => item?.id === id || item?.name === id);
    if (skill) return skill;
  }
  return null;
}

// The former tool and agent ids a device or AI can still send (whole ids, and agent prefixes by their former prefix),
// with how long each must go unused before its row is retired (the service watch former-names-retire reads this).
export function formerNames() {
  return {
    ids: [...Object.keys(toolMap), ...Object.keys(agentMap), ...Object.keys(prefixMap), ...Object.keys(operationMap)],
    counted_since: renamed.counted_since,
    quiet_days: renamed.quiet_days,
    note_every_minutes: renamed.note_every_minutes,
  };
}

// The former ids an agents request names: its agent, the agent it addresses, the tool it runs and the skills its card
// lists. An agent id under a former prefix counts as that prefix.
export function formerIdsIn(input) {
  const found = new Set();
  const look = (id) => {
    if (typeof id !== 'string') return;
    if (Object.hasOwn(toolMap, id) || Object.hasOwn(agentMap, id)) found.add(id);
    else for (const former of Object.keys(prefixMap)) if (id.startsWith(former)) found.add(former);
  };
  look(input?.agent_id);
  look(input?.to_agent);
  look(input?.tool_id);
  for (const skill of Array.isArray(input?.skills) ? input.skills : []) {
    look(typeof skill === 'string' ? skill : skill?.id);
    look(skill?.name);
  }
  return [...found];
}
