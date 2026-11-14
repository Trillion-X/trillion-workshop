// packages/agents-hub/do-work/agent-record-writes.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE ONE mutation path for agent configuration from the hub: a durable
// engine write-batch of the full ai-agent-profile record at its addressed
// home. Create, edit, rename, model change, tool change, instruction reorder,
// and archive are all configurations of this single write — the record IS the
// state, the array order IS the instruction order (SSOT:
// ai-agent-profile.instruction_refs).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Writes the COMPLETE record every time — no partial patches, no merge code
// 2. Address label = the record's own id (e.g. "ai-agent-profile:writer") so
//    each agent record has one stable addressed home
// 3. Zero imports from other feature packages
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { AgentProfileRecord } from '@/packages/agents-hub/read-data/resolve-agent-cards';

/** The path that places a record in the shared published-records feed. */
// Writes name NO partition, and go through the label-addressed request rather than the
// binary frame builder, because only the label-addressed path lets a caller omit one.
// The engine then resolves the partition to the one the request arrived on, which is the
// store of the app actually serving the caller (engine-operation-target reads the field
// with `optional_string_field` and falls back to `default_partition`, proved by
// `label_handler_uses_the_envelope_partition_when_request_omits_partition_label`).
//
// This surface previously named a partition taken from its generated scope binding, which
// carries the package set's build-time label. Inside any app other than the one the set was
// built for, that wrote agent records into a different app's store.
//
// The binary builder (`buildEngineWriteBatchRequestFromLabels`) cannot express "the app I am
// running in": `partitionBytes()` demands exactly one of partitionLabel or
// partitionMultihashCodeHex and throws when both are absent.
const ENGINE_LABEL_TARGET = 'engine.operation.label-addressed';
const WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

/** One label-addressed write entry, partition deliberately absent. */
function writeBatchRequest(writes: readonly Record<string, unknown>[]): unknown {
  return { target: ENGINE_LABEL_TARGET, payload: { operation_label: WRITE_BATCH_OPERATION, writes } };
}

const PUBLISHED_RECORD_PATH: readonly string[] = ['current-item', 'published-record'];

export type EngineRequestSender = (request: unknown) => Promise<unknown>;

function selectedInstructionRefs(profile: AgentProfileRecord): string[] | null {
  const selection = profile.instruction_selection;
  if (!selection) return null;
  if (selection.kind !== 'ai-agent-profile.instruction-selection/v1' || !Array.isArray(selection.candidates)) {
    throw new Error('This profile’s managed instruction selection is invalid and was not saved.');
  }
  const included: string[] = [];
  for (const candidate of selection.candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('This profile’s managed instruction selection is invalid and was not saved.');
    }
    const row = candidate as Record<string, unknown>;
    if (row.disposition !== 'include' && row.disposition !== 'exclude') {
      throw new Error('This profile’s managed instruction selection is invalid and was not saved.');
    }
    if (typeof row.instruction_ref !== 'string' || !row.instruction_ref.trim()) {
      throw new Error('This profile’s managed instruction selection is invalid and was not saved.');
    }
    if (row.disposition === 'include') included.push(row.instruction_ref);
  }
  return included;
}

function assertSelectionMatchesMembership(profile: AgentProfileRecord): void {
  const included = selectedInstructionRefs(profile);
  if (included !== null && JSON.stringify(included) !== JSON.stringify(profile.instruction_refs)) {
    throw new Error('This profile’s managed instruction set changed without updated selection proof and was not saved.');
  }
}

function profilePayload(profile: AgentProfileRecord): Record<string, unknown> {
  assertSelectionMatchesMembership(profile);
  return {
    kind: 'ai-agent-profile',
    id: profile.id,
    ...(profile.label ? { label: profile.label } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.status ? { status: profile.status } : {}),
    model_refs: profile.model_refs,
    tool_refs: profile.tool_refs,
    instruction_refs: profile.instruction_refs,
    ...(profile.instruction_selection ? { instruction_selection: profile.instruction_selection } : {}),
    memory_refs: profile.memory_refs,
    ...(profile.guard_ref ? { guard_ref: profile.guard_ref } : {}),
    ...(profile.process_launch ? { process_launch: profile.process_launch } : {}),
  };
}

/** Feed addresses arrive as encoded fact-address hex ("1f20" + 64 hex).
 *  Re-hashing one through addressLabel writes a DIFFERENT address — the
 *  "edits don't stick" failure class. Route encoded forms verbatim. */
function isEncodedFactAddress(value: string): boolean {
  return /^1f20[0-9a-f]{64}$/i.test(value);
}

function addressFieldsFor(profile: AgentProfileRecord): Record<string, string> {
  const address = profile.source_address ?? profile.id;
  return isEncodedFactAddress(address)
    ? { address_multihash_hex: address }
    : { address_label: address };
}

/** Atomic batch write of full agent records — one engine request, N agents. */
export async function writeAgentProfiles(
  profiles: readonly AgentProfileRecord[],
  send: EngineRequestSender = sendRequestToBitfieldTarget as EngineRequestSender,
): Promise<void> {
  if (profiles.length === 0) return;
  console.log(`[agents-hub] writing ${profiles.length} agent record(s):`, profiles.map((profile) => profile.id).join(','));
  const request = writeBatchRequest(
    profiles.map((profile) => ({
      ...addressFieldsFor(profile),
      path_labels: PUBLISHED_RECORD_PATH,
      payload: profilePayload(profile),
    })),
  );
  await send(request);
}

/** One building block to tombstone: the address it lives at and its current
 *  payload (so the tombstone keeps the record's kind/id and just flips status). */
export interface PublishedRecordDelete {
  sourceAddress: string;
  payload: Record<string, unknown>;
}

function deleteAddressFields(address: string): Record<string, string> {
  return isEncodedFactAddress(address)
    ? { address_multihash_hex: address }
    : { address_label: address };
}

/** Permanent delete for any published building block (model, tool, instruction,
 *  memory, permission limit). Writes the full record back to its own address
 *  with status 'deleted' — the readers drop status:'deleted', so it vanishes
 *  from every view. One generic path; the kind is carried by the payload, never
 *  branched on here (L069). */
export async function softDeletePublishedRecords(
  records: readonly PublishedRecordDelete[],
  send: EngineRequestSender = sendRequestToBitfieldTarget as EngineRequestSender,
): Promise<void> {
  const deletable = records.filter((record) => record.sourceAddress.trim().length > 0);
  if (deletable.length === 0) return;
  console.log(`[agents-hub] deleting ${deletable.length} record(s):`, deletable.map((record) => text(record.payload.id) ?? record.sourceAddress).join(','));
  const request = writeBatchRequest(
    deletable.map((record) => ({
      ...deleteAddressFields(record.sourceAddress),
      path_labels: PUBLISHED_RECORD_PATH,
      payload: { ...record.payload, status: 'deleted' },
    })),
  );
  await send(request);
}

/** Hide a building block that has no writable source record (a run transcript,
 *  a live memory fact). Writes a durable `agents-hub-hidden-entity` marker the
 *  readers filter out — the underlying transcript/fact is never destroyed
 *  (honest delete: "removed from the hub", not "erased from disk"). */
export async function writeHiddenEntity(
  entityId: string,
  send: EngineRequestSender = sendRequestToBitfieldTarget as EngineRequestSender,
): Promise<void> {
  if (!entityId.trim()) return;
  const addressLabel = `agents-hub-hidden:${entityId}`;
  const request = writeBatchRequest([{
    address_label: addressLabel,
    path_labels: PUBLISHED_RECORD_PATH,
    payload: { kind: 'agents-hub-hidden-entity', id: addressLabel, entity_id: entityId, status: 'active' },
  }]);
  await send(request);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Archive = the same full-record write with status flipped — never a delete. */
export function archivedCopy(profile: AgentProfileRecord): AgentProfileRecord {
  return { ...profile, status: 'archived' };
}

/** Restore an archived agent back to available. */
export function restoredCopy(profile: AgentProfileRecord): AgentProfileRecord {
  return { ...profile, status: 'available' };
}

/** A new blank agent record with a caller-supplied unique id. */
export function blankAgentProfile(id: string): AgentProfileRecord {
  return {
    id,
    model_refs: [],
    tool_refs: [],
    instruction_refs: [],
    memory_refs: [],
  };
}
