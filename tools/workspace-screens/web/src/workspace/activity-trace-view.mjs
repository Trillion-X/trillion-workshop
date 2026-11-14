// Read-only presentation of the activity owner and its durable execution/task/Sent receipts.
// This module never decides whether an outcome succeeded. The task owner supplies current_report;
// a provider response and even a captured readback remain separate from a judged real-world outcome.
// Identity comes from the captured actor snapshot. A recorder, client claim, or current agent card
// cannot stand in for an unknown historical actor. References are exact, never shortened or guessed.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length ? value : null;
const words = values => values.filter(value => text(value)).join(' · ');
const refs = values => [...new Set(values.flat().filter(value => text(value)))];
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

/** These labels report the association's captured basis, never infer it from a held job or current agent card. */
export function activityAssociationLabel(row, id) {
  const basis = object(row?.for_basis) && Object.hasOwn(row.for_basis, id) ? row.for_basis[id] : null;
  const labels = { explicit_input: 'Explicitly named in call', tool_result: 'Reference returned by tool' };
  return Object.hasOwn(labels, basis) ? labels[basis] : 'Recorded association; source not captured';
}
export const activityAssociationEvidence = row => [...new Set((row?.for ?? []).map(id => activityAssociationLabel(row, id)))].join(' · ')
  || 'No work association captured';

export const ORIGIN_VALUES = {
  real: { label: 'Real use (recorded)', tone: 'neutral' },
  synthetic: { label: 'Test / synthetic', tone: 'info' },
  unknown: { label: 'Origin unknown', tone: 'neutral' },
};
export const CAPTURE_VALUES = {
  managed_dispatch: { label: 'Managed call', tone: 'neutral' },
  internal_dispatch: { label: 'Internal call', tone: 'neutral' },
  host_transcript: { label: 'Host transcript', tone: 'neutral' },
  explicit_recording: { label: 'Explicit recording', tone: 'neutral' },
  activity_feed: { label: 'Activity feed', tone: 'neutral' },
  unknown: { label: 'Capture basis unknown', tone: 'neutral' },
};
export const DISPATCH_VALUES = {
  dispatching: { label: 'Dispatch started', tone: 'info' },
  returned: { label: 'Call returned', tone: 'info' },
  succeeded: { label: 'Dispatch returned', tone: 'info' },
  completed: { label: 'Run finished', tone: 'neutral' },
  checked: { label: 'Sample check finished', tone: 'neutral' },
  sent: { label: 'Recorded as sent', tone: 'neutral' },
  failed: { label: 'Call failed', tone: 'danger' },
  rejected: { label: 'Dispatch refused', tone: 'danger' },
  unknown: { label: 'Dispatch result unknown', tone: 'warning' },
  recorded: { label: 'Claim recorded', tone: 'neutral' },
  called: { label: 'Call recorded by host', tone: 'neutral' },
  reported_returned: { label: 'Return recorded by host', tone: 'neutral' },
  reported_failed: { label: 'Failure recorded by host', tone: 'warning' },
  working: { label: 'Run in progress', tone: 'info' },
  scheduled: { label: 'Run scheduled', tone: 'neutral' },
  for_you_to_run: { label: 'Waiting to run', tone: 'neutral' },
};
export const OUTCOME_VALUES = {
  reported_failed: { label: 'Reported failure', tone: 'danger' },
  reported_met: { label: 'Reported met', tone: 'neutral' },
  reported_unknown: { label: 'Report inconclusive', tone: 'neutral' },
  reports_unprojected: { label: 'Reports need review', tone: 'warning' },
  unjudged: { label: 'No outcome verdict', tone: 'neutral' },
};
export const OBSERVATION_VALUES = {
  readback: { label: 'Provider readback captured', tone: 'info' },
  unverified: { label: 'Observation basis unverified', tone: 'warning' },
  unavailable: { label: 'Observation unavailable', tone: 'warning' },
  missing: { label: 'Not yet independently observed', tone: 'neutral' },
};
const KIND_NAMES = { execution: 'Execution receipt', task: 'Tool run', effect: 'External effect', sent: 'Sent record', activity: 'Activity step', record: 'Related record', relation: 'Saved relationship' };
const BASIS = {
  registered_agent_snapshot: 'Registered agent snapshot at capture',
  authenticated: 'Authenticated recorder',
  server: 'Server recorder',
  client_declared: 'Client-declared app',
  provider_response: 'Provider response to dispatch',
  claimed: 'Caller-supplied claim',
  historical_source_not_captured: 'Historical actor was not captured',
  unknown: 'Not captured',
};
const labelOf = (values, value, fallback) => values[value]?.label ?? text(value) ?? fallback;
const originOf = value => Object.hasOwn(ORIGIN_VALUES, value) ? value : 'unknown';

/** Preserve the boundary's own role and basis. Legacy flat links never acquire
 *  an invented role, and a named input never becomes proof of consumption. */
export function executionReferenceRows(value) {
  return (Array.isArray(value?.references) ? value.references : []).filter(row => object(row) && text(row.ref) && text(row.role)).map(row => ({
    ...row,
    basis_label: row.basis === 'explicit_input' ? 'Named in call input' : row.basis === 'tool_result' ? 'Returned by tool'
      : row.basis === 'claimed' ? 'Supplied by the caller' : 'Basis not captured',
    path_label: Array.isArray(row.path) ? JSON.stringify(row.path) : 'Path not captured',
  }));
}

/** A label for the actor cannot be inferred from who recorded or later read the action. */
export function activityEvidence(row = {}, receipt = null) {
  const snapshot = receipt?.actor ?? row.identity_snapshot;
  const registered = snapshot?.basis === 'registered_agent_snapshot';
  const captured = registered && snapshot.selection_basis === 'caller_named_reader_bound_card';
  const actorName = captured ? text(snapshot.agent_name) ?? text(snapshot.agent_id) : null;
  const actor = actorName ? words([actorName, snapshot.model]) : 'Original caller unknown';
  const recorder = receipt?.recorder;
  return {
    actor,
    actor_basis: captured ? 'Caller-named registered card bound to this sign-in; no runtime attestation'
      : registered ? words(['Registered snapshot', snapshot.agent_name ?? snapshot.agent_id, snapshot.model, snapshot.conversation_id, 'Caller selection was not captured'])
        : BASIS[row.identity_basis] ?? BASIS.unknown,
    actor_id: captured ? text(snapshot.agent_id) : null,
    actor_model: captured ? text(snapshot.model) : null,
    actor_conversation: captured ? text(snapshot.conversation_id) : null,
    recorder: words([recorder?.app, recorder?.reader]) || (recorder?.basis === 'server' ? 'Trillion server' : text(row.app) ?? 'Recorder unknown'),
    recorder_basis: recorder ? words([BASIS[recorder.basis] ?? recorder.basis, recorder.app ? BASIS[recorder.app_basis] ?? 'App basis not captured' : null]) : 'App label in activity; authentication basis not captured',
    origin: originOf(row.origin ?? receipt?.origin),
    capture: text(row.capture_kind) ?? text(receipt?.capture_kind) ?? 'activity_feed',
    claimed_actor: words([row.agent_name ?? row.agent, row.model]),
  };
}

const kindOf = (id, value) => id.startsWith('execution:') ? 'execution'
  : id.startsWith('task:') ? 'task' : id.startsWith('effect:') ? 'effect'
    : id.startsWith('record:sent:') ? 'sent' : 'record';

function dispatchOf(kind, value) {
  if (kind === 'execution' && value.capture_kind === 'host_transcript') {
    return ({ returned: 'reported_returned', failed: 'reported_failed', called: 'called' })[value.event_phase] ?? 'recorded';
  }
  return text(kind === 'task' ? value.effect?.state ?? value.state : value.phase ?? value.state) ?? 'unknown';
}

/** Only the task owner's captured read-task response is a readback; a dispatch observation never is one. */
function outcomeOf(value, owner = null) {
  const seen = value.last_observation;
  const captured = typeof owner === 'string' && owner.startsWith('task:') && seen?.source_ref === owner
    && seen?.capture_kind === 'provider-readback'
    && ['provider', 'account', 'object_id', 'route', 'source_ref'].every(field => text(seen[field]))
    && stamp(seen.observed_at) !== null;
  const report = object(value.current_report) ? value.current_report : null;
  return {
    independent: captured ? 'readback' : seen ? 'unverified' : value.observation_unavailable ? 'unavailable' : 'missing',
    outcome: report && ['met', 'failed', 'unknown'].includes(report.result) ? `reported_${report.result}`
      : value.reports?.length ? 'reports_unprojected' : 'unjudged',
    observed: captured ? text(seen.observed) ?? '' : '',
    observation_at: captured ? seen.observed_at : null,
    observation_source: captured ? seen.source_ref : null,
    observation_reason: text(value.observation_unavailable),
    report_author: report ? report.reported_for === 'person' || report.attribution_basis === 'caller_claim' && report.answered_by === 'person'
      ? 'Reported for the person' : report.answered_by === 'person' ? 'Recorded as a person report' : text(report.answered_by) ?? 'Author unknown' : null,
    report_attribution: text(report?.attribution_basis) ?? (report ? 'Author basis not captured' : null),
    report_summary: text(report?.summary),
    report_at: text(report?.observed_at ?? report?.reported_at),
    report_source: text(report?.source_ref),
  };
}

function durableRow({ id, value }, receipts) {
  const kind = kindOf(id, value);
  const receipt = kind === 'execution' ? value : receipts.get(value.execution_ref) ?? null;
  const identity = activityEvidence({ origin: value.origin, capture_kind: value.capture_kind, app: value.recorded_by?.app }, receipt);
  const links = { ...(receipt?.links ?? {}), ...(value.links ?? {}) };
  const observation = value.effect?.observation ?? value.observation ?? receipt?.observation;
  const outcome = outcomeOf(value, kind === 'task' ? id : null);
  const provider = observation ?? (outcome.independent === 'readback' ? value.last_observation : null);
  const at = value.captured_at ?? value.sent_at ?? value.updated_at ?? value.current_report?.reported_at ?? value.finished_at ?? value.started_at ?? value.created_at ?? null;
  const source_refs = refs([value.source_ref, links.source_ref, receipt?.source_ref]);
  const work_refs = refs([value.work_ref, value.handoff_id, links.work_ref, links.handoff_id, receipt?.work_ref, receipt?.handoff_id]);
  return {
    id: `durable:${id}`, record_ref: id, kind, kind_label: KIND_NAMES[kind],
    label: text(value.operation) ?? text(value.subject) ?? text(value.title) ?? text(value.label) ?? text(value.tool_id) ?? KIND_NAMES[kind],
    at, ...identity, ...outcome,
    recorder: identity.recorder === 'Recorder unknown' && value.recorded_by?.reader ? value.recorded_by.reader : identity.recorder,
    recorder_basis: !receipt && value.recorded_by ? 'Recorder kept with Sent; original caller not established' : identity.recorder_basis,
    capture: receipt ? identity.capture : text(value.capture_kind) ?? 'unknown',
    // A real invocation can use a synthetic transport. Only the effect/provider observation names this origin.
    effect_origin: originOf(observation?.origin),
    dispatch: dispatchOf(kind, value),
    dispatch_basis: kind === 'task' || kind === 'effect' ? 'Run / effect owner' : kind === 'execution'
      ? CAPTURE_VALUES[value.capture_kind]?.label ?? 'Execution receipt' : 'Stored record',
    run_state: text(value.state),
    provider: text(provider?.provider ?? value.provider) ?? 'Provider not captured',
    account: text(provider?.account ?? value.provider_account) ?? 'Account not captured',
    provider_object: text(provider?.object_id ?? value.provider_id), route: text(provider?.route),
    connection_id: text(value.last_observation?.connection_id), provider_origin: text(value.last_observation?.provider_origin),
    provider_basis: provider ? BASIS[provider.basis] ?? (provider.capture_kind === 'provider-readback' ? 'Captured read-task response' : 'Evidence basis not captured')
      : kind === 'sent' ? 'Stored Sent fields; provider confirmation not captured' : 'Provider evidence not captured',
    from: text(value.from), reply_to: text(value.reply_to),
    source_refs,
    reference_evidence: executionReferenceRows(kind === 'execution' ? value : receipt),
    capture_coverage: receipt?.coverage?.input_output === 'not_captured' ? 'Full inputs and outputs were not captured. A named reference is not proof that it was used.' : 'Open the source receipt for capture coverage.',
    conversation_refs: refs([identity.actor_conversation, links.conversation_id, value.conversation_id]),
    claimed_source_refs: refs([receipt?.claimed?.source_ref, receipt?.claimed?.conversation_id]),
    claimed_actor: words([receipt?.claimed?.agent_name ?? receipt?.claimed?.agent_id, receipt?.claimed?.app, receipt?.claimed?.model]) || identity.claimed_actor,
    work_refs,
    work_basis: work_refs.length ? 'Links retained by the record owner' : 'No work association captured',
    work_associations: Object.fromEntries(work_refs.map(ref => [ref, 'Link retained by the record owner'])),
    proof_refs: refs([value.proof_ref, links.proof_ref, receipt?.proof_ref, outcome.observation_source, outcome.report_source]),
    task_refs: refs([value.task_id, value.by?.task_id, links.task_id]),
    other_refs: refs([value.execution_ref, links.effect_ref, value.effect_ref, links.sent_ref, links.record_ref, links.record_refs ?? [], links.case_id, receipt?.case_id, links.parent_call_id, receipt?.parent_call_id]),
    note: text(value.note), intake_state: text(value.intake_state),
    corrects: text(value.corrects), correction_reason: text(value.correction_reason),
    connection: 'Durable record', distance: '',
    raw_step: null,
  };
}

function stepRow(step, receipts, index) {
  const receipt = receipts.get(step.execution_ref) ?? null;
  const identity = activityEvidence(step, receipt);
  const receiptWork = refs([receipt?.links?.work_ref, receipt?.links?.handoff_id]);
  const work_refs = refs([step.for ?? [], receiptWork]);
  const work_associations = Object.fromEntries(work_refs.map(id => [id, words([
    step.for?.includes(id) ? activityAssociationLabel(step, id) : null,
    receiptWork.includes(id) ? 'Link retained in execution receipt' : null,
  ])]));
  return {
    id: `activity:${step.seq ?? index}:${step.link ?? ''}:${step.about ?? ''}`,
    record_ref: text(step.execution_ref) ?? text(step.item), kind: 'activity', kind_label: KIND_NAMES.activity,
    label: text(step.label) ?? text(step.tool) ?? 'Recorded call', at: text(step.at),
    ...identity, ...outcomeOf({}),
    effect_origin: originOf(receipt?.observation?.origin),
    dispatch: step.ok === true ? 'returned' : step.ok === false ? 'failed' : 'unknown',
    dispatch_basis: 'Activity call result; no outcome verdict', run_state: null,
    provider: 'Provider not captured', account: 'Account not captured', provider_object: null, route: null, provider_basis: 'Open the linked execution receipt',
    from: null, reply_to: null,
    source_refs: refs([receipt?.links?.source_ref, receipt?.source_ref]),
    reference_evidence: executionReferenceRows(receipt),
    capture_coverage: receipt?.coverage?.input_output === 'not_captured' ? 'Full inputs and outputs were not captured. A named reference is not proof that it was used.' : 'Open the source receipt for capture coverage.',
    conversation_refs: refs([identity.actor_conversation]),
    claimed_source_refs: refs([receipt?.claimed?.source_ref]),
    work_refs, work_associations,
    work_basis: [...new Set(Object.values(work_associations))].join(' · ') || 'No work association captured',
    proof_refs: refs([receipt?.links?.proof_ref]), task_refs: [],
    other_refs: refs([step.item, step.execution_ref, step.uses ?? []]),
    corrects: null, correction_reason: null,
    connection: step.link === 'for' ? activityAssociationLabel(step, step.about)
      : ({ made: 'Made by', used: 'Used it' })[step.link] ?? text(step.link) ?? 'Recorded step',
    distance: step.link === 'made' ? step.depth === 0 ? 'This item' : step.depth === 1 ? 'One step back' : `${step.depth} steps back` : 'After it',
    reason: text(step.reason), raw_step: step,
  };
}

/** Keep distinct owners, accounts and corrections distinct, including when their provider object IDs collide. */
export function traceRows(answer = {}) {
  const records = (Array.isArray(answer.records) ? answer.records : []).filter(row => text(row?.id) && object(row.value));
  const receipts = new Map(records.filter(row => row.id.startsWith('execution:')).map(row => [row.id, row.value]));
  const steps = Array.isArray(answer.steps) ? answer.steps : [];
  const related = (Array.isArray(answer.related_records) ? answer.related_records : []).filter(row => text(row?.ref));
  const named = new Set(records.map(row => row.id));
  const relations = related.filter(row => !named.has(row.ref)).map((row, index) => ({
    ...durableRow({ id: row.ref, value: {} }, new Map()),
    id: `relation:${JSON.stringify([row.ref, row.via, index])}`,
    kind: 'relation', kind_label: KIND_NAMES.relation, label: text(row.title) ?? row.ref,
    at: text(row.at), connection: words(['Saved relationship', text(row.via)]),
    dispatch_basis: 'A saved relationship does not establish that an action occurred',
  }));
  return [...records.map(row => durableRow(row, receipts)), ...steps.filter(object).map((step, index) => stepRow(step, receipts, index)), ...relations]
    .map((row, order) => ({ row, order }))
    .sort((a, b) => (stamp(b.row.at) ?? -Infinity) - (stamp(a.row.at) ?? -Infinity) || a.order - b.order)
    .map(({ row }) => row);
}

/** Absence and bounded coverage are information about this read, never proof no action happened. */
export function traceCoverage(answer = {}) {
  const durableCount = (Array.isArray(answer.records) ? answer.records : []).filter(row => text(row?.id) && object(row.value)).length;
  const stepCount = Array.isArray(answer.steps) ? answer.steps.length : 0;
  const relatedCount = (Array.isArray(answer.related_records) ? answer.related_records : []).filter(row => text(row?.ref)).length;
  const activity = answer.coverage?.activity ?? answer.coverage ?? {};
  const durable = answer.coverage?.durable;
  const messages = [`${durableCount} durable ${durableCount === 1 ? 'record' : 'records'} and ${stepCount} activity ${stepCount === 1 ? 'step' : 'steps'} available.`];
  if (relatedCount) messages.push(`${relatedCount} saved ${relatedCount === 1 ? 'relationship' : 'relationships'} available; a relationship alone does not prove use.`);
  if (answer.ambiguous) messages.push('This identifier matches more than one record. Compare provider and account before choosing a source.');
  if (activity.limit_reached) messages.push('The activity step, depth or lookup limit was reached; this chain is incomplete.');
  if (durable?.private_reach_required) messages.push('This sign-in cannot read the private execution records.');
  else if (durable?.complete === false) messages.push('The durable-record lookup is incomplete.');
  else if (!durable) messages.push('Durable-record coverage was not provided.');
  if (!durableCount) messages.push('No durable source receipt was found for this item. Its original caller and actual outcome may be unknown.');
  messages.push('Activity is a bounded feed. Managed read-only calls may be absent unless a supported host transcript or an explicit source record retained them. Uncaptured or older actions may be missing. A returned call or provider readback alone does not verify the intended outcome.');
  return { durableCount, stepCount, relatedCount, empty: !durableCount && !stepCount && !relatedCount, text: messages.join(' ') };
}

export const traceReferenceAddress = ref => `/activity/trace/${encodeURIComponent(ref)}`;
export const traceReferenceTarget = (ref, kind = 'trace') => kind === 'work' && ref.startsWith('h_') && ref.length > 2
  ? { href: `/jobs/${encodeURIComponent(ref)}`, screen: 'trillion.job-run', input: { handoff: ref }, title: 'Linked work' }
  : { href: traceReferenceAddress(ref), screen: 'trillion.activity-trace', input: { item: ref }, title: 'How this happened' };
export const dispatchLabel = value => labelOf(DISPATCH_VALUES, value, 'Dispatch result unknown');
export const observationLabel = value => labelOf(OBSERVATION_VALUES, value, 'Observation basis unverified');
