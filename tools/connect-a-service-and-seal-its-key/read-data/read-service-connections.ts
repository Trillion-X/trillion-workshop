// packages/service-connections/read-data/read-service-connections.ts

import {
  ownerRecordColumnByKey,
  ownerRecordWorkContract,
  type OwnerRecordColumnDescriptor,
} from './owner-record-work-contract';

export type ServiceConnection = {
  id: string;
  serviceName: string;
  serviceVendor: string;
  /** User-set label for this account instance ("work@example.com", "Personal") — empty when never set */
  accountLabel: string;
  status: string;
  statusRef: string;
  canConnect: boolean;
  canSend: boolean;
  canRetry: boolean;
  isPending: boolean;
  scopes: string[];
  grantScopes: string[];
  grantScopesKnown: boolean;
  capabilityChoices: Record<string, 'enabled' | 'disabled'>;
  credentialHandle: string;
  credentialHandleRefs: string[];
  /** Opaque provider-resource identities addressable within this account. */
  resourceRefs: string[];
  connectedAt: string | null;
  proofRefs: string[];
  blockerRefs: string[];
  eventRefs: string[];
};

type ServiceConnectionRow = {
  id?: unknown;
  serviceName?: unknown;
  serviceVendor?: unknown;
  accountLabel?: unknown;
  account_label?: unknown;
  status?: unknown;
  status_ref?: unknown;
  statusRef?: unknown;
  can_connect?: unknown;
  canConnect?: unknown;
  can_send?: unknown;
  canSend?: unknown;
  can_retry?: unknown;
  canRetry?: unknown;
  is_pending?: unknown;
  isPending?: unknown;
  scopes?: unknown;
  grantScopes?: unknown;
  grant_scopes?: unknown;
  grantScopesKnown?: unknown;
  grant_scopes_known?: unknown;
  capabilityChoices?: unknown;
  capability_choices?: unknown;
  credentialHandle?: unknown;
  credential_handle_refs?: unknown;
  credentialHandleRefs?: unknown;
  resource_refs?: unknown;
  resourceRefs?: unknown;
  connectedAt?: unknown;
  proof_refs?: unknown;
  proofRefs?: unknown;
  blocker_refs?: unknown;
  blockerRefs?: unknown;
  event_refs?: unknown;
  eventRefs?: unknown;
};

type ServiceConnectionCursor = {
  rowCount: number;
  cellText(rowIndex: number, columnIndex: number): string | null;
};

function isServiceConnectionCursor(value: unknown): value is ServiceConnectionCursor {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as ServiceConnectionCursor).rowCount === 'number'
    && typeof (value as ServiceConnectionCursor).cellText === 'function';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return false;
}

function asScopes(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asScopes(parsed);
    } catch {
      return [];
    }
  }

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asStringArray(value: unknown): string[] {
  return asScopes(value);
}

function asCapabilityChoices(value: unknown): Record<string, 'enabled' | 'disabled'> {
  if (typeof value === 'string') {
    try { return asCapabilityChoices(JSON.parse(value) as unknown); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, 'enabled' | 'disabled'] =>
    Boolean(entry[0]) && (entry[1] === 'enabled' || entry[1] === 'disabled')));
}

function isServiceVendorSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/u.test(value);
}

function isServiceConnectionRowUsable(row: Pick<ServiceConnection, 'id' | 'serviceName' | 'serviceVendor'>): boolean {
  return row.id.length > 0
    && row.serviceName.trim().length > 0
    && isServiceVendorSlug(row.serviceVendor);
}

function legacyStatusFromDescriptorValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readCursorText(
  cursor: ServiceConnectionCursor,
  rowIndex: number,
  column: OwnerRecordColumnDescriptor | undefined,
): string {
  return typeof column?.column === 'number' ? cursor.cellText(rowIndex, column.column) ?? '' : '';
}

function decodeServiceConnectionCursor(cursor: ServiceConnectionCursor): ServiceConnection[] {
  const records: ServiceConnection[] = [];
  const columns = ownerRecordColumnByKey(ownerRecordWorkContract());

  for (let rowIndex = 0; rowIndex < cursor.rowCount; rowIndex += 1) {
    const id = readCursorText(cursor, rowIndex, columns.get('id'));
    if (!id) continue;

    const record = {
      id,
      serviceName: readCursorText(
        cursor,
        rowIndex,
        columns.get('serviceName'),
      ),
      serviceVendor: readCursorText(
        cursor,
        rowIndex,
        columns.get('serviceVendor'),
      ),
      accountLabel: readCursorText(
        cursor,
        rowIndex,
        columns.get('accountLabel'),
      ),
      statusRef: readCursorText(
        cursor,
        rowIndex,
        columns.get('statusRef'),
      ) || 'connection-status:not-connected',
      status: legacyStatusFromDescriptorValue(
        readCursorText(cursor, rowIndex, columns.get('status')),
      ),
      canConnect: asBoolean(readCursorText(
        cursor,
        rowIndex,
        columns.get('canConnect'),
      )),
      canSend: asBoolean(readCursorText(
        cursor,
        rowIndex,
        columns.get('canSend'),
      )),
      canRetry: asBoolean(readCursorText(
        cursor,
        rowIndex,
        columns.get('canRetry'),
      )),
      isPending: asBoolean(readCursorText(
        cursor,
        rowIndex,
        columns.get('isPending'),
      )),
      scopes: asScopes(readCursorText(
        cursor,
        rowIndex,
        columns.get('scopes'),
      )),
      grantScopes: asScopes(readCursorText(cursor, rowIndex, columns.get('grantScopes'))),
      grantScopesKnown: asBoolean(readCursorText(cursor, rowIndex, columns.get('grantScopesKnown'))),
      capabilityChoices: asCapabilityChoices(readCursorText(cursor, rowIndex, columns.get('capabilityChoices'))),
      credentialHandle: readCursorText(
        cursor,
        rowIndex,
        columns.get('credentialHandle'),
      ),
      credentialHandleRefs: asStringArray(readCursorText(
        cursor,
        rowIndex,
        columns.get('credentialHandleRefs'),
      )),
      resourceRefs: asStringArray(readCursorText(
        cursor,
        rowIndex,
        columns.get('resourceRefs'),
      )),
      connectedAt: readCursorText(
        cursor,
        rowIndex,
        columns.get('connectedAt'),
      ) || null,
      proofRefs: asStringArray(readCursorText(
        cursor,
        rowIndex,
        columns.get('proofRefs'),
      )),
      blockerRefs: asStringArray(readCursorText(
        cursor,
        rowIndex,
        columns.get('blockerRefs'),
      )),
      eventRefs: asStringArray(readCursorText(
        cursor,
        rowIndex,
        columns.get('eventRefs'),
      )),
    };

    if (isServiceConnectionRowUsable(record)) records.push(record);
  }

  return records;
}

export function decodeConnectionRows(raw: unknown): ServiceConnection[] {
  if (isServiceConnectionCursor(raw)) {
    return decodeServiceConnectionCursor(raw).sort((left, right) =>
      left.serviceName.localeCompare(right.serviceName) || left.id.localeCompare(right.id),
    );
  }

  const rows = Array.isArray(raw) ? raw : [];
  const records: ServiceConnection[] = [];

  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as ServiceConnectionRow;
    const id = asString(row.id);
    if (!id) continue;

    const record = {
      id,
      serviceName: asString(row.serviceName),
      serviceVendor: asString(row.serviceVendor),
      accountLabel: asString(row.accountLabel) || asString(row.account_label),
      statusRef: asString(row.statusRef) || asString(row.status_ref) || 'connection-status:not-connected',
      status: legacyStatusFromDescriptorValue(row.status),
      canConnect: asBoolean(row.canConnect ?? row.can_connect),
      canSend: asBoolean(row.canSend ?? row.can_send),
      canRetry: asBoolean(row.canRetry ?? row.can_retry),
      isPending: asBoolean(row.isPending ?? row.is_pending),
      scopes: asScopes(row.scopes),
      grantScopes: asScopes(row.grantScopes ?? row.grant_scopes),
      grantScopesKnown: asBoolean(row.grantScopesKnown ?? row.grant_scopes_known),
      capabilityChoices: asCapabilityChoices(row.capabilityChoices ?? row.capability_choices),
      credentialHandle: asString(row.credentialHandle),
      credentialHandleRefs: asStringArray(row.credentialHandleRefs ?? row.credential_handle_refs),
      resourceRefs: asStringArray(row.resourceRefs ?? row.resource_refs),
      connectedAt: asString(row.connectedAt) || null,
      proofRefs: asStringArray(row.proofRefs ?? row.proof_refs),
      blockerRefs: asStringArray(row.blockerRefs ?? row.blocker_refs),
      eventRefs: asStringArray(row.eventRefs ?? row.event_refs),
    };

    if (isServiceConnectionRowUsable(record)) records.push(record);
  }

  return records.sort((left, right) =>
    left.serviceName.localeCompare(right.serviceName) || left.id.localeCompare(right.id),
  );
}
