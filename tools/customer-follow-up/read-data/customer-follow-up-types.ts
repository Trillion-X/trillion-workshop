export type CustomerStepKind =
  | 'outreach'
  | 'reply'
  | 'call-booked'
  | 'purchase'
  | 'onboarding'
  | 'follow-up'
  | 'feedback';

export type CustomerContactRecord = {
  kind: 'customer-contact';
  contactId: string;
  displayName: string;
  channelLabel?: string;
  ownerLabel?: string;
  sourceLabel?: string;
};

export type CustomerProductTargetRecord = {
  kind: 'customer-product-target';
  targetId: string;
  productId: string;
  productLabel: string;
  targetCount: number;
  active?: boolean;
};

export type CustomerStepRecord = {
  kind: 'customer-step';
  stepId: string;
  contactId: string;
  stepKind: CustomerStepKind;
  productId: string;
  actorId?: string;
  label: string;
  outcome?: string;
  evidenceRefs: string[];
  ownerRefs: string[];
  createdAt: string;
};

export type CustomerFollowUpRecord =
  | CustomerContactRecord
  | CustomerProductTargetRecord
  | CustomerStepRecord;

export type CustomerFollowUpState = {
  contacts: CustomerContactRecord[];
  targets: CustomerProductTargetRecord[];
  steps: CustomerStepRecord[];
};

export type CustomerContactView = {
  contact: CustomerContactRecord;
  steps: CustomerStepRecord[];
  lastStep?: CustomerStepRecord;
  lastProductId?: string;
};

export type CustomerProductProgressView = {
  target: CustomerProductTargetRecord;
  customerCount: number;
  targetCount: number;
  remainingCount: number;
  percent: number;
};

export type CustomerFollowUpViews = {
  contacts: CustomerContactView[];
  products: CustomerProductProgressView[];
  selectedContact?: CustomerContactView;
};
