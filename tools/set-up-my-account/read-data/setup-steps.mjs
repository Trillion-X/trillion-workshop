// src/setup-steps.mjs
// The one composer of the forceful first setup gate (DATA: src/setup-steps.json). It is a deliberate read-only
// projection: every result comes from the owner that also manages the thing, and every action returns to that owner's
// existing surface. Unknown reads fail closed, so a service failure can never look like completed setup.
import settings from './setup-steps.json' with { type: 'json' };
import capabilityPolicy from './setup-policy.json' with { type: 'json' };
import computerRows from '../computer/computer-sources.json' with { type: 'json' };
import showRules from './workspace/show-rules.json' with { type: 'json' };
import { ruleProblem, rulesInForce, showDecision, withChanges } from './workspace/show-rules.mjs';
import { workspaceValueIdentity } from './workspace/conflicts.mjs';
import { rulesIn } from './workspace/sidebar-rules.mjs';
import { evaluateChecks, plainWords } from './setup-checks.mjs';
import { harnessWithin } from './harnesses.mjs';
import { failureOf } from './failure.mjs';
import { observerBucket } from '../parts/choose-per-observer/read-data/score-candidates.ts';

export { personalHoldApplies } from './personal-hold.mjs';

// Workspace owners lend their screen to the guide and open it in the workspace. External recovery destinations
// remain links; rules can change the words on either action, never its owner or destination.
const knownArray = value => Array.isArray(value) ? value : null;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nextChange = (times, now) => {
  const future = times.filter(time => Number.isFinite(time) && time > now);
  return future.length ? Math.min(...future) : null;
};

function deviceStep(row, devices, now, computers = null) {
  const known = knownArray(devices);
  const device = known?.find(item => item.id === row.device) ?? null;
  const routes = Array.isArray(device?.get) ? device.get : [];
  const link = routes.find(item => item.available === true && typeof item.href === 'string' && item.href) ?? null;
  const route = link ?? routes.find(item => item.recovery?.href) ?? routes[0];
  const available = link ? true : device?.available === false || (routes.length > 0 && routes.every(item => item.available === false)) ? false : null;
  const done = typeof device?.installed === 'boolean' ? device.installed : null;
  const state = device?.state ?? route?.state ?? (available === true ? 'ready' : available === false ? 'unavailable' : 'unknown');
  // A reason is the owner's own sentence, which may name a vendor's policy or an operator; only plain words reach a person.
  const reason = plainWords(device?.reason ?? route?.prerequisite?.reason ?? route?.reason ?? route?.not_yet, { computers },
    { plain: capabilityPolicy.words.plain, calm: available === false ? settings.words.unavailable : settings.words.unknown });
  const given = device?.recovery ?? route?.recovery;
  const recovery = given && plainWords(given.label, { computers }, { plain: capabilityPolicy.words.plain }) ? given : undefined;
  const prerequisites = [...new Map(routes.filter(item => item.prerequisite).map(item => [workspaceValueIdentity(item.prerequisite), item.prerequisite])).values()];
  const sourceIds = [...new Set(routes.map(item => item.source_id).filter(id => typeof id === 'string'))];
  return {
    id: row.id,
    title: row.title ?? device?.title ?? row.device,
    // A done device carries no body: the step is its check mark, and the words it needs are only for what is still open.
    ...(done === true ? {} : { body: available !== true ? reason : (row.body ?? device?.body ?? 'Install this Trillion app.') }),
    done, available, state, prerequisites,
    audience: row.audience ?? 'ai', ...(row.done_text ? { result: row.done_text } : {}),
    ...(link ? { checked_at: link.checked_at ?? null, expires_at: link.expires_at ?? null } : {}),
    next_change_at: nextChange(routes.map(item => Date.parse(item.expires_at ?? '')), now),
    source_id: route?.source_id ?? (sourceIds.length === 1 ? sourceIds[0] : null),
    ...(done !== true && available !== true ? { blocked: { owner: route?.prerequisite?.owner ?? row.owner, resource: row.device, state, reason, ...(recovery ? { recovery } : {}) } } : {}),
    ...(link && done !== true ? { action: { label: row.action ?? link.label, tone: 'primary', href: link.href } }
      : done !== true && recovery?.href ? { action: { label: recovery.label, tone: 'primary', href: recovery.href } } : {}),
  };
}

const array = value => Array.isArray(value) ? value : null;
const proofRows = runtime => runtime?.workflow?.verified === true && runtime.workflow.withdrawn !== true ? array(runtime.workflow.verification?.verified) : null;
const findComponent = (runtime, id) => array(runtime?.components)?.find(row => row.id === id) ?? null;
const hasEvidence = proof => Array.isArray(proof?.evidence_refs) && proof.evidence_refs.length > 0;
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);

/** Keep the current computer owner's precise permission recovery. These optional diagnostics are separate from
 * full setup proof: no switch waiting does not establish that data arrived or the AI finished useful work. */
function computerSwitchSteps(row, computers, now) {
  const known = array(computers);
  if (known === null) return [{ id: row.id, title: row.unknown_title, body: settings.words.unknown, done: null, required: false }];
  return known.flatMap(computer => {
    const age = now - Date.parse(computer?.reported_at ?? '');
    const fresh = age >= 0 && age <= row.fresh_hours * 3600_000;
    // Keep known identities after their evidence expires. Dropping a pending switch here would also drop an
    // operator's requirement for that switch, turning an unreadable owner observation into workspace admission.
    const next_change_at = fresh ? Date.parse(computer.reported_at) + row.fresh_hours * 3600_000 + 1 : null;
    const sources = array(computer.sources) ?? [];
    const waiting = sources.filter(source => source.state === 'needs_switch' && source.gate);
    if (!waiting.length) {
      const unknown = !fresh || sources.some(source => source.state === 'could_not_check');
      return [{ id: `${row.id}:${computer.computer_id}`,
        title: fill(unknown ? row.unchecked_title : row.done_title, { computer: computer.name }),
        body: unknown ? settings.words.unknown : row.done_body, done: unknown ? null : true, required: false, next_change_at }];
    }
    return [...new Set(waiting.map(source => source.gate))].map(gate => {
      const open = computerRows.gates?.[gate]?.open;
      const labels = waiting.filter(source => source.gate === gate).map(source => source.label);
      const names = labels.length <= 2 ? labels.join(' and ') : fill(row.more, { first: labels.slice(0, 2).join(', '), count: labels.length - 2 });
      return { id: `${row.id}:${computer.computer_id}:${gate}`,
        title: fill(row.title, { switch: computer.gates?.[gate]?.label ?? gate }),
        body: fresh ? fill(row.body, { sources: names, computer: computer.name }) : settings.words.unknown,
        done: fresh ? false : null, required: false, next_change_at,
        ...(typeof open === 'string' ? { action: { label: row.action, tone: 'primary', href: open } } : {}) };
    });
  });
}

// A person may deliberately pause a capability after successful setup. That is a configured choice, not a new
// onboarding task. Only the owning component's explicit preserved stop can use this; outages and unknowns cannot.
function preservedPause(component) {
  if (component?.state !== 'blocked' || component.evidence?.problem) return false;
  const facts = component.evidence;
  if (component.id === 'defaults') return array(facts?.stopped_by_choice)?.length > 0
    && array(facts.missing)?.length === 0
    && array(facts.rows)?.length > 0
    && facts.rows.every(row => ['active', 'customized', 'default_off', 'off', 'removed'].includes(row.state));
  if (component.id === 'event_intake') return array(facts?.sources)?.some(source => source.state === 'stopped' && source.preserved === true)
    && array(facts.running)?.length === 0
    && facts.sources.every(source => ['listening', 'stopped'].includes(source.state)
      && (source.state !== 'stopped' || source.preserved === true)
      && (source.problems?.length ?? 0) === 0
      && !(source.attempts ?? []).some(attempt => attempt.retryable === false));
  return false;
}

function currentRuntime(row, runtime) {
  const states = (row.runtime_components ?? []).map(id => findComponent(runtime, id));
  if (!states.length) return undefined;
  if (states.some(value => !value || value.state === 'unknown')) return null;
  return states.every(value => value.ready === true && value.state === 'ready'
    || runtime?.workflow?.verified === true && preservedPause(value));
}

/** Device and notification requirements are discovered for this person, never fixed to the founder's hardware.
 * A declared scope is checked again against the current owner, so a revoked registration cannot stay green. */
function scopedOwner(row, discovered, { devices, notificationDevices }) {
  const ids = array(row.id === 'devices' ? discovered?.device_ids : row.id === 'notifications' ? discovered?.notification_routes : null);
  if (!ids?.length) return undefined;
  if (row.id === 'devices') {
    const current = array(devices);
    // A device the person may not have (an optional one, like a watch) is never unfinished: one installed app is enough.
    return current ? ids.some(id => current.some(device => device.id === id && device.installed === true)) : null;
  }
  if (row.id === 'notifications') {
    const current = array(notificationDevices);
    return current ? ids.every(id => current.some(device => (device.id === id || device.route === id)
      && (device.route === 'web-push' ? device.can_show !== 'denied' : device.can_show === 'allowed'))) : null;
  }
  return undefined;
}

/** The name parts the identity checks read. A saved first or last name is kept as given; a missing one is taken from the
 *  saved full name (first word, then the rest) when that name does not contradict the saved part. A one-word name gives no last name. */
function profileNames(profile) {
  if (!object(profile)) return profile;
  const text = value => (typeof value === 'string' ? value.trim() : '');
  // An address is never a person's name: it is not split into name parts (src/profile-names.mjs keeps it out of `name`).
  const named = text(profile.name).includes('@') ? '' : text(profile.name);
  const [first = '', ...rest] = named.split(/\s+/).filter(Boolean);
  // A name part saved as an address (an account once saved its email as the first name) is treated as not saved.
  const notAddress = value => (text(value).includes('@') ? '' : text(value));
  const given = notAddress(profile.given_name), family = notAddress(profile.family_name);
  const agrees = !given || given.toLowerCase() === first.toLowerCase();
  return { ...profile, ...(named ? {} : { name: '' }), given_name: given || (!family || rest.join(' ').toLowerCase() === family.toLowerCase() ? first : ''), family_name: family || (agrees ? rest.join(' ') : '') };
}

const domainOf = product => capabilityPolicy.ai_domains.find(row => row.product === product)?.domain ?? null;
/** A connected AI that no harness row names is still shown, by its own name when that is an app's name, else as an
 *  unnamed AI app: an AI the person connected never silently drops off the list. */
const plainName = name => {
  const text = typeof name === 'string' ? name.trim() : '';
  // An app's own name starts with a capital and has no machine marks (a dash, an underscore, a slash, a long number); a
  // key name or a diagnostic fragment ("call-long", "t") does not, so it reads as an unnamed AI app.
  return /^[A-Z][A-Za-z0-9 .]{2,39}$/.test(text) && !/\d{3,}/.test(text) && plainWords(text) === text ? text : capabilityPolicy.words.connected_unnamed_ai;
};
/** Each connected AI once, by its product (src/harnesses.json) or its own plain name, with the product's logo domain. */
export function shownAis(names, { by = 'product' } = {}) {
  const shown = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    const row = harnessWithin(typeof name === 'string' ? name : name?.name);
    const label = row ? (by === 'app' ? row.app : row.product) : plainName(typeof name === 'string' ? name : name?.name);
    if (!shown.has(label)) shown.set(label, { name: label, domain: row ? domainOf(row.product) : null });
  }
  return [...shown.values()];
}

/** An agent's own name is a client's or a helper's (claude-code, a drive keeper), never a product a person knows: the agents
 *  component's rows are named by the AI product they belong to (src/harnesses.json) or by nothing. */
function productAgents(component) {
  const agents = array(component?.evidence?.agents);
  if (component?.id !== 'agents' || !agents) return component;
  // One row per AI product (src/harnesses.json): an agent card folds into the product it belongs to, so a product with
  // three cards is one row. A product takes work, or is live, when any of its cards does.
  const products = new Map();
  for (const agent of agents) {
    const { name, domain } = shownAis([agent.name], { by: 'app' })[0];
    const seen = products.get(name);
    products.set(name, seen ? { ...seen, takes_work: seen.takes_work === true || agent.takes_work === true,
      reach: { ...seen.reach, live: seen.reach?.live === true || agent.reach?.live === true } }
      : { ...agent, name, domain, takes_work: agent.takes_work === true, reach: { ...agent.reach, live: agent.reach?.live === true } });
  }
  return { ...component, evidence: { ...component.evidence, agents: [...products.values()] } };
}

/** The live values each step's sub-checks read (data: `checks` in src/setup-policy.json, src/setup-checks.mjs). Every
 *  piece is the owner's own current answer; one that could not be read stays null so its check says it is unknown. */
function evidenceFacts({ runtime, aiConnected, aiApps, devices, notificationDevices, computers, owned, knownAt }) {
  const components = array(runtime?.components);
  return {
    // When each kept owner value was last read (src/setup-known.mjs): a check shows it as of that time, never as live.
    known_at: object(knownAt) ? knownAt : {},
    ai: { apps: array(aiApps) ? shownAis(aiApps) : aiConnected === false ? [] : null },
    devices: array(devices), notification_devices: array(notificationDevices), computers: array(computers),
    components: components ? Object.fromEntries(components.map(row => [row.id, productAgents(row)])) : null,
    workflow: object(runtime?.workflow) ? runtime.workflow : null,
    owned: object(owned) ? { ...owned, ...(object(owned.profile) ? { profile: profileNames(owned.profile) } : {}) } : null,
    // What the saved workflow proved for each step, as references. Empty when it proved nothing for that step.
    proof: runtime?.schema === 'trillion.setup-runtime/v1'
      ? Object.fromEntries(capabilityPolicy.requirements.map(row => {
        const proved = proofRows(runtime)?.find(item => item.id === row.id);
        return [row.id, proved?.state === 'verified' && hasEvidence(proved) ? proved.evidence_refs.map(ref => ({ ref })) : []];
      })) : null,
  };
}

/** A step's form as the screen draws it: what the server writes with it (writes, missing, said) stays here. */
const shownForm = ({ writes, missing, said, ...form }) => form;

/** The values a step's form starts from: what Trillion already holds for a field of the same name (only text that was read). */
const knownValues = (complete, evidence) => {
  const values = Object.fromEntries(complete.fields.flatMap(field => {
    const value = evidence.owned?.profile?.[field.name];
    return typeof value === 'string' && value.trim() ? [[field.name, value]] : [];
  }));
  return Object.keys(values).length ? { values } : {};
};

function capabilityStep(selected, { runtime, aiConnected, devices, notificationDevices, evidence }) {
  const row = selected.capability;
  const proofs = proofRows(runtime);
  const inventory = array(runtime?.workflow?.inventory?.requirements);
  const runKnown = runtime?.schema === 'trillion.setup-runtime/v1';
  const proof = proofs?.find(item => item.id === row.id);
  const discovered = inventory?.find(item => item.id === row.id);
  const notApplicable = row.applicability === 'discover' && discovered?.applicability === 'not-applicable'
    && proof?.state === 'not-applicable' && hasEvidence(proof)
    && !(row.evidence?.applicable_if_declared ?? []).some(field => array(discovered?.[field])?.length > 0);
  let done = notApplicable || proof?.state === 'verified' && hasEvidence(proof) ? true : runKnown ? false : null;
  if (row.id === 'ai-connection') done = typeof aiConnected === 'boolean' ? aiConnected : null;
  // A live step is judged by what its own checks read now; the runtime components' states are the AI's own diagnostics
  // and decide only a step without live checks.
  const current = row.live === true ? undefined : currentRuntime(row, runtime);
  if (current !== undefined) done = current;
  // A live step is decided by what its sub-checks read now: all found is done, and that reading is its verification.
  // Any check missing keeps it open; one that could not be read changes nothing. Only steps with no live check use the saved proof.
  const seen = evaluateChecks(row.checks, evidence, { now: evidence.now, words: { unknown: capabilityPolicy.words.unknown, as_of: capabilityPolicy.words.as_of } });
  // A check that could not be read decides nothing: the step is unknown unless the saved proof already holds, so one failed
  // read never turns a step into "not done" on one view and "done" on the next.
  if (row.live === true && current === undefined && !notApplicable) done = seen.observed === null ? (done === true ? true : null) : seen.observed;
  // A capability the person deliberately paused after a verified setup is a configured choice, not unfinished work.
  if (row.live === true && done !== true && runtime?.workflow?.verified === true
    && (row.runtime_components ?? []).some(id => preservedPause(findComponent(runtime, id)))) done = true;
  const paused = done === true && (row.runtime_components ?? []).some(id => preservedPause(findComponent(runtime, id)));
  // Offered whether the step is done or not, and never when it is unknown.
  // A done step's screen is offered only when the step names a label for it; otherwise its items and their add action say it all.
  const placed = row.place && done !== null && (!done || row.place.label_done)
    ? { place: row.place.address, action: { label: done ? row.place.label_done : row.place.label, tone: 'quiet', open: row.place.address } } : null;
  const scope = scopedOwner(row, discovered, { devices, notificationDevices });
  if (!notApplicable && scope !== undefined && scope !== true) done = scope;
  // Its parts are running when any check, needed or not, found real rows: such a step is never drawn as not set up.
  const running = done !== true && seen.checks.some(check => check.state === true);

  // A done step carries no body of its own: the values it found are its items, so only the owner's pause and
  // not-applicable words are said. An unfinished step says what happens next.
  // A step still being checked that already found values shows those values (and its progress), never "still being set up"
  // beside them, so a slow second check cannot contradict what was found.
  const body = done === null ? (seen.items.length || seen.progress?.done > 0 ? null : settings.words.unknown)
    : done ? paused ? 'Configured. Your deliberate pauses are preserved.' : notApplicable ? settings.words.not_applicable : null
    : running ? null : selected.body ?? capabilityPolicy.words.waiting_step;
  // Checks that list their rows are shown as items; a check's sentence is kept only when it lists none.
  // A check that could not be read says nothing of its own: the step's checking mark already says so.
  // An optional check that found nothing is the AI's own diagnostic: it is neither the person's task nor a gap, so it says nothing.
  const notes = seen.checks.filter(check => !check.items?.length && check.state !== null && !(check.optional && check.state === false));
  // A reader that cannot read is its own action; an item that already carries that action does not repeat it.
  const itemActions = new Set(seen.items.map(item => item.action?.label).filter(Boolean));
  const readerActions = seen.reconnect.filter(item => !itemActions.has(item.label));
  return {
    id: row.id, title: selected.title ?? row.title, done, ...(running ? { running: true } : {}), ...(body ? { body } : {}), audience: row.audience ?? 'ai',
    ...(row.done_text ? { result: row.done_text } : {}),
    ...(seen.items.length ? { items: seen.items } : {}),
    ...(seen.add ? { add: seen.add } : {}),
    // Progress shows only real partial progress: a step with nothing found yet is checking, never "0 of 2".
    ...(seen.progress?.done > 0 && done !== true ? { progress: seen.progress } : {}),
    ...(notes.length ? { notes: notes.map(check => ({ label: check.label, text: check.text })), observed: seen.observed } : {}),
    ...(row.live === true && done === true && !notApplicable ? { evidence_refs: seen.checks.filter(check => check.state === true).map(check => `${check.label}: ${check.text}`) } : {}),
    // A person who can finish the step here gets its fields here, also after it is done so the saved answer can be changed.
    // Its boxes start from what Trillion already holds for the same field. The screen link is only for what they cannot do
    // on it. An unknown step is still being checked, so it neither shows a form nor asks the person to do it again.
    // A step whose read failed offers no form: a blank form could overwrite a value the store holds but could not read.
    ...(done !== null && row.complete_here && !(done && row.complete_here.until_done) ? { complete_here: { ...shownForm(row.complete_here), step: row.id, ...knownValues(row.complete_here, evidence) } } : {}),
    // The step's own screen: the host draws `place` under the step and the action toggles it; a host without `place` opens the same address.
    ...(placed ? { place: placed.place, action: placed.action } : done === false && seen.open && !row.complete_here ? { action: { label: seen.open.label, tone: 'quiet', open: seen.open.screen } } : {}),
    // A reader that cannot read is its own action, also when the step is done (one reading account is enough to finish it).
    ...(done !== null && readerActions.length ? { actions: readerActions.map(item => ({ label: item.label, tone: 'quiet', open: item.screen })) } : {}),
    ...(notApplicable ? { not_applicable: true } : {}),
    // A step whose applicability is discovered holds the person only once discovery found it applicable to them: before
    // that it is shown and can be done, but a member who has nothing to connect is never kept out of their workspace by it.
    ...(row.applicability === 'discover' && discovered?.applicability !== 'applicable' ? { awaiting_discovery: true } : {}),
  };
}

// The workflow owner returns inventory only when its bytes match the admitted discovery identity. Read that
// scope while work is still running, so obtaining a required app never waits for the final installation proof.
function discoveredDevices({ runtime, access, freeDecisionAccess }) {
  const freeAccess = access?.status === 402 && access.upgrade_needed === true && freeDecisionAccess === true;
  if (!runtime) return { known: freeAccess, ids: [], run_id: null, inventory_identity: null,
    problem: freeAccess ? null : 'runtime-source-unreadable' };
  const workflow = runtime.workflow;
  if (runtime.schema !== 'trillion.setup-runtime/v1' || !object(workflow)) return { known: false, ids: [], problem: 'runtime-source-unreadable' };
  const source = { run_id: workflow.run_id ?? null, withdrawn: workflow.withdrawn === true, inventory_identity: null };
  if (workflow.inventory_problem) return { ...source, known: false, ids: [], problem: 'workflow-inventory-unreadable' };
  if (workflow.inventory == null) return { ...source, known: true, ids: [] };
  const rows = array(workflow.inventory?.requirements);
  const admitted = workflow.verified === true || Number.isFinite(Date.parse(workflow.inventory_admitted_at ?? ''));
  if (!admitted || !rows || !rows.length || rows.length > 128 || !rows.every(row => typeof row?.id === 'string' && row.id) ||
      new Set(rows.map(row => row.id)).size !== rows.length || typeof workflow.run_id !== 'string' || !workflow.run_id) {
    return { ...source, known: false, ids: [], problem: 'workflow-inventory-unreadable' };
  }
  const discovery = rows.find(row => row.id === settings.policy.inventory_requirement);
  const ids = discovery?.[settings.policy.inventory_field] ?? (discovery?.applicability === 'not-applicable' ? [] : null);
  if (!Array.isArray(ids) || ids.length > settings.native_steps.length || !ids.every(id => typeof id === 'string' &&
    settings.native_steps.some(row => row.device === id)) || new Set(ids).size !== ids.length) {
    return { ...source, known: false, ids: [], problem: 'invalid-device-discovery' };
  }
  return { ...source, known: true, ids: [...ids].sort(), inventory_identity: workspaceValueIdentity(workflow.inventory) };
}

const capabilityRows = () => capabilityPolicy.requirements.map(capability => ({ id: capability.id,
  title: capability.title, owner: 'setup-capability', required: true, applicable: true, capability }));
const expandRows = (rows, computers, now) => rows.flatMap(row => row.owner === 'computer-switches' && !row.owner_step
  ? computerSwitchSteps(row, computers, now).map(step => ({ ...row, id: step.id, title: step.title, body: step.body, owner_step: step }))
  : [row]);
const candidateRows = (facts, scope, now) => expandRows([
  ...capabilityRows(),
  // A discovered device is required, except one the data marks optional (an accessory such as a watch): it is shown, and
  // never unfinished. An operator can still require it through its rules.
  ...settings.native_steps.map(row => scope.ids.includes(row.device) ? { ...row, applicable: true, required: row.optional !== true } : row),
  settings.computer_switches,
], facts.computers, now);
const validRequirements = rows => rows.every(row => typeof row.required === 'boolean' &&
  (row.applicable === undefined || typeof row.applicable === 'boolean'));

function projectRows(rows, facts, now) {
  return expandRows(rows, facts.computers, now).filter(row => row.applicable !== false).map(row => {
    let step;
    if (row.owner === 'setup-capability') step = capabilityStep(row, facts);
    else if (row.owner === 'device') step = deviceStep(row, facts.devices, now, facts.computers);
    else if (row.owner === 'computer-switches') step = { ...row.owner_step, title: row.title, body: row.body, audience: row.audience ?? 'optional',
      ...(row.owner_step.action ? { action: { ...row.owner_step.action, label: row.action } } : {}) };
    else step = { id: row.id, title: row.title ?? row.id, body: settings.words.unknown, done: null };
    // A discovered-applicability step that discovery has not found applicable to this person holds nobody: it is shown, and
    // it is not a requirement every owner has to count (the gate, the count and the workspace read the same flag).
    const awaiting = step.awaiting_discovery === true;
    return { ...step, owner: row.owner, required: row.required === true && !awaiting };
  });
}
const splitRequirements = requirements => ({
  steps: requirements.filter(step => step.owner === 'setup-capability' || step.owner === 'setup-policy'),
  person_actions: requirements.filter(step => step.owner === 'computer-switches' || step.owner === 'device' && step.done !== true),
});

/** Full completion is still the runtime owner's whole proof. Admission may select a smaller verified set; the
 * canonical requirements array is shared by the gate, invitation preparation and server-side revalidation. */
export function setupSteps({ runtime = null, aiConnected = null, aiApps = null, owned = null, devices = null, notificationDevices = null,
  access = null, freeDecisionAccess = null, computers = null, now = Date.now(), rows = null, knownAt = null } = {}) {
  const facts = { runtime, aiConnected, devices, notificationDevices, access, freeDecisionAccess, computers };
  facts.evidence = { ...evidenceFacts({ runtime, aiConnected, aiApps, devices, notificationDevices, computers, owned, knownAt }), now };
  const scope = discoveredDevices(facts);
  const definitions = rows ?? candidateRows(facts, scope, now);
  const requirements = projectRows(definitions, facts, now);
  const full = projectRows(capabilityRows(), facts, now);
  const runtimeComplete = full.length > 0 && full.every(step => step.done === true);
  const extra = requirements.filter(step => step.required && step.owner !== 'setup-capability');
  const extraComplete = extra.every(step => step.done === true);
  const required = requirements.filter(step => step.required);
  const requirementsComplete = validRequirements(definitions) && required.length > 0 && required.every(step => step.done === true);
  const complete = scope.known && runtimeComplete && extraComplete;
  const freeAccess = access?.status === 402 && access.upgrade_needed === true && freeDecisionAccess === true;
  // The workspace opens once every required step only the person can do is done. Steps their AI does run beside the open
  // workspace and never hold the person: an AI's own test run is not a to-do for the person.
  const personComplete = validRequirements(definitions) && required.filter(step => step.audience === 'person_only').every(step => step.done === true);
  const workspaceReady = scope.known && (personComplete || freeAccess && aiConnected === true && extraComplete);
  return {
    complete, runtime_complete: runtimeComplete, requirements_complete: scope.known && requirementsComplete,
    workspace_ready: workspaceReady, workspace_mode: complete ? 'full' : scope.known && freeAccess ? 'free' : workspaceReady ? 'configured' : 'setup',
    requirements, ...splitRequirements(requirements), words: settings.words,
    next_change_at: nextChange(requirements.map(step => step.next_change_at), now),
    // One name per AI product (src/harnesses.json), the same list the "AIs connected" sub-check shows.
    // ai_signed_in says an AI signed in even when no sign-in name is a known product.
    ai_apps: array(aiApps) ? shownAis(aiApps).map(row => row.name) : [],
    ai_signed_in: array(aiApps) ? aiApps.length > 0 : aiConnected === true,
    can_dispatch: findComponent(runtime, 'agents')?.ready === true && findComponent(runtime, 'agents')?.evidence?.live_delivery > 0,
    setup_prompt: capabilityPolicy.words.continuation,
    workflow: runtime?.workflow ? { run_id: runtime.workflow.run_id, state: runtime.workflow.state, exists: runtime.workflow.exists,
      verified: runtime.workflow.verified, withdrawn: runtime.workflow.withdrawn === true } : null,
  };
}

/** Read policy through the existing rules and workspace-record owners. Operator context is keyed by account;
 *  person context never supplies admission facts. Only this account's entry leaves the reader. The account's own rules
 *  and setup context are read from its own records resource through its consumer (`own`, answering fetch(Request) as
 *  the account routes do), where show_rules writes them. */
export async function readSetupPolicy({ own, operator, accountId }) {
  const ownRead = async (path, what) => {
    const response = await own.fetch(new Request(`https://person${path}`));
    if (!response.ok) throw new Error(`Could not read ${what}.`);
    return response.json();
  };
  const [shared, ownRules, context, personal] = await Promise.allSettled([
    Promise.resolve().then(() => operator ? operator.workspaceRecord(showRules.record) : null),
    ownRead('/show-rules', 'personal setup rules'),
    Promise.resolve().then(() => operator ? operator.workspaceRecord(settings.policy.context_record) : null),
    ownRead(`/records?label=${encodeURIComponent(settings.policy.context_record)}`, 'the personal setup context')
      .then(answer => answer?.records?.[settings.policy.context_record] ?? null),
  ]);
  // Settled reads keep the gate closed without rejecting this projection. Keep their causes observable,
  // but never include account identities, record contents or arbitrary error text in the diagnostic.
  for (const [source, result] of [['operator_shared_rules', shared], ['personal_rules', ownRules],
    ['operator_context', context], ['personal_context', personal]]) {
    if (result.status !== 'rejected') continue;
    let code = 'unexpected';
    try { code = failureOf(result.reason).code; } catch { /* A malformed rejection must not break setup. */ }
    console.error(JSON.stringify({ event: 'setup_policy_read_failed', source, code }));
  }
  const value = result => result.status === 'fulfilled' ? result.value : null;
  const record = value(context);
  const accounts = record?.[settings.policy.account_context_key];
  const contextShape = record == null || (object(record) && object(accounts));
  const ownContext = object(accounts) && Object.hasOwn(accounts, accountId) ? accounts[accountId] : null;
  return {
    accountId,
    sharedRules: value(shared), sharedRulesKnown: Boolean(operator) && shared.status === 'fulfilled',
    ownRules: value(ownRules), ownRulesKnown: ownRules.status === 'fulfilled',
    context: object(ownContext) ? ownContext : null,
    contextKnown: Boolean(operator) && context.status === 'fulfilled' && contextShape && (ownContext == null || object(ownContext)),
    personalContext: object(value(personal)) ? value(personal) : null,
    personalContextKnown: personal.status === 'fulfilled',
  };
}

/** Select applicable steps with the existing show-rules/formula owner, then compose their actual completion and
 *  actions from the factual owners. Shared selection is operator-owned; personal rules can only edit presentation.
 *  Invalid raw records are checked here too, so generic record writes cannot bypass the rules API's validation. */
export async function setupStepsWithRules({
  accountId, system = null, sharedRules = null, ownRules = null, context = null, personalContext = null,
  sharedRulesKnown = true, ownRulesKnown = true, contextKnown = true, personalContextKnown = true,
  filterRows, heldPolicy = null, now = Date.now(), ...facts
} = {}) {
  const policy = settings.policy;
  const subject = showRules.subjects[policy.subject];
  const problems = [];
  const applied = [];
  const excluded = [];
  const references = new Map();
  const issue = (source, reason, extra = {}) => problems.push({ source, reason, blocking: source !== 'personal', ...extra });
  const collect = (record, source, known) => {
    if (!known) { issue(source, 'source-unreadable'); return []; }
    if (record != null && (!object(record) || !Array.isArray(record.rules ?? []))) { issue(source, 'invalid-rule-record'); return []; }
    const candidates = source === 'operator'
      ? rulesInForce(showRules, record)
      : (record?.rules ?? []).filter(rule => rule?.on !== false && !rule?.starting);
    const seen = new Set();
    return candidates.filter(rule => rule?.subject === policy.subject).flatMap(rule => {
      const from = rule.starting ? 'defaults' : source;
      let problem;
      try { problem = ruleProblem(showRules, rule, source); } catch { problem = 'invalid-rule'; }
      if (typeof rule.id !== 'string' || !rule.id) problem ??= 'missing-rule-id';
      if (seen.has(rule.id)) problem ??= 'duplicate-rule-id';
      seen.add(rule.id);
      if (problem) { issue(from, problem, { rule: rule.id ?? null }); return []; }
      const id = `${from}:${rule.id}`;
      references.set(id, { id: rule.id, source: from });
      return [{ ...rule, id }];
    });
  };
  const shared = collect(sharedRules, 'operator', sharedRulesKnown);
  const personal = collect(ownRules, 'personal', ownRulesKnown);
  const accountKnown = typeof accountId === 'string' && accountId.length > 0;
  if (!accountKnown) issue('account', 'account-unreadable');
  if (context != null && !object(context)) {
    contextKnown = false;
    issue('operator', 'invalid-context-record');
  }
  for (const fact of subject.facts.filter(fact => fact.from)) {
    const record = context?.[fact.from];
    if (record != null && (!object(record) || Object.values(record).some(row => {
      const value = (fact.path ?? []).reduce((here, key) => here?.[key], row);
      return value != null && fact.value_type && typeof value !== fact.value_type;
    }))) {
      contextKnown = false;
      issue('operator', 'invalid-context-record', { field: fact.from });
    }
    if (fact.requires_candidate && object(record)) {
      for (const [id, value] of Object.entries(record)) if (value === true && !settings.native_steps.some(row => row.id === id && (!fact.candidate_owner || row.owner === fact.candidate_owner))) {
        issue('operator', 'unknown-required-step', { step: id, field: fact.from });
      }
    }
  }
  if (!contextKnown && shared.some(rule => rulesIn(rule.when).some(one => subject.facts.find(fact => fact.id === one.field)?.from))) {
    issue('operator', 'context-source-unreadable');
  }
  const trustedContext = contextKnown ? { ...policy.context_defaults, ...(object(context) ? context : {}) } : null;
  const bucket = accountKnown ? observerBucket(`${policy.bucket_epoch}:${accountId}`, policy.bucket_count) : null;
  const discovery = discoveredDevices(facts);
  if (!discovery.known) issue('workflow', discovery.problem ?? 'runtime-source-unreadable');
  const candidates = candidateRows(facts, discovery, now);
  const base = setupSteps({ ...facts, now, rows: candidates.map(row => ({ ...row, applicable: true })) });
  const readFacts = (row, source) => ({
    ...row,
    context: trustedContext,
    personal_context: personalContextKnown && object(personalContext) ? personalContext : null,
    // These facts are read last, never from an editable context or a changing rule.
    id: row.id, owner: row.owner, resource: row.device ?? row.id, account_id: accountKnown ? accountId : null,
    bucket, system, done: source?.done ?? null, available: source?.available ?? null,
  });
  const decide = async (row, source, rules) => {
    try {
      const answer = await showDecision({ data: { ...showRules, starting_rules: [] }, record: { rules }, subject: policy.subject,
        thing: readFacts(row, source), now, filterRows, readRecord: name => trustedContext?.[name] ?? null });
      for (const item of answer.incomplete ?? []) {
        const ref = references.get(item.rule);
        issue(ref?.source ?? 'operator', item.reason ?? 'unfinished-condition', { step: row.id, rule: ref?.id ?? null, ...(item.field ? { field: item.field } : {}) });
      }
      for (const change of answer.changes) applied.push({ step: row.id, rule: references.get(change.rule)?.id ?? null,
        source: references.get(change.rule)?.source ?? 'operator', path: change.path });
      return { row: withChanges(row, answer.changes), next: answer.next_change_at };
    } catch {
      issue(rules.every(rule => references.get(rule.id)?.source === 'personal') ? 'personal' : 'operator', 'rule-evaluation-unreadable', { step: row.id });
      return { row, next: null };
    }
  };
  const answers = await Promise.all(candidates.map(async (original, index) => {
    const source = base.requirements.find(step => step.id === original.id);
    const sharedAnswer = await decide({ ...original, order: index }, source, shared);
    const ownAnswer = await decide(sharedAnswer.row, source, personal);
    if (ownAnswer.row.required === true && ownAnswer.row.applicable === false &&
      !applied.some(change => change.step === original.id && change.path[0] === 'applicable')) {
      // Requiring a hidden candidate must never silently discard that requirement. Keep its owner visible until
      // the operator explicitly selects applicability (including an intentional exclusion).
      ownAnswer.row = { ...ownAnswer.row, applicable: true };
      issue('operator', 'required-step-needs-explicit-applicability', { step: original.id });
    }
    if (ownAnswer.row.applicable === false) excluded.push({ step: original.id, required: ownAnswer.row.required === true,
      rules: applied.filter(change => change.step === original.id && change.path[0] === 'applicable') });
    return { row: ownAnswer.row, turns: [sharedAnswer.next, ownAnswer.next] };
  }));
  const result = setupSteps({ ...facts, now, rows: answers.map(answer => answer.row).sort((a, b) => a.order - b.order) });
  const definitionsKnown = validRequirements(answers.map(answer => answer.row));
  if (!definitionsKnown) issue('defaults', 'invalid-requirement-row');
  // Held requirements (src/setup-known.mjs): when only rule sources could not be read now, the steps the last resolved policy
  // required stay required, and the status line is not shown; each step still says what was read and when. The gate stays closed
  // (requirementsResolved below), because an unread policy never proves setup complete.
  const unreadableOnly = problems.filter(problem => problem.blocking).every(problem => problem.reason === 'source-unreadable' || problem.reason === 'context-source-unreadable');
  const held = problems.some(problem => problem.blocking) && unreadableOnly && heldPolicy?.requirements_resolved === true && Array.isArray(heldPolicy.required_ids)
    ? new Set(heldPolicy.required_ids) : null;
  if (held) result.requirements = result.requirements.map(step => held.has(step.id) ? { ...step, required: true } : step);
  const noRequiredSteps = !result.requirements.some(step => step.required);
  if (noRequiredSteps && !contextKnown && !problems.some(problem => problem.reason === 'context-source-unreadable')) {
    issue('operator', 'context-source-unreadable');
  }
  // Admission policy can deliberately select a smaller or empty cohort, without changing the workflow owner's
  // complete result. Free access also retains every extra native or explicitly operator-mandated obligation.
  const requirementsResolved = accountKnown && sharedRulesKnown && contextKnown && definitionsKnown &&
    !problems.some(problem => problem.blocking);
  const extra = result.requirements.filter(step => step.required && (step.owner !== 'setup-capability' || applied.some(change =>
    change.step === step.id && change.source === 'operator' && ['required', 'applicable'].includes(change.path[0]))));
  const extrasComplete = extra.every(step => step.done === true);
  result.requirements_complete = requirementsResolved && result.requirements.filter(step => step.required).every(step => step.done === true);
  result.complete = requirementsResolved && result.runtime_complete && extrasComplete;
  const freeAccess = facts.access?.status === 402 && facts.access.upgrade_needed === true && facts.freeDecisionAccess === true;
  const personComplete = result.requirements.filter(step => step.required && step.audience === 'person_only').every(step => step.done === true);
  result.workspace_ready = requirementsResolved && (personComplete || freeAccess && facts.aiConnected === true && extrasComplete);
  result.workspace_mode = result.complete ? 'full' : requirementsResolved && freeAccess ? 'free' : result.workspace_ready ? 'configured' : 'setup';
  // The unreadable policy is a status line, not a step: it is not counted and it keeps the gate closed (requirementsResolved).
  if (problems.some(problem => problem.blocking) && !held) result.notice = policy.unresolved_step;
  Object.assign(result, splitRequirements(result.requirements));
  const turns = [...answers.flatMap(answer => answer.turns), base.next_change_at];
  const snapshot = { version: policy.version, defaults: { capabilities: capabilityPolicy.requirements, native: settings.native_steps,
    computers: settings.computer_switches }, shared, personal, context: trustedContext, personalContext: personalContextKnown ? personalContext : null,
    discovery, accountId, bucket, sharedRulesKnown, ownRulesKnown, contextKnown, personalContextKnown };
  result.policy = {
    version: policy.version, source_version: workspaceValueIdentity(snapshot),
    requirements_resolved: requirementsResolved, required_count: result.requirements.filter(step => step.required).length,
    discovery,
    sources: { rules_record: showRules.record, context_record: policy.context_record, shared_known: sharedRulesKnown,
      personal_known: ownRulesKnown, context_known: contextKnown, personal_context_known: personalContextKnown },
    applied, excluded, problems, next_change_at: nextChange(turns, now),
  };
  return result;
}
