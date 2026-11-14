import {
  contentAddress,
  LOCAL_FIRST_RUN_FACT_OWNERS,
  localFirstRunFactOwner,
  localFirstRunFactSupportsKeepBoth,
  validateLocalFirstRunSource,
  type AccountDeletionReadback,
  type AccountFirstRunFactRecord,
  type AccountSessionReadback,
  type LocalFirstRunFactName,
  type LocalFirstRunFactSource,
} from './adopt-local-first-run-state';

export const LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_REQUEST_SCHEMA =
  'account-session.local-first-run-conflict-resolution-request/owner-scoped';
export const LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_RECEIPT_SCHEMA =
  'account-session.local-first-run-conflict-resolution-receipt/owner-scoped';

export type LocalFirstRunConflictResolution =
  | 'keep-account'
  | 'adopt-local'
  | 'keep-both';

export interface LocalFirstRunConflictResolutionRequest {
  schema: typeof LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_REQUEST_SCHEMA;
  kind: 'local-first-run-conflict-resolution-request';
  account_session_receipt: AccountSessionReadback;
  adoption_id: string;
  conflict_id: string;
  fact: LocalFirstRunFactName;
  resolution: LocalFirstRunConflictResolution;
  resolution_content: string | null;
  account_ref: string;
  local_source: LocalFirstRunFactSource;
  keep_both_supported: boolean;
  idempotency_identity: string;
}

export interface LocalFirstRunConflictResolutionReceipt {
  schema: typeof LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_RECEIPT_SCHEMA;
  kind: 'local-first-run-conflict-resolution-receipt';
  adoption_id: string;
  conflict_id: string;
  fact: LocalFirstRunFactName;
  resolution: LocalFirstRunConflictResolution;
  destination_owner: string;
  destination_ref: string;
  superseded_suggestion_ref: string;
  next_destination_operation: 'start-assigned-record-work-session';
}

export interface LocalFirstRunConflictOwnerEffects {
  readAccountFact(input: {
    fact: LocalFirstRunFactName;
    owner: string;
    accountScope: string;
  }): Promise<{ status: 'absent' } | { status: 'found'; records: readonly AccountFirstRunFactRecord[] }>;
  writeAccountFact(input: {
    fact: LocalFirstRunFactName;
    owner: string;
    accountScope: string;
    source: LocalFirstRunFactSource;
    mode: 'replace' | 'append';
  }): Promise<AccountFirstRunFactRecord>;
  readPriorConflictResolution(input: {
    accountScope: string;
    idempotencyIdentity: string;
  }): Promise<LocalFirstRunConflictResolutionReceipt | null>;
  writeConflictResolutionReceipt(receipt: LocalFirstRunConflictResolutionReceipt):
    Promise<LocalFirstRunConflictResolutionReceipt>;
}

export class LocalFirstRunConflictInputError extends Error {}
export class LocalFirstRunConflictBlockedError extends Error {
  public readonly deletionRequestedAt: string;
  constructor(deletionRequestedAt: string) {
    super('Account deletion is in progress');
    this.deletionRequestedAt = deletionRequestedAt;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalFirstRunConflictInputError(`${label} is required.`);
  }
  return value.trim();
}

function decodeSession(value: unknown): AccountSessionReadback {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).status !== 'signed_in') {
    throw new LocalFirstRunConflictInputError('Conflict resolution requires a signed-in account-session readback.');
  }
  const session = value as Record<string, unknown>;
  return {
    status: 'signed_in',
    ref: requireString(session.ref, 'Account-session ref'),
    accountIdHash: requireString(session.accountIdHash, 'Account scope'),
  };
}

export function decodeLocalFirstRunConflictResolutionRequest(
  value: unknown,
): LocalFirstRunConflictResolutionRequest {
  if (!value || typeof value !== 'object') {
    throw new LocalFirstRunConflictInputError('Conflict request is invalid.');
  }
  const request = value as Record<string, unknown>;
  if (
    request.schema !== LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_REQUEST_SCHEMA
    || request.kind !== 'local-first-run-conflict-resolution-request'
  ) {
    throw new LocalFirstRunConflictInputError('Conflict request schema or kind is invalid.');
  }
  const resolution = request.resolution;
  if (resolution !== 'keep-account' && resolution !== 'adopt-local' && resolution !== 'keep-both') {
    throw new LocalFirstRunConflictInputError('Conflict resolution is invalid.');
  }
  const factName = requireString(request.fact, 'Fact') as LocalFirstRunFactName;
  if (!Object.prototype.hasOwnProperty.call(LOCAL_FIRST_RUN_FACT_OWNERS, factName)) {
    throw new LocalFirstRunConflictInputError('Conflict fact is unknown.');
  }
  const resolutionContent = typeof request.resolution_content === 'string' && request.resolution_content.trim()
    ? request.resolution_content.trim()
    : null;
  if (resolutionContent !== null) {
    throw new LocalFirstRunConflictInputError('This fact owner does not accept edited resolution content.');
  }
  const keepBothSupported = request.keep_both_supported === true;
  if (resolution === 'keep-both' && (!keepBothSupported || !localFirstRunFactSupportsKeepBoth(factName))) {
    throw new LocalFirstRunConflictInputError('This fact does not support keeping both values.');
  }

  const decoded: LocalFirstRunConflictResolutionRequest = {
    schema: LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_REQUEST_SCHEMA,
    kind: 'local-first-run-conflict-resolution-request',
    account_session_receipt: decodeSession(request.account_session_receipt),
    adoption_id: requireString(request.adoption_id, 'Adoption id'),
    conflict_id: requireString(request.conflict_id, 'Conflict id'),
    fact: factName,
    resolution,
    resolution_content: resolutionContent,
    account_ref: requireString(request.account_ref, 'Account ref'),
    local_source: validateLocalFirstRunSource(request.local_source, factName),
    keep_both_supported: keepBothSupported,
    idempotency_identity: requireString(request.idempotency_identity, 'Idempotency identity'),
  };
  const expected = contentAddress({
    account: decoded.account_session_receipt.accountIdHash,
    adoption_id: decoded.adoption_id,
    conflict_id: decoded.conflict_id,
    resolution: decoded.resolution,
    resolution_content: decoded.resolution_content,
  });
  if (decoded.idempotency_identity !== expected) {
    throw new LocalFirstRunConflictInputError('Conflict idempotency identity is invalid.');
  }
  return decoded;
}

function sameRecord(a: AccountFirstRunFactRecord, b: AccountFirstRunFactRecord): boolean {
  return a.owner === b.owner && a.ref === b.ref && a.content_hash === b.content_hash;
}

async function proveWritten(
  effects: LocalFirstRunConflictOwnerEffects,
  request: LocalFirstRunConflictResolutionRequest,
  written: AccountFirstRunFactRecord,
  current: AccountFirstRunFactRecord,
): Promise<AccountFirstRunFactRecord> {
  const readback = await effects.readAccountFact({
    fact: request.fact,
    owner: request.local_source.owner,
    accountScope: request.account_session_receipt.accountIdHash,
  });
  if (readback.status !== 'found') throw new Error('destination-owner-readback-missing');
  const records = [...readback.records];
  const writtenPresent = records.some((record) => sameRecord(record, written));
  if (!writtenPresent) throw new Error('destination-owner-readback-missing');
  if (request.resolution === 'keep-both' && !records.some((record) => sameRecord(record, current))) {
    throw new Error('ordered-list-owner-readback-missing-current-value');
  }
  return written;
}

export async function resolveLocalFirstRunConflict(
  input: unknown,
  effects: LocalFirstRunConflictOwnerEffects,
  deletionState: AccountDeletionReadback,
): Promise<LocalFirstRunConflictResolutionReceipt> {
  const request = decodeLocalFirstRunConflictResolutionRequest(input);
  if (deletionState.deletionRequestedAt) {
    throw new LocalFirstRunConflictBlockedError(deletionState.deletionRequestedAt);
  }

  const accountScope = request.account_session_receipt.accountIdHash;
  const prior = await effects.readPriorConflictResolution({
    accountScope,
    idempotencyIdentity: request.idempotency_identity,
  });
  if (prior) {
    if (
      prior.schema !== LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_RECEIPT_SCHEMA
      || prior.adoption_id !== request.adoption_id
      || prior.conflict_id !== request.conflict_id
    ) {
      throw new LocalFirstRunConflictInputError('Prior conflict receipt conflicts with the request identity.');
    }
    return prior;
  }

  const read = await effects.readAccountFact({
    fact: request.fact,
    owner: request.local_source.owner,
    accountScope,
  });
  if (read.status !== 'found') throw new LocalFirstRunConflictInputError('Current account fact is missing.');
  const current = read.records.find((record) => record.ref === request.account_ref);
  if (!current) throw new LocalFirstRunConflictInputError('The account fact changed; restart adoption.');

  let destination: AccountFirstRunFactRecord;
  if (request.resolution === 'keep-account') {
    destination = current;
  } else {
    const written = await effects.writeAccountFact({
      fact: request.fact,
      owner: localFirstRunFactOwner(request.fact),
      accountScope,
      source: request.local_source,
      mode: request.resolution === 'keep-both' ? 'append' : 'replace',
    });
    destination = await proveWritten(effects, request, written, current);
  }

  const receipt: LocalFirstRunConflictResolutionReceipt = {
    schema: LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_RECEIPT_SCHEMA,
    kind: 'local-first-run-conflict-resolution-receipt',
    adoption_id: request.adoption_id,
    conflict_id: request.conflict_id,
    fact: request.fact,
    resolution: request.resolution,
    destination_owner: destination.owner,
    destination_ref: destination.ref,
    superseded_suggestion_ref: request.resolution === 'keep-account'
      ? request.local_source.ref
      : request.account_ref,
    next_destination_operation: 'start-assigned-record-work-session',
  };
  const writtenReceipt = await effects.writeConflictResolutionReceipt(receipt);
  if (
    writtenReceipt.schema !== LOCAL_FIRST_RUN_CONFLICT_RESOLUTION_RECEIPT_SCHEMA
    || writtenReceipt.adoption_id !== receipt.adoption_id
    || writtenReceipt.conflict_id !== receipt.conflict_id
  ) {
    throw new Error('conflict-resolution-receipt-readback-missing');
  }
  return receipt;
}
