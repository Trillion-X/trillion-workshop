// src/tool-listing-budget.mjs
//
// PURPOSE
//   The MCP tool list, shrunk in steps to fit a budget the asking AI names. Trillion serves hundreds of tools; an AI with a
//   small window can ask for the most detail that fits (tools/list with params.budget_chars) and is told what it did not
//   get. The levels, their order and the words are DATA (src/tool-listing-budget.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Without a named budget nothing changes: the list is exactly what the server holds. A budget is never inferred.
//   2. The most detailed level whose whole list fits is sent; when none fits the least detailed is sent, and the answer
//      says so in _meta rather than pretending it fit.
//   3. A level only removes text and schema detail; it never renames, reorders or drops a tool.
import settings from './tool-listing-budget.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sentence = text => { const at = String(text ?? '').search(/[.!?](\s|$)/); return at === -1 ? String(text ?? '') : String(text).slice(0, at + 1); };

function withoutPropertyDescriptions(schema) {
  if (Array.isArray(schema)) return schema.map(withoutPropertyDescriptions);
  if (!object(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key, value]) => !(key === 'description' && typeof value === 'string')).map(([key, value]) => [key, withoutPropertyDescriptions(value)]));
}

/** One tool shown at one level of the DATA. */
export function shownAt(tool, level) {
  const { description, inputSchema, ...rest } = tool;
  const text = level.description === 'full' ? description : level.description === 'first_sentence' ? sentence(description) : undefined;
  const schema = !level.schema ? { type: 'object' } : level.property_descriptions ? inputSchema : withoutPropertyDescriptions(inputSchema);
  return { ...rest, ...(text ? { description: text } : {}), inputSchema: schema };
}

/** The list at the most detailed level that fits `budget` characters: { tools, level, chars, fits }, or null when no budget is named. */
export function listWithinBudget(tools, budget, rules = settings) {
  if (!(Number.isFinite(budget) && budget > 0)) return null;
  let last = null;
  for (const level of rules.levels) {
    const shown = tools.map(tool => shownAt(tool, level));
    const chars = JSON.stringify(shown).length;
    last = { tools: shown, level: level.id, chars, fits: chars <= budget };
    if (last.fits) return last;
  }
  return last;
}

/** The _meta that tells the AI what it was sent. */
export const listingMeta = (answer, budget, rules = settings) => ({
  [rules.meta_key]: { level: answer.level, chars: answer.chars, budget_chars: budget, fits: answer.fits, tools: answer.tools.length,
    ...(answer.level === rules.levels[0].id ? {} : { said: rules.words.shrunk.replace('{budget}', String(budget)).replace('{level}', answer.level) }) },
});

/** The listing with the tools the AI named (params.names) put back in full, in their place; the names no tool has go in `unknown`. */
export function withNamedInFull(shown, full, names, rules = settings) {
  if (!Array.isArray(names) || !names.length) return { tools: shown, unknown: [] };
  const wanted = new Set(names.filter(name => typeof name === 'string'));
  const held = new Set(full.map(tool => tool.name));
  return { tools: shown.map((tool, at) => (wanted.has(tool.name) ? full[at] : tool)), unknown: [...wanted].filter(name => !held.has(name)), said: rules.words.unknown_names };
}
