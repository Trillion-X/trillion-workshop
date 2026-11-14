import type {
  OperationCandidateFact,
  OperationEvidence,
  OperationRecord,
  OperationSourceRef,
  OperationTransition,
} from './operation-records.ts';

export interface SourceLinkedReviewEvidenceInput {
  contentAddressRef?: string;
  id: string;
  package: string;
  payload?: Record<string, unknown>;
  sensitiveFieldRefs?: string[];
  sourceKind: string;
  sourceRef: string;
}

export interface SourceLinkedReviewTargetInput {
  actionDefinitionId: string;
  ownerPackage: string;
  target?: string;
}

export interface SourceLinkedReviewProposalInput {
  confidence?: number;
  id: string;
  payload: Record<string, unknown>;
  reviewReason?: string;
  reviewState?: string;
  sourceEvidenceRefs?: string[];
  targetRecordRef: string;
}

export interface SourceLinkedReviewInput {
  candidateFacts?: SourceLinkedReviewProposalInput[];
  decisionRefs?: string[];
  dependencyRefs?: string[];
  display?: Partial<OperationRecord['display']>;
  evidence: SourceLinkedReviewEvidenceInput[];
  id: string;
  kindDescriptor?: string;
  linkRefs?: string[];
  modeHints?: string[];
  priority?: string;
  priorityDescriptor?: string;
  receiptRefs?: string[];
  sortKey?: string;
  source: OperationSourceRef;
  stateDescriptor?: string;
  target: SourceLinkedReviewTargetInput;
  updatedAt?: string;
}

export interface SourceLinkedReviewGraph {
  candidateFacts: OperationCandidateFact[];
  evidence: OperationEvidence[];
  operation: OperationRecord;
}

function uniqueText(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function sourceEvidence(input: SourceLinkedReviewEvidenceInput): OperationEvidence {
  return {
    id: input.id,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    contentAddressRef: input.contentAddressRef,
    payload: input.payload,
    sensitiveFieldRefs: input.sensitiveFieldRefs ?? [],
    candidateFactRefs: [],
  };
}

function proposalEvidenceRefs(proposal: SourceLinkedReviewProposalInput, evidenceRefs: readonly string[]): string[] {
  return uniqueText([...(proposal.sourceEvidenceRefs ?? []), ...evidenceRefs]);
}

function proposalFact(
  proposal: SourceLinkedReviewProposalInput,
  target: SourceLinkedReviewTargetInput,
  evidenceRefs: readonly string[],
  kindDescriptor: string,
): OperationCandidateFact {
  return {
    id: proposal.id,
    targetOwnerPackage: target.ownerPackage,
    targetRecordRef: proposal.targetRecordRef,
    operationKind: kindDescriptor,
    proposedPatch: proposal.payload,
    sourceEvidenceRefs: proposalEvidenceRefs(proposal, evidenceRefs),
    confidence: proposal.confidence ?? 0,
    reviewState: proposal.reviewState ?? 'needs_review',
    reviewReason: proposal.reviewReason ?? '',
  };
}

function acceptTransition(
  input: SourceLinkedReviewInput,
  evidenceRefs: readonly string[],
  candidateFactRefs: readonly string[],
): OperationTransition {
  return {
    id: `${input.id}:accept`,
    ownerPackage: input.target.ownerPackage,
    actionDefinitionId: input.target.actionDefinitionId,
    target: input.target.target ?? 'slot::workflow',
    label: input.display?.status ?? 'Accept',
    input: {
      operationRef: input.id,
      sourceRecord: input.source,
      evidenceRefs,
      candidateFactRefs,
    },
    idempotencyKey: `source-linked-review:${input.id}:${candidateFactRefs.join('|')}`,
    sideEffectClass: 'target-owner-write',
    evidenceRefs: [...evidenceRefs],
    candidateFactRefs: [...candidateFactRefs],
    modeHints: input.modeHints ?? ['review'],
  };
}

export function buildSourceLinkedRecordReviewGraph(input: SourceLinkedReviewInput): SourceLinkedReviewGraph {
  const kindDescriptor = input.kindDescriptor ?? 'operation.kind.source-linked-record-review';
  const evidence = input.evidence.map(sourceEvidence);
  const evidenceRefs = uniqueText(evidence.map((entry) => entry.id));
  const candidateFacts = (input.candidateFacts ?? []).map((proposal) => proposalFact(proposal, input.target, evidenceRefs, kindDescriptor));
  const candidateFactRefs = uniqueText(candidateFacts.map((entry) => entry.id));
  const receiptRefs = input.receiptRefs ?? [];
  const decisionRefs = input.decisionRefs ?? [];

  return {
    evidence,
    candidateFacts,
    operation: {
      id: input.id,
      ownerPackage: input.target.ownerPackage,
      source: input.source,
      kindDescriptor,
      stateDescriptor: input.stateDescriptor ?? 'operation.state.review-needed',
      priority: input.priority ?? 'normal',
      priorityDescriptor: input.priorityDescriptor ?? 'operation.priority.normal',
      linkRefs: uniqueText([...(input.linkRefs ?? []), ...receiptRefs, ...decisionRefs]),
      dependencyRefs: input.dependencyRefs ?? [],
      evidenceRefs,
      candidateFactRefs,
      relationshipEdgeRefs: uniqueText([
        ...input.evidence.map((entry) => `${input.id}:evidence:${entry.id}`),
        ...candidateFactRefs.map((ref) => `${input.id}:candidate:${ref}`),
        ...decisionRefs.map((ref) => `${input.id}:decision:${ref}`),
        ...receiptRefs.map((ref) => `${input.id}:receipt:${ref}`),
      ]),
      transitions: candidateFactRefs.length ? [acceptTransition(input, evidenceRefs, candidateFactRefs)] : [],
      display: {
        title: input.display?.title ?? input.id,
        status: input.display?.status ?? 'Needs review',
        reason: input.display?.reason ?? '',
        detail: input.display?.detail ?? [],
      },
      privacyClass: 'public',
      modeHints: input.modeHints ?? ['review'],
      sortKey: input.sortKey ?? input.id,
      updatedAt: input.updatedAt,
    },
  };
}
