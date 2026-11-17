// tools/start-a-computer/do-work/install-init.mjs
//
// Keeps a program running on a computer by rendering one init row (read-data/init-rows.json) and loading it. The row names
// the init system's file, its text (a read-data/unit-templates file, or `text` given inline), and the steps that unload
// and load it; this file knows no init system and no operating system. A computer is described by `have` (the facts its
// own probe wrote: platform, arch ...), and a row is chosen by whether its `match` holds for it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fill } from './fill-fields.mjs';

const TEMPLATE = name => readFileSync(new URL(`../read-data/unit-templates/${name}`, import.meta.url), 'utf8');
export const INIT_ROWS = JSON.parse(readFileSync(new URL('../read-data/init-rows.json', import.meta.url), 'utf8')).rows;

/** A `match` holds when each key it names is the computer's value for it (a list names the values that count). */
export const holds = (match, have) => Object.entries(match ?? {}).every(([key, want]) => (Array.isArray(want) ? want : [want]).includes(have[key]));

/** The row for a computer: the first of `rows` whose match holds and whose scope is `scope`. */
export function selectInit(rows, have, scope) {
  const row = rows.find(candidate => candidate.scope === scope && holds(candidate.match, have));
  if (!row) throw new Error(`no init row keeps a program running for scope ${scope} on ${JSON.stringify(have)}`);
  return row;
}

const swap = (text, pairs) => (pairs ?? []).reduce((out, [from, to]) => out.split(from).join(to), text);
const mode = row => parseInt(row.mode ?? '0644', 8);

/** What installing would do: the file's path, text and mode, and the steps (argv lists) that unload and load it.
 * `values` is { label, command: [argv...], ...whatever the row's template and steps name }; the row's `requires` must all be there. */
export function renderInit(row, values) {
  for (const key of row.requires ?? []) if (values[key] === undefined) throw new Error(`init row ${row.id} needs ${key}`);
  if (!Array.isArray(values.command) || !values.command.length || values.command.some(item => typeof item !== 'string')) throw new Error(`init row ${row.id} needs command, the program's argv`);
  const escaped = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value !== 'object').map(([key, value]) => [key, swap(String(value), row.escape)]));
  const item = text => swap(swap(text, row.escape), row.argument?.escape);
  const wrap = text => (row.argument?.each ?? '{}').replace('{}', () => item(text));
  const [program, ...rest] = values.command;
  const field = { ...escaped, command: values.command.map(wrap).join(row.argument?.join ?? ' '), program: swap(program, row.escape), arguments: rest.map(wrap).join(row.argument?.join ?? ' ') };
  const text = fill(row.text ?? TEMPLATE(row.template), field, `init row ${row.id}`);
  const path = fill(row.file, values, `init row ${row.id}`);
  const steps = list => (list ?? []).map(argv => argv.map(part => fill(part, { ...values, file: path }, `init row ${row.id}`)));
  return { path, text, mode: mode(row), unload: steps(row.unload), gone: row.gone ? steps([row.gone])[0] : null, load: steps(row.load) };
}

const said = error => `${error.stderr ?? ''}${error.message ?? ''}`;

/** Writes the rendered file, unloads whatever the label already ran (a refusal the row's `absent` matches means nothing ran),
 * waits until the init system no longer knows it, and loads the new one. */
export function installInit(row, values, { run = execFileSync, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = Date.now } = {}) {
  const plan = renderInit(row, values);
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.text, { mode: plan.mode });
  const ran = unloadSteps(row, plan, { run, pause, now });
  for (const [command, ...args] of plan.load) run(command, args, { stdio: 'pipe' });
  return { init: row.id, definition: plan.path, replaced: ran };
}

function unloadSteps(row, plan, { run, pause, now }) {
  let ran = false;
  for (const [command, ...args] of plan.unload) {
    try { run(command, args, { stdio: 'pipe' }); ran = true; } catch (error) { if (!row.absent || !new RegExp(row.absent).test(said(error))) throw error; }
  }
  if (ran && plan.gone) {
    const until = now() + (row.gone_within_ms ?? 10000);
    for (let alive = true; alive && now() < until;) {
      try { run(plan.gone[0], plan.gone.slice(1), { stdio: 'pipe' }); pause(100); } catch { alive = false; }
    }
  }
  return ran;
}

/** Unloads the label and removes the file the row wrote. */
export function removeInit(row, values, { run = execFileSync, pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = Date.now } = {}) {
  const plan = renderInit(row, values);
  const ran = unloadSteps(row, plan, { run, pause, now });
  rmSync(plan.path, { force: true });
  return { init: row.id, definition: plan.path, removed: ran };
}
