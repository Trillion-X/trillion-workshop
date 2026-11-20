// tools/show-my-automations-on-the-signed-in-page-what-sets/do-work/list-my-automations.mjs
//
// The read the Automations screens are drawn from: everything a person's account does by itself, and one of them as a
// when -> then graph. It reads the engine's own sources and keeps nothing:
//   wakes    the rows `wake:list` answers (each declared wake, whether it is switched on, its mark). Their words, states and
//            switches are `tool:see-what-runs-on-its-own`'s; this file imports that one function, so there is one set of words.
//   recipes  the person's workflow rows (the list `workflow_recipes`): id, label, job, steps and `fires_when`, the
//            conditions each workflow says it fires on, whose `label` is the condition in words
//            (tools/workflows/branches/fires-when.json). A field kept as JSON text on a row is read back by parsing it.
//   tools    optional descriptors ({ id, label, input_schema }) of the tools the wakes run, to say what each one does.
// A wake is a trigger (it hears a fact), a schedule (the fact it hears is a due time) or a kept-running program; a
// workflow is a recipe. Nothing here names a tool, a fact or a workflow.
//
//   node do-work/list-my-automations.mjs < { wakes, recipes?, tools?, open? }   prints { result } on its last line
//
// With `open` (an automation's id from the list) the answer is that one automation: what sets it off, what it does, the
// input schema of what it runs and its graph. Old shapes (a rule's `when.recorded`, a schedule's `every.unit`) are not the
// engine's any more: the engine wakes only on facts and kept-running programs (src/wake.rs, wake:list).
import { text } from 'node:stream/consumers';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { seeWhatRunsOnItsOwn } from '../../what-runs-on-its-own/do-work/what-runs-on-its-own.mjs';
import { recordedWords } from '../read-data/record-kind-words.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idWords = id => { const words = String(id ?? '').replace(/^(tool|workflow):/, '').replace(/[-_]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };
const upper = words => words.charAt(0).toUpperCase() + words.slice(1);
const listed = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const parsed = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return undefined; } };
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** A workflow row as the recipe it holds: nested fields kept as JSON text are parsed; a row that is not a recipe is refused. */
function recipeOf(row) {
  const recipe = { ...(row?.values ?? row?.value ?? row?.payload ?? row) };
  if (typeof recipe.id !== 'string' || !recipe.id) throw new Error('Each recipe is a workflow row with an id.');
  for (const field of ['steps', 'fires_when', 'input_schema']) {
    if (typeof recipe[field] === 'string') {
      const value = parsed(recipe[field]);
      if (value === undefined) throw new Error(`The ${field} of ${recipe.id} is not JSON.`);
      recipe[field] = value;
    }
  }
  return recipe;
}

/** What sets a fact wake off, as a sentence: the kind's own words, then each field it must have. */
function sayFact(fact) {
  const fields = Object.entries(fact.match ?? {}).map(([field, value]) => `${String(field).replace(/[-_]/g, ' ')} is '${value}'`);
  return `When ${recordedWords(fact.kind ?? 'event')}${fields.length ? ` whose ${listed(fields)}` : ''}`;
}

// The words of the conditions a workflow fires on now (a condition marked Off is not one).
const firesOn = recipe => (Array.isArray(recipe.fires_when) ? recipe.fires_when : []).filter(item => item?.state !== 'Off').map(item => item.label).filter(Boolean);

const kindOf = on => (on.running ? 'running' : on.fact?.watch?.schedules?.length ? 'schedule' : 'trigger');

export function listMyAutomations(input) {
  if (!Array.isArray(input.wakes)) throw new Error('Send wakes: the rows wake:list answers, [{ tool, id, on, switched_on, mark }].');
  const recipes = (input.recipes ?? []).map(recipeOf);
  const byRecipe = new Map(recipes.map(recipe => [recipe.id, recipe]));
  const tools = new Map((input.tools ?? []).map(tool => [tool.id, tool]));
  const said = seeWhatRunsOnItsOwn({ wakes: input.wakes });
  const nameOf = id => byRecipe.get(id)?.label ?? tools.get(id)?.label ?? idWords(id);
  const wakeRows = input.wakes.map(wake => ({ wake, cause: said.causes.find(cause => cause.tool === wake.tool && cause.id === wake.id) }));

  const automations = wakeRows.map(({ wake, cause }) => {
    const kind = kindOf(wake.on);
    return {
      id: `${wake.tool}/${wake.id}`,
      open_id: `automation:${wake.tool}/${wake.id}`,
      kind,
      name: `${nameOf(wake.tool)}: ${idWords(wake.id)}`,
      when: kind === 'trigger' ? sayFact(wake.on.fact) : upper(cause.waits_for),
      does: nameOf(wake.tool),
      starts: byRecipe.has(wake.tool) ? wake.tool : null,
      enabled: cause.switch.on,
      state: cause.state,
      red: cause.red,
      last_run_at: iso(cause.last_run_ms),
      last_problem: cause.red ? cause.why : null,
      switch: cause.switch,
    };
  });

  const workflows = recipes.map(recipe => {
    const wakes = input.wakes.filter(wake => wake.tool === recipe.id);
    return {
      workflow_id: recipe.id,
      label: recipe.label ?? idWords(recipe.id),
      job: recipe.job ?? '',
      made_by: recipe.made_by ?? null,
      steps: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
      fires_when: firesOn(recipe),
      enabled: wakes.length ? wakes.some(wake => wake.switched_on) : null,
    };
  });

  if (input.open === undefined) return { automations, workflows, red: said.red, on: said.on, off: said.off };
  return openOne(String(input.open).replace(/^automation:/, ''), { automations, wakeRows, recipes, byRecipe, tools });
}

/** One automation or workflow: what sets it off, what it does, the input of what it runs and its steps as a graph. */
function openOne(id, { automations, wakeRows, byRecipe, tools }) {
  const automation = automations.find(item => item.id === id);
  if (automation) {
    const { wake } = wakeRows.find(row => `${row.wake.tool}/${row.wake.id}` === id);
    const tool = tools.get(wake.tool);
    const recipe = byRecipe.get(wake.tool);
    return {
      kind: automation.kind, id, label: automation.name, enabled: automation.enabled, says: automation.when, does: automation.does,
      then: recipe ? { workflow_id: recipe.id } : { tool_id: wake.tool },
      input_schema: recipe?.input_schema ?? tool?.input_schema ?? null,
      last_run: automation.last_run_at ? { at: automation.last_run_at, problem: automation.last_problem } : null,
      graph: {
        steps: [{ id: 'when', title: automation.when, state: { label: automation.enabled ? 'On' : 'Off' } }, { id: 'then', title: automation.does }],
        edges: [{ from: 'when', to: 'then' }],
      },
    };
  }
  const recipe = byRecipe.get(id);
  if (!recipe) throw new Error(`There is no automation or workflow ${id}. Send open as an id the list gave.`);
  const steps = (Array.isArray(recipe.steps) ? recipe.steps : []).map(step => ({ id: step.id, title: step.title ?? idWords(step.id), does: step.do ?? '' }));
  return {
    kind: 'workflow', id, label: recipe.label ?? idWords(id), says: firesOn(recipe).join('; '), does: recipe.job ?? '',
    input_schema: recipe.input_schema ?? null,
    graph: { steps, edges: steps.slice(1).map((step, index) => ({ from: steps[index].id, to: step.id })) },
  };
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  console.log(JSON.stringify({ result: listMyAutomations(input) }));
}
