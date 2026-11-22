// The validator for workflow recipe rows: what is wrong with a recipe, every problem at once. A recipe that passes can
// be run by any account. Ported without change in behaviour from the workflow engine's `recipeProblems`.

import { readFileSync } from 'node:fs';
import { wakeProblems, WAKE_VOCABULARY } from './wake-problems.mjs';
import { conditionProblems, FIRES_WHEN } from './fires-when.mjs';
import { CHECK_VOCABULARY, checkProblems } from './check-bindings.mjs';

export { CHECK_VOCABULARY };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// Who an ask asks is a literal or a binding the engine resolves (a step no tool runs asks the run's own actor).
const toolNamed = name => typeof name === 'string' && name.startsWith('tool:');
const named = name => nonempty(name) || (object(name) && name.$kind === 'binding');
export const STEP_ANATOMY = JSON.parse(readFileSync(new URL('./step-anatomy.json', import.meta.url), 'utf8'));

// Syntax only: references and extension keywords remain the execution owner's
// responsibility. Reject malformed schema containers before reading check paths.
function submitShapeProblems(schema, name, seen = new Set()) {
  if (typeof schema === 'boolean') return [];
  if (!object(schema) || seen.has(schema)) return [`${name} must be an acyclic object or boolean schema.`];
  seen.add(schema);
  const problems = [];
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string') && new Set(value).size === value.length;
  if (schema.required !== undefined && !strings(schema.required)) problems.push(`${name}.required must be a list of unique field names.`);
  const types = ['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'];
  if (schema.type !== undefined && !(typeof schema.type === 'string' ? types.includes(schema.type) : strings(schema.type) && schema.type.length && schema.type.every(type => types.includes(type)))) problems.push(`${name}.type must name JSON Schema value types.`);
  for (const field of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) if (schema[field] !== undefined) {
    if (!object(schema[field])) problems.push(`${name}.${field} must map names to schemas.`);
    else for (const [key, child] of Object.entries(schema[field])) problems.push(...submitShapeProblems(child, `${name}.${field}.${key}`, seen));
  }
  for (const field of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (schema[field] !== undefined) {
    if (!Array.isArray(schema[field]) || !schema[field].length) problems.push(`${name}.${field} must be a nonempty schema list.`);
    else schema[field].forEach((child, index) => problems.push(...submitShapeProblems(child, `${name}.${field}[${index}]`, seen)));
  }
  for (const field of ['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems']) if (schema[field] !== undefined) problems.push(...submitShapeProblems(schema[field], `${name}.${field}`, seen));
  seen.delete(schema);
  return problems;
}

/** The same branch/order context is used by population and source coverage. */
export function stepAnatomyContext(step, rows) {
  const prior = rows.filter(row => row !== step && Number.isInteger(row?.position) && row.position < step?.position
    && Array.isArray(row.part_of) && Array.isArray(step?.part_of) && row.part_of.some(branch => step.part_of.includes(branch)));
  return { earlier: new Set(prior.map(row => row.id)), schemas: { this: step?.submit, steps: new Map(prior.map(row => [row.id, row.submit])) } };
}

// Reusable for account rows as well as recipe steps. This validates the anatomy, not the truth of the words.
// Judged answers carry both examples; machine checks continue through the existing vocabulary validator below.
export function stepAnatomyProblems(step, { name = 'step', judged = step?.judged === true, vocabulary = CHECK_VOCABULARY, earlier = new Set(), schemas = { this: step?.submit }, validateChecks = true } = {}) {
  if (!object(step)) return [`${name} must be an object.`];
  const problems = [];
  for (const field of STEP_ANATOMY.required_text) if (!nonempty(step[field])) problems.push(`${name}.${field} must be nonempty text.`);
  if (!(object(step.submit) && step.submit.type === 'object')) problems.push(`${name}.submit must be a JSON Schema with "type": "object".`);
  else problems.push(...submitShapeProblems(step.submit, `${name}.submit`));
  for (const field of STEP_ANATOMY.required_references) if (!(Array.isArray(step[field]) && step[field].length > 0 && step[field].every(nonempty))) problems.push(`${name}.${field} must list at least one nonempty source or branch id.`);
  if (!(Number.isInteger(step.position) && step.position >= 0)) problems.push(`${name}.position must be an integer at least zero.`);
  const exampleParts = nonempty(step.good_answer) && step.good_answer.match(/\bPasses:\s*([\s\S]*?)\bFails:\s*([\s\S]*)/i);
  const examples = exampleParts && nonempty(exampleParts[1]) && nonempty(exampleParts[2]);
  if (step.good_answer !== undefined && !examples) problems.push(`${name}.good_answer must include nonempty Passes: and Fails: examples.`);
  if (judged && !examples) problems.push(`${name}.good_answer is required for a judged step, with Passes: and Fails: examples.`);
  if (step.checks !== undefined && !Array.isArray(step.checks)) problems.push(`${name}.checks must be a list when supplied.`);
  if (validateChecks && Array.isArray(step.checks)) problems.push(...checkProblems(step.checks, name, step.id, earlier, vocabulary, schemas));
  if (!(Array.isArray(step.checks) && step.checks.length > 0) && !examples) problems.push(`${name} must have machine checks or good_answer with Passes: and Fails: examples.`);
  return problems;
}
const PIN = /^1f:[a-f0-9]{64}$/;

const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/;

// The tools the host itself offers a person's AI, as DATA (host-tools.json): a recipe may name them though no tool row
// of the Workshop does. Everything else a recipe names must be a Workshop tool, or it is reported as a gap.
export const HOST_TOOLS = new Set(JSON.parse(readFileSync(new URL('../host-tools.json', import.meta.url), 'utf8')).tools.map(row => row.tool));
const TOOL_ID = /tool:[a-z0-9][a-z0-9.:-]*[a-z0-9]/g;

// Every tool id a recipe names, sorted: the tool of a step's run_tool and each `tool:<id>` in the words of its steps
// (or of a written definition), including the words of the schemas it hands back.
export function recipeToolIds(recipe) {
  const found = new Set();
  const visit = (value, key) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TOOL_ID)) found.add(match[0]);
      if (key === 'tool_id' && value.startsWith('tool:')) found.add(value);
    } else if (Array.isArray(value)) value.forEach(item => visit(item));
    else if (object(value)) Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(recipe?.steps ?? recipe?.definition);
  return [...found].sort();
}

// The tool ids a recipe names that no Workshop tool and no host tool offers. `known` holds the Workshop's tool ids
// (workshop-tool-ids.mjs reads them from the tool rows). A gap is a warning, never a refusal: the recipe is valid and
// says what it needs, and the list is what to build or port next.
export function recipeToolGaps(recipe, { known, host = HOST_TOOLS }) {
  return recipeToolIds(recipe).filter(id => !known.has(id) && !host.has(id));
}

// A shared block is a workflow row that does what recipes used to copy as a step written out for whoever answers. Its
// definition's `stands_for` lists the words of the steps it replaced, as they were written; a hand step whose words open
// the same way is that block written out again, and runs the block instead (an action step naming it). Adding a block
// row with its `stands_for` is all it takes for every later recipe to be pointed at it.
const BLOCK_OPENING_WORDS = 10;

/** A step's words with what differs from copy to copy taken out: quoted, bracketed and code text, workflow/tool/record
 *  ids and numbers each become one placeholder, and only lowercase letters remain. */
export function stepWords(text) {
  return String(text ?? '').toLowerCase()
    .replace(/`[^`]*`/g, ' x ').replace(/<[^<>]*>/g, ' x ').replace(/"[^"]*"/g, ' x ')
    .replace(/(workflow|tool|record|list|brief):[a-z0-9:._#-]+/g, ' x ')
    .replace(/\b\d[\d.,:]*\b/g, ' n ')
    .replace(/[^a-z ]+/g, ' ')
    .split(/\s+/).filter(Boolean);
}

const opening = (text, count = BLOCK_OPENING_WORDS) => {
  const words = stepWords(text);
  return words.length >= count ? words.slice(0, count).join(' ') : null;
};

/** The blocks among workflow rows ({ recipe, definition } as kept, or payloads with id): each row whose definition lists
 *  `stands_for`, with the openings of those words. A block whose copies share their first words with other steps says
 *  how many words tell its copies apart (`stands_for_words`, more than the default ten). */
export function sharedBlocks(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const id = row?.recipe ?? row?.id;
    const standsFor = row?.definition?.stands_for;
    const asked = row?.definition?.stands_for_words;
    const words = Number.isInteger(asked) && asked > BLOCK_OPENING_WORDS ? asked : BLOCK_OPENING_WORDS;
    const openings = [...new Set((Array.isArray(standsFor) ? standsFor : []).map(text => opening(text, words)).filter(Boolean))];
    return typeof id === 'string' && openings.length ? [{ id, words, openings }] : [];
  });
}

// The words of a step someone answers by hand; a tool step, an action and a loop already run something.
function handWords(step) {
  if (step?.kind !== 'ask' || toolNamed(step.config?.name)) return null;
  return step.config?.input?.do ?? step.config?.context?.do ?? null;
}

/** Each hand step of a recipe that writes out a shared block again, naming the block to run instead. A block is never
 *  pointed at itself. */
export function recipeBlockRepeats(recipe, { blocks = [] } = {}) {
  const steps = Array.isArray(recipe?.definition?.steps) ? recipe.definition.steps.map(step => ({ id: step?.id, words: handWords(step), at: 'definition.steps' }))
    : Array.isArray(recipe?.steps) ? recipe.steps.filter(step => step?.run_tool === undefined).map(step => ({ id: step?.id, words: step?.do, at: 'steps' })) : [];
  const repeats = [];
  for (const step of steps) {
    const block = blocks.find(item => {
      const words = opening(step.words, item.words ?? BLOCK_OPENING_WORDS);
      return words && item.id !== recipe?.id && item.openings.includes(words);
    });
    if (block) repeats.push(`${step.at}.${step.id} writes out ${block.id} again: run it as one step, { "kind": "action", "config": { "definition_id": "${block.id}", "inputs": { ... } } }, binding its input from this run, instead of copying its words.`);
  }
  return repeats;
}

// Every problem with a pin a caller sent; none for a step with no pin.
function pinProblems(pinned, name) {
  if (pinned === undefined) return [];
  if (!object(pinned) || !PIN.test(pinned.version ?? '') || !object(pinned.fields) || !Object.values(pinned.fields).every(value => PIN.test(value ?? ''))) {
    return [`${name} must be { version: "1f:...", fields: { field: "1f:..." } }, as describe_workflow shows it; leave it out and saving fills it in.`];
  }
  return [];
}

// Policy belongs to the account's recipe. Identity comes only from the host, never the output being checked.
function actorPolicyProblems(policy, { name, step_id, asks, prior }) {
  if (policy === undefined) return [];
  const problems = [];
  if (!object(policy) || policy.authenticated !== true || Object.keys(policy).some(key => !['authenticated', 'distinct_from', 'distinct_from_if_admitted'].includes(key)))
    return [`${name}.actor_policy must require authenticated: true with distinct_from or distinct_from_if_admitted prior step ids.`];
  const own = asks.get(step_id);
  // Actor evidence comes from whoever sends the answer; a tool's answer has none, so a tool step cannot carry the policy.
  if (!own || toolNamed(own.name)) problems.push(`${name}.actor_policy requires a step someone answers, not a tool.`);
  for (const field of ['distinct_from', 'distinct_from_if_admitted']) {
    const refs = policy[field] ?? [];
    if (!Array.isArray(refs) || refs.length > 64 || refs.some(id => typeof id !== 'string') || new Set(refs).size !== refs.length)
      problems.push(`${name}.actor_policy.${field} must list at most 64 different prior step ids.`);
  }
  if (problems.some(problem => problem.includes('must list'))) return problems;
  const refs = [...(policy.distinct_from ?? []), ...(policy.distinct_from_if_admitted ?? [])];
  for (const id of refs) {
    if (id === step_id || !prior(id)) problems.push(`${name}.actor_policy.distinct_from names ${id}, which is not a prior dependency.`);
    if (asks.get(id)?.policy?.authenticated !== true) problems.push(`${name}.actor_policy.distinct_from requires authenticated actor evidence on ${id}.`);
  }
  return problems;
}

// What is wrong with a recipe row, every problem at once. A recipe that passes can be run by any account. Given `blocks`
// (sharedBlocks of the person's workflow rows), a hand step that writes out a block again is refused, naming the block.
export function recipeProblems(recipe, vocabulary = CHECK_VOCABULARY, { stepAnatomy = false, blocks } = {}) {
  if (!object(recipe)) return ['The workflow must be an object.'];
  const problems = blocks === undefined ? [] : recipeBlockRepeats(recipe, { blocks });
  if (!/^workflow:[a-z0-9][a-z0-9-]*$/.test(recipe.id ?? '')) problems.push('id must be "workflow:" followed by lowercase letters, numbers and dashes.');
  if (!nonempty(recipe.job)) problems.push('job must say in plain words what the workflow gets done.');
  if (recipe.made_from !== undefined && !(Array.isArray(recipe.made_from) && recipe.made_from.every(id => /^workflow:[a-z0-9][a-z0-9-]*$/.test(id ?? '')) && !recipe.made_from.includes(recipe.id))) problems.push('made_from must list the ids of the workflows this one was made from ("workflow:..."), never its own id.');
  if (recipe.produces !== undefined && !nonempty(recipe.produces)) problems.push('produces must say in one line what a run makes that could become something to share.');
  if (recipe[WAKE_VOCABULARY.field] !== undefined && recipe.produces === undefined) problems.push('a recipe with a wake must say what a run produces (produces), so the person knows what each firing makes.');
  if (recipe.input_schema !== undefined && !(object(recipe.input_schema) && recipe.input_schema.type === 'object')) problems.push('input_schema must be a JSON Schema with "type": "object".');
  const stepIds = (Array.isArray(recipe.definition?.steps) ? recipe.definition.steps : Array.isArray(recipe.steps) ? recipe.steps : []).map(step => step?.id);
  problems.push(...wakeProblems(recipe[WAKE_VOCABULARY.field], { stepIds, inputFields: Object.keys(recipe.input_schema?.properties ?? {}) }));
  problems.push(...conditionProblems(recipe[FIRES_WHEN.field]));
  if (recipe.definition !== undefined) {
    if (stepAnatomy) for (const [index, step] of (Array.isArray(recipe.definition?.steps) ? recipe.definition.steps : []).entries()) {
      if (step?.kind === 'ask') problems.push(...stepAnatomyProblems(step.config?.input, { name: `definition.steps[${index}].config.input`, judged: !toolNamed(step.config?.name) }));
    }
    return [...problems, ...definitionProblems(recipe.definition, vocabulary)];
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) return [...problems, 'steps (or definition) must list at least one step.'];
  const seen = new Set();
  const submits = new Map();
  const actorAsks = new Map(recipe.steps.map(step => [step?.id, { name: step?.run_tool?.tool_id ?? null, policy: step?.actor_policy }]));
  recipe.steps.forEach((step, index) => {
    const name = `steps[${index}]`;
    if (!object(step)) { problems.push(`${name} must be an object.`); return; }
    if (stepAnatomy) problems.push(...stepAnatomyProblems(step, { name, judged: step.run_tool === undefined, validateChecks: false }));
    if (!STEP_ID.test(step.id ?? '')) problems.push(`${name}.id must be lowercase letters, numbers, dashes or underscores.`);
    else if (seen.has(step.id)) problems.push(`${name}.id "${step.id}" is used twice.`);
    seen.add(step.id);
    if (!nonempty(step.do)) problems.push(`${name}.do must say what to do in this step.`);
    if (!(object(step.submit) && step.submit.type === 'object')) problems.push(`${name}.submit must be a JSON Schema with "type": "object" for what the step hands back.`);
    if (step.run_tool !== undefined && !(object(step.run_tool) && /^tool:/.test(step.run_tool.tool_id ?? '') && (step.run_tool.input === undefined || object(step.run_tool.input)))) problems.push(`${name}.run_tool must be { tool_id: "tool:...", input: { field: value, or { "from": path } } }.`);
    else if (step.run_tool !== undefined) problems.push(...pinProblems(step.run_tool.pinned, `${name}.run_tool.pinned`));
    problems.push(...checkProblems(step.checks, name, step.id, seen, vocabulary, { this: step.submit, input: recipe.input_schema, steps: submits }));
    // Several agents on one step, lanes and where an output is kept were the recipe layer's (its job queue and tables,
    // deleted 2026-11-18): several agents are a loop with parallel: true in the recipe's own definition, and what a run
    // keeps the AI writes to the person's own database itself.
    for (const field of ['agents', 'lanes', 'lanes_from', 'outputs']) if (step[field] !== undefined) problems.push(`${name}.${field} is not a step field: write several agents as a loop with parallel: true in the recipe's own definition, and keep what a step makes in the person's own database.`);
    submits.set(step.id, step.submit);
    problems.push(...actorPolicyProblems(step.actor_policy, { name, step_id: step.id, asks: actorAsks, prior: id => id !== step.id && seen.has(id) }));
  });
  return problems;
}

// What is wrong with an engine definition written directly: { steps: [{ id, kind, config }], edges: [{ from, to, kind }] }.
// The engine decides everything else when it runs; this names what would make every run of it fail.
function definitionProblems(definition, vocabulary) {
  if (!object(definition) || !Array.isArray(definition.steps) || definition.steps.length === 0) return ['definition must be { steps: [...], edges: [...] } with at least one step.'];
  const problems = [];
  const ids = new Set();
  definition.steps.forEach((step, index) => {
    const name = `definition.steps[${index}]`;
    if (!object(step) || !/^[a-z0-9][a-z0-9_#-]*$/.test(step.id ?? '') || !nonempty(step.kind)) { problems.push(`${name} must have an id (lowercase letters, numbers, dashes, underscores or #) and a kind.`); return; }
    if (ids.has(step.id)) problems.push(`${name}.id "${step.id}" is used twice.`);
    ids.add(step.id);
    if (step.kind === 'ask' && !named(step.config?.name)) problems.push(`${name}.config.name must say who answers: a tool id, or a binding such as the run's own actor {"$kind":"binding","select":{"from":"context","path":"actor.user_id"}}.`);
    if (step.kind === 'ask') problems.push(...pinProblems(step.config?.context?.pinned, `${name}.config.context.pinned`));
    if (step.kind === 'ask' && !toolNamed(step.config?.name) && !(nonempty(step.config.input?.do) && object(step.config.input?.submit) && step.config.input.submit.type === 'object')) problems.push(`${name}.config.input must say what is done (do) and the shape it hands back (submit, a JSON Schema with "type": "object").`);
    if (step.kind === 'check') {
      if (!nonempty(step.config?.subject)) problems.push(`${name}.config.subject must name the step whose output is checked.`);
      if (!Array.isArray(step.config?.rules)) problems.push(`${name}.config.rules must list the checks.`);
      else problems.push(...checkProblems(step.config.rules, name, step.config.subject, new Set(definition.steps.map(item => item?.id).filter(id => id !== step.config.subject)), vocabulary));
    }
  });
  if (!Array.isArray(definition.edges ?? [])) problems.push('definition.edges must be a list of { from, to, kind }.');
  for (const [index, edge] of (definition.edges ?? []).entries()) if (!object(edge) || !ids.has(edge.from) || !ids.has(edge.to)) problems.push(`definition.edges[${index}] must join two steps of the definition.`);
  problems.push(...booleanEdgeProblems(definition));
  problems.push(...placeholderInputProblems(definition));
  problems.push(...alwaysEdgeProblems(definition));
  const actorAsks = new Map(definition.steps.filter(step => step?.kind === 'ask').map(step => [step.id, { name: step.config?.name, policy: step.config?.context?.actor_policy }]));
  const precedes = (from, to) => {
    const visited = new Set(), pending = [from];
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of Array.isArray(definition.edges) ? definition.edges : []) if (edge?.from === id) {
        if (edge.to === to) return true;
        pending.push(edge.to);
      }
    }
    return false;
  };
  for (const step of definition.steps.filter(step => step?.kind === 'ask')) problems.push(...actorPolicyProblems(step.config?.context?.actor_policy, {
    name: `definition.steps.${step.id}.config.context`, step_id: step.id, asks: actorAsks, prior: id => id !== step.id && actorAsks.has(id) && precedes(id, step.id),
  }));
  return problems;
}

// An on_result edge branches on a boolean. Its binding must end in a transform that yields a boolean, unless the source step's SQL
// aliases the read column as a boolean expression. Anything else reads text, a count or null, and the edge never does what it says.
const BOOLEAN_OPS = new Set(['op:core.equals', 'op:core.eq', 'op:core.ne', 'op:core.not', 'op:core.gt', 'op:core.ge', 'op:core.gte', 'op:core.lt', 'op:core.le',
  'op:core.contains', 'op:core.includes', 'op:core.ends_with', 'op:core.in_list', 'op:core.is_null', 'op:core.is_not_null', 'op:core.is_empty', 'op:core.array_contains', 'op:core.text_regex_match']);
function sqlAliasesBoolean(sql, column) {
  const text = String(sql ?? '');
  const alias = new RegExp(`\\bAS\\s+${column}\\b`, 'i').exec(text);
  if (!alias) return false;
  let expression = text.slice(0, alias.index).split(/,(?![^()]*\))/).at(-1);
  const select = expression.search(/\bSELECT\b/i);
  if (select >= 0) expression = expression.slice(select + 6);
  return /(=|<>|!=|<=|>=|<|>|\bIS\s+(NOT\s+)?NULL\b|\bEXISTS\b|\bNOT\b|\bLIKE\b|\bIN\s*\(|\bBETWEEN\b)/i.test(expression);
}
function booleanEdgeProblems(definition) {
  const problems = [];
  for (const [index, edge] of (Array.isArray(definition.edges) ? definition.edges : []).entries()) {
    if (edge?.kind !== 'on_result' || !object(edge.config) || edge.config.$kind !== 'binding') continue;
    const transforms = Array.isArray(edge.config.transform) ? edge.config.transform : [];
    const last = transforms.at(-1)?.op;
    if (BOOLEAN_OPS.has(last)) continue;
    const path = String(edge.config.select?.path ?? '');
    const column = path.split('.').at(-1);
    const source = definition.steps.find(step => step?.id === edge.from);
    if (source?.kind === 'ask' && source.config?.name === 'tool:run-sql-in-my-database' && sqlAliasesBoolean(source.config.input?.sql, column)) continue;
    if (source?.kind === 'ask' && source.config?.input?.submit?.properties?.[column]?.type === 'boolean') continue;
    const returned = source?.kind === 'return' ? source.config?.value?.[column] : null;
    if (returned?.$kind === 'binding' && BOOLEAN_OPS.has((returned.transform ?? []).at(-1)?.op)) continue;
    problems.push(`definition.edges[${index}] (${edge.from} -> ${edge.to}, on_result) reads ${path || 'nothing'} without a boolean transform (ends with ${last ?? 'no transform'}); end it with an op:core.equals/not/gt-style transform, or alias the column as a boolean expression in ${edge.from}'s SQL, or type it boolean in ${edge.from}'s submit schema (an ask), or end the returned value in a boolean transform (a return).`);
  }
  return problems;
}

// A step input whose whole string value is an unfilled placeholder ("<one record per visit or sale...>") was written by hand and would reach its tool as a literal.
const PLACEHOLDER = /^<[^<>]+>$/;
function placeholderInputProblems(definition) {
  const problems = [];
  const walk = (value, path) => {
    if (typeof value === 'string') { if (PLACEHOLDER.test(value.trim())) problems.push(`${path} is an unfilled placeholder: ${value.slice(0, 60)}`); return; }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (object(value)) for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
  };
  for (const step of Array.isArray(definition.steps) ? definition.steps : []) walk(step?.config?.input, `definition.steps.${step?.id}.config.input`);
  return problems;
}

// An "always" edge takes its next step unconditionally; the engine ignores a config on it, so a condition written there gates nothing.
function alwaysEdgeProblems(definition) {
  return (Array.isArray(definition.edges) ? definition.edges : []).flatMap((edge, index) => edge?.kind === 'always' && edge.config !== undefined
    ? [`definition.edges[${index}] (${edge.from} -> ${edge.to}) is an always edge with a config; the engine ignores it. Use on_result with the condition, or drop the config.`]
    : []);
}
