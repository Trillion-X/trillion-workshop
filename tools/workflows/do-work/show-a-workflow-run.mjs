// tools/workflows/do-work/show-a-workflow-run.mjs
//
// Where the run started by an event id stands: its waiting-step tasks, grouped by run (read-data/show-a-workflow-run.mjs). The
// one SELECT is sent through the run's door to the person's own SQL tool (read-data/engine-door.mjs), against the database
// named in the input, so this program holds no key, no connection string and names no store. Read only: it writes nothing.
//
// Runs on the person's own computer, through the run's door on fd 3.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { SHOW_PARAMS, SHOW_SQL, showRunsFor } from '../read-data/show-a-workflow-run.mjs';
import { readDoor, sqlRows } from '../read-data/engine-door.mjs';

const DATABASE = /^[a-z][a-z0-9_]*$/;

/** input: { event_id, database }. Returns { event_id, runs: [{ run_key, workflow, tasks: [{ id, status, step }] }] }. */
export async function showWorkflowRun(input, { door = readDoor(), fetchImpl = fetch } = {}) {
  if (typeof input.database !== 'string' || !DATABASE.test(input.database)) throw new Error('give database: the name of the person\'s database the run\'s tasks are in.');
  const rows = await sqlRows(door, input.database, SHOW_SQL, SHOW_PARAMS(input.event_id), `show:${input.event_id}:${Date.now()}`, fetchImpl);
  return showRunsFor(input.event_id, rows);
}

// Run as the program: the input JSON comes on stdin, the answer goes out as one JSON line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify({ result: await showWorkflowRun(JSON.parse(readFileSync(0, 'utf8') || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
