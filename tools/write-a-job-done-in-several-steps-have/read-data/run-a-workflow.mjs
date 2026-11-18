// tools/write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs
//
// A person's workflow run on the workflow engine in one call: the recipe (its payload, or its row and its step rows as
// the person's lists keep them) and its input go in, with the answers known so far, and the run comes back: `paused`
// at the first step with no answer (the steps it waits on are in `waiting`), or finished. The recipe becomes an engine
// definition through the older version's own definitionOf (read-data/workflows.mjs, moved here whole), and the engine is the
// one-call runner (tools/run-a-workflow-definition-on-the-workflow-engine-in-one-call). Nothing is stored: no queue, no
// table, no records door. The kit a run carries is chosen before the engine is called (kitFor), never inside it.
//
// Invariants:
//   - A recipe with its own `definition` runs as that definition; ordered steps run as definitionOf makes them (an ask
//     per step, and after a step with checks the steps that judge them, with the lookups' definitions in `uses`).
//   - An answer is given by step id; a step's checks run on the engine as ordinary steps, so a bad answer fails the
//     run there, naming the rule and the values that break it, never judged here.
//   - A listed workflow row runs as this tool (its row source's invoke_with): the engine hands the row's id as `row`
//     beside the run's own fields (a wake's input, or a tools:run input), so `row` as text is a shipped recipe by id
//     (public-recipes.mjs) and every other field is the run's input. `start_at` in that input names the step a woken
//     run starts at: the run starts there, and a step it names that the recipe lacks is refused.
//   - Every run of a recipe carries its kit (kitFor) in the answer, so no run starts without one.
//   - The tool is runAsTheTool: its stdin is { run: the call's input, woken_by: the waking fact } (the row's invoke fills
//     woken_by from the engine's task, cause.detail, which only a wake's run has). A woken run's input gains `fact`, the
//     fact's payload, so a step binds {from: input, path: fact.<field>}; when later facts were folded into it, `folded`
//     (how many) and `last` (the last one's payload). A run nothing woke is given its input unchanged.
//   - An ask named by a tool id (tool:...) is answered in the same call by running that tool through the run's own door
//     (door.run), keyed by the step and the BLAKE3 of what it asks, so a retried run repeats no tool. An answer already
//     given for the step wins. When the tool did not run (the run holds no door, or no right to start it), the ask waits
//     like any other, with the door's words as `why`; a tool that ran and failed fails the run. Every other ask (the
//     person, an AI, an agent, a door method) waits, as it does with no door.
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { definitionOf } from './workflows.mjs';
import { recipeFromRows } from '../../workflows/read-data/recipe-rows.mjs';
import { kitFor } from '../../workflows/read-data/kit-for-a-run.mjs';
import { publicRecipe } from '../../workflows/read-data/public-recipes.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const ENGINE = new URL('../../build-engine-modules-for-web-hosts/built-stored-bytes/workflow-engine/', import.meta.url);
let loaded = null;

/** The built workflow engine (wasm), loaded once per process. */
export async function workflowEngine() {
  loaded ??= (async () => {
    const engine = await import(new URL('workflow_engine.js', ENGINE).href);
    await engine.default({ module_or_path: readFileSync(new URL('workflow_engine_bg.wasm', ENGINE)) });
    return engine;
  })();
  return loaded;
}

/** The recipe as its payload: given as one, a shipped recipe named by id, or made from the person's recipe row and step rows. */
export function recipeOf({ recipe = null, row = null, steps = [] }) {
  if (recipe) return recipe;
  if (typeof row === 'string') return publicRecipe(row);
  if (row) return recipeFromRows(row, steps);
  throw new Error('Give recipe (a recipe payload) or row with its steps (the rows the person keeps).');
}

/** The kit the run carries, chosen before the engine runs. */
export const kitOf = recipe => kitFor(recipe);

/** The recipe from the step `start_at` names on, or the recipe itself when it names none. */
function startingAt(payload, start) {
  if (start === undefined) return payload;
  // A recipe holding its own definition is a graph, not a list of steps to cut: it starts at its first step, which a wake
  // names as its start_at like any other.
  if (payload.definition) {
    const first = payload.definition.steps?.[0]?.id;
    if (start !== first) throw new Error(`start_at names ${JSON.stringify(start)}, but ${payload.id} holds its own definition, which starts at its first step, ${JSON.stringify(first)}.`);
    return payload;
  }
  const at = (payload.steps ?? []).findIndex(step => step.id === start);
  if (at < 0) throw new Error(`start_at names ${JSON.stringify(start)}, which is not a step of ${payload.id}: ${(payload.steps ?? []).map(step => step.id).join(', ')}.`);
  return { ...payload, steps: payload.steps.slice(at) };
}

const TOOL = /^tool:[a-z0-9][a-z0-9-]*$/;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const valueOf = bytes => (bytes === undefined || bytes === null || !bytes.length ? {} : JSON.parse(decoder.decode(bytes)));
const text = value => encoder.encode(JSON.stringify(value));

/** The engine's host when the run has a door: answers given win, tool asks run through the door, the rest wait. Returns
 *  { host, waiting } (waiting fills as the engine asks). With no door it is null, and the runner's own hostless asks apply. */
function toolHost(door, answers) {
  if (!door || typeof door.run !== 'function') return null;
  const waiting = [];
  const wait = (step, name, payload, why) => {
    waiting.push({ step_id: step, asks: name, input: payload, ...(why ? { why } : {}) });
    return text({ $kind: 'not-answered-yet', step_id: step });
  };
  const host = {
    async ask(name, payloadBytes, contextBytes) {
      const step = valueOf(contextBytes).step_id ?? name;
      if (Object.hasOwn(answers, step)) return text(answers[step]);
      if (Object.hasOwn(answers, name)) return text(answers[name]);
      const payload = valueOf(payloadBytes);
      if (!TOOL.test(name)) return wait(step, name, payload);
      try {
        return text(await door.run(name, payload, { key: `${step}:${bytesToHex(blake3(payloadBytes ?? new Uint8Array()))}` }));
      } catch (error) {
        if (error?.outcome === 'committed') throw error;
        return wait(step, name, payload, String(error?.message ?? error));
      }
    },
    async read(from) { throw new Error(`Nothing here answers a read of ${from}; give the value as an answer instead.`); },
  };
  return { host, waiting };
}

/** One run: { recipe | row + steps, input?, answers? } → { definition, run, kit } where run.status is the engine's. */
export async function runAWorkflow({ recipe = null, row = null, steps = [], input = {}, answers = {}, partition = 'person' } = {}, { engine = workflowEngine, door = null } = {}) {
  const shipped = recipeOf({ recipe, row, steps });
  const payload = startingAt(shipped, input?.start_at);
  const definition = definitionOf(payload);
  const runner = makeWorkflowDefinitionRunner(engine);
  const asked = { definitions: [definition, ...(definition.uses ?? [])], workflow_id: definition.id, input, answers, partition };
  const hosted = toolHost(door, answers ?? {});
  const run = hosted ? { ...(await runner.runWorkflowDefinition(asked, hosted.host)), waiting: hosted.waiting } : await runner.runWorkflowDefinition(asked);
  return { definition, run, kit: kitFor(shipped) };
}

/** tool:run-workflow-definition: given definitions and a workflow_id, those run as they are; given a recipe (or its row
 *  and step rows), it is made a definition first. Returns the run (status, waiting, each step's output), and the
 *  definition made when a recipe was given. */
export async function runWorkflow({ definitions = null, workflow_id = null, recipe = null, row = null, steps = [], input, answers = {}, partition = 'person', ...given } = {}, { engine = workflowEngine, door = null } = {}) {
  if (Object.keys(given).length) {
    // A listed row run as this tool: its own fields are the run's input (a wake's input, or a tools:run input).
    if (typeof row !== 'string' || input !== undefined) throw new Error(`Only a listed workflow row's run takes fields of its own (${Object.keys(given).join(', ')}); give them as input.`);
    input = given;
  }
  input ??= {};
  if (definitions) {
    if (recipe || row) throw new Error('Give definitions with a workflow_id, or a recipe (or its row and steps), not both.');
    const asked = { definitions, workflow_id, input, answers, partition };
    const hosted = toolHost(door, answers ?? {});
    return hosted ? { ...(await makeWorkflowDefinitionRunner(engine).runWorkflowDefinition(asked, hosted.host)), waiting: hosted.waiting }
      : makeWorkflowDefinitionRunner(engine).runWorkflowDefinition(asked);
  }
  const { definition, run, kit } = await runAWorkflow({ recipe, row, steps, input, answers, partition }, { engine, door });
  return { ...run, definition, kit };
}

/** tool:run-workflow-definition as the engine calls it: { run, woken_by? } → runWorkflow(run), the waking fact in its input. */
export async function runAsTheTool({ run = {}, woken_by = null } = {}, options = {}) {
  if (!woken_by || typeof woken_by !== 'object' || woken_by.payload === undefined) return runWorkflow(run, options);
  const woken = { fact: woken_by.payload, ...(woken_by.coalesced > 0 ? { folded: woken_by.coalesced, last: woken_by.last?.payload ?? null } : {}) };
  const listed = typeof run.row === 'string' && run.input === undefined;
  return runWorkflow(listed ? { ...run, ...woken } : { ...run, input: { ...(run.input ?? {}), ...woken } }, options);
}
