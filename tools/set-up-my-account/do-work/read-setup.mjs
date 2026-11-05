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
//   then it runs tool:see-what-is-left-to-set-up with them (contract A: the row declares it in `runs`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A source that could not be read is unknown, never empty (old readSetupPolicy's Promise.allSettled): a show-rules
//      or setup-context read that fails leaves `rules` / `personal_context` out of the request, and the steps say so.
//      The operator's shared rules and context are sent only when `setup_facts` carries them; otherwise they are unknown
//      and the gate stays closed (old trillion read them from the service's edge store, which no tool reaches).
//   2. A `setup_facts` refusal keeps its status (old readSetup rejected with the setup owner's status), so the screen
//      host answers it as it answered the old read's failure.
//   3. An origin that is not a web address is the service's own (old readSetup: webOrigin(origin) ?? ownOrigin).
//   4. Nothing is written.
import showRules from '../read-data/show-rules.json' with { type: 'json' };
import setupSettings from '../read-data/setup-steps.json' with { type: 'json' };

const SCREEN_TOOL = 'tool:see-what-is-left-to-set-up';
const SETUP_FACTS = 'setup_facts';
// The service's own address, as old readSetup's ownOrigin (src/screen-reads.mjs) and getStartedFacts' default.
const OWN_ORIGIN = 'https://app.gettrillion.ai';
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

/** tool:read-setup: { user_agent?, origin?, account_id } → the Get started screen. */
export async function readSetup(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('Send one JSON object: { user_agent?, origin?, account_id }.');
  const accountId = text(input.account_id);
  if (!accountId) throw new Error('account_id names the account whose setup this is: the page\'s own account.');
  const origin = webOrigin(input.origin) ?? OWN_ORIGIN;
  let answer;
  try {
    answer = await door.files(SETUP_FACTS, { user_agent: text(input.user_agent), origin });
  } catch (error) {
    throw Object.assign(new Error(error?.message ?? 'Setup could not be read.'), { status: Number.isInteger(error?.status) ? error.status : 502 });
  }
  if (!object(answer)) throw Object.assign(new Error('Setup could not be read.'), { status: 502 });
  const [rules, personalContext] = await Promise.all([ownRecord(door, showRules.record), ownRecord(door, setupSettings.policy.context_record)]);
  const request = {
    account_id: accountId,
    facts: object(answer.facts) ? answer.facts : {},
    ...Object.fromEntries(BESIDE.filter(name => Object.hasOwn(answer, name)).map(name => [name, answer[name]])),
    ...(rules !== undefined ? { rules } : {}),
    ...(personalContext !== undefined ? { personal_context: personalContext } : {}),
    origin,
    ...(typeof input.now === 'string' ? { now: input.now } : {}),
  };
  return door.run(SCREEN_TOOL, request, { key: `read-setup:${accountId}` });
}
