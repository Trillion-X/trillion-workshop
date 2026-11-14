export type PublishedRecord = {
  payload?: unknown;
};

export type ScreenAfterSignInCheckRecord = {
  customer_screen_label: string;
  id: string;
  sign_in_screen_label: string;
  signed_status: string;
  unsigned_status: string;
};

type RecordSource = unknown;

const DEFAULT_RECORD: ScreenAfterSignInCheckRecord = {
  customer_screen_label: 'Access',
  id: 'screen-after-sign-in-check:default',
  sign_in_screen_label: 'Sign in',
  signed_status: 'signed',
  unsigned_status: 'unsigned',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function payloads(source: RecordSource): unknown[] {
  const records = Array.isArray(source)
    ? source
    : isRecord(source) && Array.isArray(source.records)
      ? source.records
      : undefined;
  return records?.map((record) => (isRecord(record) && 'payload' in record ? record.payload : record)) ?? [];
}

export function readScreenAfterSignInCheckRecord(source: RecordSource): ScreenAfterSignInCheckRecord {
  for (const payload of payloads(source)) {
    if (!isRecord(payload) || payload.kind !== 'screen-after-sign-in-check-record') continue;
    return {
      customer_screen_label: readString(payload.customer_screen_label) ?? DEFAULT_RECORD.customer_screen_label,
      id: readString(payload.id) ?? DEFAULT_RECORD.id,
      sign_in_screen_label: readString(payload.sign_in_screen_label) ?? DEFAULT_RECORD.sign_in_screen_label,
      signed_status: readString(payload.signed_status) ?? DEFAULT_RECORD.signed_status,
      unsigned_status: readString(payload.unsigned_status) ?? DEFAULT_RECORD.unsigned_status,
    };
  }
  return DEFAULT_RECORD;
}
