import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  LiveMatchFormat,
  LiveMatchRecord,
  LiveMatchScoringModel,
  LiveMatchTeam,
  LiveScoreEventRecord,
  LiveScorePayload,
} from '../read-data/live-match-score-types.ts';
import { findScoringRule, REFERENCE_SCORING_RULES } from '../read-data/scoring-rules.ts';

export const START_LIVE_MATCH_ACTION = 'action:live-match-score.start-match';

export type StartLiveMatchDraft = {
  matchId?: string;
  shareId?: string;
  initialEventId?: string;
  scoringRuleRef: string;
  matchFormat: LiveMatchFormat;
  teamAPlayers: readonly string[];
  teamBPlayers: readonly string[];
  teamALabel?: string;
  teamBLabel?: string;
  createdBy?: string;
  scoringModel?: Partial<LiveMatchScoringModel>;
  now?: Date;
};

export type StartLiveMatchInput = {
  match_id: string;
  event_id: string;
  match_record: LiveMatchRecord;
  initial_event_record: LiveScoreEventRecord;
};

/** Resolve a scoring-rule record's model by ref (DATA), replacing the old
 *  `defaultScoringModel(sport)` sport branch. An unknown/absent ref falls back to
 *  the first reference rule (findScoringRule's behavior) — never a sport literal.
 *  The open set of rules is the open set of "sports": a new rule is a DATA row. */
function scoringModelForRule(scoringRuleRef: string): LiveMatchScoringModel {
  return findScoringRule(REFERENCE_SCORING_RULES, scoringRuleRef)!.scoringModel;
}

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function cleanPlayers(players: readonly string[]): string[] {
  return players.map((player) => player.trim()).filter(Boolean);
}

function teamLabel(players: readonly string[], fallback: string): string {
  return cleanPlayers(players).join(' / ') || fallback;
}

function validateRoster(matchFormat: LiveMatchFormat, teamA: readonly string[], teamB: readonly string[]) {
  const required = matchFormat === 'doubles' ? 2 : 1;
  if (cleanPlayers(teamA).length < required || cleanPlayers(teamB).length < required) {
    throw new Error(matchFormat === 'doubles' ? 'Doubles needs two players on each side' : 'Singles needs one player on each side');
  }
}

function buildTeam(teamId: 'team-a' | 'team-b', players: readonly string[], label: string | undefined): LiveMatchTeam {
  const cleaned = cleanPlayers(players);
  return {
    teamId,
    label: label?.trim() || teamLabel(cleaned, teamId === 'team-a' ? 'Team A' : 'Team B'),
    players: cleaned,
  };
}

function initialScorePayload(): LiveScorePayload {
  return {
    setNumber: 1,
    teamScores: {
      'team-a': 0,
      'team-b': 0,
    },
    pointScores: {
      'team-a': 0,
      'team-b': 0,
    },
    gameScores: {
      'team-a': 0,
      'team-b': 0,
    },
    setScores: {
      'team-a': 0,
      'team-b': 0,
    },
    displayScores: {
      'team-a': '0',
      'team-b': '0',
    },
    scoringPhase: 'standard',
  };
}

export function buildStartLiveMatchInput(draft: StartLiveMatchDraft): StartLiveMatchInput {
  validateRoster(draft.matchFormat, draft.teamAPlayers, draft.teamBPlayers);
  const createdAt = (draft.now ?? new Date()).toISOString();
  const matchId = draft.matchId ?? generatedId('live-match');
  const eventId = draft.initialEventId ?? generatedId('live-score-event');
  const shareId = draft.shareId ?? generatedId('live-match-share');
  const match_record: LiveMatchRecord = {
    kind: 'live-match',
    matchId,
    scoringRuleRef: draft.scoringRuleRef,
    matchFormat: draft.matchFormat,
    teams: [
      buildTeam('team-a', draft.teamAPlayers, draft.teamALabel),
      buildTeam('team-b', draft.teamBPlayers, draft.teamBLabel),
    ],
    scoringModel: {
      ...scoringModelForRule(draft.scoringRuleRef),
      ...draft.scoringModel,
    },
    status: 'live',
    share: {
      shareId,
      publicPath: `/live/${encodeURIComponent(matchId)}`,
      enabled: true,
    },
    createdBy: draft.createdBy,
    createdAt,
  };
  return {
    match_id: matchId,
    event_id: eventId,
    match_record,
    initial_event_record: {
      kind: 'live-score-event',
      eventId,
      matchId,
      sequence: 0,
      actorId: draft.createdBy,
      eventKind: 'start',
      score: initialScorePayload(),
      localState: 'confirmed',
      createdAt,
    },
  };
}

export function startLiveMatch(input: StartLiveMatchInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: START_LIVE_MATCH_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
