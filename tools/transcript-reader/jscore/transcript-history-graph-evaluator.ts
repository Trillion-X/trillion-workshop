import {
  readTranscriptHistoryRecordGraph,
  type ReadTranscriptHistoryGraphInput,
} from '@/packages/transcript-history/read-data/transcript-history-record-graph';
import {
  buildAcceptTranscriptRecordsRequest,
  type AcceptTranscriptRecordsActionDescriptor,
  type AcceptTranscriptRecordsContext,
} from '@/packages/transcript-history/do-work/accept-transcript-records';

export interface TranscriptHistoryGraphEvaluatorInput extends ReadTranscriptHistoryGraphInput {
  action?: AcceptTranscriptRecordsActionDescriptor;
  actionContext?: AcceptTranscriptRecordsContext;
}

export function evaluateTranscriptHistoryGraph(input: TranscriptHistoryGraphEvaluatorInput) {
  const model = readTranscriptHistoryRecordGraph(input);
  const actionContext = input.actionContext
    ? { ...input.actionContext, selected: input.actionContext.selected ?? model.items[0] ?? null }
    : { selected: model.items[0] ?? null };
  return {
    model,
    actionRequest: input.action ? buildAcceptTranscriptRecordsRequest(input.action, actionContext) : null,
    proof: {
      evaluator: 'transcript-history-graph-evaluator',
      modelRevision: model.revision,
    },
  };
}
