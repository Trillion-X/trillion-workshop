import { readTrustedRuntimeClockMs, readTrustedRuntimePartition, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { buildEngineReadCurrentRequestFromLabels, buildEngineWriteBatchRequestFromLabels, decodeEngineReadCurrentReply, type EngineReadCurrentReply } from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

type Row = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value as Row).sort().filter((key) => (value as Row)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}` : JSON.stringify(value);
const address = (kind: string, ref: string) => `package::conversations::${kind}::${ref}`;
const conversationAddress = (ref: string) => address('addressed-exchange-conversation', ref);
const turnAddress = (ref: string) => address('addressed-exchange-turn', ref);
const correctionHandoffAddress = (ref: string) => address('background-work-correction-handoff', ref);
const pageAddress = (ref: string) => address('addressed-exchange-message-page', ref);
const participantIndexAddress = (subject: string, actor: string) => address('participant-conversations', `${encodeURIComponent(subject)}:${encodeURIComponent(actor)}`);
const readStateAddress = (conversation: string, actor: string) => address('participant-read-state', `${encodeURIComponent(conversation)}:${encodeURIComponent(actor)}`);
const pageSize = 64;
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const identityAddress = (label: string) => hex(makeMultihashEncodedBytesFromCodeHex(`1f:${hex(encoder.encode(label))}`));

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const payload = object(value)?.payload;
  if (payload === undefined) throw new Error('conversations:unreadable-owner-reply');
  return bytes(payload);
}
function reply(value: unknown): Row {
  const direct = object(value);
  if (direct && !('payload' in direct)) return direct;
  const parsed = object(JSON.parse(decoder.decode(bytes(value))));
  if (!parsed) throw new Error('conversations:invalid-owner-reply');
  return parsed;
}
function refs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((ref) => !text(ref)) || new Set(value).size !== value.length) throw new Error('conversations:invalid-references');
  return value as string[];
}
function row(value: EngineReadCurrentReply): Row | null {
  if (!value.found || value.payload === null) return null;
  const parsed = object(JSON.parse(decoder.decode(value.payload)));
  if (!parsed) throw new Error('conversations:invalid-canonical-record');
  return parsed;
}
function basis(value: EngineReadCurrentReply) {
  if (!value.found) return null;
  if (!value.payloadHash) throw new Error('conversations:missing-atomic-basis');
  return value.payloadHash;
}

/** Canonical exchanges use current session and participation owners on every request,
 * including idempotent replay. No transport connection or client actor string grants access. */
export async function exchangeTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const wrapper = object(input); const payload = object(wrapper?.payload);
  const actor = object(wrapper?.ambient_actor); const decision = object(wrapper?.access_decision);
  const revisions = object(decision?.revisions);
  if (!payload || !actor || !decision || !revisions || decision.decision !== 'allow'
    || !text(actor.actor_ref) || text(actor.actor_ref) !== text(decision.actor_ref)
    || !text(actor.session_ref) || text(actor.session_ref) !== text(decision.session_ref)
    || text(actor.session_revision) !== text(revisions.session_revision)
    || !text(payload.subject_ref) || text(payload.subject_ref) !== text(decision.subject_ref)) throw new Error('conversations:current-admission-required');
  const verified = reply(await sender({ target: 'access-rule.verify-decision', payload: {
    decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref,
    subject_ref: payload.subject_ref, action_ref: 'conversations.exchange', revisions,
  } }));
  const durable = object(verified.decision);
  if (verified.verified !== true || !durable || durable.decision !== 'allow'
    || durable.actor_ref !== actor.actor_ref || durable.session_ref !== actor.session_ref
    || durable.subject_ref !== payload.subject_ref
    || !Array.isArray(durable.authorized_action_refs) || !durable.authorized_action_refs.includes('conversations.exchange')) throw new Error('conversations:admission-denied');
  const admitted = { ambient_actor: actor, access_decision: durable };
  const subjectRef = text(payload.subject_ref); const actorRef = text(actor.actor_ref);
  const conversationRef = text(payload.conversation_ref);
  const operation = text(payload.operation);
  if (!conversationRef && operation !== 'list') throw new Error('conversations:conversation-required');
  if (['author_ref', 'actor_ref', 'partition', 'created_at', 'sequence'].some((key) => key in payload)) throw new Error('conversations:server-owned-field');
  const partition = readTrustedRuntimePartition(context);
  const current = async (label: string) => decodeEngineReadCurrentReply(bytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, label, { addressMode: 'identity-text' }))));
  let membershipPreconditions: Array<{ partitionLabel: string; addressLabel: string; expectedCurrent: { payloadHash: Uint8Array | null } }> = [];
  const membership = async (actors: string[]) => {
    const result = reply(await sender({ target: 'subject-participant.read-subject-participants', payload: {
      ...admitted, payload: { subject_ref: subjectRef, participations: actors.map((ref) => ({ participation_ref: `participant:${ref}` })) },
    } }));
    const rows = Array.isArray(result.rows) ? result.rows.map(object) : [];
    if (result.status !== 'accepted' || actors.some((ref) => !rows.some((entry) => entry?.actor_ref === ref
      && entry.subject_ref === subjectRef && entry.removed !== true))) throw new Error('conversations:current-membership-required');
    const conditions = Array.isArray(result.read_preconditions) ? result.read_preconditions.map(object) : [];
    membershipPreconditions = actors.map((ref) => {
      const matches = conditions.filter((condition) => condition?.participation_ref === `participant:${ref}`);
      const condition = matches[0];
      if (matches.length !== 1 || !condition || condition.partition_label !== partition || !text(condition.address_label)
        || !Array.isArray(condition.payload_hash) || !condition.payload_hash.length
        || condition.payload_hash.some((byte) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)) throw new Error('conversations:membership-changed');
      return { partitionLabel: partition, addressLabel: text(condition.address_label), expectedCurrent: { payloadHash: new Uint8Array(condition.payload_hash as number[]) } };
    });
  };
  await membership([actorRef]);
  if (operation === 'list') {
    const index = row(await current(participantIndexAddress(subjectRef, actorRef)));
    const entries = index ? refs(index.conversation_refs) : [];
    const conversations: Row[] = [];
    const headSnapshots: Array<{ ref: string; hash: Uint8Array | null }> = [];
    for (const ref of entries) {
      const snapshot = await current(conversationAddress(ref));
      const head = row(snapshot);
      if (!head || head.access_scope_ref !== subjectRef || head.consent_state_ref !== 'consent:granted'
        || !refs(head.participant_refs).includes(actorRef)) continue;
      const state = row(await current(readStateAddress(ref, actorRef)));
      conversations.push({ ...head, unread_count: Math.max(0, Number(head.next_sequence) - Number(state?.next_sequence ?? 0)) });
      headSnapshots.push({ ref, hash: basis(snapshot) });
    }
    // The list carries private previews. Releasing a previously read head after
    // its consent/participants changed leaks just as a stale message page does.
    for (const snapshot of headSnapshots) {
      const latest = await current(conversationAddress(snapshot.ref));
      if (!latest.found || !snapshot.hash || !latest.payloadHash
        || hex(snapshot.hash) !== hex(latest.payloadHash)) throw new Error('conversations:list-changed-during-read');
    }
    await membership([actorRef]);
    const verification = reply(await sender({ target: 'access-rule.verify-decision', payload: {
      decision_proof: decision.decision_proof, actor_ref: actorRef, session_ref: actor.session_ref,
      subject_ref: subjectRef, action_ref: 'conversations.exchange', revisions,
    } }));
    if (verification.verified !== true) throw new Error('conversations:admission-denied');
    return { status: 'accepted', conversations };
  }
  const before = await current(conversationAddress(conversationRef));
  const existing = row(before);
  if (existing && (existing.access_scope_ref !== subjectRef || !refs(existing.participant_refs).includes(actorRef))) throw new Error('conversations:conversation-access-denied');
  const authorizeRelease = async () => {
    const verification = reply(await sender({ target: 'access-rule.verify-decision', payload: {
      decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref,
      subject_ref: subjectRef, action_ref: 'conversations.exchange', revisions,
    } }));
    if (verification.verified !== true || object(verification.decision)?.decision !== 'allow') throw new Error('conversations:admission-denied');
    await membership([actorRef]);
    const head = row(await current(conversationAddress(conversationRef)));
    if (!head || head.access_scope_ref !== subjectRef || !refs(head.participant_refs).includes(actorRef)) throw new Error('conversations:conversation-access-denied');
    if (head.consent_state_ref !== 'consent:granted') throw new Error('conversations:consent-required');
    return head;
  };
  const now = new Date(readTrustedRuntimeClockMs(context)).toISOString();
  const write = (label: string, value: Row, previous: EngineReadCurrentReply) => ({
    partitionLabel: partition, addressMultihashHex: identityAddress(label),
    // Private exchanges are read through admission, never the global published-record feed.
    pathLabels: ['current-item', 'private-conversation-record'], payloadBytes: encoder.encode(JSON.stringify(value)), expectedCurrent: { payloadHash: basis(previous) },
  });
  if (operation === 'open') {
    const participants = refs(payload.participant_refs);
    if (!participants.includes(actorRef) || !participants.length || !text(payload.title)) throw new Error('conversations:invalid-open');
    await membership(participants);
    const specification = { subject_ref: subjectRef, participant_refs: [...participants].sort(), title: text(payload.title) };
    if (existing) {
      if (existing.open_fingerprint !== canonical(specification)) throw new Error('conversations:conflicting-open-replay');
      await authorizeRelease();
      if (existing.state_ref !== 'state:open') throw new Error('conversations:send-unavailable');
      return { status: 'accepted', replay: true, conversation: existing };
    }
    const value = { kind: 'conversations.addressed-exchange-conversation.v1', conversation_ref: conversationRef,
      access_scope_ref: subjectRef, participant_refs: specification.participant_refs, title: specification.title,
      way_refs: [], service_connection_refs: [], state_ref: 'state:open', consent_state_ref: 'consent:granted',
      created_at: now, updated_at: now, last_activity_at: now, last_message_preview: '', next_sequence: 0,
      open_fingerprint: canonical(specification) };
    const indexes = await Promise.all(participants.map(async (participant) => {
      const label = participantIndexAddress(subjectRef, participant);
      const previous = await current(label); const index = row(previous);
      const existingRefs = index ? refs(index.conversation_refs) : [];
      return write(label, { kind: 'conversations.participant-conversations.v1', subject_ref: subjectRef,
        participant_ref: participant, conversation_refs: [...new Set([...existingRefs, conversationRef])] }, previous);
    }));
    try { await sender(buildEngineWriteBatchRequestFromLabels([write(conversationAddress(conversationRef), value, before), ...indexes], membershipPreconditions)); } catch { /* atomic readback distinguishes a competing opener */ }
    const saved = row(await current(conversationAddress(conversationRef)));
    if (!saved || saved.open_fingerprint !== value.open_fingerprint) throw new Error('conversations:open-not-acknowledged');
    await authorizeRelease();
    return { status: 'accepted', replay: false, conversation: saved };
  }
  if (!existing) throw new Error('conversations:conversation-unavailable');
  if (existing.consent_state_ref !== 'consent:granted') throw new Error('conversations:consent-required');
  if (operation === 'acknowledge') {
    const nextSequence = payload.next_sequence;
    if (!Number.isSafeInteger(nextSequence) || Number(nextSequence) < 0 || Number(nextSequence) > Number(existing.next_sequence)) throw new Error('conversations:invalid-read-frontier');
    const label = readStateAddress(conversationRef, actorRef);
    const previous = await current(label); const state = row(previous);
    if (Number(state?.next_sequence ?? 0) >= Number(nextSequence)) {
      await authorizeRelease();
      return { status: 'accepted', replay: true, read_state: state };
    }
    await membership([actorRef]);
    const value = { kind: 'conversations.participant-read-state.v1', conversation_ref: conversationRef,
      participant_ref: actorRef, next_sequence: nextSequence, updated_at: now };
    try {
      await sender(buildEngineWriteBatchRequestFromLabels([write(label, value, previous)], [
        ...membershipPreconditions,
        { partitionLabel: partition, addressMultihashHex: identityAddress(conversationAddress(conversationRef)), expectedCurrent: { payloadHash: basis(before) } },
      ]));
    } catch { /* monotonic owner readback resolves reconnect and concurrent acknowledgements */ }
    const saved = row(await current(label));
    if (!saved || Number(saved.next_sequence) < Number(nextSequence)) throw new Error('conversations:read-frontier-not-acknowledged');
    await authorizeRelease();
    return { status: 'accepted', replay: false, read_state: saved };
  }
  if (operation === 'read') {
    const pageNumber = payload.page === undefined ? 0 : Number(payload.page);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 0) throw new Error('conversations:invalid-page');
    const pageRef = `message-page:${conversationRef}:${pageNumber}`;
    const page = row(await current(pageAddress(pageRef)));
    if (!page) {
      await authorizeRelease();
      return { status: 'accepted', conversation: existing, page: { message_refs: [] }, turns: [], next_page: null };
    }
    if (page.conversation_ref !== conversationRef) throw new Error('conversations:page-scope-mismatch');
    const turns = await Promise.all(refs(page.message_refs).map(async (ref) => {
      const turn = row(await current(turnAddress(ref)));
      if (!turn || turn.conversation_ref !== conversationRef) throw new Error('conversations:page-turn-unavailable');
      return turn;
    }));
    // Revocation during an owner read cannot release the fetched page.
    await authorizeRelease();
    return { status: 'accepted', conversation: existing, page, turns,
      next_page: (pageNumber + 1) * pageSize < Number(existing.next_sequence) ? pageNumber + 1 : null };
  }
  if (operation !== 'append' || existing.state_ref !== 'state:open') throw new Error('conversations:send-unavailable');
  const turnRef = text(payload.turn_ref); const content = text(payload.content);
  if (!turnRef || !content) throw new Error('conversations:invalid-turn');
  const correctionRequest = payload.correction_request === undefined ? null : object(payload.correction_request);
  if (payload.correction_request !== undefined && (!correctionRequest
    || Object.keys(correctionRequest).sort().join(',') !== 'expected_owner_revision,work_ref'
    || !text(correctionRequest.work_ref)
    || !Number.isSafeInteger(correctionRequest.expected_owner_revision)
    || Number(correctionRequest.expected_owner_revision) < 0)) {
    throw new Error('conversations:invalid-correction-request');
  }
  const specification = { conversation_ref: conversationRef, author_ref: actorRef, content,
    source_refs: refs(payload.source_refs ?? []), correlation_refs: refs(payload.correlation_refs ?? []),
    parent_turn_ref: text(payload.parent_turn_ref), role: text(payload.role) || 'human',
    ...(correctionRequest ? { correction_request: {
      work_ref: text(correctionRequest.work_ref),
      expected_owner_revision: Number(correctionRequest.expected_owner_revision),
    } } : {}) };
  const turnBefore = await current(turnAddress(turnRef)); const priorTurn = row(turnBefore);
  const fingerprint = canonical(specification);
  if (priorTurn) {
    if (priorTurn.request_fingerprint !== fingerprint) throw new Error('conversations:conflicting-turn-replay');
    if (correctionRequest) {
      const priorHandoff = row(await current(correctionHandoffAddress(turnRef)));
      if (!priorHandoff || priorHandoff.request_fingerprint !== fingerprint
        || priorHandoff.turn_ref !== turnRef || priorHandoff.conversation_ref !== conversationRef
        || priorHandoff.work_ref !== text(correctionRequest.work_ref)
        || priorHandoff.expected_owner_revision !== Number(correctionRequest.expected_owner_revision)) {
        throw new Error('conversations:correction-handoff-unavailable');
      }
    }
    await authorizeRelease();
    return { status: 'accepted', replay: true, turn: priorTurn,
      ...(correctionRequest ? { correction_handoff_ref: correctionHandoffAddress(turnRef) } : {}) };
  }
  if (specification.parent_turn_ref) {
    const parent = row(await current(turnAddress(specification.parent_turn_ref)));
    if (!parent || parent.conversation_ref !== conversationRef) throw new Error('conversations:parent-turn-unavailable');
  }
  if (specification.role !== 'human') throw new Error('conversations:server-owned-role');
  const sequence = Number(existing.next_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('conversations:invalid-canonical-frontier');
  const pageRef = `message-page:${conversationRef}:${Math.floor(sequence / pageSize)}`;
  const pageBefore = await current(pageAddress(pageRef)); const priorPage = row(pageBefore);
  if (priorPage && priorPage.conversation_ref !== conversationRef) throw new Error('conversations:page-scope-mismatch');
  const priorRefs = priorPage ? refs(priorPage.message_refs) : [];
  if (priorRefs.length !== sequence % pageSize) throw new Error('conversations:page-frontier-conflict');
  const turn = { kind: 'conversations.addressed-exchange-turn.v1', ...specification,
    turn_ref: turnRef, sequence, occurred_at: now, speaker_ref: actorRef, request_fingerprint: fingerprint };
  const handoffBefore = correctionRequest ? await current(correctionHandoffAddress(turnRef)) : null;
  if (handoffBefore && row(handoffBefore)) throw new Error('conversations:correction-handoff-conflict');
  const handoff = correctionRequest ? {
    kind: 'conversations.background-work-correction-handoff/v1',
    handoff_ref: turnRef,
    subject_ref: subjectRef,
    conversation_ref: conversationRef,
    turn_ref: turnRef,
    work_ref: text(correctionRequest.work_ref),
    expected_owner_revision: Number(correctionRequest.expected_owner_revision),
    turn: { kind: turn.kind, conversation_ref: conversationRef, turn_ref: turnRef, role: 'human', content },
    request_fingerprint: fingerprint,
  } : null;
  const page = { kind: 'conversations.addressed-exchange-message-page.v1', message_page_ref: pageRef,
    conversation_ref: conversationRef, message_refs: [...priorRefs, turnRef], next_cursor_ref: turnRef };
  const conversation = { ...existing, next_sequence: sequence + 1, message_page_ref: pageRef,
    last_message_preview: content, last_activity_at: now, updated_at: now };
  await membership([actorRef]);
  try { await sender(buildEngineWriteBatchRequestFromLabels([
    write(conversationAddress(conversationRef), conversation, before),
    write(turnAddress(turnRef), turn, turnBefore),
    write(pageAddress(pageRef), page, pageBefore),
    ...(handoff && handoffBefore ? [write(correctionHandoffAddress(turnRef), handoff, handoffBefore)] : []),
  ], membershipPreconditions)); } catch { /* exact immutable turn readback resolves lost acknowledgements */ }
  const saved = row(await current(turnAddress(turnRef)));
  if (!saved || saved.request_fingerprint !== fingerprint) throw new Error('conversations:append-not-acknowledged');
  if (handoff) {
    const savedHandoff = row(await current(correctionHandoffAddress(turnRef)));
    if (!savedHandoff || canonical(savedHandoff) !== canonical(handoff)) {
      throw new Error('conversations:correction-handoff-not-acknowledged');
    }
  }
  await authorizeRelease();
  return { status: 'accepted', replay: false, turn: saved,
    ...(handoff ? { correction_handoff_ref: correctionHandoffAddress(turnRef) } : {}) };
}
