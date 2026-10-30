// The validator for workflow recipe rows: what is wrong with a recipe, every problem at once. A recipe that passes can
// be run by any account. Ported without change in behaviour from the workflow engine's `recipeProblems`.

import { readFileSync } from 'node:fs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const PIN = /^1f:[a-f0-9]{64}$/;

// The check vocabulary (kinds, the fields each takes, roots, catalogs) is DATA, not code: adding a kind is adding a row.
export const CHECK_VOCABULARY = JSON.parse(readFileSync(new URL('../recipe-check-kinds.json', import.meta.url), 'utf8'));
const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/;

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
  if (!(own?.name === 'ai' || own?.name?.startsWith('agent:'))) problems.push(`${name}.actor_policy requires an AI or agent ask.`);
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

// Whether a value has a shape a check field can take. The shapes are the closed set of JSON value forms.
const SHAPES = {
  list: value => Array.isArray(value),
  words: value => Array.isArray(value) && value.length > 0 && value.every(nonempty),
  count: value => Number.isInteger(value) && value > 0,
  catalog: (value, vocabulary) => vocabulary.catalogs.some(row => row.catalog === value),
};

// Every problem with the keys of a path-shaped field: a list of keys (or a list of such lists) from a root, reading only earlier steps.
function pathProblems(value, where, field, stepId, earlier, vocabulary) {
  const roots = vocabulary.roots.map(row => row.root);
  const problems = [];
  const paths = Array.isArray(value) && Array.isArray(value[0]) ? value : [value];
  for (const path of paths) {
    if (!Array.isArray(path) || !roots.includes(path[0]) || path.some(key => typeof key !== 'string')) problems.push(`${where}.${field} must be a list of keys starting with ${roots.map(root => `"${root}"`).join(', ')}.`);
    else if (path[0] === 'steps' && (path[1] === stepId || !earlier.has(path[1]))) problems.push(`${where}.${field} reads step "${path[1]}", which is not an earlier step.`);
  }
  return problems;
}

// Every problem with one list of check rules (the engine's `check` step config), for step `stepId` whose earlier
// steps are `earlier`. What a kind takes comes from its row in the vocabulary; there is no branch on a kind's name.
function checkProblems(checks, name, stepId, earlier, vocabulary) {
  const problems = [];
  const kinds = new Map(vocabulary.kinds.map(row => [row.kind, row]));
  for (const [at, check] of (checks ?? []).entries()) {
    const where = `${name}.checks[${at}]`;
    const row = object(check) ? kinds.get(check.kind) : undefined;
    if (!row) { problems.push(`${where}.kind must be one of: ${[...kinds.keys()].join(', ')}.`); continue; }
    if (!nonempty(check.says)) problems.push(`${where}.says must say, in plain words, what the check asks for.`);
    const refused = (field, refusal) => `${where}.${field} ${(refusal ?? 'is not the right shape.').replace('{catalogs}', vocabulary.catalogs.map(entry => entry.catalog).join(', '))}`;
    for (const { field, shape, required, refusal } of row.fields) {
      const value = check[field];
      if (value === undefined) { if (required) problems.push(refused(field, refusal)); continue; }
      if (shape === 'path') problems.push(...pathProblems(value, where, field, stepId, earlier, vocabulary));
      else if (!SHAPES[shape](value, vocabulary)) problems.push(refused(field, refusal));
    }
    for (const { fields, refusal } of row.one_of ?? []) if (fields.every(field => !(field in check))) problems.push(`${where} ${refusal}`);
  }
  return problems;
}

// What is wrong with a recipe row, every problem at once. A recipe that passes can be run by any account.
export function recipeProblems(recipe, vocabulary = CHECK_VOCABULARY) {
  const problems = [];
  if (!object(recipe)) return ['The workflow must be an object.'];
  if (!/^workflow:[a-z0-9][a-z0-9-]*$/.test(recipe.id ?? '')) problems.push('id must be "workflow:" followed by lowercase letters, numbers and dashes.');
  if (!nonempty(recipe.job)) problems.push('job must say in plain words what the workflow gets done.');
  if (recipe.made_from !== undefined && !(Array.isArray(recipe.made_from) && recipe.made_from.every(id => /^workflow:[a-z0-9][a-z0-9-]*$/.test(id ?? '')) && !recipe.made_from.includes(recipe.id))) problems.push('made_from must list the ids of the workflows this one was made from ("workflow:..."), never its own id.');
  if (recipe.input_schema !== undefined && !(object(recipe.input_schema) && recipe.input_schema.type === 'object')) problems.push('input_schema must be a JSON Schema with "type": "object".');
  if (recipe.definition !== undefined) return [...problems, ...definitionProblems(recipe.definition, vocabulary)];
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) return [...problems, 'steps (or definition) must list at least one step.'];
  const seen = new Set();
  const actorAsks = new Map(recipe.steps.map(step => [step?.id, { name: step?.run_tool?.tool_id ?? 'ai', policy: step?.actor_policy }]));
  recipe.steps.forEach((step, index) => {
    const name = `steps[${index}]`;
    if (!object(step)) { problems.push(`${name} must be an object.`); return; }
    if (!STEP_ID.test(step.id ?? '')) problems.push(`${name}.id must be lowercase letters, numbers, dashes or underscores.`);
    else if (seen.has(step.id)) problems.push(`${name}.id "${step.id}" is used twice.`);
    seen.add(step.id);
    if (!nonempty(step.do)) problems.push(`${name}.do must say what to do in this step.`);
    if (!(object(step.submit) && step.submit.type === 'object')) problems.push(`${name}.submit must be a JSON Schema with "type": "object" for what the step hands back.`);
    if (step.run_tool !== undefined && !(object(step.run_tool) && /^tool:/.test(step.run_tool.tool_id ?? '') && (step.run_tool.input === undefined || object(step.run_tool.input)))) problems.push(`${name}.run_tool must be { tool_id: "tool:...", input: { field: value, or { "from": path } } }.`);
    else if (step.run_tool !== undefined) problems.push(...pinProblems(step.run_tool.pinned, `${name}.run_tool.pinned`));
    problems.push(...checkProblems(step.checks, name, step.id, seen, vocabulary));
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
    if (step.kind === 'ask' && !nonempty(step.config?.name)) problems.push(`${name}.config.name must say who answers: "ai", a tool id, or "agent:<agent_id>".`);
    if (step.kind === 'ask') problems.push(...pinProblems(step.config?.context?.pinned, `${name}.config.context.pinned`));
    if (step.kind === 'ask' && step.config?.name === 'ai' && !(nonempty(step.config.input?.do) && object(step.config.input?.submit) && step.config.input.submit.type === 'object')) problems.push(`${name}.config.input must say what the AI does (do) and the shape it hands back (submit, a JSON Schema with "type": "object").`);
    if (step.kind === 'check') {
      if (!nonempty(step.config?.subject)) problems.push(`${name}.config.subject must name the step whose output is checked.`);
      if (!Array.isArray(step.config?.rules)) problems.push(`${name}.config.rules must list the checks.`);
      else problems.push(...checkProblems(step.config.rules, name, step.config.subject, new Set(definition.steps.map(item => item?.id).filter(id => id !== step.config.subject)), vocabulary));
    }
  });
  if (!Array.isArray(definition.edges ?? [])) problems.push('definition.edges must be a list of { from, to, kind }.');
  for (const [index, edge] of (definition.edges ?? []).entries()) if (!object(edge) || !ids.has(edge.from) || !ids.has(edge.to)) problems.push(`definition.edges[${index}] must join two steps of the definition.`);
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
