// tools/guard-ai-spending/read-data/spend-rails.ts
//
// The ways an AI's spending can be paid (a card, a bank, x402 or the next one) as DATA rows: one reader, one
// contract. A rail row is valid only when its guard is this folder's budget reservation and its ledger is this
// folder's spend record, so no rail can pay around the fail-closed budget or the common ledger. A rail is a row; no
// code branches on which rail it is.
//
// Ported from bitfield-packages packages/payment-adapter/read-data/operation-routes.ts (the rail half:
// PaymentRailEvidenceContract, PaymentRailDescriptor, readOwnerInvoke, readRailEvidenceContract, readPaymentRail,
// readPaymentRails and the helpers they use). Changed: an invoke names a Workshop tool id ({ tool }) instead of an
// old-engine workflow target and action id, and readPaymentRails reads the rows it is given (the shipped DATA in
// spend-rails.json plus the person's own payment-rail records) instead of a package manifest.

export const GUARD_TOOL = 'tool:reserve-a-spend-within-budget';
export const LEDGER_TOOL = 'tool:record-a-spend';
export const SESSION_INTENT_KIND = 'operation-session-intent-record';

export interface OperationOwnerInvokeDescriptor {
  tool: string;
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOwnerInvoke(value: unknown): OperationOwnerInvokeDescriptor | null {
  const tool = text(record(value).tool);
  return tool ? { tool } : null;
}

function readRailEvidenceContract(value: unknown): PaymentRailEvidenceContract | null {
  const row = record(value);
  const sessionIntentKind = text(row.session_intent_kind ?? row.sessionIntentKind);
  const evidenceRef = text(row.evidence_ref ?? row.evidenceRef);
  const projectionRef = text(row.projection_ref ?? row.projectionRef);
  if (!sessionIntentKind || !evidenceRef || !projectionRef) return null;
  return { sessionIntentKind, evidenceRef, projectionRef };
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
    || guardInvoke.tool !== GUARD_TOOL
    || ledgerInvoke.tool !== LEDGER_TOOL
    || evidenceContract.sessionIntentKind !== SESSION_INTENT_KIND
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

export function readPaymentRails(rows: readonly unknown[]): PaymentRailDescriptor[] {
  return rows
    .map((row) => readPaymentRail(row))
    .filter((rail): rail is PaymentRailDescriptor => rail !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
}
