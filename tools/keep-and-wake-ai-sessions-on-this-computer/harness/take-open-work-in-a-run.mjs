#!/usr/bin/env node
// harness/take-open-work-in-a-run.mjs
//
// Purpose
//   The taker (take-open-work.mjs) as a tool run this computer's engine keeps: tool:take-given-tasks-on-this-computer and
//   its kept-running wake keep-taking-given-tasks (tool-rows.json). The engine starts it when the person switches the wake
//   on, starts it again when it crashes or the engine restarts, and stops it when the wake is switched off, so the tasks
//   given to this computer's taker are taken with no launchd job, login item, terminal or hand-started process.
//     node harness/take-open-work-in-a-run.mjs --home <kept folder> --program <granted AI program> --work <granted folder>
//   The three values are the run's own: its kept folder, and the program and work folder of its start-a-program grant
//   (the row fills them from the run's task). Standard input is the run's input; its `settings` are this computer's
//   take-open-work.computer.json values (computer_name, chosen_ai, tasks_store, account, ais, working_folder ...), where
//   the text {granted_program}, {granted_work} and {kept_home} stands for the three values above.
//
// How it works
//   1. HOME becomes the kept folder, so what the taker keeps (its started records, rests, results and the AI's own
//      settings) lasts between starts, and its state folder (take-open-work.json `state_folder`) is inside the run's reach.
//   2. The settings, holes filled, are written where a computer made from its row keeps them
//      (<state folder>/take-open-work.computer.json, read by take-open-work.mjs readSettings and chosen-ai.mjs).
//   3. The helper's own handler (wake-handlers/take-open-work.mjs start) runs a full pass now, again every
//      full_pass_every_minutes, sooner when a run it started ends, and less often while nothing waits.
//   4. The process stays running between passes; the engine's session is what keeps it.
//
// Non-negotiable invariants
//   1. No key is written anywhere: the settings name sources, never values. The account is reached through the run's own
//      door (account-call.mjs `run door`), and the AI's login is the environment the engine mounts for the run.
//   2. Settings that choose no AI end the start at once with the words that say so (exit 1), never a taker that takes nothing.
//   3. Only the three named holes are filled; every other {name} in the settings is left for the taker's own fill.
//
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOLES = { granted_program: '--program', granted_work: '--work', kept_home: '--home' };
const takerData = JSON.parse(readFileSync(new URL('./take-open-work.json', import.meta.url), 'utf8'));

/** The value of `--name <value>` in argv, or null. */
const flag = (argv, name) => {
  const at = argv.indexOf(name);
  return at >= 0 && typeof argv[at + 1] === 'string' && argv[at + 1] !== '' ? argv[at + 1] : null;
};

/** The settings with every {granted_program}, {granted_work} and {kept_home} replaced by its value, in every text at any
 * depth; nothing else changes. Pure. */
export function runSettings(settings, values) {
  const fill = value => {
    if (typeof value === 'string') return value.replace(/\{(granted_program|granted_work|kept_home)\}/g, (_, name) => values[name]);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  return fill(settings);
}

/** The three values from argv: { granted_program, granted_work, kept_home }. Throws naming a missing one. */
export function runValues(argv) {
  return Object.fromEntries(Object.entries(HOLES).map(([name, option]) => {
    const value = flag(argv, option);
    if (!value) throw new Error(`The run names no ${option}: the row fills it from the run's task.`);
    return [name, value];
  }));
}

/** Writes the settings as this computer's take-open-work.computer.json in the taker's state folder under `home`. */
export function keepRunSettings(settings, home) {
  const folder = join(home, takerData.state_folder.replace(/^~\/?/, ''));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, 'take-open-work.computer.json');
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(part, path);
  return path;
}

async function main(argv) {
  const values = runValues(argv);
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) throw new Error('The run\'s input names no settings for this computer\'s taker.');
  // HOME first: the taker's modules read their folders from it when they load.
  process.env.HOME = values.kept_home;
  keepRunSettings(runSettings(input.settings, values), values.kept_home);
  const log = line => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), part: 'take-given-tasks', said: line })}\n`);
  const helperRules = JSON.parse(readFileSync(new URL('./wake-sessions.json', import.meta.url), 'utf8'));
  const { chosenAi } = await import('./chosen-ai.mjs');
  if (!chosenAi(helperRules)) {
    process.stderr.write(`${takerData.words.no_chosen_ai}\n`);
    process.exitCode = 1;
    return;
  }
  const { start } = await import('./wake-handlers/take-open-work.mjs');
  start({ rules: helperRules, log });
  // The handler's timer does not hold the process open (it is unref'd for the helper); the engine's session does, through this.
  setInterval(() => {}, 2 ** 30);
}

const isEntryScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isEntryScript()) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
}
