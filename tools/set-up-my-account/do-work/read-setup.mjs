// tools/set-up-my-account/do-work/read-setup.mjs
//
// PURPOSE
//   tool:read-setup, the one read of the Get started screen (tool:get-started, GET /work/api/screens/get-started in
//   tools/show-my-screens-from-a-catalogue-of-reads-and-layouts). Old trillion drew that screen from one read,
//   tool:read-setup (src/screen-reads.mjs readSetup, the account action read-setup, tag
//   old-trillion-before-worker-retire), which asked the account's own setup owner for GET /setup/facts
//   (src/native-setup.mjs facts) and drew getStartedFacts over it. Here the same facts are gathered the same way, each
//   from its owner today, and the screen is drawn by tool:see-what-is-left-to-set-up:
//     - the account's own mechanics (sign-ins and their app grants, notification devices, the AI connection, computers,
//       the setup runtime, device releases, the last setup snapshot) are the account files door's `setup_facts`
//       (the brief's contract C), asked for the asking browser's user_agent and origin as old /setup/facts was;
//     - the account's own show rules and its own setup context are its records `show-rules` and `setup-context`
//       (old readSetupPolicy's ownRead('/show-rules') and ownRead('/records?label=setup-context'));
//     - the account id is the page's admitted account (contract B), old facts()'s owner_user_id;
//     - the setup runtime, when `setup_facts` carries none: old facts() read it from the account's setup runtime owner
//       (src/native-setup.mjs:104-158, makeSetupRuntime over makeSetupWorkflow). Here the setup run is a recipe run, so
//       the runtime moved here (from-an-older-version/src/setup-runtime.mjs) reads its workflow from the run itself: the recipe whose
//       default_for names the policy's purpose (tools/workflows public-recipes.mjs), its run under the policy's request
//       key and its kept answers (tools/workflows read-a-recipe-run.mjs). The other readers old trillion had (defaults,
//       timed work, event intake, agents) have no owner read here yet and answer unavailable, which the screen shows as
//       unknown; none of them decides a step (read-data/setup-steps.mjs, a live step is judged by its own checks);
//   then it runs tool:see-what-is-left-to-set-up with them (contract A: the row declares it in `runs`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source that could not be read is unknown, never empty (old readSetupPolicy's Promise.allSettled): a show-rules
//      or setup-context read that fails leaves `rules` / `personal_context` out of the request, and the steps say so.
//      The operator's shared rules and context are sent only when `setup_facts` carries them; otherwise they are unknown
//      and the gate stays closed (old trillion read them from the service's edge store, which no tool reaches).
//   2. A `setup_facts` refusal keeps its status (old readSetup rejected with the setup owner's status), so the screen
//      host answers it as it answered the old read's failure.
//   3. An origin that is not a web address is refused: the address the page was reached at is input, never a fixed host.
//   4. Nothing is written.
import showRules from '../read-data/show-rules.json' with { type: 'json' };
import setupSettings from '../read-data/setup-steps.json' with { type: 'json' };
import { devicesFor, installationObserver, systemOf } from '../../set-up-my-devices-and-cameras/src/devices.mjs';
import capabilityPolicy from '../read-data/setup-policy.json' with { type: 'json' };
import { makeSetupRuntime, makeSetupWorkflow } from '../from-an-older-version/src/setup-runtime.mjs';
import { readARecipeRun } from '../../workflows/read-data/read-a-recipe-run.mjs';
import { defaultRecipeFor } from '../../workflows/read-data/public-recipes.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const SCREEN_TOOL = 'tool:see-what-is-left-to-set-up';
const SETUP_FACTS = 'setup_facts';
// The names see-what-is-left-to-set-up reads beside `facts`, when the files door answers them.
const BESIDE = ['system', 'shared_rules', 'context', 'setup_access', 'installs'];

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

/** old src/screen-reads.mjs webOrigin: the origin of an http(s) address, or null. */
export const webOrigin = value => {
  try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null; } catch { return null; }
};

/** One of the account's own records, or undefined when it could not be read (unknown, invariant 1). */
async function ownRecord(door, label) {
  try {
    const { records } = await door.readWorkspace([label]);
    return Object.hasOwn(records, label) ? records[label] ?? null : null;
  } catch {
    return undefined;
  }
}

/** The setup runtime, read from the setup run itself (see the PURPOSE above), or what makes it unavailable. Nothing is
 *  written: the run and its kept answers are read once, and the old owner's receipt and session are not kept by a read. */
async function setupRuntime(door, now) {
  const policy = capabilityPolicy.workflow;
  const recipe = defaultRecipeFor(policy.default_for);
  const workflow = async () => {
    if (!recipe) throw new Error('No setup workflow is published.');
    const run = await readARecipeRun({ recipe, request_key: policy.request_key }, { door });
    const kept = new Map(run.steps.filter(step => step.kept).map(step => [step.id, step]));
    const shape = run.exists ? {
      state: run.status === 'failed' ? 'failed' : run.finished ? 'finished' : 'working',
      done: Object.fromEntries([...kept.values()].map(step => [step.id,
        { admitted_at: step.kept_at, output_identity: makeHashCodeHexFromJson(step.answer), kept_answer: step.answer_id }])),
    } : null;
    return makeSetupWorkflow({
      policy: { ...policy, id: recipe }, definitions: capabilityPolicy.requirements, identity: makeHashCodeHexFromJson,
      readRun: id => (id === run.run ? shape : null),
      readOutput: (id, step) => (id === run.run ? kept.get(step)?.answer ?? null : null),
      readReference: () => ({ value: null }),
      readScope: () => ({ computers: [] }),
      owner: () => { throw new Error('A read starts no setup run.'); },
      now: () => new Date(now),
    }).read();
  };
  return makeSetupRuntime({ read: { workflow }, now: () => now }).read();
}

/** tool:read-setup: { origin, account_id, user_agent? } → the Get started screen. */
export async function readSetup(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('Send one JSON object: { origin, account_id, user_agent? }.');
  const accountId = text(input.account_id);
  if (!accountId) throw new Error('account_id names the account whose setup this is: the page\'s own account.');
  const origin = webOrigin(input.origin);
  if (!origin) throw new Error('origin names the web address the page was reached at (http or https).');
  let answer;
  try {
    answer = await door.files(SETUP_FACTS, { user_agent: text(input.user_agent), origin });
  } catch (error) {
    throw Object.assign(new Error(error?.message ?? 'Setup could not be read.'), { status: Number.isInteger(error?.status) ? error.status : 502 });
  }
  if (!object(answer)) throw Object.assign(new Error('Setup could not be read.'), { status: 502 });
  // Old /setup/facts drew `devices` from the names the account's sign-ins were made under (devicesFor({ signedInAs, system,
  // observer, distribution, now }), src/native-setup.mjs:243) only when those names could be read; the files door answers
  // them as `signed_in.names`. The device releases (`distribution`) have no owner here, so each app's ways to get it are
  // its published entries alone, as old devicesFor drew them when the distribution read failed.
  const userAgent = text(input.user_agent);
  const system = Object.hasOwn(answer, 'system') ? answer.system : systemOf(userAgent);
  const signedIn = object(answer.signed_in) && Array.isArray(answer.signed_in.names) ? answer.signed_in.names.filter(name => typeof name === 'string') : null;
  const now = typeof input.now === 'string' && Number.isFinite(Date.parse(input.now)) ? Date.parse(input.now) : Date.now();
  const devices = signedIn ? devicesFor({ signedInAs: signedIn, system, observer: installationObserver(userAgent), distribution: null, now }) : undefined;
  const [rules, personalContext] = await Promise.all([ownRecord(door, showRules.record), ownRecord(door, setupSettings.policy.context_record)]);
  const runtime = object(answer.facts) && Object.hasOwn(answer.facts, 'runtime') ? undefined : await setupRuntime(door, now);
  const request = {
    account_id: accountId,
    facts: { ...(object(answer.facts) ? answer.facts : {}), ...(devices && !object(answer.facts?.devices) && !Array.isArray(answer.facts?.devices) ? { devices } : {}),
      ...(runtime ? { runtime } : {}) },
    ...Object.fromEntries(BESIDE.filter(name => Object.hasOwn(answer, name)).map(name => [name, answer[name]])),
    ...(Object.hasOwn(answer, 'system') ? {} : { system }),
    ...(rules !== undefined ? { rules } : {}),
    ...(personalContext !== undefined ? { personal_context: personalContext } : {}),
    origin,
    ...(typeof input.now === 'string' ? { now: input.now } : {}),
  };
  return door.run(SCREEN_TOOL, request, { key: `read-setup:${accountId}` });
}
