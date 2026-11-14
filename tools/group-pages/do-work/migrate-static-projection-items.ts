import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;
type MigrationRow = {
  scope_ref: string;
  item_ref: string;
  target_ref: string;
  created_at: string;
  fields: JsonRecord;
  expected_revision: 0;
  idempotency_ref: string;
};

const decoder = new TextDecoder();
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : record(value)
    ? `{${Object.keys(record(value)!).sort().map((key) => `${JSON.stringify(key)}:${canonical(record(value)![key])}`).join(',')}}`
    : JSON.stringify(value);

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload === undefined) throw new Error('target reply did not include bytes');
  return replyBytes(payload);
}

function jsonReply(reply: unknown): JsonRecord {
  if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || ArrayBuffer.isView(reply)) {
    const parsed = record(JSON.parse(decoder.decode(replyBytes(reply))));
    if (!parsed) throw new Error('owner target reply must be an object');
    return parsed;
  }
  const outer = record(reply);
  if (!outer) throw new Error('owner target reply must be an object');
  if (outer.payload instanceof Uint8Array || outer.payload instanceof ArrayBuffer || ArrayBuffer.isView(outer.payload)) return jsonReply(outer.payload);
  return outer;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function currentBasis(value: EngineReadCurrentReply): string {
  if (!value.found || value.payload === null || !value.payloadHash) throw new Error('migration source is missing or lacks an atomic basis');
  return base64(value.payloadHash);
}

function sourceProjection(value: EngineReadCurrentReply): JsonRecord {
  if (!value.found || value.payload === null) throw new Error('migration source is missing');
  const parsed = record(JSON.parse(decoder.decode(value.payload)));
  if (!parsed) throw new Error('migration source projection is invalid');
  return parsed;
}

function migrationConstraint(decision: JsonRecord) {
  const constraints = record(decision.constraints);
  const migration = record(constraints?.static_projection_migration);
  const sourceAddress = text(migration?.source_address_label);
  const allowedScopes = Array.isArray(migration?.allowed_scope_refs) ? migration.allowed_scope_refs.map(text).filter(Boolean) : [];
  const child = record(migration?.child_admission);
  if (!sourceAddress || allowedScopes.length === 0 || new Set(allowedScopes).size !== allowedScopes.length
    || migration?.historical_created_at !== true || !child || !text(child.predicate_ref)
    || child.predicate_binding === undefined || !record(child.context)) {
    throw new Error('static projection migration constraint is incomplete');
  }
  return { sourceAddress, allowedScopes: new Set(allowedScopes), child };
}

function collectSurfaces(value: JsonRecord): JsonRecord[] {
  const output: JsonRecord[] = [value];
  const nested = record(value.surface_input)?.scoped_subject_surfaces;
  if (Array.isArray(nested)) {
    for (const entry of nested) {
      const payload = record(record(entry)?.payload);
      if (payload) output.push(...collectSurfaces(payload));
    }
  }
  return output;
}

export function protectedRowsFromStaticProjection(projection: JsonRecord, allowedScopes: ReadonlySet<string>, idempotencyRef: string): MigrationRow[] {
  const rows: MigrationRow[] = [];
  for (const surface of collectSurfaces(projection)) {
    const input = record(surface.surface_input);
    if (!input || !Array.isArray(input.scoped_group_page_items) || input.scoped_group_page_items.length === 0) continue;
    const pages = Array.isArray(input.scoped_group_pages) ? input.scoped_group_pages.map(record).filter((entry): entry is JsonRecord => Boolean(entry)) : [];
    if (pages.length !== 1) throw new Error('each protected static surface must name exactly one group scope');
    const scopeRef = text(pages[0].group_ref);
    if (!scopeRef || !allowedScopes.has(scopeRef)) throw new Error('protected static projection contains an unexpected scope');
    for (const value of input.scoped_group_page_items) {
      const row = record(value); const fields = record(row?.fields);
      const itemRef = text(row?.item_ref); const targetRef = text(row?.target_ref); const createdAt = text(row?.created_at);
      if (!row || !fields || !itemRef || !targetRef || !createdAt || targetRef !== scopeRef) throw new Error('protected static projection row identity is invalid');
      rows.push({
        scope_ref: scopeRef,
        item_ref: itemRef,
        target_ref: targetRef,
        created_at: createdAt,
        fields: clone(fields),
        expected_revision: 0,
        idempotency_ref: `static-projection:${idempotencyRef}:${encodeURIComponent(scopeRef)}:${encodeURIComponent(targetRef)}:${encodeURIComponent(itemRef)}`,
      });
    }
  }
  if (rows.length === 0) throw new Error('protected static projection source must be non-empty');
  const identities = new Set(rows.map((row) => canonical([row.scope_ref, row.target_ref, row.item_ref])));
  if (identities.size !== rows.length) throw new Error('protected static projection contains duplicate item identity');
  return rows.sort((left, right) => canonical([left.scope_ref, left.target_ref, left.item_ref]).localeCompare(canonical([right.scope_ref, right.target_ref, right.item_ref])));
}

export function projectionWithoutProtectedRows(projection: JsonRecord): JsonRecord {
  const clean = clone(projection);
  for (const surface of collectSurfaces(clean)) {
    const input = record(surface.surface_input);
    if (input) delete input.scoped_group_page_items;
  }
  return clean;
}

function census(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => ({
    scope_ref: text(row.scope_ref),
    item_ref: text(row.item_ref),
    target_ref: text(row.target_ref),
    created_at: text(row.created_at),
    fields: clone(record(row.fields) ?? {}),
  })).sort((left, right) => canonical([left.scope_ref, left.target_ref, left.item_ref]).localeCompare(canonical([right.scope_ref, right.target_ref, right.item_ref])));
}

function assertOwnerMutation(reply: JsonRecord, rows: MigrationRow[], replay: boolean) {
  if (reply.status !== 'accepted' || reply.conflict === true || !Array.isArray(reply.receipts) || reply.receipts.length !== rows.length) throw new Error('item owner mutation receipt is incomplete or conflicted');
  for (const row of rows) {
    const receipt = reply.receipts.map(record).find((entry) => text(entry?.idempotency_ref) === row.idempotency_ref);
    const owned = record(receipt?.row);
    if (!receipt || receipt.status !== 'accepted' || (replay && receipt.replay !== true)
      || text(receipt.item_ref) !== row.item_ref || text(receipt.target_ref) !== row.target_ref
      || !owned || text(owned.created_at) !== row.created_at || canonical(owned.fields) !== canonical(row.fields)) {
      throw new Error('item owner mutation receipt does not preserve source identity, time, and content');
    }
  }
}

function assertDestination(source: MigrationRow[], reply: JsonRecord, before: JsonRecord[]): JsonRecord[] {
  if (reply.status !== 'accepted' || !Array.isArray(reply.rows)) throw new Error('item owner destination readback is missing');
  const rows = reply.rows.map(record).filter((entry): entry is JsonRecord => Boolean(entry));
  const expected = census(source as unknown as JsonRecord[]);
  const selected = rows.filter((row) => source.some((item) => item.item_ref === text(row.item_ref) && item.target_ref === text(row.target_ref)));
  if (canonical(census(selected)) !== canonical(expected)) throw new Error('item owner destination census does not preserve source identity, time, and content');
  for (const prior of before) {
    if (!rows.some((row) => text(row.item_ref) === text(prior.item_ref) && text(row.target_ref) === text(prior.target_ref) && canonical(row) === canonical(prior))) throw new Error('migration changed an existing item index member');
  }
  return rows;
}

async function admittedChildDecision(scopeRef: string, durable: JsonRecord, actor: JsonRecord, child: JsonRecord, sourceBasis: string, sender: Sender) {
  const revisions = clone(record(durable.revisions) ?? {});
  revisions.resource_revision = sourceBasis;
  const requestKind = text(durable.kind).replace('access-decision', 'access-decision-request');
  const decision = jsonReply(await sender({
    target: 'access-rule.evaluate',
    payload: {
      kind: requestKind,
      correlation_id: `static-projection-migration:${scopeRef}:${sourceBasis}`,
      subject_ref: scopeRef,
      action_ref: 'item-record.record-space-items',
      authorized_action_refs: ['item-record.record-space-items', 'item-record.read-space-items'],
      constraints: { item_record_migration: { historical_created_at: true, source_basis: sourceBasis } },
      predicate_ref: child.predicate_ref,
      predicate_binding: child.predicate_binding,
      context: child.context,
      ambient_actor: actor,
      revisions,
    },
  }));
  if (decision.decision !== 'allow' || text(decision.subject_ref) !== scopeRef
    || text(decision.actor_ref) !== text(actor.actor_ref) || text(decision.session_ref) !== text(actor.session_ref)) {
    throw new Error('current child-scope migration decision is required');
  }
  return decision;
}

/** Reads, migrates, verifies, and returns only an exact-basis source replacement instruction. */
export async function migrateStaticProjectionItemsTarget(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget as Sender) {
  const wrapped = record(input); const payload = record(wrapped?.payload); const actor = record(wrapped?.ambient_actor); const decision = record(wrapped?.access_decision); const revisions = record(decision?.revisions);
  if (!payload || Object.keys(payload).sort().join(',') !== 'idempotency_ref,source_basis' || !text(payload.idempotency_ref) || !text(payload.source_basis)
    || !actor || !decision || !revisions || decision.decision !== 'allow'
    || text(decision.action_ref) !== 'group-page.migrate-static-projection-items'
    || text(actor.actor_ref) !== text(decision.actor_ref) || text(actor.session_ref) !== text(decision.session_ref)
    || text(actor.session_revision) !== text(revisions.session_revision)) throw new Error('current server migration admission is required');
  const verified = jsonReply(await sender({ target: 'access-rule.verify-decision', payload: { decision_proof: decision.decision_proof, actor_ref: actor.actor_ref, session_ref: actor.session_ref, subject_ref: decision.subject_ref, action_ref: 'group-page.migrate-static-projection-items', revisions } }));
  const durable = record(verified.decision);
  if (verified.verified !== true || !durable) throw new Error('current server migration admission is not durable');
  const constraint = migrationConstraint(durable); const partition = readTrustedRuntimePartition(context);
  const before = decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, constraint.sourceAddress))));
  const sourceBasis = currentBasis(before);
  if (sourceBasis !== text(payload.source_basis)) throw new Error('migration source basis changed before extraction');
  const projection = sourceProjection(before);
  const sourceRows = protectedRowsFromStaticProjection(projection, constraint.allowedScopes, text(payload.idempotency_ref));
  const grouped = new Map<string, MigrationRow[]>();
  for (const row of sourceRows) grouped.set(row.scope_ref, [...(grouped.get(row.scope_ref) ?? []), row]);
  const destinationRows: JsonRecord[] = [];
  const scopeReceipts: JsonRecord[] = [];
  for (const [scopeRef, rows] of grouped) {
    const childDecision = await admittedChildDecision(scopeRef, durable, actor, constraint.child, sourceBasis, sender);
    const ownerEnvelope = (ownerPayload: JsonRecord) => ({ payload: ownerPayload, ambient_actor: actor, access_decision: childDecision });
    const beforeScope = jsonReply(await sender({ target: 'item-record.read-space-items', payload: ownerEnvelope({ scope_ref: scopeRef, list_scope: true }) }));
    if (beforeScope.status !== 'accepted' || !Array.isArray(beforeScope.rows)) throw new Error('item owner pre-migration index readback is required');
    const prior = beforeScope.rows.map(record).filter((entry): entry is JsonRecord => Boolean(entry));
    const mutations = rows.map((row) => ({ item_ref: row.item_ref, target_ref: row.target_ref, expected_revision: row.expected_revision, idempotency_ref: row.idempotency_ref, requested_at: row.created_at, created_at: row.created_at, fields: row.fields }));
    const first = jsonReply(await sender({ target: 'item-record.record-space-items', payload: ownerEnvelope({ scope_ref: scopeRef, mutations }) }));
    assertOwnerMutation(first, rows, false);
    const after = jsonReply(await sender({ target: 'item-record.read-space-items', payload: ownerEnvelope({ scope_ref: scopeRef, list_scope: true }) }));
    destinationRows.push(...assertDestination(rows, after, prior));
    const replay = jsonReply(await sender({ target: 'item-record.record-space-items', payload: ownerEnvelope({ scope_ref: scopeRef, mutations }) }));
    assertOwnerMutation(replay, rows, true);
    const replayRead = jsonReply(await sender({ target: 'item-record.read-space-items', payload: ownerEnvelope({ scope_ref: scopeRef, list_scope: true }) }));
    assertDestination(rows, replayRead, prior);
    scopeReceipts.push({ scope_ref: scopeRef, first_receipts: first.receipts, replay_receipts: replay.receipts });
  }
  const finalSource = decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, constraint.sourceAddress))));
  if (currentBasis(finalSource) !== sourceBasis || canonical(sourceProjection(finalSource)) !== canonical(projection)) throw new Error('migration source basis changed before removal instruction');
  return {
    status: 'accepted',
    source_basis: sourceBasis,
    source_census: census(sourceRows as unknown as JsonRecord[]),
    destination_census: census(destinationRows.filter((row) => sourceRows.some((source) => source.item_ref === text(row.item_ref) && source.target_ref === text(row.target_ref)))),
    owner_receipts: scopeReceipts,
    replay_no_duplicate: true,
    destination_verified: true,
    removal: {
      source_address_label: constraint.sourceAddress,
      expected_payload_hash_base64: sourceBasis,
      replacement_projection: projectionWithoutProtectedRows(projection),
    },
  };
}

export const mount = migrateStaticProjectionItemsTarget;
