import type {
  CustomerStepKind,
  CustomerStepRecord,
} from '../read-data/customer-follow-up-types.ts';

export type RecordCustomerStepDraft = {
  stepId?: string;
  contactId: string;
  productId: string;
  stepKind: CustomerStepKind;
  actorId?: string;
  label?: string;
  outcome?: string;
  evidenceRefs?: string[];
  ownerRefs?: string[];
  now?: Date;
};

export type RecordCustomerStepInput = {
  step_id: string;
  step_record: CustomerStepRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function clean(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} needs a value`);
  return trimmed;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed || undefined;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function defaultLabel(kind: CustomerStepKind): string {
  return {
    outreach: 'Outreach recorded',
    reply: 'Reply recorded',
    'call-booked': 'Call booked',
    purchase: 'Purchase recorded',
    onboarding: 'Onboarding recorded',
    'follow-up': 'Follow-up recorded',
    feedback: 'Feedback recorded',
  }[kind];
}

export function buildRecordCustomerStepInput(draft: RecordCustomerStepDraft): RecordCustomerStepInput {
  const stepId = draft.stepId ?? generatedId('customer-step');
  return {
    step_id: stepId,
    step_record: {
      kind: 'customer-step',
      stepId,
      contactId: clean(draft.contactId, 'Customer'),
      productId: clean(draft.productId, 'Product'),
      stepKind: draft.stepKind,
      actorId: optionalText(draft.actorId),
      label: optionalText(draft.label) ?? defaultLabel(draft.stepKind),
      outcome: optionalText(draft.outcome),
      evidenceRefs: uniqueStrings(draft.evidenceRefs),
      ownerRefs: uniqueStrings(draft.ownerRefs),
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}
