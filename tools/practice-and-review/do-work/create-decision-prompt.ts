import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  DecisionEvidence,
  DecisionPrompt,
  DecisionSubject,
  DecisionSubjectRef,
  EvidenceAttachment,
} from '../read-data/practice-decision-loop-types.ts';

export const CREATE_DECISION_PROMPT_ACTION = 'action:practice-decision-loop.create-prompt';

export type CreateDecisionPromptDraft = {
  subjectId?: string;
  evidenceId?: string;
  attachmentId?: string;
  promptId?: string;
  subjectKind: string;
  subjectLabel?: string;
  subjectPayload?: Record<string, unknown>;
  evidenceKind: string;
  evidenceSourceId: string;
  evidenceSourceLabel?: string;
  evidenceConfidence?: number;
  evidencePayload: Record<string, unknown>;
  attachmentRelationshipKind?: string;
  promptKind: string;
  title: string;
  body: string;
  choices: DecisionPrompt['choices'];
  now?: Date;
};

export type CreateDecisionPromptInput = {
  subject_id: string;
  subject_record: DecisionSubject;
  evidence_id: string;
  evidence_record: DecisionEvidence;
  attachment_id: string;
  attachment_record: EvidenceAttachment;
  prompt_id: string;
  prompt_record: DecisionPrompt;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildCreateDecisionPromptInput(
  draft: CreateDecisionPromptDraft,
): CreateDecisionPromptInput {
  const createdAt = (draft.now ?? new Date()).toISOString();
  const subjectId = draft.subjectId ?? generatedId('decision-subject');
  const evidenceId = draft.evidenceId ?? generatedId('decision-evidence');
  const attachmentId = draft.attachmentId ?? generatedId('evidence-attachment');
  const promptId = draft.promptId ?? generatedId('decision-prompt');
  const subjectRef: DecisionSubjectRef = {
    id: subjectId,
    kind: draft.subjectKind,
    label: draft.subjectLabel,
  };

  return {
    subject_id: subjectId,
    subject_record: {
      kind: 'decision-subject',
      subjectId,
      subjectKind: draft.subjectKind,
      label: draft.subjectLabel,
      payload: draft.subjectPayload,
      createdAt,
    },
    evidence_id: evidenceId,
    evidence_record: {
      kind: 'decision-evidence',
      evidenceId,
      subject: subjectRef,
      evidenceKind: draft.evidenceKind,
      source: {
        id: draft.evidenceSourceId,
        label: draft.evidenceSourceLabel,
        confidence: draft.evidenceConfidence,
      },
      payload: draft.evidencePayload,
      createdAt,
    },
    attachment_id: attachmentId,
    attachment_record: {
      kind: 'evidence-attachment',
      attachmentId,
      evidenceId,
      subject: subjectRef,
      relationshipKind: draft.attachmentRelationshipKind ?? 'supports-prompt',
      createdAt,
    },
    prompt_id: promptId,
    prompt_record: {
      kind: 'decision-prompt',
      promptId,
      subject: subjectRef,
      promptKind: draft.promptKind,
      title: draft.title,
      body: draft.body,
      choices: draft.choices,
      evidenceRefs: [evidenceId],
      createdAt,
    },
  };
}

export function createDecisionPrompt(input: CreateDecisionPromptInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: CREATE_DECISION_PROMPT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
