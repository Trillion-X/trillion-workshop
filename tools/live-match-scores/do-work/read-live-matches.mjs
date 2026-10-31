// tools/live-match-scores/do-work/read-live-matches.mjs
//
// The command of tool:read-live-matches. One JSON request on standard input:
//   { rows: [...records], match_id? }
// and { result: { matches, board, match?, next_sequence? } } out. `matches` are every match, newest first, each with the
// scorer's score, the spectator view (no actor ids, no tap still pending-offline) and its linked context; `board` is the
// rows for a schedule, bracket, standings and leaderboard; with `match_id` the answer also gives that match's `match`
// view and the `next_sequence` a new event takes.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { boardProjection, matchView, matchViews, nextSequenceForMatch, readMatchState } from '../read-data/match-replay.mjs';

export function readLiveMatches(input) {
  if (!Array.isArray(input?.rows)) throw new Error('rows must be a list of records.');
  const state = readMatchState(input.rows);
  const answer = { matches: matchViews(state), board: boardProjection(state) };
  if (input.match_id !== undefined) {
    const view = matchView(state, input.match_id);
    if (!view) throw new Error(`No live match ${JSON.stringify(input.match_id)} in rows.`);
    answer.match = view;
    answer.next_sequence = nextSequenceForMatch(state, input.match_id);
  }
  return answer;
}

await runAsMain(import.meta.url, readLiveMatches);
