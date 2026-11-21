// A step with variants: several ways of doing one step, run side by side or split by what has worked, compared on one
// measure, with every run's result kept as rows in the pursuit's own database.
//
// A recipe step (or a definition step of kind "variants") holds:
//   variants  [{ id, run_tool | do, submit?, title?, checks?, measure?, summary? }, ...]: two or more ways of doing the step.
//             A variant with no do or submit takes the step's own.
//   mode      "all": every variant runs; "split": the variants the split rule chooses run (below).
//   measure   { binding, best: "max" | "min" }: what is compared, a binding over the variant's answer, written as the
//             output of step "answer" ({"$kind":"binding","select":{"from":"steps","key":"answer","path":"output..."}}).
//             A variant may carry its own measure binding when its answer has another shape.
//   checks    rules every variant's answer must pass, beside each variant's own checks (check-bindings.mjs).
//   summary   { name: binding over "answer" }: the few values of each answer the comparison shows; none by default.
//   keep_in   the database that keeps variant_results: a pursuit's <pursuit>_for_who_runs_it (or { "from": path }).
//   split     { explore_share, min_runs }: the split rule's numbers when the step gives its own
//             (tools/formula-engine/rules/variants.json holds the rule and the numbers every other step uses).
//   then      one next step, or { variant id: next step } to go on where the winner says.
//
// It compiles into ordinary engine steps (S is the step's id):
//   S#table   make variant_results if it is not there (tool:run-sql-in-my-database);
//   split only: S#tally reads the kept runs per variant, S#lead names the leader and S#choose the variants to run
//             (formulas leader and choose);
//   S#each    a parallel loop over the variants run, each its own used definition S#<variant>: its ask, its checks
//             judged as steps, and a record of how it went (completed, failed with the check that broke, or error);
//             a variant that fails never stops the others;
//   S#compare { variants: [{ variant, status, checks_passed, failed_check, measure, duration_ms, cost, tokens, summary }],
//             winner }: small whatever the variants answered, since no whole answer is in it;
//   S#keep    one variant_results row per variant run;
//   S         the winner's whole answer, so a later step binds S as it would any step; S#none fails the run, naming each
//             variant's failed check, when no variant passed;
//   S#route   only for a then map: the winner, whose on_result edges lead to that variant's next step.
// cost and tokens are null: the engine's step outputs carry neither yet.
import formulas from '../../formula-engine/rules/variants.json' with { type: 'json' };
import sql from './variant-results.json' with { type: 'json' };
import { checkProblems, checkSteps } from '../../workflows/read-data/check-bindings.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const VARIANT_ID = /^[a-z0-9][a-z0-9_-]*$/;
const MODES = ['all', 'split'];
const BESTS = ['max', 'min'];
const SQL_TOOL = 'tool:run-sql-in-my-database';
const literal = value => ({ $kind: 'binding', select: { from: 'literal', value } });
const stepOutput = (key, path = 'output') => ({ $kind: 'binding', select: { from: 'steps', key, path } });
const isBinding = value => object(value) && value.$kind === 'binding' && object(value.select);

/** True when a recipe or definition step is a step with variants. */
export const hasVariants = step => object(step) && (Array.isArray(step.variants) || step.kind === 'variants');

/** A definition step of kind "variants" as the recipe step it is written as: its fields under config, or beside its id. */
const fieldsOf = step => (step.kind === 'variants' ? { ...(object(step.config) ? step.config : {}), id: step.id } : step);

/** A formula of variants.json with each of its names bound to a value of the run. A name read whole takes the value's
 *  binding (a selection's path joined, a transform's chain run first); a name read at a path reads it with get_path. */
export function formulaOf(name, values) {
  const { names, binding } = formulas.formulas[name];
  const bound = node => {
    if (Array.isArray(node)) return node.map(bound);
    if (!object(node)) return node;
    const select = node.select;
    if (node.$kind === 'binding' && object(select) && select.from === 'context' && Array.isArray(select.path) && names.includes(select.path[0])) {
      const value = values[select.path[0]];
      const rest = select.path.slice(1);
      const after = (node.transform ?? []).map(bound);
      if (value.select.from === 'steps' && !value.transform?.length) {
        const path = [value.select.path, ...rest].filter(Boolean).join('.');
        return { $kind: 'binding', select: { ...value.select, path }, ...(after.length ? { transform: after } : {}) };
      }
      const reach = rest.length ? [{ op: 'op:core.get_path', args: { path: rest.join('.') } }] : [];
      const chain = [...(value.transform ?? []), ...reach, ...after];
      return { ...value, ...(chain.length ? { transform: chain } : {}) };
    }
    return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, bound(inner)]));
  };
  return bound(binding);
}

// A binding over the variant's answer ("answer"), pointed at the ask the variant runs as.
function overAnswer(value, ask) {
  if (Array.isArray(value)) return value.map(item => overAnswer(item, ask));
  if (!object(value)) return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, overAnswer(inner, ask)]));
  if (object(out.select) && out.select.from === 'steps' && out.select.key === 'answer') out.select = { ...out.select, key: ask };
  return out;
}

/** What is wrong with a step with variants, every problem at once. `later` is the ids of the steps after it, `earlier`
 *  the ids before it (what a check path may name). */
export function variantStepProblems(given, name, { later = null, earlier = new Set() } = {}) {
  const step = fieldsOf(given);
  const problems = [];
  if (!Array.isArray(step.variants) || step.variants.length < 2) return [`${name}.variants must list at least two variants.`];
  if (!MODES.includes(step.mode)) problems.push(`${name}.mode must be one of: ${MODES.join(', ')}.`);
  if (!(object(step.measure) && isBinding(step.measure.binding) && BESTS.includes(step.measure.best))) problems.push(`${name}.measure must be { binding: a binding over the variant's answer (steps "answer"), best: "max" or "min" }.`);
  if (!(nonempty(step.keep_in) || (object(step.keep_in) && Array.isArray(step.keep_in.from)))) problems.push(`${name}.keep_in must name the database that keeps variant_results (a pursuit's <pursuit>_for_who_runs_it), or { "from": path }.`);
  if (step.run_tool !== undefined) problems.push(`${name}.run_tool belongs on each variant, not on the step.`);
  if (step.split !== undefined) {
    const share = step.split?.explore_share;
    const runs = step.split?.min_runs;
    if (step.mode !== 'split') problems.push(`${name}.split is only for mode "split".`);
    if (!object(step.split) || (share !== undefined && !(typeof share === 'number' && share >= 0 && share <= 1)) || (runs !== undefined && !(Number.isInteger(runs) && runs >= 0))) {
      problems.push(`${name}.split must be { explore_share: a number from 0 to 1, min_runs: a whole number from 0 }, each optional.`);
    }
  }
  if (step.summary !== undefined && !(object(step.summary) && Object.values(step.summary).every(isBinding))) problems.push(`${name}.summary must name bindings over the variant's answer.`);
  const ids = new Set();
  step.variants.forEach((variant, index) => {
    const where = `${name}.variants[${index}]`;
    if (!object(variant)) { problems.push(`${where} must be an object.`); return; }
    if (!VARIANT_ID.test(variant.id ?? '')) problems.push(`${where}.id must be lowercase letters, numbers, dashes or underscores.`);
    else if (ids.has(variant.id)) problems.push(`${where}.id "${variant.id}" is used twice.`);
    ids.add(variant.id);
    if (variant.run_tool !== undefined) {
      if (!(object(variant.run_tool) && /^tool:/.test(variant.run_tool.tool_id ?? '') && (variant.run_tool.input === undefined || object(variant.run_tool.input)))) problems.push(`${where}.run_tool must be { tool_id: "tool:...", input: { field: value, or { "from": path } } }.`);
    } else {
      if (!nonempty(variant.do ?? step.do)) problems.push(`${where}.do (or the step's do) must say what to do.`);
      const submit = variant.submit ?? step.submit;
      if (!(object(submit) && submit.type === 'object')) problems.push(`${where}.submit (or the step's submit) must be a JSON Schema with "type": "object".`);
    }
    if (variant.measure !== undefined && !(object(variant.measure) && isBinding(variant.measure.binding))) problems.push(`${where}.measure must be { binding }.`);
    if (variant.summary !== undefined && !(object(variant.summary) && Object.values(variant.summary).every(isBinding))) problems.push(`${where}.summary must name bindings over the variant's answer.`);
    problems.push(...checkProblems([...(step.checks ?? []), ...(variant.checks ?? [])], where, askId(step.id, variant.id ?? ''), earlier));
  });
  if (step.then !== undefined) {
    const known = id => later === null || later.includes(id);
    if (nonempty(step.then)) { if (!known(step.then)) problems.push(`${name}.then names "${step.then}", which is not a step after this one.`); }
    else if (object(step.then)) {
      const keys = Object.keys(step.then);
      if (keys.length !== ids.size || !keys.every(key => ids.has(key))) problems.push(`${name}.then must name a next step for each variant: ${[...ids].join(', ')}.`);
      for (const [variant, next] of Object.entries(step.then)) if (!nonempty(next) || !known(next)) problems.push(`${name}.then.${variant} names "${next}", which is not a step after this one.`);
    } else problems.push(`${name}.then must be one next step, or { variant id: next step }.`);
  }
  return problems;
}

const askId = (stepId, variantId) => `${stepId}#${variantId}`;

/** A step with variants as engine steps: { steps, edges, uses, first, last, onwards, routes }.
 *  - first: the step the steps before it lead to; last: the step whose output is the winner's answer (the step's own id).
 *  - onwards(to): the edge from it to the step after it, taken once a variant won.
 *  - routes: [{ to, edge(first of to) }] for a then given as one step or a map, in place of onwards.
 *  `workflow` is the workflow's id (variant_results.workflow); `ask(fields)` makes the ask a recipe step makes, so a
 *  variant is asked as any step is; `bindingsOf` makes a run_tool input's { from } values bindings. */
export function variantSteps(given, { workflow, ask, bindingsOf }) {
  const step = fieldsOf(given);
  const S = step.id;
  const id = suffix => `${S}#${suffix}`;
  const best = step.measure.best;
  const database = object(step.keep_in) ? bindingsOf(step.keep_in) : step.keep_in;
  const split = { ...formulas.split, ...(object(step.split) ? step.split : {}) };
  const sqlAsk = (stepId, input) => ({ id: stepId, kind: 'ask', config: { name: SQL_TOOL, input: { database, statement_timeout_ms: 20000, ...input }, context: { step_id: stepId, title: `${step.title ?? S}: ${stepId.slice(S.length + 1)}` } } });

  const sign = literal(best === 'min' ? -1 : 1);
  const ids = step.variants.map(variant => variant.id);
  const uses = step.variants.flatMap(variant => variantDefinition(step, variant, { definition: askId(S, variant.id), ask }));

  const steps = [sqlAsk(id('table'), { sql: sql.table })];
  const edges = [];
  const chain = (...names) => names.slice(1).forEach((to, index) => edges.push({ from: names[index], to, kind: 'always' }));
  let source = literal(ids);
  if (step.mode === 'split') {
    steps.push(
      sqlAsk(id('tally'), { sql: sql.tally, params: [workflow, S, ids] }),
      { id: id('lead'), kind: 'return', config: { value: { leader: formulaOf('leader', { tally: stepOutput(id('tally'), 'output.rows.0.tally'), sign }) } } },
      { id: id('choose'), kind: 'return', config: { value: { chosen: formulaOf('choose', {
        tally: stepOutput(id('tally'), 'output.rows.0.tally'), total: stepOutput(id('tally'), 'output.rows.0.total'),
        explore_share: literal(split.explore_share), min_runs: literal(split.min_runs), leader: stepOutput(id('lead'), 'output.leader'),
      }) } } },
    );
    source = stepOutput(id('choose'), 'output.chosen');
  }
  const outs = stepOutput(id('each'));
  const records = formulaOf('records', { outs });
  steps.push(
    { id: id('each'), kind: 'loop', config: {
      source, item_var: 'variant', parallel: true, tolerate_item_errors: true, max_iterations: ids.length,
      definition_id: { $kind: 'binding', select: { from: 'loop', path: 'variant' }, transform: [{ op: 'op:core.concat', args: { prefix: `${S}#` } }] },
      definition_refs: ids.map(variant => askId(S, variant)),
    } },
    { id: id('compare'), kind: 'return', config: { value: { variants: records, winner: formulaOf('winner', { records, sign }) } } },
    sqlAsk(id('keep'), { sql: sql.keep, params: [workflow, S, { $kind: 'binding', select: { from: 'input', path: 'run_id' } }, stepOutput(id('compare'))] }),
    { id: S, kind: 'return', config: { value: formulaOf('winner_output', { outs, winner: stepOutput(id('compare'), 'output.winner') }) } },
    { id: id('none'), kind: 'fail', config: { error: formulaOf('none_passed', { records: stepOutput(id('compare'), 'output.variants') }) } },
  );
  chain(...steps.filter(each => each.kind !== 'fail').map(each => each.id));
  const won = { $kind: 'binding', select: { from: 'input', path: 'output' }, transform: [{ op: 'op:core.is_not_null' }] };
  edges.push({ from: S, to: id('none'), kind: 'on_result', config: { $kind: 'binding', select: { from: 'input', path: 'output' }, transform: [{ op: 'op:core.is_null' }] } });
  const onwards = to => ({ from: S, to, kind: 'on_result', config: won });
  let routes = null;
  if (nonempty(step.then)) routes = [{ to: step.then, edge: onwards }];
  else if (object(step.then)) {
    steps.push({ id: id('route'), kind: 'return', config: { value: { winner: stepOutput(id('compare'), 'output.winner') } } });
    edges.push({ from: S, to: id('route'), kind: 'on_result', config: won });
    routes = Object.entries(step.then).map(([variant, to]) => ({
      to, edge: first => ({ from: id('route'), to: first, kind: 'on_result', config: { $kind: 'binding', select: { from: 'input', path: 'output.winner' }, transform: [{ op: 'op:core.equals', args: { value: variant } }] } }),
    }));
  }
  return { steps, edges, uses, first: id('table'), last: S, onwards: routes ? null : onwards, routes };
}

// One variant as the definition the loop runs for it: its ask, its checks (a broken one gives a failed record instead of
// failing the loop), and its record. An ask that fails (its tool failed) gives an error record the same way.
function variantDefinition(step, variant, { definition, ask }) {
  const A = definition;
  const rules = [...(step.checks ?? []), ...(variant.checks ?? [])];
  const steps = [ask({ ...variant, id: A, title: variant.title ?? `${step.title ?? step.id}: ${variant.id}`, do: variant.do ?? step.do, submit: variant.submit ?? step.submit, checks: rules })];
  const edges = [];
  const uses = [];
  const record = fields => ({ variant: variant.id, measure: null, duration_ms: stepOutput(A, 'duration_ms'), cost: null, tokens: null, summary: null, ...fields });
  const summary = variant.summary ?? step.summary;
  const measure = (variant.measure ?? step.measure).binding;
  const done = { id: `${A}#done`, kind: 'return', config: { value: {
    record: record({ status: 'completed', checks_passed: true, failed_check: null, measure: overAnswer(measure, A), ...(summary ? { summary: overAnswer(summary, A) } : {}) }),
    output: stepOutput(A),
  } } };
  const broke = { id: `${A}#broke`, kind: 'return', config: { value: {
    record: record({ status: 'error', checks_passed: false, failed_check: { ...stepOutput(A, 'error'), transform: [{ op: 'op:core.text_left', args: { count: 300 } }] } }),
    output: null,
  } } };
  edges.push({ from: A, to: broke.id, kind: 'on_failure' });
  if (rules.length) {
    const judged = checkSteps(A, rules);
    for (const judge of judged.steps) {
      // The step that would fail the run on a broken rule answers this variant's failed record instead, in its words.
      if (judge.kind === 'fail') steps.push({ id: judge.id, kind: 'return', config: { value: { record: record({ status: 'failed', checks_passed: false, failed_check: { ...judge.config.error, transform: [...(judge.config.error.transform ?? []), { op: 'op:core.text_left', args: { count: 300 } }] } }), output: null } } });
      else steps.push(judge);
    }
    edges.push(...judged.edges, judged.onwards(done.id));
    uses.push(...judged.uses);
  } else edges.push({ from: A, to: done.id, kind: 'always' });
  steps.push(done, broke);
  return [{ id: definition, name: `${step.title ?? step.id}: ${variant.id}`, kind: 'action', is_active: true, version: 1, steps, edges }, ...uses];
}
