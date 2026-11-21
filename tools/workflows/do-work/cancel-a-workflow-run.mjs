// tools/workflows/do-work/cancel-a-workflow-run.mjs
//
// Stop a run for good: its waiting tasks are withdrawn (details.withdrawn and status Withdrawn), so an answer that comes later is
// refused by the answer-back recipe, and a live waiting step is cancelled on the engine (tools:cancel). Only the one run's tasks
// are touched: the run key (run.run) selects them, because one fact can start several runs. The holder check runs first; nothing
// changes when it refuses. Reached through the run's door on fd 3 (read-data/engine-door.mjs); names no store and no command.
//
// Runs on the person's own computer, as the person.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { holderCheck } from '../read-data/workflow-run-holder.mjs';
import { operate, readDoor, sqlRows } from '../read-data/engine-door.mjs';

const RUN_KEY = /^[0-9a-f]{64}$/;
const WHY_BYTES = 512;
const DATABASE = /^[a-z][a-z0-9_]*$/;

// The run's envelope fields, read from one of its waiting tasks (the same envelope every step carries).
async function runOf(door, database, runKey, fetchImpl) {
  const rows = await sqlRows(door, database, `select t.details->'told_as'->'payload'->'run' as run from calendar_tasks t
    where t.details->'told_as'->'payload'->'run'->>'run' = $1 limit 1`, [runKey], `cancel-read:${runKey}:${Date.now()}`, fetchImpl);
  const row = rows[0];
  if (!row) throw new Error(`no waiting task belongs to run ${runKey}; nothing was done`);
  const run = typeof row.run === 'string' ? JSON.parse(row.run) : row.run;
  return { actor: run.actor ?? null, started_by: run.started_by ?? null };
}

/** input: { run_key, caller, database, why? }. Returns { run_key, withdrawn: n, cancelled: true|false }; refused before any change when the holder check fails. */
export async function cancelWorkflowRun(input, { door = readDoor(), fetchImpl = fetch } = {}) {
  const { run_key: runKey, caller, database, why = 'cancelled by the door' } = input;
  if (typeof runKey !== 'string' || !RUN_KEY.test(runKey)) throw new Error('run_key is the 64-hex run key (run.run) of the run.');
  if (typeof database !== 'string' || !DATABASE.test(database)) throw new Error('give database: the name of the person\'s database the run is in.');
  if (Buffer.byteLength(why) > WHY_BYTES) throw new Error(`why is over ${WHY_BYTES} bytes.`);
  const holder = holderCheck(await runOf(door, database, runKey, fetchImpl), caller);
  if (!holder.ok) throw new Error(holder.why);
  const withdrawn = await sqlRows(door, database, `update calendar_tasks set status = 'Withdrawn',
      details = details || jsonb_build_object('withdrawn', jsonb_build_object('at', now()::text, 'by', $2::text, 'why', $3::text))
    where details->'told_as'->'payload'->'run'->>'run' = $1
      and status not in ('Done', 'Withdrawn', 'Not needed')
    returning id`, [runKey, caller, why], `cancel-withdraw:${runKey}:${Date.now()}`, fetchImpl);
  let cancelled = false;
  try {
    cancelled = (await operate(door, 'tools:cancel', { run: runKey }, `cancel-run:${runKey}:${Date.now()}`, fetchImpl)).cancelled === true;
  } catch {
    cancelled = false;
  }
  return { run_key: runKey, withdrawn: withdrawn.length, cancelled };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify({ result: await cancelWorkflowRun(JSON.parse(readFileSync(0, 'utf8') || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
