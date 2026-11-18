import { decodeFeedRowsForSubject, type FeedItem } from '../read-data/read-item-records.ts';

export const ITEM_RECORD_FEED_REFRESH_EVENT = 'item-record:changed';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

function decodeReply(reply: unknown): JsonRecord {
  let value = record(reply);
  if (value && 'payload' in value) {
    const payload = value.payload;
    if (payload instanceof Uint8Array) value = record(JSON.parse(new TextDecoder().decode(payload)));
    else if (payload instanceof ArrayBuffer) value = record(JSON.parse(new TextDecoder().decode(new Uint8Array(payload))));
    else if (ArrayBuffer.isView(payload)) value = record(JSON.parse(new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))));
    else value = record(payload);
  }
  if (!value) throw new Error('item feed reply must be an object');
  return value;
}

/** The request for a subject's feed rows: the caller's host sends it and hands the reply back to readItemRecordFeed. */
export function itemRecordFeedRequest(subjectRef: string): { target: string; payload: JsonRecord } {
  const subject = typeof subjectRef === 'string' ? subjectRef.trim() : '';
  if (!subject) throw new Error('item feed subject is required');
  return { target: 'item-record.read-feed-items', payload: { subject_ref: subject, expected_revision: 0 } };
}

/** Feed rows for a subject from the reply the caller's host got for itemRecordFeedRequest; no reply, no rows. */
export function readItemRecordFeed(subjectRef: string, reply: unknown = null): FeedItem[] {
  const subject = typeof subjectRef === 'string' ? subjectRef.trim() : '';
  if (!subject) throw new Error('item feed subject is required');
  if (reply === null) return [];
  const decoded = decodeReply(reply);
  if (decoded.status !== 'accepted' || decoded.subject_ref !== subject || !Array.isArray(decoded.rows)) {
    throw new Error('item feed was not accepted for the requested subject');
  }
  return decodeFeedRowsForSubject(decoded.rows, subject);
}
