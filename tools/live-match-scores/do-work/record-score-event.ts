import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  LiveMatchRecord,
  LiveScoreEventKind,
  LiveScoreEventRecord,
  LiveScoreLocalState,
  LiveScorePayload,
  LiveScoreSide,
} from '../read-data/live-match-score-types.ts';
import { scorePointForSide } from '../read-data/read-live-match-score.ts';

export const RECORD_SCORE_EVENT_ACTION = 'action:live-match-score.record-event';

export type RecordScoreEventDraft = {
  eventId?: string;
  matchId: string;
  sequence: number;
  actorId?: string;
  eventKind?: LiveScoreEventKind;
  score: LiveScorePayload;
  localState?: LiveScoreLocalState;
  now?: Date;
};

export type AdvanceScoreEventDraft = Omit<RecordScoreEventDraft, 'eventKind' | 'score'> & {
  match: LiveMatchRecord;
  currentScore: LiveScorePayload;
  side: LiveScoreSide;
};

export type RecordScoreEventInput = {
  event_id: string;
  event_record: LiveScoreEventRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function assertScore(score: LiveScorePayload) {
  for (const pair of [score.teamScores, score.pointScores, score.gameScores, score.setScores]) {
    if (!pair) continue;
    for (const value of Object.values(pair)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('Scores must be whole numbers at or above 0');
      }
    }
  }
}

export function buildRecordScoreEventInput(draft: RecordScoreEventDraft): RecordScoreEventInput {
  if (!Number.isInteger(draft.sequence) || draft.sequence < 1) {
    throw new Error('Score event sequence must be a whole number above 0');
  }
  assertScore(draft.score);
  const eventId = draft.eventId ?? generatedId('live-score-event');
  return {
    event_id: eventId,
    event_record: {
      kind: 'live-score-event',
      eventId,
      matchId: draft.matchId,
      sequence: draft.sequence,
      actorId: draft.actorId,
      eventKind: draft.eventKind ?? 'score',
      score: draft.score,
      localState: draft.localState ?? 'confirmed',
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function buildAdvanceScoreEventInput(draft: AdvanceScoreEventDraft): RecordScoreEventInput {
  return buildRecordScoreEventInput({
    ...draft,
    eventKind: 'score',
    score: scorePointForSide(draft.match, draft.currentScore, draft.side),
  });
}

export function recordScoreEvent(input: RecordScoreEventInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_SCORE_EVENT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
