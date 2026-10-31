// tools/walk-through-an-app-like-its-users/do-work/walk-through-an-app.mjs
//
// The command the tool rows run: `node walk-through-an-app.mjs walk` (tool:walk-through-an-app-like-its-users),
// `node walk-through-an-app.mjs map` (tool:map-an-apps-screens-and-controls) or `node walk-through-an-app.mjs observe`
// (tool:read-what-a-running-app-shows). Reads one JSON request on standard
// input and prints one JSON line: { "result": <report> } or { "error": "<what to change>" }.
import { readFileSync } from 'node:fs';
import { observeApp } from './observe.mjs';
import { mapApp, walkApp } from './walk.mjs';

const conventions = JSON.parse(readFileSync(new URL('./walk-conventions.json', import.meta.url), 'utf8'));
const jobs = { walk: walkApp, map: mapApp, observe: observeApp };

try {
  const job = jobs[process.argv[2]];
  if (!job) throw new Error(`Say which job to do as the first argument: ${Object.keys(jobs).join(' or ')}.`);
  const text = readFileSync(0, 'utf8');
  let request;
  try { request = JSON.parse(text); } catch { throw new Error('Standard input must be one JSON request.'); }
  const result = await job(request, conventions);
  process.stdout.write(`${JSON.stringify({ result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 2;
}
