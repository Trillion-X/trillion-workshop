import type { DisplayMarkSpec } from '@/packages/ui/show/display-mark';
import { statusView, type StatusOverrides, type StatusView } from '@/packages/ui/show/status-vocabulary';
import type { EvidenceProjection, ExecutionReceipt } from './capability-records';
import { STRIPE_STATUS_OVERRIDES } from './stripe-status-overrides';

export type RenderingCategory =
  | 'summary'
  | 'review'
  | 'readiness'
  | 'timeline'
  | 'proof'
  | 'action'
  | 'empty'
  | 'error';

export interface DescriptorAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly target?: string;
  readonly payload?: Record<string, unknown>;
}

export interface DescriptorPart {
  readonly mark?: DisplayMarkSpec;
  readonly status?: StatusView;
  readonly label: string;
  readonly value?: string;
  readonly copy?: string;
  readonly emphasis?: 'normal' | 'strong';
  readonly action?: DescriptorAction;
  readonly proofRef?: string;
}

export interface DescriptorSection {
  readonly category: RenderingCategory;
  readonly parts: readonly DescriptorPart[];
}

export interface SurfaceDescriptor {
  readonly schema: 'stripe-payment-provider.surface-descriptor.v1';
  readonly sections: readonly DescriptorSection[];
  readonly evidence_projection_id?: string;
  readonly invocation_id?: string;
  readonly receipt_id?: string;
}

export interface ProviderSurfaceDescriptorInput {
  readonly projection?: EvidenceProjection | null;
  readonly receipt?: ExecutionReceipt | null;
  readonly state?: string | null;
  readonly reviewItems?: readonly DescriptorPart[];
  readonly readinessItems?: readonly DescriptorPart[];
  readonly action?: DescriptorAction | null;
}

export const STRIPE_SURFACE_COPY = {
  emptyLabel: 'No provider evidence yet',
  emptyCopy: 'Start from a prepared provider request to create the first evidence record.',
  summaryLabel: 'Readiness',
  reviewLabel: 'Review',
  readinessLabel: 'Setup',
  timelineLabel: 'Latest evidence',
  proofLabel: 'Proof',
  handoffLabel: 'Secure handoff',
  handoffValue: 'Ready to open',
  noHandoffValue: 'Waiting for a safe handoff',
  startActionLabel: 'Start checkout',
  retryActionLabel: 'Try again',
  proofValue: 'Public evidence rows',
} as const;

function cleanText(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function rowsByLabel(projection: EvidenceProjection | null | undefined): Map<string, string> {
  const rows = new Map<string, string>();
  for (const row of projection?.rows ?? []) {
    rows.set(row.label.trim().toLowerCase(), row.value);
  }
  return rows;
}

function observedState(input: ProviderSurfaceDescriptorInput): string {
  const explicit = cleanText(input.state);
  if (explicit) return explicit;
  const fromRows = rowsByLabel(input.projection).get('observed state');
  if (fromRows) return fromRows;
  const fromReceipt = cleanText(input.receipt?.state);
  if (fromReceipt) return fromReceipt;
  return input.projection || input.receipt ? 'ready' : 'empty';
}

function observedCopy(input: ProviderSurfaceDescriptorInput): string {
  const observed = cleanText(input.projection?.observed_at ?? input.receipt?.observed_at);
  return observed ? `Observed ${observed}` : '';
}

function defaultAction(status: StatusView, input: ProviderSurfaceDescriptorInput): DescriptorAction {
  const label = status.isError ? STRIPE_SURFACE_COPY.retryActionLabel : STRIPE_SURFACE_COPY.startActionLabel;
  return {
    id: 'action:stripe-payment-provider.start-checkout',
    label,
    enabled: !status.isError,
    disabledReason: status.isError ? status.label : undefined,
    target: 'slot::workflow',
    payload: {
      invocation_id: input.projection?.invocation_id,
      descriptor_id: input.projection?.descriptor_id,
      evidence_projection_id: input.projection?.id,
    },
  };
}

function buildReviewParts(projection: EvidenceProjection | null | undefined, provided: readonly DescriptorPart[] | undefined): DescriptorPart[] {
  if (provided?.length) return [...provided];
  const rows = rowsByLabel(projection);
  const publicHandoff = rows.get('public handoff url') || rows.get('public client token ref');
  return [{
    label: STRIPE_SURFACE_COPY.handoffLabel,
    value: publicHandoff ? STRIPE_SURFACE_COPY.handoffValue : STRIPE_SURFACE_COPY.noHandoffValue,
    emphasis: publicHandoff ? 'strong' : 'normal',
  }];
}

function buildProofPart(projection: EvidenceProjection | null | undefined): DescriptorPart {
  const count = projection?.rows.length ?? 0;
  return {
    label: STRIPE_SURFACE_COPY.proofLabel,
    value: `${count} ${STRIPE_SURFACE_COPY.proofValue}`,
    copy: projection?.redaction_policy_id ? 'Redacted by policy data before display.' : '',
    proofRef: projection?.id,
  };
}

export function buildProviderSurfaceDescriptor(
  input: ProviderSurfaceDescriptorInput = {},
  overrides: StatusOverrides = STRIPE_STATUS_OVERRIDES,
): SurfaceDescriptor {
  const rawState = observedState(input);
  const status = statusView(rawState, overrides);
  const empty = rawState === 'empty' && !input.projection && !input.receipt;
  if (empty) {
    return {
      schema: 'stripe-payment-provider.surface-descriptor.v1',
      sections: [{
        category: 'empty',
        parts: [{
          label: STRIPE_SURFACE_COPY.emptyLabel,
          copy: STRIPE_SURFACE_COPY.emptyCopy,
          status,
        }],
      }],
    };
  }

  const summary: DescriptorPart = {
    label: STRIPE_SURFACE_COPY.summaryLabel,
    status,
    copy: observedCopy(input),
    mark: { name: status.label, glyph: status.isError ? 'TriangleAlert' : 'ShieldCheck', shape: 'rounded' },
  };
  const action = input.action ?? defaultAction(status, input);
  const sections: DescriptorSection[] = [
    { category: status.isError ? 'error' : 'summary', parts: [summary] },
    { category: 'review', parts: buildReviewParts(input.projection, input.reviewItems) },
  ];
  if (input.readinessItems?.length) sections.push({ category: 'readiness', parts: input.readinessItems });
  sections.push({
    category: 'timeline',
    parts: [{
      label: STRIPE_SURFACE_COPY.timelineLabel,
      status,
      copy: observedCopy(input),
      proofRef: input.projection?.id,
    }],
  });
  sections.push({ category: 'proof', parts: [buildProofPart(input.projection)] });
  sections.push({ category: 'action', parts: [{ label: action.label, action }] });

  return {
    schema: 'stripe-payment-provider.surface-descriptor.v1',
    evidence_projection_id: input.projection?.id,
    invocation_id: input.projection?.invocation_id,
    receipt_id: input.projection?.receipt_id ?? input.receipt?.id,
    sections,
  };
}
