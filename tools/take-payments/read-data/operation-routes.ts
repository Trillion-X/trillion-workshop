
import packageData from '@/packages/payment-adapter/things-to-store-and-run.json';

export interface OperationInputBindingDescriptor {
  key: string;
  label: string;
  inputKind: string;
  ownerRef?: string;
  required: boolean;
}

export interface OperationOwnerInvokeDescriptor {
  target: string;
  actionDefinitionId: string;
  includeSteps: boolean;
  includeOutput: boolean;
}

export interface ExternalOperationRouteDescriptor {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  actionLabel: string;
  icon: string;
  outputKind: string;
  defaultRoute: boolean;
  ownerInvoke: OperationOwnerInvokeDescriptor;
  inputBindings: OperationInputBindingDescriptor[];
  relationshipRefs: string[];
  evidenceRef: string;
  projectionRef: string;
  display: Record<string, unknown>;
  payloadTemplate: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface OperationSessionIntent {
  kind: 'operation-session-intent-record';
  id: string;
  routeId: string;
  ownerInvoke: OperationOwnerInvokeDescriptor;
  inputFacts: Record<string, unknown>;
  subject: Record<string, unknown>;
  relationshipRefs: string[];
  evidenceRef: string;
  projectionRef: string;
  idempotencyKey: string;
  requestedAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface MaterializeOperationSessionIntentInput {
  route?: ExternalOperationRouteDescriptor | Record<string, unknown>;
  route_id?: string;
  input_facts?: Record<string, unknown>;
  subject?: Record<string, unknown>;
  idempotency_key?: string;
  requested_at?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentRailEvidenceContract {
  sessionIntentKind: string;
  evidenceRef: string;
  projectionRef: string;
}

export interface PaymentRailDescriptor {
  kind: 'payment-rail-descriptor';
  id: string;
  label: string;
  enabled: boolean;
  spendAuthorityRef: string;
  guardInvoke: OperationOwnerInvokeDescriptor;
  ledgerInvoke: OperationOwnerInvokeDescriptor;
  settlementInvoke: OperationOwnerInvokeDescriptor;
  evidenceContract: PaymentRailEvidenceContract;
  credentialRef: string;
  metadata: Record<string, unknown>;
}

type PackageThing = {
  payload?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function packageThings(): PackageThing[] {
  return Array.isArray(packageData.things) ? packageData.things as PackageThing[] : [];
}

function readInputBinding(value: unknown): OperationInputBindingDescriptor | null {
  const row = record(value);
  const key = text(row.key);
  const label = text(row.label);
  const inputKind = text(row.input_kind ?? row.inputKind);
  if (!key || !label || !inputKind) return null;
  return {
    key,
    label,
    inputKind,
    ownerRef: text(row.owner_ref ?? row.ownerRef) || undefined,
    required: bool(row.required, true),
  };
}

function readOwnerInvoke(value: unknown): OperationOwnerInvokeDescriptor | null {
  const row = record(value);
  const target = text(row.target) || 'slot::workflow';
  const actionDefinitionId = text(row.action_definition_id ?? row.actionDefinitionId ?? row.definition_id ?? row.definitionId);
  if (!target || !actionDefinitionId) return null;
  return {
    target,
    actionDefinitionId,
    includeSteps: bool(row.include_steps ?? row.includeSteps, false),
    includeOutput: bool(row.include_output ?? row.includeOutput, true),
  };
}

function readRailEvidenceContract(value: unknown): PaymentRailEvidenceContract | null {
  const row = record(value);
  const sessionIntentKind = text(row.session_intent_kind ?? row.sessionIntentKind);
  const evidenceRef = text(row.evidence_ref ?? row.evidenceRef);
  const projectionRef = text(row.projection_ref ?? row.projectionRef);
  if (!sessionIntentKind || !evidenceRef || !projectionRef) return null;
  return { sessionIntentKind, evidenceRef, projectionRef };
}

function isExternalOperationRouteDescriptor(value: unknown): value is ExternalOperationRouteDescriptor {
  const row = record(value);
  const ownerInvoke = record(row.ownerInvoke);
  return Boolean(
    text(row.id)
      && text(row.label)
      && text(ownerInvoke.actionDefinitionId)
      && text(row.projectionRef),
  );
}

export function readExternalOperationRoute(value: unknown): ExternalOperationRouteDescriptor | null {
  if (isExternalOperationRouteDescriptor(value)) return value;
  const row = record(value);
  if (text(row.kind) !== 'external-operation-route-record') return null;
  const id = text(row.id);
  const label = text(row.label);
  const ownerInvoke = readOwnerInvoke(row.owner_invoke ?? row.ownerInvoke);
  const projectionRef = text(row.projection_ref ?? row.projectionRef);
  if (!id || !label || !ownerInvoke || !projectionRef) return null;
  return {
    id,
    label,
    shortLabel: text(row.short_label ?? row.shortLabel) || label,
    description: text(row.description),
    actionLabel: text(row.action_label ?? row.actionLabel) || label,
    icon: text(row.icon) || 'Circle',
    outputKind: text(row.output_kind ?? row.outputKind) || 'external-operation',
    defaultRoute: bool(row.default_route ?? row.defaultRoute, false),
    ownerInvoke,
    inputBindings: list(row.input_bindings ?? row.inputBindings)
      .map(readInputBinding)
      .filter((entry): entry is OperationInputBindingDescriptor => entry !== null),
    relationshipRefs: textList(row.relationship_refs ?? row.relationshipRefs),
    evidenceRef: text(row.evidence_ref ?? row.evidenceRef) || `${id}:evidence`,
    projectionRef,
    display: record(row.display),
    payloadTemplate: record(row.payload_template ?? row.payloadTemplate),
    metadata: record(row.metadata),
  };
}

export function readPaymentRail(value: unknown): PaymentRailDescriptor | null {
  const row = record(value);
  if (text(row.kind) !== 'payment-rail-descriptor') return null;

  const id = text(row.id);
  const label = text(row.label);
  const spendAuthorityRef = text(row.spend_authority_ref ?? row.spendAuthorityRef);
  const guardInvoke = readOwnerInvoke(row.guard_invoke ?? row.guardInvoke);
  const ledgerInvoke = readOwnerInvoke(row.ledger_invoke ?? row.ledgerInvoke);
  const settlementInvoke = readOwnerInvoke(row.settlement_invoke ?? row.settlementInvoke);
  const evidenceContract = readRailEvidenceContract(row.evidence_contract ?? row.evidenceContract);
  const credentialRef = text(row.credential_ref ?? row.credentialRef);

  if (
    !id
    || !label
    || !spendAuthorityRef
    || !credentialRef
    || !guardInvoke
    || !ledgerInvoke
    || !settlementInvoke
    || !evidenceContract
    || guardInvoke.actionDefinitionId !== 'action:budget-gate'
    || ledgerInvoke.actionDefinitionId !== 'action:record-spend'
    || evidenceContract.sessionIntentKind !== 'operation-session-intent-record'
  ) return null;

  return {
    kind: 'payment-rail-descriptor',
    id,
    label,
    enabled: bool(row.enabled, false),
    spendAuthorityRef,
    guardInvoke,
    ledgerInvoke,
    settlementInvoke,
    evidenceContract,
    credentialRef,
    metadata: record(row.metadata),
  };
}

export function readPaymentRails(rawThings: readonly PackageThing[] = packageThings()): PaymentRailDescriptor[] {
  return rawThings
    .map((thing) => readPaymentRail(thing.payload))
    .filter((rail): rail is PaymentRailDescriptor => rail !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function readExternalOperationRoutes(rawThings: readonly PackageThing[] = packageThings()): ExternalOperationRouteDescriptor[] {
  return rawThings
    .map((thing) => readExternalOperationRoute(thing.payload))
    .filter((route): route is ExternalOperationRouteDescriptor => route !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function routeOutputTarget(route: ExternalOperationRouteDescriptor) {
  return {
    id: route.id,
    label: route.label,
    shortLabel: route.shortLabel,
    description: route.description,
    icon: route.icon,
    actionLabel: route.actionLabel,
    outputKind: route.outputKind,
    route: {
      target: route.ownerInvoke.target,
      definitionId: route.ownerInvoke.actionDefinitionId,
      includeSteps: route.ownerInvoke.includeSteps,
      includeOutput: route.ownerInvoke.includeOutput,
    },
    requiredInputs: route.inputBindings.map((binding) => ({
      key: binding.key,
      label: binding.label,
      inputKind: binding.inputKind,
      serviceVendor: binding.ownerRef,
    })),
    operationRoute: route,
  };
}

export function readOperationOutputTargets(rawThings?: readonly PackageThing[]) {
  return readExternalOperationRoutes(rawThings).map(routeOutputTarget);
}

function requiredBindingErrors(route: ExternalOperationRouteDescriptor, inputFacts: Record<string, unknown>): string[] {
  return route.inputBindings
    .filter((binding) => binding.required && inputFacts[binding.key] === undefined)
    .map((binding) => `Missing required input binding: ${binding.key}`);
}

function routeFromInput(input: MaterializeOperationSessionIntentInput): ExternalOperationRouteDescriptor | null {
  const directRoute = readExternalOperationRoute(input.route);
  if (directRoute) return directRoute;
  const routeId = text(input.route_id);
  return readExternalOperationRoutes().find((route) => route.id === routeId) ?? null;
}

export function materializeOperationSessionIntent(input: MaterializeOperationSessionIntentInput): OperationSessionIntent | { error: string; details?: string[] } {
  const route = routeFromInput(input);
  if (!route) return { error: 'operation route is required' };

  const idempotencyKey = text(input.idempotency_key);
  const requestedAt = text(input.requested_at);
  const inputFacts = record(input.input_facts);
  const subject = record(input.subject);
  const bindingErrors = requiredBindingErrors(route, inputFacts);
  const errors = [
    ...bindingErrors,
    ...(!idempotencyKey ? ['idempotency_key is required'] : []),
    ...(!requestedAt ? ['requested_at is required'] : []),
  ];
  if (errors.length > 0) return { error: 'operation intent input is incomplete', details: errors };

  return {
    kind: 'operation-session-intent-record',
    id: `operation-session:${idempotencyKey}`,
    routeId: route.id,
    ownerInvoke: route.ownerInvoke,
    inputFacts,
    subject,
    relationshipRefs: route.relationshipRefs,
    evidenceRef: route.evidenceRef,
    projectionRef: route.projectionRef,
    idempotencyKey,
    requestedAt,
    payload: {
      ...route.payloadTemplate,
      route_id: route.id,
      input_facts: inputFacts,
      subject,
    },
    metadata: {
      ...route.metadata,
      ...record(input.metadata),
    },
  };
}
