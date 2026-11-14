// tools/workflows/read-data/draft-a-kit.mjs
//
// A kit (L082, kit-template.json) drafted from the item's own row and nothing else: the item's words, its input schema, its
// sample run and its steps. Nothing is invented: a part the item's own data cannot give leaves the draft refused by kitProblems,
// and the refusal's words are the gap (`kitGap`). A draft is marked `draft: true` until a person or lane has read it.
//
//   draftKit({ recipe | tool, known?, keptLists? }) -> { kit, problems }
//     `known`: the ids a set may name (every item here and the host's tools)
//     `keptLists`: list id -> the list entry (fields, example rows, alike) another kit here already holds, reused when the item names that list     problems are kitProblems' words; empty when the draft is whole
//
// No item is named here; the shape of the draft is the template's.

import { itemNames, kitProblems } from './kit-problems.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const words = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const first = text => words(text).split(/(?<=[.!?])\s/)[0];

// An example value taken from the schema's own words (const, enum, default, examples), never made up; undefined when it gives none.
function exampleOf(schema, name = 'value', placeholders = []) {
  if (!object(schema)) return undefined;
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === 'object') {
    const out = {};
    for (const key of schema.required ?? []) {
      const value = exampleOf(schema.properties?.[key], key, placeholders);
      if (value === undefined) return undefined;
      out[key] = value;
    }
    return out;
  }
  if (schema.type === 'array') {
    if (!schema.minItems) return [];
    const one = exampleOf(schema.items, name, placeholders);
    return one === undefined ? undefined : [one];
  }
  // A value only the person can give: shown as a placeholder naming it and its schema's own words, and listed in `placeholders`.
  placeholders.push(name);
  return `<${name}${schema.description ? `: ${first(schema.description).replace(/[.]$/, '')}` : schema.type ? `: ${schema.type}` : ''}>`;
}

// What the item's own schema or sample says comes back, in words.
function comesBack(answerSchema, sample, selector, job) {
  if (sample?.contains !== undefined) return `The answer's ${sample.output_selector ?? 'result'} contains "${words(sample.contains)}".`;
  const fields = Object.keys(answerSchema?.properties ?? {});
  if (fields.length) return `An answer with the fields ${fields.slice(0, 8).join(', ')}.`;
  if (typeof selector === 'string' && selector) return `The answer's ${selector} holds the result: ${first(job)}`;
  return job ? `The result the item's own job names: ${first(job)}` : '';
}

const runCall = (tool, input) => ({ server: 'trillion', tool: 'run_resource_operation', input: { address: '@workshop-tools', method: 'tools:run', input: { tool, input } } });

function toolDraft(tool) {
  const sample = (tool.verify ?? []).find(entry => entry?.input !== undefined);
  const placeholders = [];
  const input = sample ? sample.input : exampleOf(tool.input_schema, 'input', placeholders);
  const back = comesBack(tool.output_schema, sample, tool.result_selector, tool.job);
  const required = tool.input_schema?.required ?? [];
  const asks = required.length ? `with ${required.join(', ')}` : 'with nothing more';
  return {
    start_here: `Say to your AI: "Run ${tool.id} ${asks}." ${first(tool.job)}`,
    instructions: [
      `1. Say to your AI: "Run ${tool.id}", and give it ${required.length ? required.join(', ') : 'nothing more'}.`,
      `2. The AI calls run_resource_operation at @workshop-tools with method tools:run, tool ${tool.id} and its input (the worked example shows one).`,
      `3. Read what comes back: ${back || 'the tool\'s answer'}`,
    ],
    example: input === undefined ? null : {
      title: `${tool.label ?? tool.id} on a sample input`, ask: `Run ${tool.id}.`, mcp: runCall(tool.id, input), hands_back: back, ...(placeholders.length ? { given: `The person gives: ${[...new Set(placeholders)].join(', ')} (shown as <name> in the input).` } : {}),
    },
    workflows: [], tools: [tool.id, ...itemNames({ tool }).tools],
  };
}

function recipeDraft(recipe) {
  const steps = recipe.steps ?? [];
  const placeholders = [];
  const input = exampleOf(recipe.input_schema ?? { type: 'object' }, 'input', placeholders);
  const names = itemNames({ recipe });
  const [step] = steps;
  const fields = object(step?.submit) ? (step.submit.required ?? Object.keys(step.submit.properties ?? {})) : [];
  const back = step ? `Step ${step.id} answers with ${fields.length ? fields.join(', ') : 'its result'}.` : '';
  return {
    start_here: `Say to your AI: "Run ${recipe.id}." ${first(recipe.job)}`,
    instructions: [
      `1. Say to your AI: "Run ${recipe.id}"${input && Object.keys(input).length ? ' with the input in the worked example' : ''}.`,
      `2. The AI starts it with tool:start-a-recipe-run (row ${recipe.id}) and works through its steps in order: ${steps.map(item => item.id).join(', ')}.`,
      `3. Read what each step hands back; the last step is ${steps.at(-1)?.id ?? 'the only step'}.`,
    ],
    example: input === undefined || !step ? null : {
      title: `${recipe.label ?? recipe.id} from its first step`, ask: `Run ${recipe.id}.`,
      mcp: runCall('tool:start-a-recipe-run', { row: recipe.id, ...input }), workflow: recipe.id, step: step.id, hands_back: back, ...(placeholders.length ? { given: `The person gives: ${[...new Set(placeholders)].join(', ')} (shown as <name> in the input).` } : {}),
    },
    workflows: [recipe.id, ...names.workflows], tools: names.tools,
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
export function draftKit({ recipe = null, tool = null, known = null, keptLists = new Map() }) {
  const item = recipe ?? tool;
  const part = recipe ? recipeDraft(recipe) : toolDraft(tool);
  const kit = {
    draft: true,
    drafted_from: `${item.id}'s own row (its words, input schema, sample run and steps); read it before relying on it`,
    start_here: part.start_here,
    lists: itemNames({ recipe, tool }).lists.filter(id => keptLists.has(id)).map(id => keptLists.get(id)),
    no_lists_because: 'The item names no list in its own words, input or steps, so it has no example rows to ship.',
    workflows: part.workflows,
    tools: part.tools,
    instructions: part.instructions,
    worked_examples: part.example ? [part.example] : [],
  };
  if (kit.lists.length) kit.pour = pourFor(kit.lists[0]);
  const problems = kitProblems(kit, { recipe, tool });
  // A tool or workflow the item's words name that nothing offers cannot go in a set a person installs.
  if (known) for (const id of [...kit.tools, ...kit.workflows]) if (!known.has(id)) problems.push(`The item names ${id}, which no Workshop item or host tool offers.`);
  if (!part.example) problems.push(`No worked example can be drawn from the item's own data: ${tool ? 'it has no sample run and its input schema gives no example value for a required field' : 'its input schema gives no example value for a required field, or it has no step'}.`);
  return { kit, problems };
}
