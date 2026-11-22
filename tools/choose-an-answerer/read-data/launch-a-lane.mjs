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
//   4. The inputs come from loadChoices (one loader for every caller); the store and doors are named on the command line.
//   5. codex-lb routes a Codex request to one of its accounts by its own routing; the chooser's account is recorded in the
//      answer, and it is not forced on the request (codex-lb's per-request account selection is not verified here).

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chooseAnswerer } from './choose-an-answerer.mjs';
import { loadChoices, sqlThrough } from './load-choices.mjs';

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

/**
 * The command line: brief on stdin; --dir, --result, --store and --sql-command (argv JSON) required; --kind, --codex-door,
 * --claude-door. With --pick-only it runs loadChoices and chooseAnswerer and starts nothing: it prints {provider, account,
 * model, why} or {none}, so a caller can choose before it commits to a start path. `deps` lets a test replace the loader.
 */
/** execFile options for a launched run: a timeout only when one is given (a Codex lane runs as long as its job needs). */
export function runOptions({ cwd, timeoutSeconds = 0 }) {
  return { cwd, maxBuffer: 1 << 24, ...(timeoutSeconds > 0 ? { timeout: timeoutSeconds * 1000 } : {}) };
}

export async function cli(argv, stdinText, deps = {}) {
  const flag = name => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
  const pickOnly = argv.includes('--pick-only');
  const timeoutSeconds = Number(flag('timeout-seconds') ?? 0);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error('--timeout-seconds takes a number of seconds, 0 or more (0 is no timeout)');
  const store = flag('store'), sqlCommand = flag('sql-command');
  const dir = flag('dir'), resultFile = flag('result');
  if (!store || !sqlCommand || (!pickOnly && (!dir || !resultFile))) {
    throw new Error('usage: launch-a-lane.mjs --dir DIR --result FILE --store NAME --sql-command \'["cmd",...]\' [--kind K] [--codex-door URL] [--claude-door URL] [--pick-only] [--timeout-seconds N] < brief');
  }
  const doors = { codex: flag('codex-door'), claude: flag('claude-door') };
  const load = deps.loadChoices ?? loadChoices;
  const choices = await load({ store, doors, runSql: sqlThrough(JSON.parse(sqlCommand)) });
  const need = { kind: flag('kind') ?? 'ai' };
  if (pickOnly) {
    const pick = chooseAnswerer(need, choices);
    return pick.none ? { none: pick.none } : { provider: pick.provider, account: pick.account, model: pick.model, why: pick.why };
  }
  return launchALane({ brief: stdinText, dir, resultFile, need, ...choices,
    run: ({ argv: command, stdin, cwd }) => new Promise(resolve => {
      const child = execFile(command[0], command.slice(1), runOptions({ cwd, timeoutSeconds }), error => {
        resolve({ exit_code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 });
      });
      child.stdin.end(stdin);
    }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  cli(process.argv.slice(2), Buffer.concat(chunks).toString('utf8'))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
