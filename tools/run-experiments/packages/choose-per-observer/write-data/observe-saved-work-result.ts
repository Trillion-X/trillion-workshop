import type { AtomicOperationWorkStore } from '@/packages/operation-records/read-data/operation-work-store';
import { operationWorkAddresses as addresses } from '@/packages/operation-records/read-data/operation-work-store';
import { buildObservationRecord } from './observe';
import { selectWinner } from '../read-data/select';
import { validateCandidateSet, type SelectionSurface } from '../../../../funnels-screen/read-data/candidate-set-schema';
import { validateDecider, type DeciderProgram } from '../read-data/decider-schema';
import { measureCustomerLoop, type CustomerLoopEvent } from '@/packages/content-analytics/read-data/customer-loop-measurement.ts';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

type Row = Record<string, unknown>;
const row = (value: unknown, message = 'Saved result evidence is missing.'): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Row;
};
const ref = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
    || value.includes('::')) throw new Error('Learning references must be opaque identifiers.');
  return value;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const permissionAddress = (leaseRef: string) =>
  `package::permission-lease::allowed-to::${encodeURIComponent(leaseRef)}`;

function activePermissionContext(permission: Row, leaseRef: string, at?: string): Row {
  const allowed = permission.allowed_operation_refs;
  if (permission.kind !== 'permission_lease' || permission.lease_ref !== leaseRef
    || permission.revoked !== false || !Array.isArray(allowed)
    || !allowed.includes('learn-local-saved-result')
    || typeof permission.allowed_by_decision_proof !== 'string'
    || !permission.allowed_by_decision_proof.trim()) {
    throw new Error('Permission to learn from this saved result is missing or revoked.');
  }
  if (permission.expires_at !== undefined && permission.expires_at !== null) {
    const expires = Date.parse(String(permission.expires_at));
    const observed = Date.parse(String(at));
    if (!Number.isFinite(expires) || !Number.isFinite(observed) || observed >= expires) {
      throw new Error('Permission to learn from this saved result is missing or revoked.');
    }
  }
  const context = row(permission.bound_context, 'Saved result permission context is missing.');
  const allowedContextFields = new Set(['work_ref', 'observer_id', 'candidate_id', 'candidate_material_ref',
    'installation_ref', 'user_ref', 'selection_surface_ref', 'applicability_ref', 'useful_impact']);
  if (Object.keys(context).some(key => !allowedContextFields.has(key))) {
    throw new Error('Saved result permission context contains unsupported fields.');
  }
  return context;
}

/** Local selection evidence, NOT a claim of usefulness or permission to transfer.
 * Reads exact current owners; all source bases and permission are fenced by the
 * same write batch. Private result prose is never copied into the observation.
 * The binding is explicit DATA, never inferred from another connector's consent.
 */
export async function observeSavedWorkResult(bindingInput: string | { permission_lease_ref: string }, store: AtomicOperationWorkStore, savedDelivery?: unknown, at?: string) {
  const leaseRef = typeof bindingInput === 'string' ? undefined : ref(bindingInput.permission_lease_ref);
  const bindingRef = typeof bindingInput === 'string' ? ref(bindingInput)
    : `learning:${makeHashCodeHexFromBytes(new TextEncoder().encode(leaseRef!))}`;
  const conditions: Parameters<AtomicOperationWorkStore['writeBatch']>[0]['preconditions'] = [];
  const read = async (address: string, addressMode: 'identity-text' | 'label-hash' = 'identity-text', expectedHash?: string) => {
    const record = await store.read(address, { addressMode });
    if (!record) throw new Error('Saved result evidence is missing.');
    if (expectedHash !== undefined && (!/^1f:[0-9a-f]{64}$/.test(expectedHash)
      || String(record.basis) !== String(makeMultihashEncodedBytesFromCodeHex(expectedHash)))) {
      throw new Error('Useful result evidence changed.');
    }
    conditions.push({ address, addressMode, expectedBasis: record.basis });
    return row(record.value);
  };
  let derivedBinding: Row | undefined;
  let priorBinding: Awaited<ReturnType<AtomicOperationWorkStore['read']>> = null;
  if (leaseRef) {
    const lease = await read(permissionAddress(leaseRef), 'label-hash');
    const context = activePermissionContext(lease, leaseRef, at);
    if (!(lease.allowed_operation_refs as unknown[]).includes('learn-local-useful-impact')
      || !context.useful_impact) {
      throw new Error('Permission to measure this result is missing or revoked.');
    }
    const workRef = ref(context.work_ref);
    const savedResult = await read(addresses.result(workRef));
    const surface = await read(ref(context.selection_surface_ref));
    const candidateId = ref(context.candidate_id);
    const candidateMaterialRef = ref(context.candidate_material_ref);
    if (!validateCandidateSet(surface).valid || surface.applicability_ref !== ref(context.applicability_ref)) {
      throw new Error('The saved result is not compatible with this choice.');
    }
    const candidates = (surface.candidates as Row[]).filter(candidate => candidate.candidate_id === candidateId
      && candidate.material_ref === candidateMaterialRef);
    if (candidates.length !== 1) throw new Error('The saved result does not identify one compatible choice.');
    derivedBinding = { kind: 'saved-work-result-learning-binding', binding_ref: bindingRef, state: 'active',
      work_ref: workRef, observer_id: ref(context.observer_id), candidate_id: candidateId,
      candidate_material_ref: candidateMaterialRef,
      installation_ref: ref(context.installation_ref), user_ref: ref(context.user_ref), permission_lease_ref: leaseRef,
      selection_surface_ref: ref(context.selection_surface_ref), applicability_ref: ref(context.applicability_ref),
      result_ref: ref(savedResult.result_ref), result_revision: savedResult.result_revision,
      result_basis: String(conditions[conditions.length - 2].expectedBasis),
      surface_basis: String(conditions[conditions.length - 1].expectedBasis),
      useful_impact: context.useful_impact };
    priorBinding = await store.read(bindingRef);
    if (priorBinding && !equal(priorBinding.value, derivedBinding)) {
      const previous = row(priorBinding.value);
      if (previous.permission_lease_ref !== leaseRef || previous.binding_ref !== bindingRef
        || previous.kind !== derivedBinding.kind || previous.work_ref !== derivedBinding.work_ref
        || previous.observer_id !== derivedBinding.observer_id || previous.installation_ref !== derivedBinding.installation_ref
        || previous.user_ref !== derivedBinding.user_ref || previous.state !== 'active'
        || previous.selection_surface_ref !== derivedBinding.selection_surface_ref
        || previous.applicability_ref !== derivedBinding.applicability_ref
        || previous.candidate_id !== derivedBinding.candidate_id
        || previous.candidate_material_ref !== derivedBinding.candidate_material_ref
        || previous.result_ref !== derivedBinding.result_ref
        || previous.surface_basis !== derivedBinding.surface_basis
        || (previous.result_revision === derivedBinding.result_revision && previous.result_basis !== derivedBinding.result_basis)
        || Number(previous.result_revision) > Number(derivedBinding.result_revision)
        || Number(row(previous.useful_impact).measurement_revision) >= Number(row(context.useful_impact).measurement_revision)) {
        throw new Error('Saved result learning conflicts with its existing binding.');
      }
    }
    conditions.push({ address: bindingRef, expectedBasis: priorBinding?.basis ?? null });
  }
  const binding = derivedBinding ?? await read(bindingRef);
  if (binding.kind !== 'saved-work-result-learning-binding' || binding.state !== 'active') {
    throw new Error('Saved result learning is not enabled.');
  }
  const workRef = ref(binding.work_ref), observerId = ref(binding.observer_id);
  const candidateId = ref(binding.candidate_id), installation = ref(binding.installation_ref);
  const candidateMaterialRef = ref(binding.candidate_material_ref), user = ref(binding.user_ref);
  const permissionLeaseRef = ref(binding.permission_lease_ref);
  const grant = await read(permissionAddress(permissionLeaseRef), 'label-hash');
  const permissionContext = activePermissionContext(grant, permissionLeaseRef, at);
  if (grant.subject_ref !== user || permissionContext.installation_ref !== installation
    || permissionContext.user_ref !== user || permissionContext.work_ref !== workRef
    || permissionContext.observer_id !== observerId || permissionContext.candidate_id !== candidateId
    || permissionContext.selection_surface_ref !== binding.selection_surface_ref
    || permissionContext.applicability_ref !== binding.applicability_ref
    || permissionContext.candidate_material_ref !== candidateMaterialRef
    || !equal(permissionContext.useful_impact, binding.useful_impact)) {
    throw new Error('Permission to learn from this saved result is missing or revoked.');
  }
  const fact = await read(addresses.fact(workRef));
  const conversation = ref(fact.conversation_ref);
  const progress = await read(addresses.progress(workRef));
  const result = await read(addresses.result(workRef));
  if (fact.schema !== 'operation-records.work-fact/owner-scoped'
    || progress.schema !== 'operation-records.work-progress/owner-scoped'
    || result.kind !== 'operation-records.work-result/owner-scoped'
    || [fact, progress, result].some(value => value.work_ref !== workRef)
    || !Number.isSafeInteger(fact.revision) || Number(fact.revision) < 0
    || !Number.isSafeInteger(progress.revision) || Number(progress.revision) < 0
    || progress.state !== 'completed' || progress.owner_revision !== fact.revision
    || result.owner_revision !== fact.revision || result.conversation_ref !== conversation
    || progress.completed_result !== result.result
    || result.result_projection_ref !== `background-work-result:${workRef}`) {
    throw new Error('The saved result is not current completed work.');
  }
  const resultRef = ref(result.result_ref), eventRef = ref(progress.completed_event_ref);
  const revision = result.result_revision;
  const evidence = result.outcome_evidence_refs;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0
    || !Array.isArray(evidence) || evidence.length === 0 || evidence.length > 64
    || new Set(evidence.map(ref)).size !== evidence.length) throw new Error('Saved result references are invalid.');
  const receipt = await read(addresses.receipt(eventRef));
  const derivative = await read(addresses.derivative(resultRef));
  if (receipt.schema !== 'operation-records.work-continuation-receipt/owner-scoped'
    || receipt.state !== 'completed' || receipt.work_ref !== workRef || receipt.event_ref !== eventRef
    || receipt.owner_revision !== fact.revision || receipt.progress_revision !== progress.revision
    || receipt.result_projection_ref !== result.result_projection_ref
    || receipt.completed_result_ref !== resultRef || receipt.completed_result_revision !== revision
    || !equal(receipt.outcome_evidence_refs, evidence)
    || derivative.derivative_ref !== resultRef || derivative.work_ref !== workRef
    || derivative.source_revision !== fact.revision || derivative.result_revision !== revision
    || !equal(derivative.outcome_evidence_refs, evidence)
    || typeof derivative.result !== 'string' || !derivative.result.trim()
    || derivative.result !== result.result) throw new Error('The saved result revision could not be verified.');
  let metric = 'saved_result_revision', metricValue = Number(revision);
  let impactEvidence: Row | undefined;
  if (savedDelivery !== undefined && binding.useful_impact === undefined) {
    throw new Error('Permission to measure this result is missing.');
  }
  if (binding.useful_impact !== undefined) {
    const impact = row(binding.useful_impact);
    if (Object.keys(impact).some(key => !['measurement_revision', 'attribution_window_ms', 'event_refs', 'delivery_ref',
      'tenant_ref', 'recipient_ref', 'provider_ref', 'job_ref', 'job_revision', 'run_ref', 'result_ref',
      'result_revision', 'saved_result_revision'].includes(key))) throw new Error('Useful result measurement contains unsupported fields.');
    if (!(grant.allowed_operation_refs as unknown[]).includes('learn-local-useful-impact')
      || !equal(permissionContext.useful_impact, impact)) throw new Error('Permission to measure this result is missing or revoked.');
    if (!Number.isSafeInteger(impact.measurement_revision) || Number(impact.measurement_revision) < 0
      || !Number.isSafeInteger(impact.attribution_window_ms) || Number(impact.attribution_window_ms) <= 0
      || !Array.isArray(impact.event_refs) || impact.event_refs.length < 4 || impact.event_refs.length > 64) {
      throw new Error('Useful result measurement is invalid.');
    }
    // Hash-bound owner records, not caller-supplied useful flags or private prose.
    const readExact = async (value: unknown) => {
      const descriptor = row(value);
      if (Object.keys(descriptor).some(key => !['address', 'content_hash', 'address_mode'].includes(key))
        || typeof descriptor.address !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:%-]{0,2047}$/.test(descriptor.address)
        || typeof descriptor.content_hash !== 'string'
        || (descriptor.address_mode !== undefined && !['identity-text', 'label-hash'].includes(String(descriptor.address_mode)))) {
        throw new Error('Useful result references are invalid.');
      }
      return read(descriptor.address, descriptor.address_mode as 'identity-text' | 'label-hash' | undefined, descriptor.content_hash);
    };
    const deliveryRef = row(impact.delivery_ref);
    const delivery = await readExact(deliveryRef);
    if (delivery.kind !== 'content-generation.run' || delivery.status !== 'completed' || delivery.verified !== true
      || typeof delivery.id !== 'string' || deliveryRef.address !== `content-generation.run::${delivery.id}`
      || delivery.original_request_ref !== `content-generation.dispatch-request::${delivery.id}`
      || delivery.successor_ref !== `content-generation.dispatch-request::continuation::${delivery.id}`
      || !Array.isArray(delivery.execution_evidence_refs) || delivery.execution_evidence_refs.length !== 3
      || !Array.isArray(delivery.result_refs) || !delivery.result_refs.length || delivery.result_refs.length > 16) {
      throw new Error('Delivery alone has not verified this result.');
    }
    for (const basis of [...delivery.execution_evidence_refs, ...delivery.result_refs]) await readExact(basis);
    if (savedDelivery !== undefined && !equal(savedDelivery, {
      result_ref: deliveryRef.address, result_content_hash: deliveryRef.content_hash,
      input_refs: delivery.result_refs.map(value => ({ canonical_address: row(value).address, expected_content_hash: row(value).content_hash })),
    })) throw new Error('The delivered result does not match this learning permission.');
    const keys = ['tenant_ref', 'recipient_ref', 'provider_ref', 'job_ref', 'job_revision', 'run_ref', 'result_revision'] as const;
    for (const key of keys) ref(impact[key]);
    if (impact.result_ref !== resultRef || impact.saved_result_revision !== revision || impact.run_ref !== delivery.id) {
      throw new Error('Useful evidence belongs to another saved result.');
    }
    const events: CustomerLoopEvent[] = [];
    const seen = new Set<string>();
    for (const descriptor of impact.event_refs) {
      const event = await readExact(descriptor);
      const eventId = ref(event.event_ref);
      if (seen.has(eventId)) throw new Error('Useful result evidence contains duplicate events.');
      seen.add(eventId);
      if (!['content', 'result', 'run', 'outcome', 'repeat', 'share'].includes(String(event.kind))
        || !Number.isSafeInteger(event.occurred_at_ms) || Number(event.occurred_at_ms) < 0
        || event.result_ref !== resultRef || keys.some(key => event[key] !== impact[key])
        || (event.kind === 'content' && !ref(event.attribution_ref))
        || (event.kind === 'outcome' && typeof event.useful !== 'boolean')) {
        throw new Error('Useful result evidence does not match this work.');
      }
      events.push(event as unknown as CustomerLoopEvent);
    }
    // A bounded single attempt removes ambiguous first-outcome/anchor ordering.
    for (const kind of ['content', 'result', 'run', 'outcome']) {
      if (events.filter(event => event.kind === kind).length !== 1) throw new Error('Useful result evidence is ambiguous.');
    }
    const measurement = measureCustomerLoop(events, Number(impact.attribution_window_ms));
    if (!measurement.joined || measurement.attribution_status !== 'attributed') throw new Error('Useful result evidence is incomplete or too late.');
    metric = 'useful_result_count'; metricValue = measurement.useful_result_count;
    impactEvidence = { measurement_revision: impact.measurement_revision, delivery_ref: deliveryRef,
      event_refs: impact.event_refs, metric, value: metricValue };
  }
  const built = buildObservationRecord({ observerId, trustRef: 'trust:derived',
    at,
    path: ['candidate', 'outcome', metric, candidateId], value: metricValue,
    basis: `${eventRef}:${revision}${impactEvidence ? `:${impactEvidence.measurement_revision}` : ''}` });
  const value = { ...built.record, evidence: { work_ref: workRef, result_ref: resultRef,
    result_revision: revision, owner_revision: fact.revision, outcome_evidence_refs: evidence,
    installation_ref: installation, binding_ref: bindingRef, ...(impactEvidence ? { useful_impact: impactEvidence } : {}) } };
  // Later callers use this same action: choices are computed from freshly read
  // owners, not from a previously saved observation after its grant was revoked.
  let choice: { candidate_id: string; material_ref: string } | undefined;
  let selectionContext: Row | undefined;
  if (binding.selection_surface_ref !== undefined) {
    const surface = await read(ref(binding.selection_surface_ref));
    const decider = await read(ref(surface.decider_program_ref));
    if (!validateCandidateSet(surface).valid || !validateDecider(decider).valid
      || surface.applicability_ref !== binding.applicability_ref
      || typeof binding.applicability_ref !== 'string'
      || !(surface.candidates as Row[]).some(candidate => candidate.candidate_id === candidateId
        && candidate.material_ref === candidateMaterialRef)) {
      throw new Error('The saved result is not compatible with this choice.');
    }
    const winner = selectWinner(surface as unknown as SelectionSurface, [value],
      decider as unknown as DeciderProgram, `${observerId}:${surface.address}`);
    if (winner) choice = { candidate_id: ref(winner.candidate_id), material_ref: ref(winner.material_ref) };
    selectionContext = { surface_ref: binding.selection_surface_ref, applicability_ref: binding.applicability_ref,
      candidate_id: candidateId, material_ref: candidateMaterialRef, choice,
      surface_basis: String(conditions[conditions.length - 2].expectedBasis),
      decider_basis: String(conditions[conditions.length - 1].expectedBasis) };
  }
  Object.assign(value.evidence, { selection_context: selectionContext });
  const prior = await store.read(built.address);
  if (prior) value.at = String(row(prior.value).at);
  const replay = Boolean(prior && equal(prior.value, value));
  if (prior && !replay) {
    const old = row(prior.value), oldEvidence = row(old.evidence);
    const oldSelection = oldEvidence.binding_ref === bindingRef ? undefined
      : row(oldEvidence.selection_context, 'Prior selection evidence is missing.');
    const sameSelectionTarget = oldSelection !== undefined && selectionContext !== undefined
      && oldSelection.surface_ref === selectionContext.surface_ref
      && oldSelection.applicability_ref === selectionContext.applicability_ref
      && oldSelection.candidate_id === selectionContext.candidate_id
      && oldSelection.material_ref === selectionContext.material_ref;
    if ((oldEvidence.binding_ref !== bindingRef && (!impactEvidence || !sameSelectionTarget))
      || oldEvidence.work_ref !== workRef || oldEvidence.installation_ref !== installation
      || Number(oldEvidence.owner_revision) > Number(fact.revision)
      || Number(oldEvidence.result_revision) > Number(revision)
      || (impactEvidence ? Number(row(oldEvidence.useful_impact).measurement_revision) >= Number(impactEvidence.measurement_revision)
        : Number(oldEvidence.result_revision) === Number(revision))) throw new Error('Saved result learning conflicts with prior evidence.');
    value.at = built.record.at;
  }
  conditions.push({ address: built.address, expectedBasis: prior?.basis ?? null });
  try {
    if (!replay && !await store.writeBatch({ preconditions: conditions, writes: [
      ...(derivedBinding ? [{ address: bindingRef, value: derivedBinding,
        pathLabels: ['current-item', 'published-record', 'saved-work-result-learning-binding'] }] : []),
      { address: built.address, value, pathLabels: ['current-item', 'published-record', 'observation'] }] })) throw new Error('Learning was not saved.');
  } catch {
    // A prior matching observation alone cannot prove this invocation retained
    // permission. Recheck every foreign basis before accepting a lost response.
    for (const condition of conditions.filter(item => item.address !== built.address && !(derivedBinding && item.address === bindingRef))) {
      const current = await store.read(condition.address, { addressMode: condition.addressMode });
      if (!current || String(current.basis) !== String(condition.expectedBasis)) {
        throw new Error('Permission or saved result evidence changed during learning.');
      }
    }
  }
  const saved = await store.read(built.address);
  if (!saved || !equal(saved.value, value)) throw new Error('Saved result learning changed before it could be saved.');
  if (derivedBinding && !equal((await store.read(bindingRef))?.value, derivedBinding)) throw new Error('Saved result learning binding changed.');
  for (const condition of conditions.filter(item => item.address !== built.address && !(derivedBinding && item.address === bindingRef))) {
    const current = await store.read(condition.address, { addressMode: condition.addressMode });
    if (!current || String(current.basis) !== String(condition.expectedBasis)) {
      throw new Error('Permission or saved result evidence changed during learning.');
    }
  }
  return { state: 'observed', replay, binding_ref: bindingRef, result_ref: resultRef, result_revision: revision,
    measurement: { metric, value: metricValue }, ...(choice ? { choice } : {}) };
}
