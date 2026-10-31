// tools/live-match-scores/do-work/score-a-match.mjs
//
// The command of tool:score-a-match. One JSON request on standard input, { result } out. `operation` is one of:
//   start-match   { scoring_rule_ref, match_format, team_a_players, team_b_players, scoring_rules?, team_a_label?,
//                   team_b_label?, created_by?, scoring_model?, match_id?, share_id?, event_id?, share_path_prefix?, now? }
//                 -> { match_record, initial_event_record }
//   score-point   { rows, match_id, side, actor_id?, event_id?, local_state?, now? } -> { event_record, score }
//   undo-point    { rows, match_id, actor_id?, event_id?, now? } -> { event_record, score }: the score before the latest
//                 event, written as a new event (the log only grows)
//   record-score  { rows, match_id, score, actor_id?, event_id?, local_state?, now? } -> { event_record, score }: a score
//                 the scorer typed in, checked for whole numbers
//   link-context  { match_id, tournament_id?, schedule_row_id?, bracket_match_id?, standing_id?, leaderboard_id?,
//                   context_id?, now? } -> { context_record }
// `rows` are the records read for the match (their match, events and links); every answer is records for the caller to
// write, and nothing is kept here. `now` is an ISO time (the clock when absent); ids are made when absent.
import { randomUUID } from 'node:crypto';
import { runAsMain } from '../read-data/run-as-main.mjs';
import { bundledScoringRules } from '../read-data/scoring-rules.mjs';
import { assertScore, buildMatchRecord, initialScorePayload, scorePointForSide } from '../read-data/match-scoring.mjs';
import { matchView, nextSequenceForMatch, previousScoreForMatch, readMatchState } from '../read-data/match-replay.mjs';

const idOr = (given, prefix) => given ?? `${prefix}:${randomUUID()}`;

function timeOf(now) {
  const when = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(when.getTime())) throw new Error('now must be an ISO time such as 2026-01-01T09:00:00Z.');
  return when.toISOString();
}

function startMatch(input) {
  const createdAt = timeOf(input.now);
  const matchId = idOr(input.match_id, 'live-match');
  const eventId = idOr(input.event_id, 'live-score-event');
  const matchRecord = buildMatchRecord({
    ...input,
    match_id: matchId,
    share_id: idOr(input.share_id, 'live-match-share'),
    share_path_prefix: input.share_path_prefix ?? '/live/',
    created_at: createdAt,
  }, input.scoring_rules ?? bundledScoringRules);
  return {
    match_record: matchRecord,
    initial_event_record: {
      kind: 'live-score-event',
      eventId,
      matchId,
      sequence: 0,
      actorId: input.created_by,
      eventKind: 'start',
      score: initialScorePayload(),
      localState: 'confirmed',
      createdAt,
    },
  };
}

function eventAfter(input, score) {
  const state = readMatchState(input.rows);
  const view = matchView(state, input.match_id);
  if (!view) throw new Error(`No live match ${JSON.stringify(input.match_id)} in rows: give the match's records as rows.`);
  const next = score(view, state);
  assertScore(next);
  const localState = input.local_state ?? 'confirmed';
  if (!['confirmed', 'pending-offline', 'reconciled'].includes(localState)) throw new Error('local_state must be confirmed, pending-offline or reconciled.');
  return {
    event_record: {
      kind: 'live-score-event',
      eventId: idOr(input.event_id, 'live-score-event'),
      matchId: input.match_id,
      sequence: nextSequenceForMatch(state, input.match_id),
      actorId: input.actor_id,
      eventKind: 'score',
      score: next,
      localState,
      createdAt: timeOf(input.now),
    },
    score: next,
  };
}

function linkContext(input) {
  if (!input.match_id) throw new Error('match_id is required.');
  return {
    context_record: {
      kind: 'live-match-context-link',
      contextId: idOr(input.context_id, 'live-match-context'),
      matchId: input.match_id,
      tournamentId: input.tournament_id,
      scheduleRowId: input.schedule_row_id,
      bracketMatchId: input.bracket_match_id,
      standingId: input.standing_id,
      leaderboardId: input.leaderboard_id,
      createdAt: timeOf(input.now),
    },
  };
}

export function scoreAMatch(input) {
  switch (input?.operation) {
    case 'start-match': return startMatch(input);
    case 'score-point': return eventAfter(input, view => scorePointForSide(view.match, view.score, input.side));
    case 'undo-point': return eventAfter(input, (view, state) => {
      const previous = previousScoreForMatch(state, input.match_id);
      if (!previous) throw new Error('No saved point to undo.');
      return previous;
    });
    case 'record-score': return eventAfter(input, () => {
      if (!input.score?.teamScores || !Number.isInteger(input.score.setNumber)) throw new Error('score needs setNumber and teamScores.');
      return input.score;
    });
    case 'link-context': return linkContext(input);
    default: throw new Error('operation must be start-match, score-point, undo-point, record-score or link-context.');
  }
}

await runAsMain(import.meta.url, scoreAMatch);
