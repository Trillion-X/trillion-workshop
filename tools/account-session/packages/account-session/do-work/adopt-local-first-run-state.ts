import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

import { LOCAL_FIRST_RUN_JOURNEY_ID, writeLocalFirstRunProvenance } from './remove-local-first-run-provenance';

export const LOCAL_FIRST_RUN_ADOPTION_REQUEST_SCHEMA =
  'account-session.local-first-run-adoption-request/owner-scoped';
export const LOCAL_FIRST_RUN_ADOPTION_RECEIPT_SCHEMA =
  'account-session.local-first-run-adoption-receipt/owner-scoped';
export const LOCAL_FIRST_RUN_ANONYMOUS_SCOPE = 'local-operator-or-browser';

export type LocalFirstRunFactName =
  | 'slide_outcome_refs'
  | 'personalization_answer_refs'
  | 'selected_job_answer_ref'
  | 'ordered_selected_job_ids'
  | 'provider_selection_ref'
  | 'service_connection_refs'
  | 'guided_cursor_ref'
  | 'guided_outcome_refs'
  | 'destination_intent_ref';

export interface LocalFirstRunFactSource {
  owner: string;
  ref: string;
  content_hash: string;
}

export interface AccountFirstRunFactRecord {
  owner: string;
  ref: string;
  content_hash: string;
}

export interface AccountSessionReadback {
  ref: string;
  accountIdHash: string;
  status: 'signed_in';
}

export interface AccountDeletionReadback {
  deletionRequestedAt: string | null;
}

export type LocalFirstRunFactSet = Partial<
  Record<LocalFirstRunFactName, readonly LocalFirstRunFactSource[]>
>;

export interface LocalFirstRunAdoptionRequest {
  schema: typeof LOCAL_FIRST_RUN_ADOPTION_REQUEST_SCHEMA;
  kind: 'local-first-run-adoption-request';
  account_session_receipt: AccountSessionReadback;
  anonymous_scope: typeof LOCAL_FIRST_RUN_ANONYMOUS_SCOPE;
  local_bundle_ref: string;
  local_bundle_content_hash: string;
  idempotency_identity: string;
  facts: LocalFirstRunFactSet;
}

export interface AcceptedLocalFirstRunFact {
  fact: LocalFirstRunFactName;
  destination_owner: string;
  destination_ref: string;
}

export interface PendingLocalFirstRunConflict {
  fact: LocalFirstRunFactName;
  conflict_id: string;
  account_ref: string;
  local_ref: string;
  decision_required: 'keep-account|adopt-local|keep-both';
  keep_both_supported: boolean;
}

export interface RejectedLocalFirstRunFact {
  fact: LocalFirstRunFactName;
  reason: string;
}

export interface LocalFirstRunAdoptionRetry {
  fact: LocalFirstRunFactName;
  source_ref: string;
  retry_identity: string;
  typed_error: string;
}

export interface LocalFirstRunAdoptionReceipt {
  schema: typeof LOCAL_FIRST_RUN_ADOPTION_RECEIPT_SCHEMA;
  kind: 'local-first-run-adoption-receipt';
  adoption_id: string;
  account_scope: string;
  accepted_facts: AcceptedLocalFirstRunFact[];
  pending_conflicts: PendingLocalFirstRunConflict[];
  rejected_facts: RejectedLocalFirstRunFact[];
  prior_adoption_state: 'absent' | 'same-idempotent-identity' | 'superseded' | 'conflicting';
  partial_failure: {
    state: 'not_applicable' | 'retryable' | 'blocked';
    completed_facts: AcceptedLocalFirstRunFact[];
    retry_facts: LocalFirstRunAdoptionRetry[];
    member_action: 'none' | 'retry-now' | 'resolve-conflict';
  };
  destination_intent_ref: string | null;
}

export type PriorLocalFirstRunAdoption =
  | { status: 'absent' }
  | { status: 'same-idempotent-identity'; receipt: LocalFirstRunAdoptionReceipt }
  | { status: 'prior-adoption'; receipt: LocalFirstRunAdoptionReceipt };

export interface LocalFirstRunOwnerEffects {
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
  readPriorAdoption(input: {
    accountScope: string;
    idempotencyIdentity: string;
  }): Promise<PriorLocalFirstRunAdoption>;
  writeAdoptionReceipt(receipt: LocalFirstRunAdoptionReceipt): Promise<LocalFirstRunAdoptionReceipt>;
}

export class LocalFirstRunAdoptionInputError extends Error {}
export class LocalFirstRunAdoptionBlockedError extends Error {
  public readonly deletionRequestedAt: string;
  constructor(deletionRequestedAt: string) {
    super('Account deletion is in progress');
    this.deletionRequestedAt = deletionRequestedAt;
  }
}

export const LOCAL_FIRST_RUN_FACT_OWNERS: Readonly<Record<LocalFirstRunFactName, string>> = {
  slide_outcome_refs: 'guided-overlay',
  personalization_answer_refs: 'ask-questions-sort-answers-follow-up',
  selected_job_answer_ref: 'ask-questions-sort-answers-follow-up',
  ordered_selected_job_ids: 'ask-questions-sort-answers-follow-up',
  provider_selection_ref: 'selected-agent',
  service_connection_refs: 'service-connections',
  guided_cursor_ref: 'guided-overlay',
  guided_outcome_refs: 'guided-overlay',
  destination_intent_ref: 'ask-questions-sort-answers-follow-up',
};

const SINGULAR_FACTS = new Set<LocalFirstRunFactName>([
  'selected_job_answer_ref',
  'provider_selection_ref',
  'guided_cursor_ref',
  'destination_intent_ref',
]);

const ORDERED_LIST_FACTS = new Set<LocalFirstRunFactName>([
  'slide_outcome_refs',
  'personalization_answer_refs',
  'ordered_selected_job_ids',
  'service_connection_refs',
  'guided_outcome_refs',
]);

const SECRET_FACT_PATTERN = /credential|secret|token|password|entitlement/i;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contentAddress(value: unknown): string {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(value)));
}

export function localFirstRunFactOwner(fact: LocalFirstRunFactName): string {
  return LOCAL_FIRST_RUN_FACT_OWNERS[fact];
}

export function localFirstRunFactSupportsKeepBoth(fact: LocalFirstRunFactName): boolean {
  return ORDERED_LIST_FACTS.has(fact);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new LocalFirstRunAdoptionInputError(`${label} is required.`);
  return value.trim();
}

export function validateLocalFirstRunSource(
  value: unknown,
  fact: LocalFirstRunFactName,
): LocalFirstRunFactSource {
  if (!value || typeof value !== 'object') throw new LocalFirstRunAdoptionInputError(`${fact} source is invalid.`);
  const source = value as Record<string, unknown>;
  const owner = requiredText(source.owner, `${fact} source owner`);
  const ref = requiredText(source.ref, `${fact} source ref`);
  const contentHash = requiredText(source.content_hash, `${fact} source content hash`);
  if (owner !== LOCAL_FIRST_RUN_FACT_OWNERS[fact]) {
    throw new LocalFirstRunAdoptionInputError(`${fact} source owner is not authorized.`);
  }
  if (SECRET_FACT_PATTERN.test(ref) || SECRET_FACT_PATTERN.test(owner) || SECRET_FACT_PATTERN.test(contentHash)) {
    throw new LocalFirstRunAdoptionInputError(`${fact} may not carry credentials or account authority.`);
  }
  return { owner, ref, content_hash: contentHash };
}

function decodeSession(value: unknown): AccountSessionReadback {
  if (!value || typeof value !== 'object') {
    throw new LocalFirstRunAdoptionInputError('Signed-in account-session readback is required.');
  }
  const session = value as Record<string, unknown>;
  if (session.status !== 'signed_in') {
    throw new LocalFirstRunAdoptionInputError('Adoption requires a signed-in account-session readback.');
  }
  return {
    ref: requiredText(session.ref, 'Account-session readback ref'),
    accountIdHash: requiredText(session.accountIdHash, 'Account scope'),
    status: 'signed_in',
  };
}

export function decodeLocalFirstRunAdoptionRequest(value: unknown): LocalFirstRunAdoptionRequest {
  if (!value || typeof value !== 'object') throw new LocalFirstRunAdoptionInputError('Adoption request is invalid.');
  const request = value as Record<string, unknown>;
  if (request.schema !== LOCAL_FIRST_RUN_ADOPTION_REQUEST_SCHEMA) {
    throw new LocalFirstRunAdoptionInputError('Adoption request schema is invalid.');
  }
  if (request.kind !== 'local-first-run-adoption-request') {
    throw new LocalFirstRunAdoptionInputError('Adoption request kind is invalid.');
  }
  if (request.anonymous_scope !== LOCAL_FIRST_RUN_ANONYMOUS_SCOPE) {
    throw new LocalFirstRunAdoptionInputError('Adoption anonymous scope is invalid.');
  }
  const localBundleRef = requiredText(request.local_bundle_ref, 'Local bundle ref');
  const localBundleHash = requiredText(request.local_bundle_content_hash, 'Local bundle content hash');
  const idempotencyIdentity = requiredText(request.idempotency_identity, 'Adoption idempotency identity');
  const session = decodeSession(request.account_session_receipt);
  if (idempotencyIdentity !== `${session.accountIdHash}:${localBundleHash}`) {
    throw new LocalFirstRunAdoptionInputError('Adoption idempotency identity must be account scope + local bundle content hash.');
  }
  if (!request.facts || typeof request.facts !== 'object' || Array.isArray(request.facts)) {
    throw new LocalFirstRunAdoptionInputError('Adoption facts are required.');
  }

  const facts: LocalFirstRunFactSet = {};
  for (const [fact, raw] of Object.entries(request.facts as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(LOCAL_FIRST_RUN_FACT_OWNERS, fact)) {
      throw new LocalFirstRunAdoptionInputError(`Unknown first-run fact ${fact}.`);
    }
    const factName = fact as LocalFirstRunFactName;
    const rows = Array.isArray(raw) ? raw : [raw];
    if (SINGULAR_FACTS.has(factName) && rows.length > 1) {
      throw new LocalFirstRunAdoptionInputError(`${fact} accepts one source.`);
    }
    if (!rows.length) throw new LocalFirstRunAdoptionInputError(`${fact} must contain at least one source.`);
    facts[factName] = rows.map((row) => validateLocalFirstRunSource(row, factName));
  }

  return {
    schema: LOCAL_FIRST_RUN_ADOPTION_REQUEST_SCHEMA,
    kind: 'local-first-run-adoption-request',
    account_session_receipt: session,
    anonymous_scope: LOCAL_FIRST_RUN_ANONYMOUS_SCOPE,
    local_bundle_ref: localBundleRef,
    local_bundle_content_hash: localBundleHash,
    idempotency_identity: idempotencyIdentity,
    facts,
  };
}

function sameFact(a: LocalFirstRunFactSource, b: AccountFirstRunFactRecord): boolean {
  return a.owner === b.owner && a.ref === b.ref && a.content_hash === b.content_hash;
}

function isAdoptionReceipt(value: unknown): value is LocalFirstRunAdoptionReceipt {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Record<string, unknown>).schema === LOCAL_FIRST_RUN_ADOPTION_RECEIPT_SCHEMA,
  );
}

function selectedJobSummary(
  request: LocalFirstRunAdoptionRequest,
  accepted: readonly AcceptedLocalFirstRunFact[],
): string[] {
  const adopted = accepted
    .filter((fact) => fact.fact === 'ordered_selected_job_ids')
    .map((fact) => fact.destination_ref);
  return adopted.length ? adopted : (request.facts.ordered_selected_job_ids ?? []).map((source) => source.ref);
}

function buildReceipt(
  request: LocalFirstRunAdoptionRequest,
  adoptionId: string,
  priorState: LocalFirstRunAdoptionReceipt['prior_adoption_state'],
  accepted: AcceptedLocalFirstRunFact[],
  conflicts: PendingLocalFirstRunConflict[],
  retry: LocalFirstRunAdoptionRetry[],
  markerBlocked = false,
): LocalFirstRunAdoptionReceipt {
  const destination = accepted.find((fact) => fact.fact === 'destination_intent_ref')?.destination_ref ?? null;
  const blocked = markerBlocked || retry.length > 0;
  return {
    schema: LOCAL_FIRST_RUN_ADOPTION_RECEIPT_SCHEMA,
    kind: 'local-first-run-adoption-receipt',
    adoption_id: adoptionId,
    account_scope: request.account_session_receipt.accountIdHash,
    accepted_facts: accepted,
    pending_conflicts: conflicts,
    rejected_facts: [],
    prior_adoption_state: priorState,
    partial_failure: {
      state: blocked ? (markerBlocked && !retry.length ? 'blocked' : 'retryable') : 'not_applicable',
      completed_facts: accepted,
      retry_facts: retry,
      member_action: conflicts.length ? 'resolve-conflict' : blocked ? 'retry-now' : 'none',
    },
    destination_intent_ref: destination,
  };
}

export async function adoptLocalFirstRunState(
  input: unknown,
  effects: LocalFirstRunOwnerEffects,
  deletionState: AccountDeletionReadback,
): Promise<LocalFirstRunAdoptionReceipt> {
  const request = decodeLocalFirstRunAdoptionRequest(input);
  if (deletionState.deletionRequestedAt) {
    throw new LocalFirstRunAdoptionBlockedError(deletionState.deletionRequestedAt);
  }

  const accountScope = request.account_session_receipt.accountIdHash;
  const adoptionId = contentAddress({
    account_scope: accountScope,
    idempotency_identity: request.idempotency_identity,
  });
  const prior = await effects.readPriorAdoption({
    accountScope,
    idempotencyIdentity: request.idempotency_identity,
  });
  if (prior.status === 'same-idempotent-identity') {
    if (!isAdoptionReceipt(prior.receipt) || prior.receipt.adoption_id !== adoptionId) {
      throw new LocalFirstRunAdoptionInputError('Prior adoption receipt conflicts with the request identity.');
    }
    return { ...prior.receipt, prior_adoption_state: 'same-idempotent-identity' };
  }
  const priorState = prior.status === 'prior-adoption' ? 'superseded' : 'absent';

  const accepted: AcceptedLocalFirstRunFact[] = [];
  const conflicts: PendingLocalFirstRunConflict[] = [];
  const retry: LocalFirstRunAdoptionRetry[] = [];

  for (const fact of Object.keys(LOCAL_FIRST_RUN_FACT_OWNERS) as LocalFirstRunFactName[]) {
    const sources = request.facts[fact];
    if (!sources?.length) continue;
    const owner = LOCAL_FIRST_RUN_FACT_OWNERS[fact];
    try {
      const read = await effects.readAccountFact({ fact, owner, accountScope });
      const accountRecords = read.status === 'found' ? [...read.records] : [];
      if (accountRecords.length && sources.some((source) => !accountRecords.some((record) => sameFact(source, record)))) {
        accepted.push({ fact, destination_owner: owner, destination_ref: accountRecords[0].ref });
      }
      for (const source of sources) {
        const matchingAccount = accountRecords.find((record) => sameFact(source, record));
        if (matchingAccount) {
          accepted.push({ fact, destination_owner: owner, destination_ref: matchingAccount.ref });
          continue;
        }
        if (accountRecords.length) {
          const accountRecord = accountRecords[0];
          conflicts.push({
            fact,
            conflict_id: contentAddress({ adoptionId, fact, accountRef: accountRecord.ref, localRef: source.ref }),
            account_ref: accountRecord.ref,
            local_ref: source.ref,
            decision_required: 'keep-account|adopt-local|keep-both',
            keep_both_supported: localFirstRunFactSupportsKeepBoth(fact),
          });
          continue;
        }

        const written = await effects.writeAccountFact({
          fact,
          owner,
          accountScope,
          source,
          mode: ORDERED_LIST_FACTS.has(fact) ? 'append' : 'replace',
        });
        const readback = await effects.readAccountFact({ fact, owner, accountScope });
        const proved = readback.status === 'found'
          && readback.records.some((record) => sameFact(written, record) || sameFact(source, record));
        if (!proved) {
          retry.push({
            fact,
            source_ref: source.ref,
            retry_identity: contentAddress({ adoptionId, fact, sourceRef: source.ref }),
            typed_error: 'destination-owner-readback-missing',
          });
          continue;
        }
        accepted.push({ fact, destination_owner: owner, destination_ref: written.ref });
      }
    } catch (error) {
      if (error instanceof LocalFirstRunAdoptionInputError || error instanceof LocalFirstRunAdoptionBlockedError) throw error;
      for (const source of sources) {
        retry.push({
          fact,
          source_ref: source.ref,
          retry_identity: contentAddress({ adoptionId, fact, sourceRef: source.ref }),
          typed_error: error instanceof Error ? error.message : 'owner-unavailable',
        });
      }
    }
  }

  let markerBlocked = false;
  if (!retry.length && !conflicts.length) {
    try {
      writeLocalFirstRunProvenance({
        schema: 'account-session.local-first-run-adoption-marker/local',
        adoption_id: adoptionId,
        account_scope: accountScope,
        journey_id: LOCAL_FIRST_RUN_JOURNEY_ID,
        selected_job_ids: selectedJobSummary(request, accepted),
      });
    } catch {
      markerBlocked = true;
    }
  }

  const receipt = buildReceipt(request, adoptionId, priorState, accepted, conflicts, retry, markerBlocked);
  if (!markerBlocked && !retry.length) {
    const written = await effects.writeAdoptionReceipt(receipt);
    if (!isAdoptionReceipt(written) || written.adoption_id !== adoptionId) {
      throw new Error('adoption-receipt-owner-readback-missing');
    }
  }
  return receipt;
}
