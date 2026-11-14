import {
  readGenericRecordWorkGraph,
  type WorkGraphAction,
  type WorkGraphProjection,
  type WorkGraphRecord,
} from './generic-record-work-graph.ts';

export type OutsideConversation = WorkGraphRecord;
export type OutsideConversationsSurface = WorkGraphProjection;

export function decodeOutsideConversationsSurface(raw: unknown): OutsideConversationsSurface {
  return readGenericRecordWorkGraph(raw);
}

export type { WorkGraphAction, WorkGraphProjection, WorkGraphRecord };
