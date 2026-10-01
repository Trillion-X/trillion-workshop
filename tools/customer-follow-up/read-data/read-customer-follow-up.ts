import type {
  CustomerContactRecord,
  CustomerContactView,
  CustomerFollowUpState,
  CustomerFollowUpViews,
  CustomerProductProgressView,
  CustomerProductTargetRecord,
  CustomerStepRecord,
} from './customer-follow-up-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function latestStep(steps: readonly CustomerStepRecord[]): CustomerStepRecord | undefined {
  return [...steps].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function activeTarget(target: CustomerProductTargetRecord): boolean {
  return target.active !== false;
}

function percent(count: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((count / target) * 100)));
}

export function readCustomerFollowUpState(rows: unknown): CustomerFollowUpState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    contacts: values.filter((value): value is CustomerContactRecord => kind(value) === 'customer-contact'),
    targets: values.filter((value): value is CustomerProductTargetRecord => kind(value) === 'customer-product-target'),
    steps: values.filter((value): value is CustomerStepRecord => kind(value) === 'customer-step'),
  };
}

export function customerProductProgressViews(state: CustomerFollowUpState): CustomerProductProgressView[] {
  return state.targets
    .filter(activeTarget)
    .map((target) => {
      const purchasedContactIds = new Set(
        state.steps
          .filter((step) => step.productId === target.productId && step.stepKind === 'purchase')
          .map((step) => step.contactId),
      );
      const customerCount = purchasedContactIds.size;
      const targetCount = Math.max(0, Math.round(target.targetCount));
      return {
        target,
        customerCount,
        targetCount,
        remainingCount: Math.max(0, targetCount - customerCount),
        percent: percent(customerCount, targetCount),
      };
    })
    .sort((a, b) => a.target.productLabel.localeCompare(b.target.productLabel));
}

export function customerContactViews(state: CustomerFollowUpState): CustomerContactView[] {
  return state.contacts
    .map((contact) => {
      const steps = state.steps
        .filter((step) => step.contactId === contact.contactId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const lastStep = latestStep(steps);
      return {
        contact,
        steps,
        lastStep,
        lastProductId: lastStep?.productId,
      };
    })
    .sort((a, b) => {
      const left = a.lastStep?.createdAt ?? '';
      const right = b.lastStep?.createdAt ?? '';
      return right.localeCompare(left) || a.contact.displayName.localeCompare(b.contact.displayName);
    });
}

export function customerFollowUpViews(state: CustomerFollowUpState, selectedContactId?: string): CustomerFollowUpViews {
  const contacts = customerContactViews(state);
  return {
    contacts,
    products: customerProductProgressViews(state),
    selectedContact: contacts.find((view) => view.contact.contactId === selectedContactId) ?? contacts[0],
  };
}
