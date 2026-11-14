import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
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

/** Read current feed rows through the session-admitted browser doorway. */
export async function readItemRecordFeed(subjectRef: string): Promise<FeedItem[]> {
  const subject = typeof subjectRef === 'string' ? subjectRef.trim() : '';
  if (!subject) throw new Error('item feed subject is required');
  const reply = decodeReply(await sendRequestToBitfieldTarget({
    target: 'item-record.read-feed-items',
    payload: { subject_ref: subject, expected_revision: 0 },
  }));
  if (reply.status !== 'accepted' || reply.subject_ref !== subject || !Array.isArray(reply.rows)) {
    throw new Error('item feed was not accepted for the requested subject');
  }
  return decodeFeedRowsForSubject(reply.rows, subject);
}
