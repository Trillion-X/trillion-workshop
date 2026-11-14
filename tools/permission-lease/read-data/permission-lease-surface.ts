import permissionLeaseContract from '../../record-voice-and-meetings/things-to-store-and-run.json';

export interface PackageRecordThing {
  type?: string;
  address?: string;
  payload?: unknown;
  remove?: boolean;
}

export interface PermissionLease {
  leaseRef: string;
  subjectRef?: string;
  connectorRef?: string;
  credentialHandleRef?: string;
  providerHandleRef?: string;
  serviceConnectionHandleRef?: string;
  allowedActions: string[];
  allowedOperationRefs: string[];
  expiresAt: string | null;
  revoked: boolean;
  evidenceRefs: string[];
}

export interface PermissionLeaseCheck {
  checkRef: string;
  operationRef: string;
  requestedActionRef?: string;
  leaseRef?: string;
  subjectRef?: string;
  result: string;
  checkedAt?: string;
  expiresAt: string | null;
  revoked: boolean;
  evidenceRefs: string[];
  blockedReasonRef?: string;
  ownerActionRef?: string;
}

export interface PermissionLeaseAction {
  actionRef: string;
  operation: 'record-lease' | 'check-lease' | string;
  target: string;
  definitionId: string;
  label: string;
}

export interface PermissionDecision {
  available: boolean;
  reason: string;
  check: PermissionLeaseCheck | null;
  lease: PermissionLease | null;
  action: PermissionLeaseAction | null;
}

export interface PermissionLeaseSurface {
  title: string;
  status: string;
  summary: string;
  leaseShape: ReadonlyArray<readonly [string, string]>;
  operationGraph: Array<readonly [string, string]>;
  evidenceOutputs: string[];
  checkRecords: string[];
  gates: string[];
  reusedPrimitives: string[];
  leases: PermissionLease[];
  checks: PermissionLeaseCheck[];
  actions: PermissionLeaseAction[];
}

const DEFAULT_TARGET = 'slot::workflow';

const LEASE_SHAPE = [
  ['Who', 'the account or actor'],
  ['Where', 'the broker or service'],
  ['Key', 'saved outside the order'],
  ['Allowed', 'what can run'],
  ['Expires', 'when it stops'],
] as const;

function thingsFrom(records: unknown): PackageRecordThing[] {
  if (Array.isArray(records)) return records.filter(isThing);
  if (records && typeof records === 'object' && Array.isArray((records as { things?: unknown }).things)) {
    return (records as { things: unknown[] }).things.filter(isThing);
  }
  return [];
}

function isThing(value: unknown): value is PackageRecordThing {
  return Boolean(value && typeof value === 'object');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function asNullableTime(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isExpired(expiresAt: string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= now.getTime();
}

function timeRank(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function decodePermissionLeases(records: unknown): PermissionLease[] {
  return thingsFrom(records).flatMap((thing) => {
    if (thing.remove) return [];
    const payload = asObject(thing.payload);
    if (!payload || payload.kind !== 'permission_lease') return [];
    const leaseRef = asString(payload.lease_ref) ?? asString(payload.leaseRef) ?? thing.address;
    if (!leaseRef) return [];
    return [{
      leaseRef,
      subjectRef: asString(payload.subject_ref) ?? asString(payload.subjectRef),
      connectorRef: asString(payload.connector_ref) ?? asString(payload.connectorRef),
      credentialHandleRef: asString(payload.credential_handle_ref) ?? asString(payload.credential_ref),
      providerHandleRef: asString(payload.provider_handle_ref),
      serviceConnectionHandleRef: asString(payload.service_connection_handle_ref),
      allowedActions: asStringArray(payload.allowed_actions ?? payload.allowedActions),
      allowedOperationRefs: asStringArray(payload.allowed_operation_refs ?? payload.allowedOperationRefs),
      expiresAt: asNullableTime(payload.expires_at ?? payload.expiresAt),
      revoked: payload.revoked === true,
      evidenceRefs: asStringArray(payload.evidence_refs ?? payload.evidenceRefs),
    }];
  });
}

export function decodePermissionLeaseChecks(records: unknown): PermissionLeaseCheck[] {
  return thingsFrom(records).flatMap((thing) => {
    if (thing.remove) return [];
    const payload = asObject(thing.payload);
    if (!payload || payload.kind !== 'permission_lease_check') return [];
    const checkRef = asString(payload.check_ref) ?? asString(payload.checkRef) ?? thing.address;
    const operationRef = asString(payload.operation_ref) ?? asString(payload.operationRef);
    const result = asString(payload.result);
    if (!checkRef || !operationRef || !result) return [];
    return [{
      checkRef,
      operationRef,
      requestedActionRef: asString(payload.requested_action_ref) ?? asString(payload.requestedActionRef),
      leaseRef: asString(payload.lease_ref) ?? asString(payload.leaseRef),
      subjectRef: asString(payload.subject_ref) ?? asString(payload.subjectRef),
      result,
      checkedAt: asString(payload.checked_at) ?? asString(payload.checkedAt),
      expiresAt: asNullableTime(payload.expires_at ?? payload.expiresAt),
      revoked: payload.revoked === true,
      evidenceRefs: asStringArray(payload.evidence_refs ?? payload.evidenceRefs),
      blockedReasonRef: asString(payload.blocked_reason_ref) ?? asString(payload.blockedReasonRef),
      ownerActionRef: asString(payload.owner_action_ref) ?? asString(payload.ownerActionRef),
    }];
  }).sort((left, right) => timeRank(right.checkedAt) - timeRank(left.checkedAt));
}

export function decodeConfiguredPermissionActions(records: unknown): PermissionLeaseAction[] {
  return thingsFrom(records).flatMap((thing) => {
    if (thing.remove) return [];
    const payload = asObject(thing.payload);
    if (!payload || payload.kind !== 'permission_lease_action') return [];
    const actionRef = asString(payload.action_ref) ?? asString(payload.actionRef) ?? thing.address;
    const operation = asString(payload.operation);
    const definitionId = asString(payload.definition_id) ?? asString(payload.definitionId);
    if (!actionRef || !operation || !definitionId) return [];
    return [{
      actionRef,
      operation,
      target: asString(payload.target) ?? DEFAULT_TARGET,
      definitionId,
      label: asString(payload.label) ?? operation,
    }];
  });
}

export function buildPermissionLeaseSurface(
  records: unknown = permissionLeaseContract,
  now: Date = new Date(),
): PermissionLeaseSurface {
  const things = thingsFrom(records);
  const primitiveContract = asObject(things.find((thing) => thing.address === 'package::permission-lease::primitive-contract')?.payload);
  const graph = asObject(things.find((thing) => thing.address === 'package::permission-lease::capability-operation-graph')?.payload);
  const operations = Array.isArray(graph?.operations) ? graph.operations : [];
  const checks = decodePermissionLeaseChecks(things);
  const hasGranted = checks.some((check) => (
    check.result === 'granted'
    && !check.revoked
    && !isExpired(check.expiresAt, now)
  ));
  const hasBlocked = checks.some((check) => check.result !== 'granted' || check.revoked || isExpired(check.expiresAt, now));

  return {
    title: 'Allowed trading',
    status: hasGranted ? 'allowed' : hasBlocked ? 'blocked' : 'needs check',
    summary: 'Orders run only when the latest check says yes.',
    leaseShape: LEASE_SHAPE,
    operationGraph: operations.map((operation) => {
      const record = asObject(operation) ?? {};
      const id = asString(record.id)?.replace(/^operation:permission-lease\./, '') ?? 'Check';
      if (id === 'record-lease') return ['Save rule', 'store who can trade'] as const;
      if (id === 'check-lease') return ['Check order', 'answer yes or no before trading'] as const;
      return [id, 'check whether trading is allowed'] as const;
    }),
    evidenceOutputs: asStringArray(graph?.evidence_outputs).map((output) => output.replace(/_/g, ' ')),
    checkRecords: ['allowed', 'denied', 'missing', 'expired', 'revoked', 'wrong scope'],
    gates: asStringArray(primitiveContract?.blockers).map(() => 'Connect a broker before live orders.'),
    reusedPrimitives: asStringArray(primitiveContract?.reuses).map((primitive) => primitive.replace(/-/g, ' ')),
    leases: decodePermissionLeases(things),
    checks,
    actions: decodeConfiguredPermissionActions(things),
  };
}

export function permissionDecisionForOperation(
  surface: PermissionLeaseSurface,
  operationRef: string,
  requestedActionRef?: string,
  now: Date = new Date(),
): PermissionDecision {
  const check = surface.checks.find((candidate) => (
    candidate.operationRef === operationRef
    && (!requestedActionRef || candidate.requestedActionRef === requestedActionRef)
  )) ?? null;
  const lease = check?.leaseRef
    ? surface.leases.find((candidate) => candidate.leaseRef === check.leaseRef) ?? null
    : null;
  const action = surface.actions.find((candidate) => candidate.operation === 'check-lease') ?? null;

  if (!check) return { available: false, reason: 'order not checked', check, lease, action };
  if (check.revoked) return { available: false, reason: 'order check revoked', check, lease, action };
  if (isExpired(check.expiresAt, now)) return { available: false, reason: 'order check expired', check, lease, action };
  if (check.result !== 'granted') return { available: false, reason: `order ${check.result}`, check, lease, action };
  if (!lease) return { available: false, reason: 'missing trading rule', check, lease, action };
  if (lease.revoked) return { available: false, reason: 'trading rule revoked', check, lease, action };
  if (isExpired(lease.expiresAt, now)) return { available: false, reason: 'trading rule expired', check, lease, action };
  if (
    requestedActionRef
    && lease.allowedActions.length > 0
    && !lease.allowedActions.includes(requestedActionRef)
  ) {
    return { available: false, reason: 'order outside allowed trading', check, lease, action };
  }
  return { available: true, reason: 'order allowed', check, lease, action };
}

export const permissionLeaseSurface = buildPermissionLeaseSurface();
