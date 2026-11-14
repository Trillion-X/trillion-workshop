export type AnyRecord = Record<string, unknown>;

export interface RequestIntakeActionDescriptor {
  id: string;
  target?: string;
  operation?: string;
  definitionId?: string;
  definitionIds?: string[];
  definition_id?: string;
  definition_ids?: string[];
  input?: AnyRecord;
  copy?: Array<{ key: string; from?: string; value?: unknown }>;
}

export interface RequestIntakeActionContext {
  operationId: string;
  recordRef?: string;
  shapeRef?: string;
  descriptorId?: string;
  fieldValues?: AnyRecord;
  receiptRef?: string;
  receipt?: {
    ownerRef: string;
    title: string;
    summary?: string;
    processSessionRef?: string;
    observedAt?: string;
    raw?: unknown;
  };
  linkedReceiptRefs?: string[];
  answers?: AnyRecord;
  descriptors?: RequestIntakeActionDescriptor[];
}

export interface RequestIntakeTargetRequest {
  target: string;
  payload: AnyRecord;
}

export interface RequestIntakeReceiptLink {
  kind: 'generic.owner-receipt';
  ref: string;
  owner_ref: string;
  title: string;
  summary?: string;
  process_session_ref?: string;
  observed_at?: string;
  raw?: unknown;
}

export interface RequestIntakeActionResult {
  recordWrites: AnyRecord[];
  targetRequests: RequestIntakeTargetRequest[];
  afterCasTargetRequests?: RequestIntakeTargetRequest[];
  receiptLinks: RequestIntakeReceiptLink[];
  errors: Array<{ code: string; detail: string }>;
}

export interface SourceMessageCandidate {
  record_ref: string;
  source_ref: string;
  atom_ref: string;
  native_message_ref?: string | null;
  content_revision?: string | null;
  at?: string | null;
  text: string;
  origin_ref: string;
}

export interface SourceMessageDecision {
  disposition_ref: string;
  reason: string;
  create_task: boolean;
  owner_ref?: string;
  existing_task_ref?: string;
  acceptance_criteria?: string;
}

export interface SourceMessageOwner {
  owner_ref: string;
  active: boolean;
}

/** Pure admission decision. The caller must perform an atomic absent-current
 * write before sending targetRequests; this function never claims CAS itself. */
export function decideSourceMessageIntake(input: {
  candidate: SourceMessageCandidate;
  decision: SourceMessageDecision;
  owners: SourceMessageOwner[];
  existingRequest?: AnyRecord | null;
  sendToOwner: RequestIntakeActionDescriptor;
}): RequestIntakeActionResult {
  const { candidate, decision, owners, existingRequest, sendToOwner } = input;
  const errors: RequestIntakeActionResult['errors'] = [];
  if (candidate.origin_ref !== 'human-root-session' || !candidate.record_ref.startsWith('request:') ||
      !candidate.source_ref || !candidate.atom_ref || !candidate.text.trim()) {
    errors.push({ code: 'source_not_human_or_incomplete', detail: candidate.record_ref });
  }
  if (!decision.disposition_ref || !decision.reason.trim()) {
    errors.push({ code: 'decision_incomplete', detail: candidate.record_ref });
  }
  if (existingRequest) {
    if (existingRequest.record_ref !== candidate.record_ref ||
        existingRequest.source_ref !== candidate.source_ref ||
        existingRequest.native_message_ref !== (candidate.native_message_ref ?? null)) {
      errors.push({ code: 'source_identity_conflict', detail: candidate.record_ref });
    }
    return { recordWrites: [], targetRequests: [], receiptLinks: [], errors };
  }
  if (errors.length) return { recordWrites: [], targetRequests: [], receiptLinks: [], errors };
  const owner = owners.find((row) => row.owner_ref === decision.owner_ref && row.active);
  if (decision.create_task && !owner) {
    errors.push({ code: 'owner_not_resolved', detail: decision.owner_ref ?? candidate.record_ref });
    return {
      recordWrites: [{
        kind: 'request-intake.source-message-decision',
        record_ref: candidate.record_ref,
        source_ref: candidate.source_ref,
        native_message_ref: candidate.native_message_ref ?? null,
        atom_ref: candidate.atom_ref,
        disposition_ref: 'disposition:defer',
        reason: 'No active owner matches the decision.',
        owner_ref: null,
        task_ref: null,
      }],
      targetRequests: [], receiptLinks: [], errors,
    };
  }
  if (errors.length) return { recordWrites: [], targetRequests: [], receiptLinks: [], errors };

  // A task reference alone says nothing about its current execution thread.
  // Linking it here would CAS-admit the Request while dispatching no work; when
  // the named thread was replaced, the new message would silently disappear.
  if (decision.existing_task_ref) {
    errors.push({ code: 'current_task_executor_not_verified', detail: decision.existing_task_ref });
    return { recordWrites: [], targetRequests: [], receiptLinks: [], errors };
  }

  const taskRef = candidate.record_ref;
  const recordWrites: AnyRecord[] = [{
    kind: 'request-intake.source-message-decision',
    record_ref: candidate.record_ref,
    source_ref: candidate.source_ref,
    native_message_ref: candidate.native_message_ref ?? null,
    atom_ref: candidate.atom_ref,
    content_revision: candidate.content_revision ?? null,
    at: candidate.at ?? null,
    disposition_ref: decision.disposition_ref,
    reason: decision.reason,
    owner_ref: owner?.owner_ref ?? null,
    task_ref: decision.create_task ? taskRef : null,
  }];
  if (!decision.create_task) {
    return { recordWrites, targetRequests: [], receiptLinks: [], errors: [] };
  }
  const context: RequestIntakeActionContext = {
    operationId: candidate.record_ref,
    recordRef: taskRef,
    shapeRef: 'shape:thing-you-asked-for',
    fieldValues: {
      'field:what-you-asked-for': candidate.text,
      'field:when-you-asked': candidate.at ?? null,
      'field:where-you-said-it': candidate.atom_ref,
      'field:who-owns-it': owner!.owner_ref,
      'field:what-success-looks-like': decision.acceptance_criteria ?? 'The requested outcome is verified.',
    },
    answers: { proof_links: [candidate.atom_ref] },
  };
  return { recordWrites, targetRequests: [],
    afterCasTargetRequests: buildRequestIntakeActionRequests(sendToOwner, context),
    receiptLinks: [], errors: [] };
}

export function buildSourceMessageCasRequest(result: RequestIntakeActionResult): RequestIntakeTargetRequest | null {
  if (result.errors.length || result.recordWrites.length !== 1) return null;
  const record = result.recordWrites[0];
  if (typeof record.record_ref !== 'string' || !record.record_ref.startsWith('request:')) return null;
  return {
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes: [{
        address_label: record.record_ref,
        address_mode: 'identity_text',
        path_labels: ['current-item', 'request-intake-request'],
        payload: record,
        expected_current: { payload_hash_base64: null },
      }],
    },
  };
}

export function sourceMessageRequestsAfterCas(
  result: RequestIntakeActionResult,
  casReply: AnyRecord,
): RequestIntakeTargetRequest[] {
  return result.errors.length === 0 && casReply.write_count === 1
    ? result.afterCasTargetRequests ?? [] : [];
}

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readPath(context: RequestIntakeActionContext, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown;
  switch (parts.shift()) {
    case 'request':
      current = context;
      break;
    case 'answers':
      current = context.answers ?? {};
      break;
    case 'fields':
      current = context.fieldValues ?? {};
      break;
    default:
      return undefined;
  }
  for (const part of parts) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function descriptorInput(
  descriptor: RequestIntakeActionDescriptor,
  context: RequestIntakeActionContext,
): AnyRecord {
  const copied: AnyRecord = {};
  for (const entry of descriptor.copy ?? []) {
    const value = entry.from ? readPath(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return {
    ...(descriptor.input ?? {}),
    ...(context.answers ?? {}),
    ...copied,
    action_id: descriptor.id,
    record_ref: context.recordRef ?? null,
    shape_ref: context.shapeRef ?? null,
    field_values: context.fieldValues ?? {},
    linked_receipt_refs: context.linkedReceiptRefs ?? [],
    receipt_ref: context.receiptRef ?? null,
  };
}

export function buildRequestIntakeActionRequests(
  descriptor: RequestIntakeActionDescriptor,
  context: RequestIntakeActionContext,
): RequestIntakeTargetRequest[] {
  const input = descriptorInput(descriptor, context);
  const declaredDefinitionIds = descriptor.definitionIds ?? descriptor.definition_ids ?? [];
  const declaredDefinitionId = descriptor.definitionId ?? descriptor.definition_id;
  const definitionIds = declaredDefinitionIds.length > 0
    ? declaredDefinitionIds
    : declaredDefinitionId ? [declaredDefinitionId] : [];
  if (definitionIds.length > 0) {
    return definitionIds.map((definitionId) => ({
      target: descriptor.target ?? 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    }));
  }
  return [{
    target: descriptor.target ?? 'slot::workflow',
    payload: {
      operation: descriptor.operation ?? descriptor.id,
      action_id: descriptor.id,
      input,
    },
  }];
}

export function buildRequestIntakeActionRequest(
  descriptor: RequestIntakeActionDescriptor,
  context: RequestIntakeActionContext,
): RequestIntakeTargetRequest {
  return buildRequestIntakeActionRequests(descriptor, context)[0]!;
}

export function recordRequestIntakeOwnerReceipt(input: {
  receiptRef: string;
  ownerRef: string;
  title: string;
  summary?: string;
  processSessionRef?: string;
  observedAt?: string;
  raw?: unknown;
}): RequestIntakeReceiptLink {
  return {
    kind: 'generic.owner-receipt',
    ref: input.receiptRef,
    owner_ref: input.ownerRef,
    title: input.title,
    summary: input.summary,
    process_session_ref: input.processSessionRef,
    observed_at: input.observedAt,
    raw: input.raw,
  };
}

export function requestRequestIntakeChange(context: RequestIntakeActionContext): RequestIntakeActionResult {
  const descriptors = context.descriptors ?? [];
  const descriptor = descriptors.find((entry) => entry.id === context.descriptorId);
  const errors: RequestIntakeActionResult['errors'] = [];
  const targetRequests = descriptor ? buildRequestIntakeActionRequests(descriptor, context) : [];
  if (context.descriptorId && !descriptor) {
    errors.push({ code: 'descriptor_not_found', detail: context.descriptorId });
  }
  const recordWrites = [{
    kind: 'generic.record-instance-change',
    operation_id: context.operationId,
    record_ref: context.recordRef ?? null,
    shape_ref: context.shapeRef ?? null,
    field_values: context.fieldValues ?? {},
    linked_receipt_refs: stringList(context.linkedReceiptRefs),
    receipt_ref: context.receiptRef ?? null,
  }];
  const receiptLinks = context.receiptRef && context.receipt
    ? [recordRequestIntakeOwnerReceipt({
        receiptRef: context.receiptRef,
        ownerRef: context.receipt.ownerRef,
        title: context.receipt.title,
        summary: context.receipt.summary,
        processSessionRef: context.receipt.processSessionRef,
        observedAt: context.receipt.observedAt,
        raw: context.receipt.raw,
      })]
    : [];
  return {
    recordWrites,
    targetRequests,
    receiptLinks,
    errors,
  };
}
