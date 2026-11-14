// tools/workflows/read-data/draft-a-kit.mjs
//
// A kit (L082, kit-template.json) drafted from the item's own row and nothing else: the item's words, its input schema, its
// sample runs and its steps, and what those sample runs really answered when run (`observed`, from
// test-helpers/kit-drafter/observe.mjs). Nothing is invented: a worked example shows a real run (an answer observed, or the
// value the item's own sample says its answer contains), and a part the item's own data cannot give leaves the draft refused
// by kitProblems, and the refusal's words are the gap. A whole draft already shows a real run, so it is not marked `draft: true`;
// `drafted_from` says it was drafted and from what.
//
//   draftKit({ recipe | tool, known?, keptLists?, observed? }) -> { kit, problems }
//     known:    the ids a set may name (every item here and the host's tools)
//     keptLists: list id -> the list entry (fields, example rows, alike) another kit here already holds, reused when the item
//               names that list
//     observed: for a tool, its observed runs [{ sample, answer, kept }]; for a recipe, a Map of tool id -> observed runs, so
//               a step that runs a tool (run_tool) can show that run
//     problems: kitProblems' words and the gaps; empty when the draft is whole
//
// No item is named here; the shape of the draft is the template's.

import { itemNames, kitProblems } from './kit-problems.mjs';
import { compact, givenOf, handsBackOf, OBSERVE } from '../../../test-helpers/kit-drafter/observe.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const words = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const first = text => words(text).split(/(?<=[.!?])\s/)[0];
const lower = text => text.replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase());

// The required input fields, each with the first sentence of its own description.
function needsOf(schema) {
  const properties = object(schema?.properties) ? schema.properties : {};
  return (Array.isArray(schema?.required) ? schema.required : []).map(name => (properties[name]?.description ? `${name} (${first(properties[name].description)})` : name));
}

const runCall = (tool, input) => ({ server: 'trillion', tool: 'run_resource_operation', input: { address: '@workshop-tools', method: 'tools:run', input: { tool, input } } });
const rightsOf = tool => [tool.invoke?.records?.rights ?? []].flat().filter(object);

// How the person (or their AI) runs a tool: through the door, or on their own computer from the commands its row gives.
function runLine(tool) {
  if (tool.invoke?.kind !== 'on-your-computer') return `2. The AI calls run_resource_operation at @workshop-tools with method tools:run, tool ${tool.id} and its input (the worked example shows one).`;
  const getIt = [tool.invoke.get_it ?? []].flat();
  return `2. It runs on your own computer: the AI reads how with run_resource_operation at @workshop-tools, tools:list { tool: "${tool.id}" }${getIt.length ? `, gets it with ${getIt.join('; ')}` : ''}, then runs ${tool.invoke.run ?? 'its run command'}.`;
}

function toolDraft(tool, observed = []) {
  const needs = needsOf(tool.input_schema);
  const sample = (tool.verify ?? []).find(entry => entry?.kind === 'sample-run' && entry.input !== undefined && entry.contains !== undefined);
  const examples = observed.map(seen => ({
    title: `${tool.label ?? tool.id} on its own sample`, ask: first(tool.job), mcp: runCall(tool.id, seen.sample.input), given: givenOf(seen.sample), hands_back: handsBackOf(seen),
  }));
  // No run ended well here: the item's own sample still says what its answer contains.
  if (!examples.length && sample) examples.push({
    title: `${tool.label ?? tool.id} on its own sample`, ask: first(tool.job), mcp: runCall(tool.id, sample.input), given: givenOf(sample),
    hands_back: `The answer's ${sample.output_selector ?? tool.result_selector ?? 'result'} contains "${words(sample.contains)}".`,
  });
  const [seen] = observed;
  const rights = rightsOf(tool);
  return {
    start_here: seen
      ? `Say to your AI: "${first(tool.job)}", with ${compact(seen.sample.input, OBSERVE.input_chars)}. It runs ${tool.id} and answers ${compact(seen.answer, OBSERVE.input_chars)}`
      : sample ? `Say to your AI: "${first(tool.job)}", with ${compact(sample.input, OBSERVE.input_chars)}. It runs ${tool.id}; its answer contains "${words(sample.contains)}".` : null,
    instructions: [
      `1. Say to your AI: "${first(tool.job)}", and give it ${needs.length ? needs.join('; ') : 'nothing more: every input is optional'}.`,
      runLine(tool),
      `3. Read what comes back: ${words(tool.output_schema?.description) || first(tool.description) || first(tool.job)}`,
      ...(rights.length ? [`4. It reads and writes only its own rows through the records door: ${rights.map(right => `${right.kind ?? right.prefix} (${[right.operations ?? []].flat().join(', ')})`).join('; ')}.`] : []),
    ],
    examples,
    no_lists_because: rights.length
      ? `It names no list of yours: it takes its input and keeps only its own rows (${[...new Set(rights.map(right => right.kind ?? right.prefix))].join(', ')}) through the records door.`
      : 'It names no list of yours: it takes its input and answers, and keeps no row.',
    gap: examples.length ? null : `No real run can be shown: ${(tool.verify ?? []).some(entry => entry?.kind === 'sample-run') ? 'none of its sample runs ended well here and none says what its answer contains' : 'it has no sample run (verify, kind sample-run)'}.`,
    workflows: itemNames({ tool }).workflows, tools: [tool.id, ...itemNames({ tool }).tools],
  };
}

function recipeDraft(recipe, observedByTool = new Map()) {
  const steps = recipe.steps ?? [];
  const names = itemNames({ recipe });
  const needs = needsOf(recipe.input_schema);
  const examples = [];
  for (const step of steps) {
    const toolId = step.run_tool?.tool_id;
    const [seen] = (toolId && observedByTool.get(toolId)) || [];
    if (!seen || examples.length >= OBSERVE.most_runs) continue;
    examples.push({ title: `Step ${step.id}: ${step.title ?? step.id}`, ask: `Run ${recipe.id}.`, mcp: runCall(toolId, seen.sample.input), workflow: recipe.id, step: step.id, given: givenOf(seen.sample), hands_back: handsBackOf(seen) });
  }
  const writesRows = JSON.stringify(steps).includes('records:write');
  return {
    start_here: needs.length ? null : `Say to your AI: "Run ${recipe.id}." It ${lower(first(recipe.job))}`,
    instructions: [
      `1. Say to your AI: "Run ${recipe.id}"${needs.length ? `, with ${needs.join('; ')}` : ''}; it starts it with tool:start-a-recipe-run (row ${recipe.id}).`,
      ...steps.map((step, at) => `${at + 2}. ${step.title ?? step.id}${step.done_when ? `: done when ${words(step.done_when)}` : '.'}`),
      `${steps.length + 2}. Read what it gives back: ${words(recipe.produces) || `what step ${steps.at(-1)?.id ?? 'the last step'} hands back`}`,
    ],
    examples,
    no_lists_because: writesRows ? null : 'Its steps name no list and write no row: each step answers in the run itself.',
    gap: [
      ...(needs.length ? [`start_here needs real values for its input: ${needs.join('; ')}.`] : []),
      ...(examples.length ? [] : ['No real run of a step can be shown: no step runs a tool (run_tool) whose own sample run ended well here.']),
      ...(writesRows ? ['Its steps write rows (records:write) but the kit cannot name those lists with fields and example rows from the recipe alone.'] : []),
    ].join(' ') || null,
    workflows: [recipe.id, ...names.workflows], tools: [...new Set(['tool:start-a-recipe-run', ...names.tools])],
  };
}

// How the first list's example rows go into a list the person already keeps: the pour tool, asked of the list's own fields.
function pourFor(list) {
  return {
    tool: 'tool:pour-example-rows-into-my-list', least_coverage: 0.8,
    how: 'Name the list you already keep for the same job and read it with records:read (its fields and row type). Run tool:pour-example-rows-into-my-list with that list as into and this kit list as kit_list: it matches each kit field to one of yours (your map, the same id, the same label, or a name in alike), pours nothing under 80% and names the fields with no home, and otherwise answers the one records:write that adds the example rows beside your own.',
    example: { kit_list: list.list, into: { list: `list:my-${list.list.slice(5)}`, row_type: list.row_type, fields: list.fields.map(({ id, label }) => ({ id, label })) } },
  };
}

/** The draft kit for one item, and the words of what still stops it passing. */
export function draftKit({ recipe = null, tool = null, known = null, keptLists = new Map(), observed = undefined }) {
  const item = recipe ?? tool;
  const part = recipe ? recipeDraft(recipe, observed) : toolDraft(tool, observed);
  const kit = {
    drafted_from: `${item.id}'s own row (its words, input schema, sample runs and steps) and what its sample runs answered here; read it before relying on it`,
    start_here: part.start_here,
    lists: itemNames({ recipe, tool }).lists.filter(id => keptLists.has(id)).map(id => keptLists.get(id)),
    ...(part.no_lists_because ? { no_lists_because: part.no_lists_because } : {}),
    workflows: part.workflows,
    tools: part.tools,
    instructions: part.instructions,
    worked_examples: part.examples,
  };
  if (kit.lists.length) { kit.pour = pourFor(kit.lists[0]); delete kit.no_lists_because; }
  const problems = kitProblems(kit, { recipe, tool });
  // A tool or workflow the item's words name that nothing offers cannot go in a set a person installs.
  if (known) for (const id of [...kit.tools, ...kit.workflows]) if (!known.has(id)) problems.push(`The item names ${id}, which no Workshop item or host tool offers.`);
  if (part.gap) problems.push(part.gap);
  return { kit, problems };
}
