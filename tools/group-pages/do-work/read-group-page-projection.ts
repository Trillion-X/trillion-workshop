import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;

const decoder = new TextDecoder();
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function decoded(value: unknown): JsonRecord {
  if (value instanceof Uint8Array) return decoded(JSON.parse(decoder.decode(value)));
  if (value instanceof ArrayBuffer) return decoded(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return decoded(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  const outer = record(value);
  if (!outer) throw new Error('owner target reply must be an object');
  if (outer.payload instanceof Uint8Array || outer.payload instanceof ArrayBuffer || ArrayBuffer.isView(outer.payload)) return decoded(outer.payload);
  return outer;
}

function projectionRow(value: unknown): JsonRecord | null {
  const row = record(value);
  const fields = record(row?.fields);
  if (!row || !fields) return null;
  return { ...fields, item_ref: row.item_ref, target_ref: row.target_ref, actor_ref: row.actor_ref, created_at: row.created_at };
}

export async function readGroupPageProjectionTarget(
  input: unknown,
  _context?: unknown,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const wrapped = record(input);
  const payload = record(wrapped?.payload);
  const actor = record(wrapped?.ambient_actor);
  const decision = record(wrapped?.access_decision);
  const revisions = record(decision?.revisions);
  if (!payload || Object.keys(payload).length !== 0 || !actor || !decision || !revisions
    || decision.decision !== 'allow'
    || text(decision.action_ref) !== 'group-page.read-projection'
    || text(actor.actor_ref) !== text(decision.actor_ref)
    || text(actor.session_ref) !== text(decision.session_ref)
    || text(actor.session_revision) !== text(revisions.session_revision)) {
    throw new Error('current server admission is required');
  }
  const verified = decoded(await sender({
    target: 'access-rule.verify-decision',
    payload: {
      decision_proof: decision.decision_proof,
      actor_ref: actor.actor_ref,
      session_ref: actor.session_ref,
      subject_ref: decision.subject_ref,
      action_ref: 'group-page.read-projection',
      revisions,
    },
  }));
  const durable = record(verified.decision);
  const durableRevisions = record(durable?.revisions);
  if (verified.verified !== true || !durable || !durableRevisions
    || text(durable.subject_ref) !== text(decision.subject_ref)
    || ['membership_revision', 'policy_revision', 'resource_revision', 'session_revision']
      .some((key) => !text(durableRevisions[key]))) {
    throw new Error('projection admission is not durable');
  }
  const rowsReply = decoded(await sender({
    target: 'item-record.read-space-items',
    payload: {
      payload: { scope_ref: durable.subject_ref, list_scope: true },
      ambient_actor: actor,
      access_decision: durable,
    },
  }));
  if (rowsReply.status !== 'accepted' || !Array.isArray(rowsReply.rows)) throw new Error('item owner readback is required');
  const rows = rowsReply.rows.map(projectionRow).filter((value): value is JsonRecord => Boolean(value));
  const scoped_group_pages = rows.filter((row) => row.kind === 'group-page' || row.kind === 'group');
  const scoped_subject_surfaces = rows
    .filter((row) => row.kind === 'placeable-surface')
    .map((row) => ({ address: text(row.item_ref), payload: row }));
  const scoped_group_page_items = rows.filter((row) => row.kind !== 'group-page' && row.kind !== 'group' && row.kind !== 'placeable-surface');
  return {
    admitted_scope: {
      action_ref: durable.action_ref,
      actor_ref: durable.actor_ref,
      decision_proof: durable.decision_proof,
      revisions: {
        membership_revision: durableRevisions.membership_revision,
        policy_revision: durableRevisions.policy_revision,
        resource_revision: durableRevisions.resource_revision,
        session_revision: durableRevisions.session_revision,
      },
      session_ref: durable.session_ref,
      subject_ref: durable.subject_ref,
    },
    scoped_group_pages,
    scoped_group_page_items,
    scoped_subject_surfaces,
  };
}

export const mount = readGroupPageProjectionTarget;
