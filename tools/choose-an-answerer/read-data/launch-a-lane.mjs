// tools/choose-an-answerer/read-data/launch-a-lane.mjs
//
// Purpose
//   The lane launcher: given a brief file, picks the answerer with chooseAnswerer and runs the brief through it, either
//   `codex exec` (Codex, through the codex-lb door its own config names) or a Claude chat. Prints which provider was
//   chosen and why. Which provider is preferred (Codex below its prefer_below_percent) is DATA on its answerer row.
//
// Non-negotiable invariants
//   1. The provider and model come only from chooseAnswerer, which reads the live lists and the limit rows; nothing is
//      typed here. A `none` answer starts nothing and says why.
//   2. The brief is sent on stdin, never in argv; no key, token or account id is put in argv or logged.
//   3. The command runs with an explicit argv (no shell), in the directory the brief names, with a result file.
//   4. codex-lb routes a Codex request to one of its accounts by its own routing; the chooser's account is recorded in the
//      answer, and it is not forced on the request (codex-lb's per-request account selection is not verified here).

import { chooseAnswerer } from './choose-an-answerer.mjs';

/** The argv and stdin for one answerer pick. Codex: `codex exec` in the lane's directory, result to a file. Claude: `claude -p`. */
export function commandFor(pick, { dir, resultFile }) {
  if (pick.provider === 'codex') {
    return { argv: ['codex', 'exec', '-C', dir, '-o', resultFile, '--skip-git-repo-check', '-m', pick.model, '-'], stdin: true };
  }
  if (pick.provider === 'claude') {
    return { argv: ['claude', '-p', '--model', pick.model, '--permission-mode', 'bypassPermissions'], stdin: true };
  }
  throw new Error(`no command is known for provider ${pick.provider}`);
}

/** Picks the answerer for a brief and runs it through `run({ argv, stdin, cwd })`. Returns what was chosen and why. */
export async function launchALane({ brief, dir, resultFile, need = { kind: 'ai' }, providers, limits, models, cooldowns = [], now = new Date(), run }) {
  const pick = chooseAnswerer(need, { providers, limits, models, cooldowns, now });
  if (pick.none) return { started: false, none: pick.none };
  const { argv, stdin } = commandFor(pick, { dir, resultFile });
  const outcome = await run({ argv, stdin: stdin ? brief : undefined, cwd: dir });
  return { started: true, provider: pick.provider, account: pick.account, model: pick.model, why: pick.why, exit_code: outcome.exit_code };
}
