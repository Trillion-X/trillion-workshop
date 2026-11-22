// tools/render-a-workflow-file-from-its-row/read-data/input-bindings.mjs
//
// A step binding that reads the run's input ({"$kind":"binding","select":{"from":"input","path":P}}, or "values":
// ["input", ...]) resolves only when the start that made the run put P's first key in its input. A run the router starts
// (a wake on a "workflow-chosen" fact, or a fires_when rule) gets fact, fact_id, kept_in and start_at, plus its wake's
// static input or its rule's input; a run another fact wakes gets fact and fact_id plus its wake's static input; a run a
// due-time wake starts gets only its wake's static input. Rows that bound input.store.credential_name from router-started
// runs failed 32% of tool:run-sql-in-my-database runs with "no credential_name" (read 5:57 AM CST Nov 22 2026): the store
// a router-started run reads is input.fact.where.
//
// unresolvedInputBindings(row) -> ["<recipe> step <id> reads input.<path>, which <start> does not give", ...]
// A start's input is not all readable here: an engine switch's own input (wake:list hides it) can give a key the row does
// not name, so these are findings. A row refuses them only once its owner has fixed or confirmed it and set the flag
// "inputs-checked" (inputsChecked(row)).
// Only steps are read: an edge's "input" is its source step's result, not the run's. A binding passes when it is marked
// omit_if_missing, or when it sits in an op:core.coalesce with another value that resolves.

const CHOSEN = 'workflow-chosen';
const TIME = 'due-time';
const CHOSEN_GIVES = ['fact', 'fact_id', 'kept_in', 'start_at'];
const COALESCE = 'op:core.coalesce';

const asObject = value => (typeof value === 'string' ? JSON.parse(value) : value);
const isEmpty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
const isBinding = value => value !== null && typeof value === 'object' && value.$kind === 'binding';

// The run-input paths one binding reads (its own select or values, not its transforms), as dotted strings.
function inputPaths(binding) {
  if (binding.select?.from === 'input') return [String(binding.select.path ?? '')];
  const values = binding.values;
  if (!Array.isArray(values)) return [];
  const paths = Array.isArray(values[0]) ? values : [values];
  return paths.filter(path => path[0] === 'input').map(path => path.slice(1).join('.'));
}

// Whether a binding's own value can be there at this start: a literal null cannot, a value from any other scope may.
function ownResolves(binding, gives) {
  if (binding.omit_if_missing === true) return true;
  if (binding.select?.from === 'literal') return binding.select.value !== null && binding.select.value !== undefined;
  const paths = inputPaths(binding);
  if (!paths.length) return true;
  // The whole input (an empty path) is always there.
  return paths.some(path => path === '' || gives.has(path.split('.')[0]));
}

function resolves(value, gives) {
  if (!isBinding(value)) return true;
  const alternatives = (value.transform ?? []).filter(step => step?.op === COALESCE).flatMap(step => step.args?.values ?? []);
  return ownResolves(value, gives) || alternatives.some(alternative => resolves(alternative, gives));
}

// Every binding in a step that cannot resolve at this start, with the input paths it reads. A coalesce's values are judged
// together with the binding that holds them; any other binding nested in a transform is judged on its own.
function unresolvedIn(value, gives, found = []) {
  if (Array.isArray(value)) { value.forEach(item => unresolvedIn(item, gives, found)); return found; }
  if (value === null || typeof value !== 'object') return found;
  if (!isBinding(value)) { Object.values(value).forEach(item => unresolvedIn(item, gives, found)); return found; }
  if (!resolves(value, gives)) found.push(...coalesced(value).flatMap(inputPaths));
  insideTransforms(value, gives, found);
  return found;
}

// A binding and the coalesce values that stand in for it, at any depth.
const coalesced = binding => [binding, ...(binding.transform ?? []).filter(step => step?.op === COALESCE)
  .flatMap(step => step.args?.values ?? []).filter(isBinding).flatMap(coalesced)];

function insideTransforms(binding, gives, found) {
  for (const step of binding.transform ?? []) {
    if (step?.op !== COALESCE) { unresolvedIn(step?.args, gives, found); continue; }
    for (const item of step.args?.values ?? []) {
      if (isBinding(item)) insideTransforms(item, gives, found);
      else unresolvedIn(item, gives, found);
    }
  }
}

// Each start a row has, with the input keys it gives: its wakes, and each fires_when rule that is not Off when no wake of
// its own hears a workflow-chosen fact. A fact that wakes a run is its input's `fact` with `fact_id`, and a fact folded
// with others adds `folded` and `last` (workflow-component main.rs, the run's input); a time is no fact the run reads.
function wakeGives(wake) {
  const fact = wake?.on?.fact;
  const kind = fact?.kind ?? 'no fact';
  const own = Object.keys(wake?.input ?? {});
  if (kind === CHOSEN) return { kind, gives: [...CHOSEN_GIVES, ...own] };
  if (!fact || kind === TIME) return { kind, gives: own };
  return { kind, gives: ['fact', 'fact_id', ...(fact.fold ? ['folded', 'last'] : []), ...own] };
}

export function startsOf(row) {
  const wakes = isEmpty(row.wakes) ? [] : asObject(row.wakes);
  const starts = wakes.map(wake => {
    const { kind, gives } = wakeGives(wake);
    return { at: `wake ${wake?.id} (${kind})`, gives: new Set(gives) };
  });
  if (wakes.some(wake => wake?.on?.fact?.kind === CHOSEN)) return starts;
  const rules = isEmpty(row.fires_when) ? [] : [asObject(row.fires_when)].flat();
  for (const rule of rules.filter(rule => rule?.state !== 'Off')) {
    // A rule's own input (the person's settings for the workflow) is spread into the run's input.
    starts.push({ at: `fires_when "${rule?.label ?? ''}" (${CHOSEN})`, gives: new Set([...CHOSEN_GIVES, ...Object.keys(rule?.input ?? {})]) });
  }
  return starts;
}

export function unresolvedInputBindings(row) {
  const steps = asObject(row.definition)?.steps ?? [];
  const problems = [];
  for (const start of startsOf(row)) {
    for (const step of steps) {
      for (const path of new Set(unresolvedIn(step?.config, start.gives))) {
        problems.push(`${row.recipe} step ${step.id} reads input.${path}, which ${start.at} does not give`);
      }
    }
  }
  return problems;
}

const CHECKED = 'inputs-checked';
export function inputsChecked(row) {
  const flags = asObject(row.flags);
  return Array.isArray(flags) ? flags.includes(CHECKED) : flags?.[CHECKED] === true;
}
