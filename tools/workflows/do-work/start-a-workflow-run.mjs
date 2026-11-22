import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/workflows/do-work/start-a-workflow-run.mjs
//
// The start of a run of one of the person's workflows: the waiter that hears a workflow-chosen-from-rows fact is checked
// alive (wake:list), and then that fact is sent (wake:arrive) with a payload of four small fields: the recipe id, the
// person's database, the run's input as JSON text with this start's unique fact_id, and the starter (the caller's record id,
// the one cancel and answer check against). The engine reads the recipe's definition itself, through a reader its wake switch
// input names, so no definition travels here (a fact holds at most 8 text fields of 1024 bytes each). The run is found
// afterwards by that fact_id (show-a-workflow-run.mjs). Nothing is written to a database here.
//
// Runs on the person's own computer, through the run's door on fd 3 (read-data/engine-door.mjs): every call is made as the
// person, so this program holds no key and names no store or command.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { operate, readDoor, sqlRows } from '../read-data/engine-door.mjs';

const WAITER = 'a-workflow-was-chosen';
const WAITER_TOOL = 'tool:run-a-workflow';
const KIND = 'workflow-chosen-from-rows';
// A fact's text field holds at most this many bytes.
const FIELD_BYTES = 1024;
const DATABASE = /^[a-z][a-z0-9_]*$/;

/** input: { workflow, caller, database, input? }. Returns { event_id, workflow, database } once the fact is sent; throws before any send when refused. */
export async function startWorkflowRun(input, { door = readDoor(), fetchImpl = fetch } = {}) {
  const { workflow, caller, database } = input;
  if (typeof workflow !== 'string' || !workflow.startsWith('workflow:')) throw new Error('give the workflow id, such as workflow:do-a-job-no-workflow-fits-yet.');
  if (typeof caller !== 'string' || !/^[a-z]+:[A-Za-z0-9._-]+$/.test(caller)) throw new Error('give caller: your AI\'s record id (such as ai:claude-code-...), the one cancel and answer will check.');
  if (typeof database !== 'string' || !DATABASE.test(database)) throw new Error('give database: the name of the person\'s database the recipe is in.');
  const runInput = input.input ?? {};
  if (typeof runInput !== 'object' || Array.isArray(runInput)) throw new Error('input must be an object.');
  const recipes = await sqlRows(door, database, 'select recipe from workflow_recipes where recipe = $1', [workflow], `recipe:${workflow}:${Date.now()}`, fetchImpl);
  if (!recipes.length) throw new Error(`no workflow ${workflow} in the person's workflow_recipes; the run was not started.`);
  let wakes;
  try {
    wakes = (await operate(door, 'wake:list', { kind: KIND }, `wake-list:${workflow}:${Date.now()}`, fetchImpl)).wakes ?? [];
  } catch (error) {
    throw new Error(`the engine would not list its wakes (wake:list), so the waiter ${WAITER} could not be checked; the run was not started. ${error.message}`);
  }
  if (!wakes.some(wake => wake.id === WAITER && wake.tool === WAITER_TOOL && wake.switched_on === true)) {
    throw new Error(`no live waiter ${WAITER} in the engine's wakes; the run was not started.`);
  }
  const eventId = `workflow-run-start:${randomUUID()}`;
  const fields = { recipe: workflow, database, input: JSON.stringify({ ...runInput, fact_id: eventId }), started_by: caller };
  for (const [name, value] of Object.entries(fields)) {
    if (Buffer.byteLength(value) > FIELD_BYTES) throw new Error(`the ${name} field is over ${FIELD_BYTES} bytes; the run was not started.`);
  }
  const told = await operate(door, 'wake:arrive', { kind: KIND, event_id: eventId, payload: fields }, eventId, fetchImpl);
  // An engine answers kept false when no wake that is on hears the fact (trillion-rust 76424ef55, src/native_entry/computer.rs
  // wake_arrive): nothing starts, so the run was not started, said with the wakes of the kind it names.
  if (told.kept === false) {
    const wakes = (told.not_heard?.wakes_of_its_kind ?? []).map(wake => `${wake.tool} ${wake.id} (hears ${(wake.from ?? []).join(', ')}, ${wake.switched_on ? 'on' : 'off'})`);
    throw new Error(`the engine heard the start but no wake that is on hears ${KIND}${wakes.length ? `; its wakes: ${wakes.join('; ')}` : ''}; the run was not started.`);
  }
  return { event_id: eventId, workflow, database, heard_by: told.heard_by ?? null };
}

// Run as the program: the input JSON comes on stdin, the answer goes out as one JSON line.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    console.log(JSON.stringify({ result: await startWorkflowRun(JSON.parse(readFileSync(0, 'utf8') || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
