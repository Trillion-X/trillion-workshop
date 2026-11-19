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
//     fact's payload, so a step binds {from: input, path: fact.<field>}, and `fact_id`, the event id the engine admitted
//     it under (one per change its teller told, so a run that tells on names each change by it); when later facts were
//     folded into it, `folded` (how many) and `last` (the last one's payload). A run nothing woke is given its input unchanged. No fact is read
//     further before a run starts: a fact carries what it can (a change carries before and after as JSON text when they
//     fit), and a run that needs more reads it in the person's store's own language, so nothing here names a store or a
//     reader tool.
//   - An ask named by a tool id (tool:...) is answered in the same call by running that tool through the run's host
//     (host.run), and an ask named by a door method a step may ask (workflows/ask-rights.json: wake:arrive, tools:list,
//     tools:run with a server's address) by that operation (host.operation), its input the door's whole input and its
//     answer the result (an error fails the step); each is keyed by the step and the BLAKE3 of what it asks, so a retried run repeats
//     nothing. An answer already given for the step wins. When the call did not happen (the run holds no door, or no
//     right to it, or anything else a wait can fix), the ask waits like any other, with the door's words as `why`; a
//     refusal of the call itself (ask-rights.json fails_on: an input not of the tool's shape, an unknown tool) fails it; a call that ran and failed fails the
//     run. Every other ask (the person, an AI, an agent) waits, as it does with no door. The rights a run holds are its
//     workflow row's own `records` (workflows/read-data/derived-records.mjs), which the engine hands it.
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
const ASK_RIGHTS = JSON.parse(readFileSync(new URL('../../workflows/ask-rights.json', import.meta.url), 'utf8'));
const DOOR_ASKS = ASK_RIGHTS.asks;
const FAILS_ON = new Set(ASK_RIGHTS.fails_on.codes);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const valueOf = bytes => (bytes === undefined || bytes === null || !bytes.length ? {} : JSON.parse(decoder.decode(bytes)));
const text = value => encoder.encode(JSON.stringify(value));

/** The engine's host when the run has its host actions: answers given win, tool asks run through them, the rest wait. Returns
 *  { host, waiting } (waiting fills as the engine asks). With no door it is null, and the runner's own hostless asks apply. */
function toolHost(host, answers) {
  if (!host || typeof host.run !== 'function') return null;
  const waiting = [];
  const wait = (step, name, payload, why) => {
    waiting.push({ step_id: step, asks: name, input: payload, ...(why ? { why } : {}) });
    return text({ $kind: 'not-answered-yet', step_id: step });
  };
  const engineHost = {
    async ask(name, payloadBytes, contextBytes) {
      const step = valueOf(contextBytes).step_id ?? name;
      if (Object.hasOwn(answers, step)) return text(answers[step]);
      if (Object.hasOwn(answers, name)) return text(answers[name]);
      const payload = valueOf(payloadBytes);
      const asked = TOOL.test(name) ? 'run' : Object.hasOwn(DOOR_ASKS, name) && typeof host.operation === 'function' ? 'operation' : null;
      if (!asked) return wait(step, name, payload);
      try {
        const answer = await host[asked](name, payload, { key: `${step}:${bytesToHex(blake3(payloadBytes ?? new Uint8Array()))}` });
        // A door operation that ran a tool answers {result} or {error}, as host.run reads it: an error fails the step.
        if (asked === 'operation' && answer && typeof answer === 'object' && Object.hasOwn(answer, 'error')) {
          throw Object.assign(new Error(`${name} did not finish: ${String(typeof answer.error === 'string' ? answer.error : JSON.stringify(answer.error)).slice(0, 300)}`), { outcome: 'committed' });
        }
        return text(asked === 'operation' && answer && typeof answer === 'object' && Object.hasOwn(answer, 'result') ? answer.result : answer);
      } catch (error) {
        if (error?.outcome === 'committed') throw error;
        // A refusal no wait can fix (the step's own call is wrong: ask-rights.json fails_on) fails the step, naming it.
        if (FAILS_ON.has(error?.code)) throw new Error(`${name} was refused (${error.code}): ${error.message}`);
        return wait(step, name, payload, String(error?.message ?? error));
      }
    },
    async read(from) { throw new Error(`Nothing here answers a read of ${from}; give the value as an answer instead.`); },
  };
  return { host: engineHost, waiting };
}

/** One run: { recipe | row + steps, input?, answers? } → { definition, run, kit } where run.status is the engine's. */
export async function runAWorkflow({ recipe = null, row = null, steps = [], input = {}, answers = {}, partition = 'person' } = {}, host = null, { engine = workflowEngine } = {}) {
  const shipped = recipeOf({ recipe, row, steps });
  const payload = startingAt(shipped, input?.start_at);
  const definition = definitionOf(payload);
  const runner = makeWorkflowDefinitionRunner(engine);
  const asked = { definitions: [definition, ...(definition.uses ?? [])], workflow_id: definition.id, input, answers, partition };
  const hosted = toolHost(host, answers ?? {});
  const run = hosted ? { ...(await runner.runWorkflowDefinition(asked, hosted.host)), waiting: hosted.waiting } : await runner.runWorkflowDefinition(asked);
  return { definition, run, kit: kitFor(shipped) };
}

/** tool:run-workflow-definition: given definitions and a workflow_id, those run as they are; given a recipe (or its row
 *  and step rows), it is made a definition first. Returns the run (status, waiting, each step's output), and the
 *  definition made when a recipe was given. */
export async function runWorkflow({ definitions = null, workflow_id = null, recipe = null, row = null, steps = [], input, answers = {}, partition = 'person', ...given } = {}, host = null, { engine = workflowEngine } = {}) {
  if (Object.keys(given).length) {
    // A listed row run as this tool: its own fields are the run's input (a wake's input, or a tools:run input).
    if (typeof row !== 'string' || input !== undefined) throw new Error(`Only a listed workflow row's run takes fields of its own (${Object.keys(given).join(', ')}); give them as input.`);
    input = given;
  }
  input ??= {};
  if (definitions) {
    if (recipe || row) throw new Error('Give definitions with a workflow_id, or a recipe (or its row and steps), not both.');
    const asked = { definitions, workflow_id, input, answers, partition };
    const hosted = toolHost(host, answers ?? {});
    return hosted ? { ...(await makeWorkflowDefinitionRunner(engine).runWorkflowDefinition(asked, hosted.host)), waiting: hosted.waiting }
      : makeWorkflowDefinitionRunner(engine).runWorkflowDefinition(asked);
  }
  const { definition, run, kit } = await runAWorkflow({ recipe, row, steps, input, answers, partition }, host, { engine });
  return { ...run, definition, kit };
}

/** tool:run-workflow-definition as the engine calls it: { run, woken_by? } → runWorkflow(run), the waking fact in its input. A
 *  woken run that ends paused throws, naming what it waits on (its error's `waiting` holds each ask). */
export async function runAsTheTool({ run = {}, woken_by = null } = {}, host = null) {
  if (!woken_by || typeof woken_by !== 'object' || woken_by.payload === undefined) return runWorkflow(run, host);
  const woken = { fact: woken_by.payload, ...(typeof woken_by.event_id === 'string' ? { fact_id: woken_by.event_id } : {}), ...(woken_by.coalesced > 0 ? { folded: woken_by.coalesced, last: woken_by.last?.payload ?? null } : {}) };
  const listed = typeof run.row === 'string' && run.input === undefined;
  const ran = await runWorkflow(listed ? { ...run, ...woken } : { ...run, input: { ...(run.input ?? {}), ...woken } }, host);
  // A run a fact woke has no one to answer what it waits on: paused, it would sit forever while its wake said it ran (26
  // gauntlet cases, 8 many-agents runs and more on Nov 19 2026). It fails instead, naming each waiting ask, so the engine
  // turns its wake failed and tells the person once (tell-when-a-wake-stops). A person's own call still pauses for them.
  if (ran?.status === 'paused') {
    const waiting = Array.isArray(ran.waiting) ? ran.waiting : [];
    const named = waiting.map(({ step_id, asks, why }) => `${step_id} (asks ${asks}${why ? `: ${why}` : ''})`).join('; ');
    throw Object.assign(new Error(`This run was woken by a fact and stopped waiting on ${named || 'an ask no one can answer here'}; no one answers a woken run, so it did not finish.`), { waiting });
  }
  return ran;
}
