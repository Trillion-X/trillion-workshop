// PORTED FROM: bitfield-packages/packages/operation-records/read-data/operation-records.ts @ e99ac5976
// package-set://bitfield-studio/packages/operation-records/read-data/operation-records.ts

// Open lens ids: owner packages can add new operation views without changing this primitive.
export type OperationMode = string;

export type OperationPriority = string;

export type OperationPrivacyClass = string;

export interface OperationSourceRef {
  package: string;
  type: string;
  id: string;
}

export interface OperationDisplayAtoms {
  title: string;
  status: string;
  reason: string;
  detail: string[];
}

export interface OperationTransition {
  id: string;
  ownerPackage: string;
  actionDefinitionId: string;
  target?: string;
  label: string;
  input: Record<string, unknown>;
  targetStateDescriptor?: string;
  idempotencyKey?: string;
  sideEffectClass?: string;
  compensationActionRef?: string;
  irreversibleEffectNotice?: string;
  actorRef?: string;
  evidenceRefs?: string[];
  candidateFactRefs?: string[];
  expiresAt?: string;
  requiresClaim?: boolean;
  modeHints: OperationMode[];
}

export interface OperationRecord {
  id: string;
  ownerPackage: string;
  source: OperationSourceRef;
  kindDescriptor: string;
  stateDescriptor: string;
  priority: OperationPriority;
  priorityDescriptor: string;
  timeWindow?: {
    startsAt?: string;
    endsAt?: string;
    localDate?: string;
  };
  linkRefs: string[];
  dependencyRefs: string[];
  evidenceRefs: string[];
  candidateFactRefs: string[];
  operationClaimRefs?: string[];
  agentProfileRefs?: string[];
  instructionBlockRefs?: string[];
  memoryContextRefs?: string[];
  toolDescriptorRefs?: string[];
  actionGuardCheckRefs?: string[];
  budgetReservationRefs?: string[];
  executionHistoryRefs?: string[];
  relationshipEdgeRefs?: string[];
  trainingBatchRefs?: string[];
  credentialHandleRefs?: string[];
  providerHandleRefs?: string[];
  serviceConnectionHandleRefs?: string[];
  transitions: OperationTransition[];
  display: OperationDisplayAtoms;
  privacyClass: OperationPrivacyClass;
  modeHints: OperationMode[];
  sortKey: string;
  updatedAt?: string;
}

export interface OperationDescriptor {
  id: string;
  family: string;
  label: string;
  shortLabel: string;
  tone: string;
  primaryVerb?: string;
  sortRank: number;
  defaultModes: OperationMode[];
  privacyClass: OperationPrivacyClass;
  redactionStrategy?: OperationRedactionStrategy;
}

export interface OperationRedactionStrategy {
  id: string;
  replacement: string;
  tokenPattern?: string;
  redactAll: boolean;
}

export interface OperationClaim {
  id: string;
  operationRef: string;
  actorRef: string;
  claimToken: string;
  claimedAt?: string;
  expiresAt?: string;
  supersededBy?: string;
  status: string;
}

export interface OperationEvidence {
  id: string;
  sourceKind: string;
  sourceRef: string;
  contentAddressRef?: string;
  capturedAt?: string;
  capturedBy?: string;
  extractorRef?: string;
  payload?: Record<string, unknown>;
  sensitiveFieldRefs: string[];
  candidateFactRefs: string[];
}

export interface OperationCandidateFact {
  id: string;
  targetOwnerPackage: string;
  targetRecordRef: string;
  operationKind: string;
  proposedPatch: Record<string, unknown>;
  sourceEvidenceRefs: string[];
  confidence: number;
  reviewState: string;
  reviewReason: string;
  createdAt?: string;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function textList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function field(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return row[camel] ?? row[snake];
}

export function priority(value: unknown): OperationPriority {
  return text(value) || 'normal';
}

export function privacy(value: unknown): OperationPrivacyClass {
  return text(value) || 'public';
}

export function modes(value: unknown): OperationMode[] {
  const selected = Array.from(new Set(textList(value).map((entry) => entry.trim()).filter(Boolean)));
  return selected.length ? selected : ['next'];
}

export function makeDescriptor(id: string, family: string, label?: string): OperationDescriptor {
  const segments = id.split('.');
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : id;
  const readable = label || lastSegment.replace(/[-_]/g, ' ') || id;
  return {
    id,
    family,
    label: readable,
    shortLabel: readable,
    tone: 'neutral',
    sortRank: 500,
    defaultModes: ['next'],
    privacyClass: 'public',
    redactionStrategy: decodeRedactionStrategy(null),
  };
}

export function decodeRedactionStrategy(raw: unknown): OperationRedactionStrategy {
  const row = record(raw);
  const id = text(row.id) || 'redaction.none';
  return {
    id,
    replacement: text(row.replacement) || 'redacted',
    tokenPattern: text(row.tokenPattern ?? row.token_pattern) || undefined,
    redactAll: Boolean(row.redactAll ?? row.redact_all),
  };
}

export function decodeOperationDescriptor(raw: unknown): OperationDescriptor | null {
  const row = record(raw);
  const id = text(row.id);
  if (!id) return null;
  const label = text(row.label) || id;
  return {
    id,
    family: text(row.family) || text(row.descriptorFamily) || 'operation',
    label,
    shortLabel: text(row.shortLabel) || text(row.short_label) || label,
    tone: text(row.tone) || 'neutral',
    primaryVerb: text(row.primaryVerb) || text(row.primary_verb) || undefined,
    sortRank: numberOr(row.sortRank ?? row.sort_rank, 500),
    defaultModes: modes(row.defaultModes ?? row.default_modes),
    privacyClass: privacy(row.privacyClass ?? row.privacy_class),
    redactionStrategy: decodeRedactionStrategy(row.redactionStrategy ?? row.redaction_strategy),
  };
}

export function decodeOperationDescriptors(raw: unknown): OperationDescriptor[] {
  return list(raw).map(decodeOperationDescriptor).filter((entry): entry is OperationDescriptor => entry !== null);
}

export function descriptorIndex(descriptors: readonly OperationDescriptor[]): Map<string, OperationDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
}

export function resolveDescriptor(index: ReadonlyMap<string, OperationDescriptor>, id: string, family: string): OperationDescriptor {
  return index.get(id) ?? makeDescriptor(id, family);
}

export function decodeTransition(raw: unknown): OperationTransition | null {
  const row = record(raw);
  const id = text(row.id);
  const ownerPackage = text(row.ownerPackage ?? row.owner_package);
  const actionDefinitionId = text(row.actionDefinitionId ?? row.action_definition_id);
  if (!id || !ownerPackage || !actionDefinitionId) return null;
  return {
    id,
    ownerPackage,
    actionDefinitionId,
    target: text(row.target) || 'slot::workflow',
    label: text(row.label) || id,
    input: record(row.input),
    targetStateDescriptor: text(row.targetStateDescriptor ?? row.target_state_descriptor) || undefined,
    idempotencyKey: text(row.idempotencyKey ?? row.idempotency_key) || undefined,
    sideEffectClass: text(row.sideEffectClass ?? row.side_effect_class) || undefined,
    compensationActionRef: text(row.compensationActionRef ?? row.compensation_action_ref) || undefined,
    irreversibleEffectNotice: text(row.irreversibleEffectNotice ?? row.irreversible_effect_notice) || undefined,
    actorRef: text(row.actorRef ?? row.actor_ref) || undefined,
    evidenceRefs: textList(row.evidenceRefs ?? row.evidence_refs),
    candidateFactRefs: textList(row.candidateFactRefs ?? row.candidate_fact_refs),
    expiresAt: text(row.expiresAt ?? row.expires_at) || undefined,
    requiresClaim: Boolean(row.requiresClaim ?? row.requires_claim),
    modeHints: modes(row.modeHints ?? row.mode_hints),
  };
}

export function decodeOperationRecord(raw: unknown): OperationRecord | null {
  const row = record(raw);
  const id = text(row.id);
  const ownerPackage = text(row.ownerPackage ?? row.owner_package);
  const source = record(row.source);
  const sourceId = text(source.id);
  if (!id || !ownerPackage || !sourceId) return null;
  const display = record(row.display);
  const timeWindow = record(row.timeWindow ?? row.time_window);
  const startsAt = text(timeWindow.startsAt ?? timeWindow.starts_at);
  const endsAt = text(timeWindow.endsAt ?? timeWindow.ends_at);
  const localDate = text(timeWindow.localDate ?? timeWindow.local_date);
  return {
    id,
    ownerPackage,
    source: {
      package: text(source.package) || ownerPackage,
      type: text(source.type),
      id: sourceId,
    },
    kindDescriptor: text(row.kindDescriptor ?? row.kind_descriptor) || 'operation.kind.unknown',
    stateDescriptor: text(row.stateDescriptor ?? row.state_descriptor) || 'operation.state.unknown',
    priority: priority(row.priority),
    priorityDescriptor: text(row.priorityDescriptor ?? row.priority_descriptor) || 'operation.priority.normal',
    ...(startsAt || endsAt || localDate ? { timeWindow: { ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}), ...(localDate ? { localDate } : {}) } } : {}),
    linkRefs: textList(row.linkRefs ?? row.link_refs),
    dependencyRefs: textList(row.dependencyRefs ?? row.dependency_refs),
    evidenceRefs: textList(row.evidenceRefs ?? row.evidence_refs),
    candidateFactRefs: textList(row.candidateFactRefs ?? row.candidate_fact_refs),
    operationClaimRefs: textList(row.operationClaimRefs ?? row.operation_claim_refs),
    agentProfileRefs: textList(row.agentProfileRefs ?? row.agent_profile_refs),
    instructionBlockRefs: textList(row.instructionBlockRefs ?? row.instruction_block_refs),
    memoryContextRefs: textList(row.memoryContextRefs ?? row.memory_context_refs),
    toolDescriptorRefs: textList(row.toolDescriptorRefs ?? row.tool_descriptor_refs),
    actionGuardCheckRefs: textList(row.actionGuardCheckRefs ?? row.action_guard_check_refs),
    budgetReservationRefs: textList(row.budgetReservationRefs ?? row.budget_reservation_refs),
    executionHistoryRefs: textList(row.executionHistoryRefs ?? row.execution_history_refs),
    relationshipEdgeRefs: textList(row.relationshipEdgeRefs ?? row.relationship_edge_refs),
    trainingBatchRefs: textList(row.trainingBatchRefs ?? row.training_batch_refs),
    credentialHandleRefs: textList(row.credentialHandleRefs ?? row.credential_handle_refs),
    providerHandleRefs: textList(row.providerHandleRefs ?? row.provider_handle_refs),
    serviceConnectionHandleRefs: textList(row.serviceConnectionHandleRefs ?? row.service_connection_handle_refs),
    transitions: list(row.transitions).map(decodeTransition).filter((entry): entry is OperationTransition => entry !== null),
    display: {
      title: text(display.title) || id,
      status: text(display.status) || 'Needs review',
      reason: text(display.reason),
      detail: textList(display.detail),
    },
    privacyClass: privacy(row.privacyClass ?? row.privacy_class),
    modeHints: modes(row.modeHints ?? row.mode_hints),
    sortKey: text(row.sortKey ?? row.sort_key) || id,
    updatedAt: text(row.updatedAt ?? row.updated_at) || undefined,
  };
}

export function decodeOperationRecords(raw: unknown): OperationRecord[] {
  return list(raw).map(decodeOperationRecord).filter((entry): entry is OperationRecord => entry !== null);
}

export function decodeOperationEvidence(raw: unknown): OperationEvidence | null {
  const row = record(raw);
  const id = text(row.id);
  const sourceKind = text(row.sourceKind ?? row.source_kind);
  const sourceRef = text(row.sourceRef ?? row.source_ref);
  if (!id || !sourceKind || !sourceRef) return null;
  const payload = record(row.payload);
  return {
    id,
    sourceKind,
    sourceRef,
    contentAddressRef: text(row.contentAddressRef ?? row.content_address_ref) || undefined,
    capturedAt: text(row.capturedAt ?? row.captured_at) || undefined,
    capturedBy: text(row.capturedBy ?? row.captured_by) || undefined,
    extractorRef: text(row.extractorRef ?? row.extractor_ref) || undefined,
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
    sensitiveFieldRefs: textList(row.sensitiveFieldRefs ?? row.sensitive_field_refs),
    candidateFactRefs: textList(row.candidateFactRefs ?? row.candidate_fact_refs),
  };
}

export function decodeOperationEvidenceList(raw: unknown): OperationEvidence[] {
  return list(raw).map(decodeOperationEvidence).filter((entry): entry is OperationEvidence => entry !== null);
}

export function decodeOperationCandidateFact(raw: unknown): OperationCandidateFact | null {
  const row = record(raw);
  const id = text(row.id);
  const targetOwnerPackage = text(row.targetOwnerPackage ?? row.target_owner_package);
  const targetRecordRef = text(row.targetRecordRef ?? row.target_record_ref);
  if (!id || !targetOwnerPackage || !targetRecordRef) return null;
  return {
    id,
    targetOwnerPackage,
    targetRecordRef,
    operationKind: text(row.operationKind ?? row.operation_kind) || 'operation.kind.unknown',
    proposedPatch: record(row.proposedPatch ?? row.proposed_patch),
    sourceEvidenceRefs: textList(row.sourceEvidenceRefs ?? row.source_evidence_refs),
    confidence: number(row.confidence),
    reviewState: text(row.reviewState ?? row.review_state) || 'needs_review',
    reviewReason: text(row.reviewReason ?? row.review_reason),
    createdAt: text(row.createdAt ?? row.created_at) || undefined,
  };
}

export function decodeOperationCandidateFacts(raw: unknown): OperationCandidateFact[] {
  return list(raw).map(decodeOperationCandidateFact).filter((entry): entry is OperationCandidateFact => entry !== null);
}

export function decodeOperationClaim(raw: unknown): OperationClaim | null {
  const row = record(raw);
  const id = text(row.id);
  const operationRef = text(row.operationRef ?? row.operation_ref);
  const actorRef = text(row.actorRef ?? row.actor_ref);
  const claimToken = text(row.claimToken ?? row.claim_token);
  if (!id || !operationRef || !actorRef || !claimToken) return null;
  return {
    id,
    operationRef,
    actorRef,
    claimToken,
    claimedAt: text(row.claimedAt ?? row.claimed_at) || undefined,
    expiresAt: text(row.expiresAt ?? row.expires_at) || undefined,
    supersededBy: text(row.supersededBy ?? row.superseded_by) || undefined,
    status: text(row.status) || 'active',
  };
}

export function decodeOperationClaims(raw: unknown): OperationClaim[] {
  return list(raw).map(decodeOperationClaim).filter((entry): entry is OperationClaim => entry !== null);
}

export function isCurrentOperationClaim(claim: OperationClaim, operationRef: string, nowIso?: string): boolean {
  if (claim.operationRef !== operationRef) return false;
  if (claim.supersededBy) return false;
  if (claim.status !== 'active') return false;
  return !nowIso || !claim.expiresAt || claim.expiresAt > nowIso;
}

export function hasExecutableSideEffectContract(transition: OperationTransition): boolean {
  return Boolean(
    transition.idempotencyKey
      || transition.compensationActionRef
      || transition.irreversibleEffectNotice,
  );
}

export function redactAtom(value: string, strategy: OperationRedactionStrategy | null | undefined): string {
  if (!strategy) return value;
  if (strategy.redactAll) return strategy.replacement;
  if (!strategy.tokenPattern) return value;
  try {
    return value.replace(new RegExp(strategy.tokenPattern, 'g'), strategy.replacement);
  } catch {
    return value;
  }
}
