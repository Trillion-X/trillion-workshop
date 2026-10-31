// tools/match-picks/do-work/tally-match-picks.mjs
//
// The command of tool:tally-match-picks. One JSON request on standard input:
//   { rows: [...records], picker_id? }
// and { result: { matches, history? } } out: every match with the community split, its result and (with picker_id) that
// picker's own pick, and (with picker_id) that picker's history with right and wrong marked.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { matchPickPersonalHistory, matchPickViews, readPicksState } from '../read-data/match-picks.mjs';

export function tallyMatchPicks(input) {
  if (!Array.isArray(input?.rows)) throw new Error('rows must be a list of records (pick-match, match-pick, match-pick-result).');
  const state = readPicksState(input.rows);
  const answer = { matches: matchPickViews(state, input.picker_id) };
  if (input.picker_id !== undefined) answer.history = matchPickPersonalHistory(state, input.picker_id);
  return answer;
}

await runAsMain(import.meta.url, tallyMatchPicks);
