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
//       the setup runtime, device releases, the last setup snapshot) are `setup_facts`, handed in by the caller from
//       what it can read of them: the engine that answered them keeps none of an account's things now, and no owner
//       answers them in one read (a named gap), so what is left out is unknown, never none;
//     - the account's own show rules and its own setup context are its settings `show-rules` and `setup-context`
//       (old readSetupPolicy's ownRead('/show-rules') and ownRead('/records?label=setup-context')), handed in by the
//       caller in `stored.workspace` ({ label: value }) as it read them from the person's own store;
//     - the account id is the page's admitted account (contract B), old facts()'s owner_user_id;
//     - the setup runtime, when `setup_facts` carries none: old facts() read it from the account's setup runtime owner
//       (src/native-setup.mjs:104-158, makeSetupRuntime over makeSetupWorkflow). The setup run is a run of the recipe whose
//       default_for names the policy's purpose (tools/workflows public-recipes.mjs) on the workflow engine
//       (tool:run-workflow-definition), which keeps nothing: the run and its answers are the caller's, kept in the person's
//       own database, and the caller hands them in as `setup_run` ({ status, answers }: the status the engine answered and
//       the answers given so far by step id). No setup_run is a setup never started. The other readers old trillion had (defaults,
//       timed work, event intake, agents) have no owner read here yet and answer unavailable, which the screen shows as
//       unknown; none of them decides a step (read-data/setup-steps.mjs, a live step is judged by its own checks);
//   then it draws the screen with tool:see-what-is-left-to-set-up's own function, seeWhatIsLeftToSetUp, called here
//   with them: a function of its input, run in this same run, so nothing goes through a door.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source that could not be read is unknown, never empty (old readSetupPolicy's Promise.allSettled): a show-rules
//      or setup-context label the caller leaves out of `stored.workspace` is one it could not read, so it leaves
//      `rules` / `personal_context` out of the request and the steps say so; a label handed in as null is read and
//      not there.
//      The operator's shared rules and context are sent only when `setup_facts` carries them; otherwise they are unknown
//      and the gate stays closed (old trillion read them from the service's edge store, which no tool reaches).
//   2. `setup_facts`, when given, is one object; left out, every mechanic is unknown.
//   3. An origin that is not a web address is refused: the address the page was reached at is input, never a fixed host.
//   4. Nothing is written and no store is reached: the run answers the screen and keeps nothing.
import showRules from '../read-data/show-rules.json' with { type: 'json' };
import setupSettings from '../read-data/setup-steps.json' with { type: 'json' };
import { devicesFor, installationObserver, systemOf } from '../../set-up-my-devices-and-cameras/src/devices.mjs';
import capabilityPolicy from '../read-data/setup-policy.json' with { type: 'json' };
import { makeSetupRuntime, makeSetupWorkflow } from './setup-runtime.mjs';
import { defaultRecipeFor } from '../../workflows/read-data/public-recipes.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { seeWhatIsLeftToSetUp } from './see-what-is-left-to-set-up.mjs';

// The names see-what-is-left-to-set-up reads beside `facts`, when setup_facts carries them.
const BESIDE = ['system', 'shared_rules', 'context', 'setup_access', 'installs'];

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

/** old src/screen-reads.mjs webOrigin: the origin of an http(s) address, or null. */
export const webOrigin = value => {
  try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null; } catch { return null; }
};

/** One of the account's own settings as the caller handed it in, or undefined when it was left out (unknown, invariant 1). */
const ownSetting = (workspace, label) => (Object.hasOwn(workspace, label) ? workspace[label] ?? null : undefined);

/** The setup runtime, read from the setup run the caller hands in (see the PURPOSE above), or what makes it unavailable.
 *  Nothing is written, and the old owner's receipt and session are not kept by a read. */
async function setupRuntime(setupRun, now) {
  const policy = capabilityPolicy.workflow;
  const recipe = defaultRecipeFor(policy.default_for);
  const workflow = async () => {
    if (!recipe) throw new Error('No setup workflow is published.');
    if (setupRun !== undefined && !(object(setupRun) && typeof setupRun.status === 'string' && (setupRun.answers === undefined || object(setupRun.answers)))) {
      throw new Error('setup_run must be { status, answers? }: the status tool:run-workflow-definition answered and the answers given so far by step id.');
    }
    const kept = new Map(Object.entries(setupRun?.answers ?? {}));
    const shape = setupRun ? {
      state: setupRun.status === 'failed' ? 'failed' : setupRun.status === 'completed' ? 'finished' : 'working',
      done: Object.fromEntries([...kept].map(([step, answer]) => [step,
        { admitted_at: null, output_identity: makeHashCodeHexFromJson(answer), kept_answer: step }])),
    } : null;
    return makeSetupWorkflow({
      policy: { ...policy, id: recipe }, definitions: capabilityPolicy.requirements, identity: makeHashCodeHexFromJson,
      readRun: () => shape,
      readOutput: (_id, step) => kept.get(step) ?? null,
      readReference: () => ({ value: null }),
      readScope: () => ({ computers: [] }),
      owner: () => { throw new Error('A read starts no setup run.'); },
      now: () => new Date(now),
    }).read();
  };
  return makeSetupRuntime({ read: { workflow }, now: () => now }).read();
}

/** The request tool:see-what-is-left-to-set-up draws the screen from, gathered from tool:read-setup's input
 *  { origin, account_id, user_agent?, setup_facts?, setup_run?, stored?: { workspace }, now? }. */
export async function setupRequest(input = {}) {
  if (!object(input)) throw new Error('Send one JSON object: { origin, account_id, user_agent? }.');
  const accountId = text(input.account_id);
  if (!accountId) throw new Error('account_id names the account whose setup this is: the page\'s own account.');
  const origin = webOrigin(input.origin);
  if (!origin) throw new Error('origin names the web address the page was reached at (http or https).');
  const answer = input.setup_facts ?? {};
  const workspace = input.stored?.workspace ?? {};
  if (!object(input.stored ?? {}) || !object(workspace)) throw new Error('stored is one object: { workspace: { label: value } }, the settings show-rules and setup-context as read from the person\'s own store.');
  if (!object(answer)) throw new Error('setup_facts is one object: { facts?, signed_in?: { names }, system?, shared_rules?, context?, setup_access?, installs? }.');
  // Old /setup/facts drew `devices` from the names the account's sign-ins were made under (devicesFor({ signedInAs, system,
  // observer, distribution, now }), src/native-setup.mjs:243) only when those names could be read; setup_facts carries
  // them as `signed_in.names`. The device releases (`distribution`) have no owner here, so each app's ways to get it are
  // its published entries alone, as old devicesFor drew them when the distribution read failed.
  const userAgent = text(input.user_agent);
  const system = Object.hasOwn(answer, 'system') ? answer.system : systemOf(userAgent);
  const signedIn = object(answer.signed_in) && Array.isArray(answer.signed_in.names) ? answer.signed_in.names.filter(name => typeof name === 'string') : null;
  const now = typeof input.now === 'string' && Number.isFinite(Date.parse(input.now)) ? Date.parse(input.now) : Date.now();
  const devices = signedIn ? devicesFor({ signedInAs: signedIn, system, observer: installationObserver(userAgent), distribution: null, now }) : undefined;
  const rules = ownSetting(workspace, showRules.record);
  const personalContext = ownSetting(workspace, setupSettings.policy.context_record);
  const runtime = object(answer.facts) && Object.hasOwn(answer.facts, 'runtime') ? undefined : await setupRuntime(input.setup_run, now);
  return {
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
}

/** tool:read-setup: its input (see setupRequest) → the Get started screen. */
export async function readSetup(input) {
  return seeWhatIsLeftToSetUp(await setupRequest(input));
}
