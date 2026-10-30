// The validator for workflow recipe rows: what is wrong with a recipe, every problem at once. A recipe that passes can
// be run by any account. Ported without change in behaviour from the workflow engine's `recipeProblems`.

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const PIN = /^1f:[a-f0-9]{64}$/;

const CHECK_KINDS = ['subset-of', 'covers', 'mentioned-in', 'excludes-words', 'distinct-at-least', 'exists'];
const CATALOGS = ['workflow', 'tool', 'list-row', 'record'];
const ROOTS = ['this', 'input', 'steps'];
const PATH_FIELDS = ['path', 'of', 'in'];
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

// Every problem with one list of check rules (the engine's `check` step config), for step `stepId` whose earlier
// steps are `earlier`.
function checkProblems(checks, name, stepId, earlier) {
  const problems = [];
  for (const [at, check] of (checks ?? []).entries()) {
    const where = `${name}.checks[${at}]`;
    if (!object(check) || !CHECK_KINDS.includes(check.kind)) { problems.push(`${where}.kind must be one of: ${CHECK_KINDS.join(', ')}.`); continue; }
    if (!nonempty(check.says)) problems.push(`${where}.says must say, in plain words, what the check asks for.`);
    for (const field of PATH_FIELDS) {
      if (check[field] === undefined) continue;
      const paths = Array.isArray(check[field]) && Array.isArray(check[field][0]) ? check[field] : [check[field]];
      for (const path of paths) if (!Array.isArray(path) || !ROOTS.includes(path[0]) || path.some(key => typeof key !== 'string')) problems.push(`${where}.${field} must be a list of keys starting with ${ROOTS.map(root => `"${root}"`).join(', ')}.`);
      else if (path[0] === 'steps' && (path[1] === stepId || !earlier.has(path[1]))) problems.push(`${where}.${field} reads step "${path[1]}", which is not an earlier step.`);
    }
    if (!Array.isArray(check.path)) problems.push(`${where}.path is required.`);
    if (check.kind === 'subset-of' && !Array.isArray(check.of)) problems.push(`${where}.of is required.`);
    if (check.kind === 'covers' && !Array.isArray(check.of) && !Array.isArray(check.values)) problems.push(`${where} needs of or values.`);
    if (check.kind === 'mentioned-in' && !Array.isArray(check.in)) problems.push(`${where}.in is required.`);
    if (check.kind === 'excludes-words' && !(Array.isArray(check.words) && check.words.length && check.words.every(nonempty))) problems.push(`${where}.words must list the words to keep out.`);
    if (check.kind === 'distinct-at-least' && !(Number.isInteger(check.count) && check.count > 0)) problems.push(`${where}.count must be a whole number above 0.`);
    if (check.kind === 'exists' && !CATALOGS.includes(check.catalog)) problems.push(`${where}.catalog must be one of: ${CATALOGS.join(', ')}.`);
  }
  return problems;
}

// What is wrong with a recipe row, every problem at once. A recipe that passes can be run by any account.
export function recipeProblems(recipe) {
  const problems = [];
  if (!object(recipe)) return ['The workflow must be an object.'];
  if (!/^workflow:[a-z0-9][a-z0-9-]*$/.test(recipe.id ?? '')) problems.push('id must be "workflow:" followed by lowercase letters, numbers and dashes.');
  if (!nonempty(recipe.job)) problems.push('job must say in plain words what the workflow gets done.');
  if (recipe.made_from !== undefined && !(Array.isArray(recipe.made_from) && recipe.made_from.every(id => /^workflow:[a-z0-9][a-z0-9-]*$/.test(id ?? '')) && !recipe.made_from.includes(recipe.id))) problems.push('made_from must list the ids of the workflows this one was made from ("workflow:..."), never its own id.');
  if (recipe.input_schema !== undefined && !(object(recipe.input_schema) && recipe.input_schema.type === 'object')) problems.push('input_schema must be a JSON Schema with "type": "object".');
  if (recipe.definition !== undefined) return [...problems, ...definitionProblems(recipe.definition)];
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
    problems.push(...checkProblems(step.checks, name, step.id, seen));
    problems.push(...actorPolicyProblems(step.actor_policy, { name, step_id: step.id, asks: actorAsks, prior: id => id !== step.id && seen.has(id) }));
  });
  return problems;
}

// What is wrong with an engine definition written directly: { steps: [{ id, kind, config }], edges: [{ from, to, kind }] }.
// The engine decides everything else when it runs; this names what would make every run of it fail.
function definitionProblems(definition) {
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
      else problems.push(...checkProblems(step.config.rules, name, step.config.subject, new Set(definition.steps.map(item => item?.id).filter(id => id !== step.config.subject))));
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
