// tools/choose-an-answerer/read-data/load-choices.mjs
//
// Purpose
//   Reads the inputs chooseAnswerer decides from, once, for every caller: the answerer-choice rows (`setting`), the
//   provider_limits rows, the cool-down rows (`setting` named cooldown/...), and the live model lists. The store is named
//   by the caller (its input), never in this file. Codex limits are read fresh from codex-lb when its door is given.
//
// Non-negotiable invariants
//   1. The store and each door's address come from the caller. Nothing is typed here.
//   2. Models are read from each door's /v1/models; a door not given, or not answering, gives an empty list, so the
//      chooser names no model for that provider.
//   3. SQL goes through `runSql(store, sql)`. The caller names the command that runs one SQL statement on a store, as
//      argv words (sqlThrough); no product name is written here.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { readCodexLimits } from '../../codex-usage-read/read-data/codex-limits.mjs';

const run = promisify(execFile);

/** A runSql that runs `commandWords` (argv, e.g. the command of a store's SQL tool) with the store and the statement as JSON. */
export function sqlThrough(commandWords) {
  return async (store, sql) => {
    // The command runs from the person's home, never from a checkout whose tools folder it would read as its own.
    const { stdout } = await run(commandWords[0], [...commandWords.slice(1), JSON.stringify({ database: store, sql })], { timeout: 120000, cwd: homedir(), env: { ...process.env, PWD: homedir() } });
    const answer = JSON.parse(stdout);
    if (answer.error) throw new Error(`the store did not answer: ${answer.error}`);
    return answer.result.rows;
  };
}

/** The live model ids a door's /v1/models lists, or [] when no door is given or it does not answer. */
export async function modelsOf(door, { fetchImpl = fetch } = {}) {
  if (!door) return [];
  try {
    const answer = await fetchImpl(`${door.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(10000) });
    if (!answer.ok) return [];
    return ((await answer.json()).data ?? []).map(model => model.id);
  } catch {
    return [];
  }
}

/**
 * The chooser's inputs: { providers, limits, models, cooldowns }.
 * `store` names the database; `doors` maps a provider to its local base address ({ codex: 'http://127.0.0.1:2455' }).
 */
export async function loadChoices({ store, doors = {}, runSql, fetchImpl = fetch, readCodex = readCodexLimits } = {}) {
  if (!store) throw new Error('loadChoices needs the store (the database) it reads');
  if (!runSql) throw new Error('loadChoices needs runSql (see sqlThrough)');
  // One statement reads all four inputs, so a launch makes one store call.
  const [inputs] = await runSql(store, `select json_build_object(
      'choices', coalesce((select json_agg(s.value::jsonb order by s.name) from setting s where s.name like 'answerer-choice/%'), '[]'::json),
      'limits', coalesce((select json_agg(json_build_object('provider', l.provider, 'account', l.account, 'window_name', l.window_name, 'used_percent', l.used_percent::float8, 'resets_at', l.resets_at, 'read_at', l.read_at, 'source', l.source, 'state', l.state)) from provider_limits l), '[]'::json),
      'cooldowns', coalesce((select json_agg(s.value::jsonb) from setting s where s.name like 'cooldown/%'), '[]'::json)) as inputs`);
  const { choices: choiceRows, limits: storedLimits, cooldowns: cooldownRows } = inputs.inputs;
  const providers = choiceRows.filter(row => Array.isArray(row.kinds));
  const cooldowns = cooldownRows;
  // A fresh codex-lb read replaces the stored Codex rows, so a launch never waits on the hourly recipe.
  const codexFresh = doors.codex ? await readCodex(doors.codex).catch(() => null) : null;
  const limits = codexFresh ? [...storedLimits.filter(row => row.provider !== 'codex'), ...codexFresh] : storedLimits;
  const models = {
    codex: await modelsOf(doors.codex, { fetchImpl }),
    claude: await modelsOf(doors.claude, { fetchImpl }),
  };
  return { providers, limits, models, cooldowns };
}
