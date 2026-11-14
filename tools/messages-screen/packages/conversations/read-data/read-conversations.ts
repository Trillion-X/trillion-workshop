import {
  decodeGenericRecordProjection,
  type GenericRecordProjection,
  type ProjectionRecord,
} from './record-projection';

export type ConversationRecord = ProjectionRecord;
export type ConversationRecordListProjection = GenericRecordProjection;

export function decodeConversationRecordList(raw: unknown): ConversationRecordListProjection {
  return decodeGenericRecordProjection(raw);
}
