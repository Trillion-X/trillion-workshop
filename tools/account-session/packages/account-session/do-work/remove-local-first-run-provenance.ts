import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

export const LOCAL_FIRST_RUN_PROVENANCE_STORAGE_KEY =
  'bitfield.account-session.local-first-run-provenance';
export const LOCAL_FIRST_RUN_REMOVE_PROVENANCE_REQUEST_SCHEMA =
  'account-session.remove-local-first-run-provenance-request/owner-scoped';
export const LOCAL_FIRST_RUN_REMOVE_PROVENANCE_RECEIPT_SCHEMA =
  'account-session.remove-local-first-run-provenance-receipt/owner-scoped';
export const LOCAL_FIRST_RUN_JOURNEY_ID = 'first-run.sign-in-last';

export interface LocalFirstRunProvenanceMarker {
  schema: 'account-session.local-first-run-adoption-marker/local';
  adoption_id: string;
  account_scope: string;
  journey_id: typeof LOCAL_FIRST_RUN_JOURNEY_ID;
  selected_job_ids: string[];
  marker_content_hash: string;
}

export interface RemoveLocalFirstRunProvenanceRequest {
  schema: typeof LOCAL_FIRST_RUN_REMOVE_PROVENANCE_REQUEST_SCHEMA;
  kind: 'remove-local-first-run-provenance-request';
  account_session_receipt: {
    status: 'signed_in';
    accountIdHash: string;
  };
  anonymous_scope: 'local-operator-or-browser';
  adoption_marker_content_hash: string;
}

export interface RemoveLocalFirstRunProvenanceReceipt {
  schema: typeof LOCAL_FIRST_RUN_REMOVE_PROVENANCE_RECEIPT_SCHEMA;
  kind: 'remove-local-first-run-provenance-receipt';
  adoption_id: string | null;
  account_unchanged: true;
  removed: boolean;
  removed_from_scope: 'local-operator-or-browser';
  business_event: {
    action: 'removed-local-first-run-provenance';
    journey_id: typeof LOCAL_FIRST_RUN_JOURNEY_ID;
    correlation_id: string | null;
    personal_payload_included: false;
  };
}

export class LocalFirstRunProvenanceInputError extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contentAddress(value: unknown): string {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(value)));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalFirstRunProvenanceInputError(`${label} is required.`);
  }
  return value.trim();
}

export function encodeLocalFirstRunProvenanceMarker(
  marker: Omit<LocalFirstRunProvenanceMarker, 'marker_content_hash'>,
): LocalFirstRunProvenanceMarker {
  if (!marker || marker.schema !== 'account-session.local-first-run-adoption-marker/local') {
    throw new LocalFirstRunProvenanceInputError('Local first-run marker schema is invalid.');
  }
  const adoptionId = requiredText(marker.adoption_id, 'Local first-run adoption id');
  const accountScope = requiredText(marker.account_scope, 'Local first-run account scope');
  if (marker.journey_id !== LOCAL_FIRST_RUN_JOURNEY_ID || !Array.isArray(marker.selected_job_ids)) {
    throw new LocalFirstRunProvenanceInputError('Local first-run marker summary is invalid.');
  }
  const selectedJobIds = marker.selected_job_ids.map((jobId) => {
    const selected = typeof jobId === 'string' ? jobId.trim() : '';
    if (!selected) throw new LocalFirstRunProvenanceInputError('Local first-run selected job ids are invalid.');
    return selected;
  });
  const identity = {
    schema: marker.schema,
    account_scope: accountScope,
    adoption_id: adoptionId,
    journey_id: marker.journey_id,
    selected_job_ids: selectedJobIds,
  };
  return { ...identity, marker_content_hash: contentAddress(identity) };
}

export function readLocalFirstRunProvenance(
  storage: Pick<Storage, 'getItem'> = globalThis.localStorage,
): LocalFirstRunProvenanceMarker | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem?.(LOCAL_FIRST_RUN_PROVENANCE_STORAGE_KEY) ?? null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalFirstRunProvenanceMarker>;
    const encoded = encodeLocalFirstRunProvenanceMarker({
      schema: parsed.schema,
      adoption_id: parsed.adoption_id,
      account_scope: parsed.account_scope,
      journey_id: parsed.journey_id,
      selected_job_ids: parsed.selected_job_ids,
    } as Omit<LocalFirstRunProvenanceMarker, 'marker_content_hash'>);
    if (parsed.marker_content_hash !== encoded.marker_content_hash) return null;
    return encoded;
  } catch {
    return null;
  }
}

export function writeLocalFirstRunProvenance(
  marker: Omit<LocalFirstRunProvenanceMarker, 'marker_content_hash'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = globalThis.localStorage,
): LocalFirstRunProvenanceMarker {
  const encoded = encodeLocalFirstRunProvenanceMarker(marker);
  storage?.setItem?.(LOCAL_FIRST_RUN_PROVENANCE_STORAGE_KEY, JSON.stringify(encoded));
  const readback = readLocalFirstRunProvenance(storage);
  if (!readback || readback.marker_content_hash !== encoded.marker_content_hash) {
    throw new Error('local-provenance-marker-write-readback-failed');
  }
  return encoded;
}

function decodeRemoveRequest(value: unknown): RemoveLocalFirstRunProvenanceRequest {
  if (!value || typeof value !== 'object') {
    throw new LocalFirstRunProvenanceInputError('Cleanup request is invalid.');
  }
  const request = value as Record<string, unknown>;
  if (
    request.schema !== LOCAL_FIRST_RUN_REMOVE_PROVENANCE_REQUEST_SCHEMA
    || request.kind !== 'remove-local-first-run-provenance-request'
  ) {
    throw new LocalFirstRunProvenanceInputError('Cleanup request schema or kind is invalid.');
  }
  const session = request.account_session_receipt;
  if (!session || typeof session !== 'object' || (session as Record<string, unknown>).status !== 'signed_in') {
    throw new LocalFirstRunProvenanceInputError('Local cleanup requires a signed-in account-session readback.');
  }
  if (request.anonymous_scope !== 'local-operator-or-browser') {
    throw new LocalFirstRunProvenanceInputError('Cleanup scope is invalid.');
  }
  return {
    schema: LOCAL_FIRST_RUN_REMOVE_PROVENANCE_REQUEST_SCHEMA,
    kind: 'remove-local-first-run-provenance-request',
    account_session_receipt: {
      status: 'signed_in',
      accountIdHash: requiredText(
        (session as Record<string, unknown>).accountIdHash,
        'Cleanup account scope',
      ),
    },
    anonymous_scope: 'local-operator-or-browser',
    adoption_marker_content_hash: requiredText(
      request.adoption_marker_content_hash,
      'Cleanup marker hash',
    ),
  };
}

export function removeLocalFirstRunProvenance(
  input: unknown,
  storage: Pick<Storage, 'getItem' | 'removeItem'> = globalThis.localStorage,
): RemoveLocalFirstRunProvenanceReceipt {
  const request = decodeRemoveRequest(input);
  const marker = readLocalFirstRunProvenance(storage);
  const markerMissingReceipt: RemoveLocalFirstRunProvenanceReceipt = {
    schema: LOCAL_FIRST_RUN_REMOVE_PROVENANCE_RECEIPT_SCHEMA,
    kind: 'remove-local-first-run-provenance-receipt',
    adoption_id: null,
    account_unchanged: true,
    removed: false,
    removed_from_scope: 'local-operator-or-browser',
    business_event: {
      action: 'removed-local-first-run-provenance',
      journey_id: LOCAL_FIRST_RUN_JOURNEY_ID,
      correlation_id: null,
      personal_payload_included: false,
    },
  };
  if (!marker || marker.marker_content_hash !== request.adoption_marker_content_hash) {
    return markerMissingReceipt;
  }

  storage.removeItem(LOCAL_FIRST_RUN_PROVENANCE_STORAGE_KEY);
  if (readLocalFirstRunProvenance(storage) !== null) {
    throw new Error('local-provenance-removal-readback-failed');
  }
  return {
    schema: LOCAL_FIRST_RUN_REMOVE_PROVENANCE_RECEIPT_SCHEMA,
    kind: 'remove-local-first-run-provenance-receipt',
    adoption_id: marker.adoption_id,
    account_unchanged: true,
    removed: true,
    removed_from_scope: 'local-operator-or-browser',
    business_event: {
      action: 'removed-local-first-run-provenance',
      journey_id: marker.journey_id,
      correlation_id: marker.adoption_id,
      personal_payload_included: false,
    },
  };
}
