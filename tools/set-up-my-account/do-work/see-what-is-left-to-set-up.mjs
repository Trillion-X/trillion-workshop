// tools/set-up-my-account/do-work/see-what-is-left-to-set-up.mjs
//
// tool:see-what-is-left-to-set-up. One JSON request on standard input, the Get started answer on the last line of
// standard output. The steps come from setupStepsWithRules (read-data/setup-steps.mjs) and the screen from
// getStartedFacts (read-data/get-started-screen.mjs), both moved from trillion as they were. Nothing is read or kept:
// the facts, the account's rules and its setup context are the request's.
import { readFileSync } from 'node:fs';
import { setupStepsWithRules } from '../read-data/setup-steps.mjs';
import { getStartedFacts } from '../read-data/get-started-screen.mjs';
import { makeRowFilter } from 'trillion-workshop/tools/formula-engine/rules/filter-rows-by-rules.mjs';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };

// The show rules' row filter is the formula engine's own (tools/formula-engine filter-rows-by-rules.mjs, the evaluator
// built from ops-core): a row's field value is row[field.id]; a missing value is null; an empty tree keeps every row; an
// unfinished rule is left out and named in `incomplete`.
const rowFilter = makeRowFilter({ operators, wasm: () => readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm'))) });
await rowFilter.load();
export function filterRowsByRules({ tree, fields, rows }) {
  return rowFilter.filterRowsByRulesNow({ tree, fields, rows });
}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// setupStepsWithRules' own names for the facts it reads (trillion src/native-setup.mjs passes them the same way).
const FACTS = ['runtime', 'aiConnected', 'aiApps', 'owned', 'devices', 'notificationDevices', 'access', 'freeDecisionAccess', 'computers', 'knownAt'];

export async function seeWhatIsLeftToSetUp(request) {
  if (!object(request)) throw new Error('Send one JSON object: { account_id, facts, rules?, context?, origin?, now? }.');
  if (typeof request.account_id !== 'string' || !request.account_id) throw new Error('account_id names the account whose setup this is.');
  if (request.facts !== undefined && !object(request.facts)) throw new Error('facts is an object of the setup facts (runtime, aiConnected, aiApps, owned, devices, notificationDevices, access, freeDecisionAccess, computers).');
  const now = request.now === undefined ? Date.now() : Date.parse(request.now);
  if (!Number.isFinite(now)) throw new Error('now is an ISO time; leave it out for now.');
  const facts = Object.fromEntries(FACTS.filter(name => Object.hasOwn(request.facts ?? {}, name)).map(name => [name, request.facts[name]]));
  // A rule set or context the request does not carry is unknown, never empty: the gate stays closed on it.
  const known = name => Object.hasOwn(request, name);
  const steps = await setupStepsWithRules({
    accountId: request.account_id, system: request.system ?? null, now, ...facts, filterRows: filterRowsByRules,
    sharedRules: request.shared_rules ?? null, sharedRulesKnown: known('shared_rules'),
    ownRules: request.rules ?? null, ownRulesKnown: known('rules'),
    context: request.context ?? null, contextKnown: known('context'),
    personalContext: request.personal_context ?? null, personalContextKnown: known('personal_context'),
  });
  return getStartedFacts({ ...steps, origin: request.origin, installs: object(request.installs) ? request.installs : undefined,
    ...(Array.isArray(request.setup_access) ? { setup_access: request.setup_access } : {}) });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    process.stdout.write(JSON.stringify({ result: await seeWhatIsLeftToSetUp(JSON.parse(readFileSync(0, 'utf8'))) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
