// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-work-actions.ts @ e99ac5976
import type { PublishedRecord } from '../../ui/show/placeable-surface-intent';
import { canonicalCapabilityRef, validatedSelector } from 'trillion-workshop/tools/ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

/** The only identity which can authorize a workflow definition. */
export interface CapabilityRef {
  canonicalAddress: string;
  canonicalRevision: string;
  payloadHash: string;
}

export interface ChatWorkflowAction {
  actionId: string;
  label: string;
  description: string | null;
  sourcePackage: string | null;
  recordId: string;
  inputSchema: unknown;
  ownerTargetRef: string;
  active: boolean;
  capabilityRef: CapabilityRef;
  resultSelector?: string;
  surfaceSelector?: string;
  cancellationCapabilityRef?: CapabilityRef;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function capability(_payload: Record<string, unknown>, row: Record<string, unknown>, _fallbackAddress: string): CapabilityRef | null {
  // A scoped feed is display data until its row carries the owner identity
  // triple.  Payload fields are owner content, not trustworthy identity
  // metadata: accepting them would make a stale or synthesized local row an
  // execution authority.
  const owner = record(row.record) ? row.record : null;
  if (!owner) return null;
  const canonicalAddress = string(owner.address);
  const canonicalRevision = string(owner.revision);
  const payloadHash = string(owner.content_hash);
  return canonicalAddress && canonicalRevision && payloadHash
    ? { canonicalAddress, canonicalRevision, payloadHash }
    : null;
}

function read(recordValue: PublishedRecord): ChatWorkflowAction | null {
  if (!record(recordValue.payload)) return null;
  const payload = recordValue.payload;
  const actionId = string(payload.id);
  const inputSchema = payload.input_schema ?? payload.inputSchema;
  const ref = capability(payload, recordValue.row, recordValue.recordId);
  if (!actionId || inputSchema === undefined || !Array.isArray(payload.steps ?? payload.workflow_steps) || !ref) return null;
  return {
    actionId,
    label: string(payload.name) ?? actionId,
    description: string(payload.description),
    sourcePackage: recordValue.sourcePackage ?? null,
    recordId: recordValue.recordId,
    inputSchema,
    ownerTargetRef: 'slot::workflow',
    active: payload.is_active !== false && payload.isActive !== false,
    capabilityRef: ref,
    ...(validatedSelector(payload.result_selector) ? { resultSelector: validatedSelector(payload.result_selector)! } : {}),
    ...(validatedSelector(payload.surface_selector) ? { surfaceSelector: validatedSelector(payload.surface_selector)! } : {}),
    ...(canonicalCapabilityRef(payload.cancellation_capability_ref) ? { cancellationCapabilityRef: canonicalCapabilityRef(payload.cancellation_capability_ref)! } : {}),
  };
}

/** Current owner rows only. Same action IDs deliberately remain distinct. */
export function findChatWorkflowActions(records: readonly PublishedRecord[]): ChatWorkflowAction[] {
  return records.flatMap((entry) => {
    const action = read(entry);
    return action?.active ? [action] : [];
  }).sort((a, b) => a.capabilityRef.canonicalAddress.localeCompare(b.capabilityRef.canonicalAddress));
}

export function sameCapabilityRef(left: CapabilityRef, right: CapabilityRef): boolean {
  return left.canonicalAddress === right.canonicalAddress
    && left.canonicalRevision === right.canonicalRevision
    && left.payloadHash === right.payloadHash;
}
