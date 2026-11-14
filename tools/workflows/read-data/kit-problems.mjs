// tools/workflows/read-data/kit-problems.mjs
//
// The kit every Workshop item ships with (L082), checked: what is missing or wrong in an item's kit, every problem at
// once. What a kit holds and its minimums are DATA (../kit-template.json `rules`); this reads them.
//
//   kitProblems(kit, { recipe, tool, template }) -> string[]
//
// `recipe` is the workflow recipe the kit belongs to (its steps name the lists, workflows and tools the kit must cover,
// and a worked example's step must be one of them); `tool` is the tool row it belongs to (its kit names the tool
// itself). Give one of them.

import { readFileSync } from 'node:fs';

export const KIT_TEMPLATE = JSON.parse(readFileSync(new URL('../kit-template.json', import.meta.url), 'utf8'));

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const words = value => (nonempty(value) ? value.trim().split(/\s+/).length : 0);
const LIST = /\blist:[a-z0-9][a-z0-9-]*[a-z0-9]/g;
const WORKFLOW = /\bworkflow:[a-z0-9][a-z0-9-]*[a-z0-9]/g;
const TOOL = /\btool:[a-z0-9][a-z0-9._:-]*[a-z0-9]/g;

// Every id of one kind the item's own steps (or written definition) name, its own id left out.
function named(body, pattern, own) {
  const found = new Set();
  const visit = value => {
    if (typeof value === 'string') for (const match of value.matchAll(pattern)) found.add(match[0]);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) Object.values(value).forEach(visit);
  };
  visit(body);
  found.delete(own);
  return [...found].sort();
}

/** The lists, workflows and tools an item's own words and steps name, its own id left out: what its kit must carry. */
export function itemNames({ recipe = null, tool = null }) {
  const own = recipe?.id ?? tool?.id;
  const body = recipe ? recipe.steps ?? recipe.definition : { job: tool?.job, description: tool?.description, invoke: tool?.invoke, input_schema: tool?.input_schema };
  return { lists: named(body, LIST, null), workflows: named(body, WORKFLOW, own), tools: named(body, TOOL, tool ? null : own).filter(id => id !== tool?.id) };
}

function listProblems(list, at, rules) {
  const where = `kit.lists[${at}]`;
  if (!object(list)) return [`${where} must be an object.`];
  const problems = [];
  if (!new RegExp(rules.list_id).test(list.list ?? '')) problems.push(`${where}.list must be a list id ("list:...").`);
  if (!new RegExp(rules.row_type).test(list.row_type ?? '')) problems.push(`${where}.row_type must be the row type its rows carry ("record:...").`);
  for (const field of ['label', 'holds']) if (!nonempty(list[field])) problems.push(`${where}.${field} must say, in plain words, ${field === 'label' ? 'the list\'s name' : 'what one row of it holds'}.`);
  const fields = Array.isArray(list.fields) ? list.fields : [];
  if (!fields.length) problems.push(`${where}.fields must list the list's fields ({ id, kind, label }).`);
  const ids = new Set();
  fields.forEach((field, index) => {
    if (!object(field) || !/^[a-z0-9_][a-z0-9_-]*$/.test(field.id ?? '') || !nonempty(field.label) || !rules.field_kinds.includes(field.kind)) {
      problems.push(`${where}.fields[${index}] must be { id, kind, label } with kind one of: ${rules.field_kinds.join(', ')}.`);
    } else if (ids.has(field.id)) problems.push(`${where}.fields[${index}].id "${field.id}" is used twice.`);
    else ids.add(field.id);
    if (object(field) && field.alike !== undefined && !(Array.isArray(field.alike) && field.alike.every(nonempty))) problems.push(`${where}.fields[${index}].alike must list other names the field goes by.`);
  });
  const rows = Array.isArray(list.example_rows) ? list.example_rows : [];
  if (rows.length < rules.least_example_rows) problems.push(`${where}.example_rows must hold at least ${rules.least_example_rows} filled-in example rows, so the person starts from rows, not from an empty list.`);
  const rowIds = new Set();
  rows.forEach((row, index) => {
    const rowWhere = `${where}.example_rows[${index}]`;
    if (!object(row) || !/^[a-z0-9][a-z0-9_-]*$/.test(row.id ?? '') || !object(row.values)) { problems.push(`${rowWhere} must be { id, values }.`); return; }
    if (rowIds.has(row.id)) problems.push(`${rowWhere}.id "${row.id}" is used twice.`);
    rowIds.add(row.id);
    const given = Object.entries(row.values).filter(([, value]) => value !== null && value !== '' && !(Array.isArray(value) && !value.length));
    if (!given.length) problems.push(`${rowWhere}.values must fill in the row.`);
    for (const [key] of given) if (!ids.has(key)) problems.push(`${rowWhere}.values.${key} is not one of the list's fields.`);
    if (ids.size && given.length < Math.ceil(ids.size / 2)) problems.push(`${rowWhere} fills ${given.length} of ${ids.size} fields: an example fills at least half of them.`);
  });
  if (!(Array.isArray(list.alike) && list.alike.length && list.alike.every(nonempty))) problems.push(`${where}.alike must name the lists people already keep that do the same job (a spreadsheet, an app's list), so a person can pour these rows into theirs.`);
  return problems;
}

function exampleProblems(example, at, { steps, workflows, own }) {
  const where = `kit.worked_examples[${at}]`;
  if (!object(example)) return [`${where} must be an object.`];
  const problems = [];
  for (const field of ['title', 'ask', 'hands_back']) if (!nonempty(example[field])) problems.push(`${where}.${field} must say ${field === 'ask' ? 'what the person says' : field === 'title' ? 'what the example shows' : 'what comes back, with real values'}.`);
  const mcp = example.mcp;
  if (!(object(mcp) && nonempty(mcp.server) && nonempty(mcp.tool) && object(mcp.input))) problems.push(`${where}.mcp must name the MCP server, the MCP tool the AI calls and its exact input ({ server, tool, input }).`);
  if (steps) {
    if (example.workflow !== own && !workflows.includes(example.workflow)) problems.push(`${where}.workflow must be this workflow or one its kit names.`);
    if (example.workflow === own && !steps.includes(example.step)) problems.push(`${where}.step must be one of this workflow's steps: ${steps.join(', ')}.`);
    if (example.workflow !== own && !nonempty(example.step)) problems.push(`${where}.step must name the step of ${example.workflow} it shows.`);
  } else if (example.workflow !== undefined && !(nonempty(example.workflow) && nonempty(example.step))) problems.push(`${where} names a workflow, so it must name the step too.`);
  return problems;
}

function pourProblems(pour, lists, rules) {
  if (!object(pour)) return ['kit.pour must say how the example rows go into a list the person already has ({ tool, least_coverage, how, example }).'];
  const problems = [];
  if (pour.tool !== rules.pour_tool) problems.push(`kit.pour.tool must be ${rules.pour_tool}.`);
  if (!(typeof pour.least_coverage === 'number' && pour.least_coverage >= rules.least_coverage && pour.least_coverage <= 1)) problems.push(`kit.pour.least_coverage must be a share from ${rules.least_coverage} to 1 of the kit's fields a person's list must match.`);
  if (!nonempty(pour.how)) problems.push('kit.pour.how must say in plain words how the rows are poured.');
  const example = pour.example;
  if (!(object(example) && lists.some(list => list?.list === example.kit_list) && object(example.into) && new RegExp(rules.list_id).test(example.into.list ?? '')
    && Array.isArray(example.into.fields) && example.into.fields.length)) problems.push('kit.pour.example must pour one of the kit\'s lists (kit_list) into a filled-in list of the person\'s (into: { list, row_type, fields }).');
  return problems;
}

/** Every problem with an item's kit, at once; none when the kit is whole. */
export function kitProblems(kit, { recipe = null, tool = null, template = KIT_TEMPLATE } = {}) {
  const rules = template.rules;
  if (!object(kit)) return ['The item has no kit: add one (tools/workflows/kit-template.json shows every part).'];
  const problems = [];
  const own = recipe?.id ?? tool?.id;
  // A tool's own words and how it runs; its sample runs and its kit are left out, since their values are examples.
  const body = recipe ? recipe.steps ?? recipe.definition : { job: tool?.job, description: tool?.description, invoke: tool?.invoke, input_schema: tool?.input_schema };
  const steps = recipe ? (recipe.steps ?? recipe.definition?.steps ?? []).map(step => step?.id) : null;
  if (words(kit.start_here) < 8) problems.push('kit.start_here must say, with real values, the first thing the person says to their AI to run this now.');

  const lists = Array.isArray(kit.lists) ? kit.lists : [];
  if (!Array.isArray(kit.lists)) problems.push('kit.lists must list the lists the item reads and writes, each with example rows.');
  if (!lists.length && words(kit.no_lists_because) < rules.no_lists_because_least_words) problems.push('kit.lists is empty: give the item\'s lists with example rows, or say in no_lists_because why it keeps none.');
  lists.forEach((list, at) => problems.push(...listProblems(list, at, rules)));
  const kitLists = new Set(lists.map(list => list?.list));
  for (const id of named(body, LIST, null)) if (!kitLists.has(id)) problems.push(`kit.lists must carry ${id}, which the item's steps name, with example rows.`);

  for (const [part, pattern, whole] of [['workflows', WORKFLOW, /^workflow:[a-z0-9][a-z0-9-]*$/], ['tools', TOOL, /^tool:[a-z0-9][a-z0-9._:-]*$/]]) {
    const given = kit[part];
    if (!(Array.isArray(given) && given.every(id => typeof id === 'string' && whole.test(id)))) { problems.push(`kit.${part} must list ${part === 'tools' ? '"tool:..."' : '"workflow:..."'} ids.`); continue; }
    const needed = named(body, pattern, part === 'tools' && tool ? null : own);
    if (part === 'tools' && tool) needed.push(tool.id);
    for (const id of new Set(needed)) if (!given.includes(id)) problems.push(`kit.${part} must name ${id}, which the item ${part === 'tools' && tool && id === tool.id ? 'is' : 'uses'}.`);
  }
  if (Array.isArray(kit.workflows) && !kit.workflows.length && !kit.tools?.length) problems.push('kit.workflows and kit.tools are both empty: name what the item runs.');

  const instructions = Array.isArray(kit.instructions) ? kit.instructions.filter(nonempty) : [];
  if (instructions.length < rules.least_instructions) problems.push(`kit.instructions must give at least ${rules.least_instructions} lines, from nothing to a finished run.`);

  const examples = Array.isArray(kit.worked_examples) ? kit.worked_examples : [];
  if (examples.length < rules.least_worked_examples) problems.push(`kit.worked_examples must give at least ${rules.least_worked_examples} specific run (which MCP, which workflow, which step).`);
  examples.forEach((example, at) => problems.push(...exampleProblems(example, at, { steps, workflows: Array.isArray(kit.workflows) ? kit.workflows : [], own })));

  if (lists.length || kit.pour !== undefined) problems.push(...pourProblems(kit.pour, lists, rules));
  return problems;
}

/** The input of the marketplace's publish_replacement_set for one kit: its workflows and tools as the components of one
 *  set, so a person installs the whole kit with one install_replacement_set. The lists travel as the kit's example rows
 *  (pour); a set holds at most `maxComponents` (100, the set's own limit). */
export function kitBundleInput(kit, { id, title, maxComponents = 100 }) {
  const components = [...new Set([...(kit.workflows ?? []), ...(kit.tools ?? [])])].map(item => {
    const [kind, ...rest] = item.split(':');
    return { kind, id: rest.join(':') };
  });
  if (!components.length || components.length > maxComponents) throw new Error(`${id}: a set holds 1 to ${maxComponents} components, the kit names ${components.length}.`);
  return { slug: id.slice(id.indexOf(':') + 1), title, description: kit.start_here, components };
}
