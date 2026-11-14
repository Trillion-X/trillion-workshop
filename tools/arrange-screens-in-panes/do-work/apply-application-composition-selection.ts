import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import {
  canonicalJson,
  decodeApplicationContributionOwnerDescriptors,
  decodeApplicationCompositionSelection,
  planApplicationCompositionTransition,
  type ApplicationContributionOwnerDescriptor,
  type ApplicationCompositionTransitionOperation,
} from '../read-data/application-composition';
import { insideTargetReplyEnvelope } from '../read-data/target-reply-envelope';

type Plain = Record<string, unknown>;
type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;

const RECEIPT_ADDRESS = 'screen-arrangement-application-selection-receipt';
const RECEIPT_SCHEMA = 'bitfield.application-composition-selection/forward-progress-receipt';
const RECEIPT_KIND = 'application-composition-selection-receipt';
const EMPTY_RECEIPT_KIND = 'application-composition-selection-receipt-empty';

function plain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function hash(value: unknown): string {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(value as never)));
}

/// ⛔ `addressIdentity` LIVED HERE AND IS GONE WITH THE REGISTRY THAT NEEDED IT. It turned a label
/// into the identity the ENGINE gave a record, so an owned-address manifest could be searched for
/// it. Nothing computes a label's address any more, because nothing looks a ref up in a manifest.
///
/// Its history is kept because the defect it carried is the one worth remembering: it was written
/// as `hash(label)`, and `hash` canonicalises first, so `canonicalJson('scene')` hashed `"scene"`
/// WITH the quotes while the engine had addressed the record as `FactAddress::hash_from("scene")`,
/// blake3 over the raw five bytes. Two characters, and the ownership test could never be satisfied
/// for any address under any marker. A check that fails closed on EVERYTHING does not read as a bug
/// in the check; it reads as "this app's own records are not owned by its own package set", which
/// sent reader after reader into admission, marker lifetime and DATA.
///
/// `owned-address-identity.test.ts` still pins the distinction against the runtime's own published
/// constant, because `hash()` remains and is still right for the objects it serves.
function payloadObject(value: unknown): Plain | null {
  // ⛔ THE SENDER RETURNS AN ENVELOPE, NOT THE BYTES. `sendRequestToBitfieldTarget` is typed
  // `Promise<BitfieldTargetReply>` and `BitfieldTargetReply` is `{ payload: Uint8Array }`, so an
  // engine reply arrives WRAPPED. Without this unwrap the checks below see a plain object, hand it
  // straight back, and every `found`/`content_hash` field read comes up undefined.
  //
  // That is not a hypothetical: it is why the composition apply failed for this whole package with
  // `current readback is invalid for <address>` while the SAME operation at the SAME address over
  // HTTP returned `{found, payload, content_hash}` every time. The engine was answering correctly
  // and this decoder was discarding the answer, which reads as a broken engine and is a broken
  // consumer. The sibling `ask-screen-arrangement.ts` has always unwrapped it; this one never did.
  const inner = insideTargetReplyEnvelope(value);
  const bytes = inner instanceof Uint8Array
    ? inner
    : ArrayBuffer.isView(inner) && inner.BYTES_PER_ELEMENT === 1
      ? new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength)
      : null;
  if (!bytes) return plain(inner) ? inner : null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    return plain(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

async function readCurrent(address: string, send: Sender): Promise<Plain> {
  const read = async (addressMode?: 'identity_text') => {
    const value = await send({
      target: 'engine.operation.label-addressed',
      payload: {
        operation_label: 'engine.operation.read-current',
        address_label: address,
        ...(addressMode ? { address_mode: addressMode } : {}),
      },
    });
    const decoded = payloadObject(value);
    if (!decoded || typeof decoded.found !== 'boolean') throw new Error(`current readback is invalid for ${address}`);
    return { ...decoded, read_address_mode: addressMode ?? 'label_hash' };
  };
  const labelAddressed = await read();
  return labelAddressed.found ? labelAddressed : read('identity_text');
}

async function readCurrentAt(
  address: string,
  addressMode: 'label_hash' | 'identity_text',
  send: Sender,
): Promise<Plain> {
  const value = await send({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.read-current',
      address_label: address,
      address_mode: addressMode,
    },
  });
  const decoded = payloadObject(value);
  if (!decoded || typeof decoded.found !== 'boolean') throw new Error(`current readback is invalid for ${address}`);
  return decoded;
}

function currentHash(value: Plain, path: string): string {
  return text(value.content_hash ?? value.contentHash, path);
}

function batchExpectedCurrent(payloadHash: string | null) {
  if (payloadHash === null) return { payload_hash_base64: null };
  let binary = '';
  for (const byte of makeMultihashEncodedBytesFromCodeHex(payloadHash)) binary += String.fromCharCode(byte);
  return { payload_hash_base64: btoa(binary) };
}

function operationIdentity(operation: ApplicationCompositionTransitionOperation): string {
  return hash(operation);
}

function isExactFailedTransitionRefresh(
  prior: Plain,
  selectionRef: string,
  transition: { ordered_operations: ApplicationCompositionTransitionOperation[] },
): boolean {
  if (prior.selection_receipt_ref !== selectionRef) return false;
  const currentIdentities = transition.ordered_operations.map(operationIdentity);
  if (Array.isArray(prior.planned_operation_identities)) {
    return prior.planned_operation_identities.every((identity) => typeof identity === 'string')
      && prior.planned_operation_identities.length === currentIdentities.length
      && prior.planned_operation_identities.every((identity, index) => identity === currentIdentities[index]);
  }
  if (!Array.isArray(prior.completed_operations)) return false;
  const failed = payloadObject(prior.failed_operation);
  if (!failed || typeof failed.operation_identity !== 'string') return false;
  const priorIdentities = prior.completed_operations.map((operation) => {
    const value = payloadObject(operation);
    return value && typeof value.operation_identity === 'string' ? value.operation_identity : null;
  });
  if (priorIdentities.some((identity) => identity === null)) return false;
  priorIdentities.push(failed.operation_identity);
  return priorIdentities.length === currentIdentities.length
    && priorIdentities.every((identity, index) => identity === currentIdentities[index]);
}

function canSupersedeFailedFullStateUpserts(
  prior: Plain,
  previousComposition: Plain | undefined,
): boolean {
  if (previousComposition !== undefined) return false;
  if (!Array.isArray(prior.planned_operation_identities)
    || !prior.planned_operation_identities.every((identity) => typeof identity === 'string')) return false;
  if (!Array.isArray(prior.completed_operations)) return false;
  const completed = prior.completed_operations.map((operation) => payloadObject(operation));
  if (completed.some((operation) => !operation || operation.phase !== 'upsert'
    || typeof operation.operation_identity !== 'string')) return false;
  const failed = payloadObject(prior.failed_operation);
  if (!failed || failed.phase !== 'upsert' || typeof failed.operation_identity !== 'string') return false;
  const attemptedIdentities = [
    ...completed.map((operation) => operation!.operation_identity),
    failed.operation_identity,
  ];
  if (attemptedIdentities.length > prior.planned_operation_identities.length) return false;
  return attemptedIdentities.every(
    (identity, index) => identity === prior.planned_operation_identities[index],
  );
}

function receiptEnvelope(receipt: Plain, current: Plain): Plain {
  return {
    kind: 'package-target-write-envelope',
    response: receipt,
    writes: [{
      record_address: RECEIPT_ADDRESS,
      path_labels: ['current-item', 'published-record'],
      payload: receipt,
      expected_current: current.found
        ? { state: 'present', payload_hash: currentHash(current, 'selection receipt current hash') }
        : { state: 'absent' },
    }],
  };
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value;
}

function objectArray(value: unknown, path: string): Plain[] {
  if (!Array.isArray(value) || !value.every(plain)) throw new Error(`${path} must be an array`);
  return value;
}

/// ⛔ DELETED 2026-09-11, AND THE DELETION IS THE POINT. Everything between here and
/// `readBoundPayload` was the registry path: a wire-hex to code-hex multihash reader, a list of
/// ways a package set states which addresses it owns, a resolver over that list, and a paged scan
/// to feed it. About 160 lines, all correct, all answering the wrong question.
///
/// The question they answered was MEMBERSHIP: was this address in a set at some moment. The
/// question that needed answering was IDENTITY: are the bytes behind this ref the bytes this
/// selection was admitted against. Membership is simultaneously too weak, because a record
/// rewritten after admission still belongs to the set, and too strong, because the record stating
/// membership is retracted at install by `migrate_aggregate_marker_to_package_current_versions`,
/// so on a customer's machine nothing could pass and the first screen could never be built.
///
/// Three real defects were found and fixed INSIDE that path before it was deleted: a label hashed
/// through `canonicalJson` so it carried two quote bytes the engine never hashed, a multihash
/// length read as one byte when it is a varint, and an ownership list that named only a record
/// whose lifetime ends at install. Each fix was correct and none of them mattered, because the
/// structure they were repairing should not have existed. That is the lesson worth more than the
/// lines: a defect found deep inside a mechanism is evidence about the MECHANISM, and three in one
/// file is the mechanism telling you it is the wrong shape.
///
/// Read one selected ref and return the exact current identity used by both the selection identity
/// and the atomic materialization precondition. The caller never copies derived hashes into DATA.
async function readSelectionReference(
  address: string,
  boundAddressModes: Readonly<Record<string, 'label_hash' | 'identity_text'>>,
  send: Sender,
): Promise<{ payload: Plain; content_hash: string }> {
  const addressMode = boundAddressModes[address];
  if (addressMode === undefined) throw new Error(`selection ref is not bound to an address mode: ${address}`);
  const current = await readCurrentAt(address, addressMode, send);
  if (!current.found) throw new Error(`selection ref is absent: ${address}`);
  const payload = payloadObject(current.payload);
  if (!payload) throw new Error(`selection ref payload is not a JSON object: ${address}`);
  const contentHash = currentHash(current, `current hash for ${address}`);
  return { payload, content_hash: contentHash };
}

async function loadAdmittedSelection(selectionRef: string, send: Sender) {
  const selectionCurrent = await readCurrent(selectionRef, send);
  if (!selectionCurrent.found) throw new Error('selection_receipt_ref is absent');
  const selection = payloadObject(selectionCurrent.payload);
  if (!selection) throw new Error('selection_receipt_ref is not an admitted application selection');
  const admittedSelection = decodeApplicationCompositionSelection(selection);
  const packageSet = admittedSelection.package_set;
  const partition = admittedSelection.partition;
  const activationMarkerRef = admittedSelection.activation_marker_ref;
  const boundAddressModes = admittedSelection.ref_address_modes;
  const previousRef = admittedSelection.previous_composition_ref;
  const nextRef = admittedSelection.next_composition_ref;
  const projectorRef = admittedSelection.projector_template_ref;
  const previousDescriptorRefs = admittedSelection.previous_owner_descriptor_refs;
  const nextDescriptorRefs = admittedSelection.next_owner_descriptor_refs;
  const selectionPolicyRef = admittedSelection.selection_policy_ref ?? null;
  const previous = previousRef ? await readSelectionReference(previousRef, boundAddressModes, send) : null;
  const next = await readSelectionReference(nextRef, boundAddressModes, send);
  const projector = await readSelectionReference(projectorRef, boundAddressModes, send);
  const selectionPolicy = selectionPolicyRef
    ? await readSelectionReference(selectionPolicyRef, boundAddressModes, send)
    : null;
  const previousDescriptors = await Promise.all(previousDescriptorRefs.map((ref) => readSelectionReference(ref, boundAddressModes, send)));
  const nextDescriptors = await Promise.all(nextDescriptorRefs.map((ref) => readSelectionReference(ref, boundAddressModes, send)));
  const projectorTemplate = plain(projector.payload.projector_template)
    ? projector.payload.projector_template
    : projector.payload;
  const sourceIdentity = {
    selection_ref: selectionRef,
    selection_hash: currentHash(selectionCurrent, 'selection receipt current hash'),
    activation_marker_ref: activationMarkerRef,
    // Every ref's verified identity, which is what the receipt was always trying to say. It used
    // to also carry the ownership record's own hash, so the receipt described the REGISTRY that
    // admitted the refs rather than the refs. That reading changed with install lifetime while
    // the refs did not, which made two identical applications look different.
    previous: previous ? { ref: previousRef, hash: previous.content_hash } : null,
    next: { ref: nextRef, hash: next.content_hash },
    projector: { ref: projectorRef, hash: projector.content_hash },
    ...(selectionPolicy ? { selection_policy: { ref: selectionPolicyRef, hash: selectionPolicy.content_hash } } : {}),
    previous_descriptors: previousDescriptorRefs.map((ref, index) => ({ ref, hash: previousDescriptors[index].content_hash })),
    next_descriptors: nextDescriptorRefs.map((ref, index) => ({ ref, hash: nextDescriptors[index].content_hash })),
  };
  const currentRefHashes = new Map<string, string>([
    ...(previous && previousRef ? [[previousRef, previous.content_hash] as const] : []),
    [nextRef, next.content_hash],
    [projectorRef, projector.content_hash],
    ...(selectionPolicy && selectionPolicyRef ? [[selectionPolicyRef, selectionPolicy.content_hash] as const] : []),
    ...previousDescriptorRefs.map((ref, index) => [ref, previousDescriptors[index].content_hash] as const),
    ...nextDescriptorRefs.map((ref, index) => [ref, nextDescriptors[index].content_hash] as const),
  ]);
  return {
    selection_identity: `admitted-selection:${hash(sourceIdentity)}`,
    selection_digest: hash(sourceIdentity),
    selection_ref: selectionRef,
    materialization_preconditions: [
      { address_label: selectionRef, address_mode: selectionCurrent.read_address_mode,
        expected_current: batchExpectedCurrent(sourceIdentity.selection_hash) },
      ...[...new Set([
        ...(previousRef ? [previousRef] : []), nextRef, projectorRef,
        ...(selectionPolicyRef ? [selectionPolicyRef] : []),
        ...previousDescriptorRefs, ...nextDescriptorRefs,
      ])].map((address_label) => ({
        address_label, address_mode: boundAddressModes[address_label],
        expected_current: batchExpectedCurrent(text(currentRefHashes.get(address_label), `current hash for ${address_label}`)),
      })),
    ],
    previous_composition: previous?.payload,
    next_composition: next.payload,
    projector_template: projectorTemplate,
    previous_owner_descriptors: previousDescriptors.map((value) => value.payload),
    next_owner_descriptors: nextDescriptors.map((value) => value.payload),
  };
}

function selectionRefFromInput(input: unknown): string {
  if (!plain(input)) throw new Error('application composition selection input must be an object');
  for (const forbidden of [
    'selection_identity',
    'previous_composition',
    'next_composition',
    'projector_template',
    'previous_owner_descriptors',
    'next_owner_descriptors',
  ]) {
    if (Object.hasOwn(input, forbidden)) throw new Error(`caller-supplied authority field is forbidden: ${forbidden}`);
  }
  return text(input.selection_receipt_ref, 'selection_receipt_ref');
}

/**
 * Derive the compiler-owned records that the public workflow must materialize before the
 * application step verifies them. The target itself remains read-only: it returns ordinary
 * workflow write items, and the workflow owner performs the write.
 *
 * Matching current records are omitted. This makes retry/restart a real no-op instead of
 * appending another copy of bytes that have already been acknowledged.
 */
export async function planApplicationCompositionSelectionMaterialization(
  input: unknown,
  send: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const selectionRef = selectionRefFromInput(input);
  const selected = await loadAdmittedSelection(selectionRef, send);
  const previous = decodeApplicationContributionOwnerDescriptors(selected.previous_owner_descriptors);
  const next = decodeApplicationContributionOwnerDescriptors(selected.next_owner_descriptors);
  const transition = planApplicationCompositionTransition(
    selected.previous_composition ?? undefined,
    selected.next_composition,
    selected.projector_template,
    previous,
    next,
  );
  // A transition delta alone cannot repair a record that should be unchanged but is absent after
  // an interrupted first materialization. Compile the complete selected screen as the upsert set,
  // while retaining only the real previous-to-next retractions. This is the recovery invariant:
  // current desired state, not historical delta intent, decides which records must exist.
  const selectedScreen = planApplicationCompositionTransition(
    undefined,
    selected.next_composition,
    selected.projector_template,
    [],
    next,
  );
  const localOperations: Array<ApplicationCompositionTransitionOperation & { kind: 'local-thing' }> = [
    ...transition.ordered_operations.filter(
      (operation): operation is ApplicationCompositionTransitionOperation & { kind: 'local-thing' } => (
        operation.kind === 'local-thing' && operation.phase === 'retract'
      ),
    ),
    ...selectedScreen.ordered_operations.filter(
      (operation): operation is ApplicationCompositionTransitionOperation & { kind: 'local-thing' } => (
        operation.kind === 'local-thing' && operation.phase === 'upsert'
      ),
    ),
  ];
  const items: Plain[] = [];
  const writes: Plain[] = [];
  for (const operation of localOperations) {
    const thing = operation.thing;
    if (thing.type !== 'record') throw new Error('screen compiler returned an unsupported local item');
    const address = text(thing.address, 'screen compiler record address');
    const current = await readCurrentAt(address, thing.address_mode === 'identity_text' ? 'identity_text' : 'label_hash', send);
    if (operation.phase === 'retract') {
      if (current.found) {
        items.push(thing);
        writes.push({ address_label: address, address_mode: thing.address_mode === 'identity_text' ? 'identity_text' : 'label_hash',
          path_labels: thing.path, expected_current: batchExpectedCurrent(currentHash(current, `current hash for ${address}`)) });
      }
      continue;
    }
    if (thing.remove === true || !Object.hasOwn(thing, 'payload')) {
      throw new Error(`screen compiler returned an incomplete record for ${address}`);
    }
    const expectedHash = hash(thing.payload);
    if (!current.found || currentHash(current, `current hash for ${address}`) !== expectedHash) {
      items.push(thing);
      writes.push({ address_label: address, address_mode: thing.address_mode === 'identity_text' ? 'identity_text' : 'label_hash',
        path_labels: thing.path, payload: thing.payload,
        expected_current: current.found
          ? batchExpectedCurrent(currentHash(current, `current hash for ${address}`))
          : batchExpectedCurrent(null) });
    }
  }
  return {
    schema: 'bitfield.application-composition-selection/materialization-plan',
    selection_identity: selected.selection_identity,
    selection_receipt_ref: selected.selection_ref,
    selection_digest: selected.selection_digest,
    items,
    writes,
    preconditions: selected.materialization_preconditions,
  };
}

async function materializedLocalReadback(
  selectionIdentity: string,
  operation: ApplicationCompositionTransitionOperation & { kind: 'local-thing' },
  send: Sender,
): Promise<Plain> {
  const thing = operation.thing;
  if (thing.type !== 'record') throw new Error('compiler-materialized local thing is not a record');
  const address = text(thing.address, 'compiler-materialized local record address');
  const current = await readCurrentAt(address, thing.address_mode === 'identity_text' ? 'identity_text' : 'label_hash', send);
  if (operation.phase === 'retract') {
    if (current.found) throw new Error(`compiler-materialized local retraction remains present at ${address}`);
    return {
      schema: 'bitfield.application-composition-selection/local-materialized-readback',
      selection_identity: selectionIdentity,
      phase: operation.phase,
      address,
      outcome: 'absent',
      readback: [{ address, outcome: 'absent' }],
    };
  }
  if (thing.remove === true || !Object.hasOwn(thing, 'payload')) {
    throw new Error(`compiler-materialized local upsert has no payload at ${address}`);
  }
  const expectedHash = hash(thing.payload);
  if (!current.found || currentHash(current, `current hash for ${address}`) !== expectedHash) {
    throw new Error(`compiler-materialized local destination is absent or mismatched at ${address}`);
  }
  return {
    schema: 'bitfield.application-composition-selection/local-materialized-readback',
    selection_identity: selectionIdentity,
    phase: operation.phase,
    address,
    outcome: 'matched',
    content_hash: expectedHash,
    readback: [{ address, outcome: 'matched', content_hash: expectedHash }],
  };
}

async function receiptFor(
  selectionIdentity: string,
  operation: ApplicationCompositionTransitionOperation & { kind: 'owner-contribution' },
  descriptor: ApplicationContributionOwnerDescriptor,
  send: Sender,
): Plain {
  const request = { ...operation.contribution, selection_identity: selectionIdentity, phase: operation.phase };
  const prepared = payloadObject(
    await send({ target: descriptor.target_ref, payload: { ...request, intent: 'prepare' } }),
  );
  if (!prepared) throw new Error(`${descriptor.target_ref} preparation is invalid`);
  const address = text(prepared.record_address ?? prepared.address_label, `${descriptor.target_ref} prepared record address`);
  const allowed = descriptor.write_authority.exact_addresses.includes(address)
    || descriptor.write_authority.address_prefixes.some((prefix) => address.startsWith(prefix));
  if (!allowed) throw new Error(`${descriptor.target_ref} prepared address escapes owner authority`);
  const read = () => readCurrent(address, send);
  if (prepared.kind === 'package-target-compiler-materialized-readback') {
    const current = await read();
    if (!current.found) throw new Error(`${descriptor.target_ref} compiler-materialized destination is absent`);
    const actualHash = currentHash(current, `current hash for ${address}`);
    return { schema: 'bitfield.application-contribution-application/owner-receipt', selection_identity: selectionIdentity, contribution_id: operation.contribution.contribution_id, phase: operation.phase, expected_current: { state: 'present', payload_hash: actualHash }, outcome: 'already-applied', content_hash: actualHash };
  }
  if (prepared.kind !== 'package-target-prepared-write' || typeof prepared.policy !== 'string') throw new Error(`${descriptor.target_ref} preparation is not a direct write`);
  const retract = prepared.retract === true;
  if (!retract && !Object.hasOwn(prepared, 'payload')) throw new Error(`${descriptor.target_ref} prepared write has no payload`);
  const expectedHash = retract ? null : hash(prepared.payload);
  const current = await read();
  const expected_current = current.found ? { state: 'present', payload_hash: currentHash(current, 'current.content_hash') } : { state: 'absent' };
  if ((retract && !current.found) || (!retract && current.found && currentHash(current, `current hash for ${address}`) === expectedHash)) {
    return { schema: 'bitfield.application-contribution-application/owner-receipt', selection_identity: selectionIdentity, contribution_id: operation.contribution.contribution_id, phase: operation.phase, expected_current, outcome: 'already-applied' };
  }
  const replaceableSeedHash = !retract && plain(prepared.replace_if_current_payload)
    ? hash(prepared.replace_if_current_payload)
    : null;
  if (!retract && prepared.policy === 'seed-only' && current.found
    && currentHash(current, `current hash for ${address}`) !== replaceableSeedHash) {
    const preservedHash = currentHash(current, `current hash for ${address}`);
    return { schema: 'bitfield.application-contribution-application/owner-receipt', selection_identity: selectionIdentity, contribution_id: operation.contribution.contribution_id, phase: operation.phase, expected_current, outcome: 'preserved-existing', content_hash: preservedHash };
  }
  const accepted = payloadObject(
    await send({ target: descriptor.target_ref, payload: { ...request, intent: 'apply', prepared, expected_current } }),
  );
  if (!accepted || accepted.kind !== 'write-accepted-for-readback') throw new Error(`${descriptor.target_ref} claimed application before readback`);
  const readback = await read();
  if ((retract && readback.found) || (!retract && (!readback.found || currentHash(readback, `readback hash for ${address}`) !== expectedHash))) throw new Error(`${descriptor.target_ref} destination readback is stale or mismatched`);
  return { schema: 'bitfield.application-contribution-application/owner-receipt', selection_identity: selectionIdentity, contribution_id: operation.contribution.contribution_id, phase: operation.phase, expected_current, outcome: 'applied', ...(expectedHash ? { content_hash: expectedHash } : {}) };
}

export async function applyApplicationCompositionSelection(
  input: unknown,
  send: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const selectionRef = selectionRefFromInput(input);
  const selected = await loadAdmittedSelection(selectionRef, send);
  const selectionIdentity = selected.selection_identity;
  const previous = decodeApplicationContributionOwnerDescriptors(selected.previous_owner_descriptors);
  const next = decodeApplicationContributionOwnerDescriptors(selected.next_owner_descriptors);
  const byOwner = new Map([...previous, ...next].map((descriptor) => [descriptor.owner_ref, descriptor]));
  const transition = planApplicationCompositionTransition(
    selected.previous_composition ?? undefined,
    selected.next_composition,
    selected.projector_template,
    previous,
    next,
  );
  const selectionDigest = selected.selection_digest;
  const receiptCurrent = await readCurrent(RECEIPT_ADDRESS, send);
  const stored = receiptCurrent.found ? payloadObject(receiptCurrent.payload) : null;
  const prior = stored?.kind === RECEIPT_KIND && stored.schema === RECEIPT_SCHEMA ? stored : null;
  if (receiptCurrent.found && !prior && stored?.kind !== EMPTY_RECEIPT_KIND) {
    throw new Error('selection receipt destination contains an unrecognized payload');
  }
  if (
    prior
    && prior.outcome === 'forward-compensation-required'
    && prior.selection_digest !== selectionDigest
    && !isExactFailedTransitionRefresh(prior, selected.selection_ref, transition)
    && !canSupersedeFailedFullStateUpserts(prior, selected.previous_composition)
  ) {
    throw new Error('a different selection is blocked until forward compensation completes');
  }
  if (prior && prior.selection_identity === selectionIdentity && prior.selection_digest !== selectionDigest) {
    throw new Error('selection identity was reused with different transition bytes');
  }
  // Re-run every planned operation against its owning target. Owner application is
  // idempotent: preparation plus current readback returns already-applied when the
  // destination is current. This keeps foreign private destination addresses out
  // of Screen's durable receipt while still verifying every destination on resume.
  const completedOperations: Plain[] = [];
  const plannedOperationIdentities = transition.ordered_operations.map(operationIdentity);
  for (const operation of transition.ordered_operations) {
    const identity = operationIdentity(operation);
    try {
      let evidence: Plain;
      if (operation.kind === 'local-thing') {
        evidence = await materializedLocalReadback(selectionIdentity, operation, send);
      } else {
        const descriptor = byOwner.get(operation.contribution.owner_ref);
        if (!descriptor || descriptor.target_ref !== operation.target_ref) {
          throw new Error(`no matching owner descriptor for ${operation.contribution.owner_ref}`);
        }
        evidence = await receiptFor(selectionIdentity, operation, descriptor, send);
      }
      completedOperations.push({ operation_identity: identity, ...evidence });
    } catch {
      return receiptEnvelope({
        schema: RECEIPT_SCHEMA,
        kind: RECEIPT_KIND,
        selection_identity: selectionIdentity,
        selection_receipt_ref: selected.selection_ref,
        selection_digest: selectionDigest,
        outcome: 'forward-compensation-required',
        planned_operation_identities: plannedOperationIdentities,
        completed_operations: completedOperations,
        failed_operation: {
          operation_identity: identity,
          phase: operation.phase,
          kind: operation.kind,
          // The owner error can contain its private target or destination identity.
          // Keep that detail at the owner boundary instead of copying it into
          // Screen's durable record and public workflow result.
          error: 'This part of the screen could not be updated. Try again.',
        },
        forward_compensation: { strategy: 'resume-failed-operation', selection_identity: selectionIdentity },
      }, receiptCurrent);
    }
  }
  return receiptEnvelope({
    schema: RECEIPT_SCHEMA,
    kind: RECEIPT_KIND,
    selection_identity: selectionIdentity,
    selection_receipt_ref: selected.selection_ref,
    selection_digest: selectionDigest,
    outcome: 'complete',
    planned_operation_identities: plannedOperationIdentities,
    completed_operations: completedOperations,
  }, receiptCurrent);
}

export function applyApplicationCompositionSelectionTarget(input: unknown, _context?: unknown) {
  return applyApplicationCompositionSelection(input);
}

export function planApplicationCompositionSelectionMaterializationTarget(input: unknown, _context?: unknown) {
  return planApplicationCompositionSelectionMaterialization(input);
}
