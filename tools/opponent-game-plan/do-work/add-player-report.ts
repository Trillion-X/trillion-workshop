import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  ScoutingVisibility,
  TennisHand,
  TennisPlayerIdentity,
  TennisPlayerReport,
  TennisPlayerStyle,
} from '../read-data/opponent-game-plan-types.ts';

export const ADD_PLAYER_REPORT_ACTION = 'action:opponent-game-plan.add-report';

export type AddPlayerReportDraft = {
  playerId: string;
  playerName: string;
  hand?: TennisHand;
  isSelf?: boolean;
  reportId?: string;
  authorId: string;
  visibility?: ScoutingVisibility;
  styleLabels?: TennisPlayerStyle[];
  strengths?: string[];
  weaknesses?: string[];
  strategiesWorked?: string[];
  strategiesFailed?: string[];
  notes?: string;
  confidence?: number;
  now?: Date;
};

export type AddPlayerReportInput = {
  player_id: string;
  player_record: TennisPlayerIdentity;
  evidence_id: string;
  report_record: TennisPlayerReport;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function cleanList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export function buildAddPlayerReportInput(draft: AddPlayerReportDraft): AddPlayerReportInput {
  const createdAt = (draft.now ?? new Date()).toISOString();
  const reportId = draft.reportId ?? generatedId('evidence');
  const visibility = draft.visibility ?? 'private';
  return {
    player_id: draft.playerId,
    player_record: {
      kind: 'subject',
      subjectId: draft.playerId,
      subjectKind: 'tennis-player',
      label: draft.playerName,
      payload: {
        hand: draft.hand,
        isSelf: draft.isSelf,
      },
      createdAt,
    },
    evidence_id: reportId,
    report_record: {
      kind: 'evidence',
      evidenceId: reportId,
      subject: {
        id: draft.playerId,
        kind: 'tennis-player',
        label: draft.playerName,
      },
      evidenceKind: 'player-report',
      source: {
        sourceId: draft.authorId,
        visibility,
        confidence: draft.confidence,
      },
      payload: {
        authorId: draft.authorId,
        visibility,
        styleLabels: draft.styleLabels ?? [],
        strengths: cleanList(draft.strengths),
        weaknesses: cleanList(draft.weaknesses),
        strategiesWorked: cleanList(draft.strategiesWorked),
        strategiesFailed: cleanList(draft.strategiesFailed),
        notes: draft.notes?.trim() || undefined,
        confidence: draft.confidence,
      },
      createdAt,
    },
  };
}

export function addPlayerReport(input: AddPlayerReportInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ADD_PLAYER_REPORT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
