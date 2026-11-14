import { decodeSourceOffer, type SourceOffer } from './read-source-offers';

type JsonRecord = Record<string, unknown>;

export const AUTHORIZED_SOURCE_OFFER_QUERY_REF = 'source-offers:authorized-materializable/v1';
export const MAX_AUTHORIZED_SOURCE_OFFERS_PER_PAGE = 16;

export type SourceOfferAuthorityDecision = {
  readonly kind: 'connected-source' | 'local-access';
  readonly offer_address: string;
  readonly offer_content_hash: string;
  readonly principal_ref: string;
  readonly source_ref: string;
  readonly operation_ref: string;
  readonly authority_ref: string;
  readonly authority_revision: string;
  readonly expires_at: string;
  readonly revoked: boolean;
  readonly allowed: boolean;
  readonly metadata_visible: boolean;
  readonly connection_ref?: string;
  readonly resource_refs?: readonly string[];
};

export type AuthorizedSourceOfferCursor = {
  readonly query_ref: typeof AUTHORIZED_SOURCE_OFFER_QUERY_REF;
  readonly principal_ref: string;
  readonly offer_snapshot_digest: string;
  readonly authority_snapshot_digest: string;
  readonly connection_snapshot_digest: string;
  readonly after_address: string;
};

export type AuthorizedSourceOffer = {
  readonly offer_address: string;
  readonly offer_content_hash: string;
  readonly source_ref: string;
  readonly authority_ref: string;
  readonly authority_revision: string;
  readonly expires_at: string;
  readonly connection_ref?: string;
  readonly materializer_ref: {
    readonly target: string;
    readonly operation_ref: string;
    readonly payload_template?: Readonly<JsonRecord>;
  };
  readonly output_contract: SourceOffer['output_contract'];
};

export type AuthorizedSourceOfferPage = {
  readonly offers: readonly AuthorizedSourceOffer[];
  readonly next_cursor: AuthorizedSourceOfferCursor | null;
  readonly missing_scope: readonly {
    readonly offer_address: string;
    readonly source_ref: string;
    readonly reason: 'authority_missing' | 'authority_expired' | 'authority_revoked' | 'principal_mismatch' | 'scope_mismatch';
  }[];
  readonly hidden_unavailable_count: number;
  readonly snapshot: {
    readonly offer_digest: string;
    readonly authority_digest: string;
    readonly connection_digest: string;
  };
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function exactString(value: unknown, label: string): string {
  const result = text(value);
  if (!result || result.length > 1024) throw new Error(`${label} is invalid.`);
  return result;
}

function compareAddress(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function materializerOperationRef(offer: SourceOffer): string {
  const template = record(offer.materializer.payload_template);
  const definitionId = text(template?.definition_id);
  const operation = text(template?.operation);
  if (offer.materializer.target === 'slot::workflow') {
    if (operation !== 'execute_definition' || !definitionId.startsWith('action:')) {
      throw new Error('Source offer materializer does not name a workflow action.');
    }
    return definitionId;
  }
  const declared = text(template?.operation_ref);
  if (!declared) throw new Error('Source offer materializer does not declare an operation reference.');
  return declared;
}

function cursorMatches(
  cursor: AuthorizedSourceOfferCursor,
  expected: Omit<AuthorizedSourceOfferCursor, 'after_address'>,
): boolean {
  return cursor.query_ref === expected.query_ref
    && cursor.principal_ref === expected.principal_ref
    && cursor.offer_snapshot_digest === expected.offer_snapshot_digest
    && cursor.authority_snapshot_digest === expected.authority_snapshot_digest
    && cursor.connection_snapshot_digest === expected.connection_snapshot_digest
    && !!text(cursor.after_address);
}

/**
 * Page source-offer metadata only after a current access owner has evaluated
 * the trusted runtime principal against the exact source and materializer
 * operation. This function never treats descriptor availability, connection
 * status, or principal identity as authorization.
 */
export function discoverAuthorizedSourceOffers(input: {
  readonly rows: readonly unknown[];
  readonly authority_decisions: readonly SourceOfferAuthorityDecision[];
  readonly trusted_principal_ref: string;
  readonly now: string;
  readonly offer_snapshot_digest: string;
  readonly authority_snapshot_digest: string;
  readonly connection_snapshot_digest: string;
  readonly cursor?: AuthorizedSourceOfferCursor | null;
  readonly limit?: number;
}): AuthorizedSourceOfferPage {
  const principalRef = exactString(input.trusted_principal_ref, 'trusted principal');
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('Current time is invalid.');
  const limit = input.limit ?? MAX_AUTHORIZED_SOURCE_OFFERS_PER_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUTHORIZED_SOURCE_OFFERS_PER_PAGE) {
    throw new Error('Source offer page limit must be an integer from 1 to 16.');
  }
  const base = {
    query_ref: AUTHORIZED_SOURCE_OFFER_QUERY_REF,
    principal_ref: principalRef,
    offer_snapshot_digest: exactString(input.offer_snapshot_digest, 'offer snapshot digest'),
    authority_snapshot_digest: exactString(input.authority_snapshot_digest, 'authority snapshot digest'),
    connection_snapshot_digest: exactString(input.connection_snapshot_digest, 'connection snapshot digest'),
  } as const;
  if (input.cursor && !cursorMatches(input.cursor, base)) {
    throw new Error('Source offer cursor is stale or belongs to a different authority scope.');
  }

  const decisions = new Map<string, SourceOfferAuthorityDecision>();
  for (const decision of input.authority_decisions) {
    if (decisions.has(decision.offer_address)) throw new Error('Source offer authority decisions are ambiguous.');
    decisions.set(decision.offer_address, decision);
  }
  const candidates = input.rows.flatMap((row) => {
    const value = record(row);
    const address = text(value?.address);
    const contentHash = text(value?.content_hash);
    const offer = decodeSourceOffer(value?.payload);
    return address && contentHash && offer ? [{ address, contentHash, offer }] : [];
  }).sort((left, right) => compareAddress(left.address, right.address));
  if (candidates.some((candidate, index) => index > 0 && candidate.address === candidates[index - 1].address)) {
    throw new Error('Source offer rows are ambiguous.');
  }
  if (input.cursor && !candidates.some((candidate) => candidate.address === input.cursor?.after_address)) {
    throw new Error('Source offer cursor does not identify a row in its bound snapshot.');
  }
  const cursorIndex = input.cursor
    ? candidates.findIndex((candidate) => candidate.address === input.cursor?.after_address)
    : -1;
  const after = input.cursor?.after_address ?? '';
  const eligible = candidates.slice(cursorIndex + 1);
  const offers: AuthorizedSourceOffer[] = [];
  const missingScope: AuthorizedSourceOfferPage['missing_scope'][number][] = [];
  let hiddenUnavailableCount = 0;
  let lastExamined = after;
  let examined = 0;

  for (const candidate of eligible) {
    if (examined === limit) break;
    examined += 1;
    lastExamined = candidate.address;
    const operationRef = materializerOperationRef(candidate.offer);
    const decision = decisions.get(candidate.address);
    let reason: AuthorizedSourceOfferPage['missing_scope'][number]['reason'] | null = null;
    if (!decision) reason = 'authority_missing';
    else if (decision.principal_ref !== principalRef) reason = 'principal_mismatch';
    else if (decision.revoked) reason = 'authority_revoked';
    else if (!Number.isFinite(Date.parse(decision.expires_at)) || Date.parse(decision.expires_at) <= nowMs) reason = 'authority_expired';
    else if (!decision.allowed
      || candidate.offer.availability.is_available !== true
      || decision.offer_content_hash !== candidate.contentHash
      || decision.source_ref !== candidate.offer.provenance.source_ref
      || !Array.isArray(decision.resource_refs)
      || !decision.resource_refs.includes(candidate.offer.provenance.source_ref)
      || decision.operation_ref !== operationRef
      || decision.authority_ref !== candidate.offer.availability.authority_ref
      || (candidate.offer.connection_ref
        ? decision.kind !== 'connected-source' || decision.connection_ref !== candidate.offer.connection_ref
        : decision.kind !== 'local-access')) reason = 'scope_mismatch';

    if (reason) {
      if (decision?.principal_ref === principalRef && decision.metadata_visible === true) {
        missingScope.push({ offer_address: candidate.address, source_ref: candidate.offer.provenance.source_ref, reason });
      } else {
        hiddenUnavailableCount += 1;
      }
      continue;
    }
    offers.push({
      offer_address: candidate.address,
      offer_content_hash: candidate.contentHash,
      source_ref: candidate.offer.provenance.source_ref,
      authority_ref: decision!.authority_ref,
      authority_revision: exactString(decision!.authority_revision, 'authority revision'),
      expires_at: decision!.expires_at,
      ...(candidate.offer.connection_ref ? { connection_ref: candidate.offer.connection_ref } : {}),
      materializer_ref: {
        target: candidate.offer.materializer.target,
        operation_ref: operationRef,
        ...(candidate.offer.materializer.payload_template ? { payload_template: candidate.offer.materializer.payload_template } : {}),
      },
      output_contract: candidate.offer.output_contract,
    });
  }

  const hasMore = examined < eligible.length;
  return {
    offers,
    next_cursor: hasMore ? { ...base, after_address: lastExamined } : null,
    missing_scope: missingScope,
    hidden_unavailable_count: hiddenUnavailableCount,
    snapshot: {
      offer_digest: base.offer_snapshot_digest,
      authority_digest: base.authority_snapshot_digest,
      connection_digest: base.connection_snapshot_digest,
    },
  };
}
