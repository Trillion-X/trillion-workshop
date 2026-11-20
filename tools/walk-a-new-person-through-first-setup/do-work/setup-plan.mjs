// The setup contract is DATA, run by the existing workflow and owner APIs. Connecting an AI is the entrance,
// never the completed outcome. start_setup prepares the existing runtime and resumes one durable account run;
// read_setup is a read-only projection. Neither chooses a model, copies another person's data, nor grants authority.
import policy from '../read-data/setup-policy.json' with { type: 'json' };
import { instructionParagraph } from '../../shared-code/src/server-instruction-paragraphs.mjs';
import { setupInstalls } from './setup-installs.mjs';
import { lensForSetup } from '../../see-a-pursuit-through-the-lens/src/pursuit-lens.mjs';
import { chooseToolkit, fillCart, offeredToolkits, TOOLKIT_SWAPS_READ, TOOLKITS_READ } from './choose-toolkit.mjs';
import { setupSteps } from './setup-steps-from-a-cart.mjs';

const callFor = (tool, args = {}) => ({ tool, arguments: args });
const uniqueCalls = calls => [...new Map(calls.map(call => [JSON.stringify([call.tool, call.arguments]), call])).values()];

export function setupInstructions() {
  return `Setting a person up: call start_setup as soon as the MCP connection works and whenever the person asks to be set up. It prepares the existing defaults, source listeners and scheduler, and starts or resumes the setup workflow; follow its next_call through configuration and independent verification. Read what you find as "Seeing what they pursue" in its full setup guide and apply it to this person's observed context. For repeated status checks use read_setup with {view:"state"}; its guidance_call keeps the full guide available. After admitted discovery changes the required devices, call start_setup again without restart to prepare their current access prerequisites, then follow prerequisites.next_calls. Preserve a stopped setup until the person explicitly requests a restart. The saved workflow, not another checklist, owns the job. ${policy.words.continuation} ${policy.principles.join(' ')}`;
}

// What first setup offers from the toolkit rows: every row, the person's choice answered as tool ids, and the cart a new account is
// filled with: the choice, else the toolkit marked default as it stands (a person who picks nothing still gets a working cart).
// The cart carries its setup steps, rendered from its own parts (setup-steps-from-a-cart.mjs), never written by hand.
function toolkitsFor({ toolkits, toolkitChoice, knownTools }) {
  const offered = offeredToolkits(toolkits);
  const cart = toolkitChoice || offered.some(row => row.default) ? fillCart({ toolkits, choice: toolkitChoice, knownTools }) : null;
  return {
    offered,
    ...(toolkitChoice ? { choice: chooseToolkit({ toolkits, choice: toolkitChoice, knownTools }) } : {}),
    ...(cart ? { cart: { ...cart, steps: setupSteps(cart, { available: knownTools }) } } : {}),
  };
}

/** A saved run and current owner observations are separate: neither instructions nor an admitted output erase a
 * current failure. The recipe names how to discover applicability, delegate work, verify it and recover. */
export function setupPlan({ runtime, known = null, prerequisites = null, native = null, origin, view = 'full', lens = null, toolkits = null, toolkit_choice: toolkitChoice = null, known_tools: knownTools = null }) {
  if (!['state', 'full'].includes(view)) throw new Error("view must be 'state' or 'full'.");
  if (toolkitChoice && !toolkits) throw new Error('toolkit_choice needs the toolkit rows it picks from: hand in toolkits.');
  const workflow = runtime?.workflow ?? null;
  const continueRun = workflow?.exists && !workflow.withdrawn && workflow.state !== 'finished';
  // An observed not-started run has one actionable continuation. Merely reading
  // diagnostics must not hide it behind several unrelated observation calls.
  // Unknown state, a completed run and a deliberate stop never imply restart.
  const needsStart = workflow?.exists === false && workflow.state === 'not_started'
    && workflow.withdrawn !== true && prerequisites?.setup_paused !== true;
  const next_call = continueRun ? callFor('read_workflow_run', {
    run_id: workflow.run_id, ...(['failed', 'stuck'].includes(workflow.state) ? { resume: true } : {}),
  }) : needsStart ? callFor('start_setup') : null;
  const plan = {
    schema: 'trillion.setup-plan/v1',
    runtime,
    read_call: callFor('read_setup'),
    read_fallback_call: callFor('start_setup', { read_only: true }),
    read_toolkits_call: TOOLKITS_READ,
    read_toolkit_swaps_call: TOOLKIT_SWAPS_READ,
    workflow: { ...policy.workflow, ...workflow },
    ...(next_call ? { next_call } : {}),
    next_calls: uniqueCalls([...(next_call ? [next_call] : runtime?.next_calls ?? []), ...(prerequisites?.next_calls ?? []), ...(known?.connections?.next_call ? [known.connections.next_call] : [])]),
    ...(continueRun ? { controls: { stop: { tool: 'stop_workflow_run', arguments: { run_id: workflow.run_id }, requires: 'Use only for an actual stop request and supply its reason. Stops future workflow steps; already started work may continue.' } } } : {}),
    ...(known ? { known } : {}),
    ...(prerequisites ? { prerequisites } : {}),
    ...(toolkits ? { toolkits: toolkitsFor({ toolkits, toolkitChoice, knownTools }) } : {}),
  };
  if (view === 'state') return {
    ...plan,
    read_call: callFor('read_setup', { view: 'state' }),
    read_fallback_call: callFor('start_setup', { read_only: true, view: 'state' }),
    guidance_call: callFor('read_setup', { view: 'full' }),
  };
  return {
    ...plan,
    goal: policy.goal,
    policy: { version: policy.version, principles: policy.principles, requirements: policy.requirements },
    install: setupInstalls(origin, native),
    mission: instructionParagraph('mission'),
    keep_trillion_in_your_instructions: instructionParagraph('host-startup'),
    ...(lens ? { see_what_they_pursue: lensForSetup(lens) } : {}),
    ai_instructions: [
      policy.words.continuation,
      'Read the saved run before acting. Reuse its known facts, accepted outputs and pending person actions. Continue independent work while one action waits; do not ask the person to repeat setup or wait in the Trillion screen.',
      'Do the authorized work with the tools available in this conversation and the existing Marketplace owners. A handoff is unfinished until the result is read back. Discover the actual AI hosts, accounts and devices; do not require a device this person does not have.',
      'After admitting discovery that changes the required devices, call start_setup again without restart, then follow prerequisites.next_calls. It prepares current native access through the same account owner as the setup screen; no open browser screen is required. read_setup only reads these prerequisites. A missing mandate needs the person’s explicit access request; never add consent merely to advance setup. A stopped setup stays stopped until the person explicitly requests a restart.',
      'The human supplies direction and observations. Retrieve known facts first. Ask only for a genuinely missing fact, authorization, or an operating-system action the AI cannot perform, with one concrete prepared action in this conversation.',
      'Inspect the local harness installer before applying it, and verify actual hook execution afterward. Preserve unrelated configuration, chosen models, pauses, budgets and permissions. Do not enable paid inference or disable approval safeguards as a side effect of setup.',
      'Read the toolkit rows with read_toolkits_call (records:list; the starter toolkits the Workshop ships arrive in the same list) and hand them in as toolkits. When the answer carries toolkits, offer them: the person picks one, drops tool ids they do not want and adds tool ids they do. To set up another way (their own domain, a machine they already run, no domain), read the swap rows with read_toolkit_swaps_call and put the value.swap of the picked row in the choice as swap. Send that choice back as toolkit_choice and install the tool ids it answers; the cart in toolkits.cart is what a new account is filled with, the toolkit marked default when nothing is picked, and its stack names the pointers of each slot; never install a toolkit as it stands once the person has changed it.',
      'Use read_setup to verify current owner state. If your cached tool catalog does not expose read_setup, call start_setup with {read_only:true} for the same observation; never combine it with restart. Do not mark a capability complete from an instruction, a configuration entry, an armed alarm, a queued import or a failed read. A large import may continue with its tracked backlog after a verified first arrival and useful result.',
    ],
  };

}
