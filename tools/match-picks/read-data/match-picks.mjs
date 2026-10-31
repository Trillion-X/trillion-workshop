// tools/match-picks/read-data/match-picks.mjs
//
// Free match picks, read from records. Three kinds of record:
//   pick-match         { kind, matchId, label, startsAt?, choices: [{ choiceId, label }], status }
//   match-pick         { kind, pickId, matchId, pickerId, choiceId, createdAt }
//   match-pick-result  { kind, resultId, matchId, winningChoiceId, summary, resolvedAt }
// A picker may change their pick: the community split counts each picker's latest pick for a match once. A match's result
// is its latest result record. A row may be the record itself or { payload } / { value } holding it.

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const payloadOf = row => (isRecord(row) ? (row.payload ?? row.value ?? row) : row);
const kindOf = value => (isRecord(value) && typeof value.kind === 'string' ? value.kind : '');

// The item with the greatest value; of equal values, the one listed last.
function latestBy(items, valueOf) {
  return items.reduce((best, item) => (best === undefined || valueOf(item).localeCompare(valueOf(best)) >= 0 ? item : best), undefined);
}

export function readPicksState(rows) {
  const values = Array.isArray(rows) ? rows.map(payloadOf) : [];
  const of = kind => values.filter(value => kindOf(value) === kind);
  return { matches: of('pick-match'), picks: of('match-pick'), results: of('match-pick-result') };
}

// Each picker's latest pick for a match, one per picker.
function currentPicks(picks) {
  const byPicker = new Map();
  for (const pick of picks) {
    if (byPicker.get(pick.pickerId) === undefined || pick.createdAt.localeCompare(byPicker.get(pick.pickerId).createdAt) >= 0) byPicker.set(pick.pickerId, pick);
  }
  return [...byPicker.values()];
}

const resultOf = (state, matchId) => latestBy(state.results.filter(result => result.matchId === matchId), result => result.resolvedAt);

// Every match with the community split (a count and a whole percent per choice, rounded), the winner once resolved, and
// the given picker's own latest pick.
export function matchPickViews(state, pickerId) {
  return state.matches
    .map(match => {
      const picks = currentPicks(state.picks.filter(pick => pick.matchId === match.matchId));
      const result = resultOf(state, match.matchId);
      const userPick = pickerId === undefined ? undefined : picks.find(pick => pick.pickerId === pickerId);
      return {
        match,
        totalPicks: picks.length,
        result,
        userPick,
        choices: match.choices.map(choice => {
          const pickCount = picks.filter(pick => pick.choiceId === choice.choiceId).length;
          return {
            ...choice,
            pickCount,
            percentPicked: picks.length > 0 ? Math.round((pickCount / picks.length) * 100) : 0,
            selectedByUser: userPick?.choiceId === choice.choiceId,
            winner: result?.winningChoiceId === choice.choiceId,
          };
        }),
      };
    })
    .sort((a, b) => (a.match.startsAt ?? '').localeCompare(b.match.startsAt ?? '') || a.match.label.localeCompare(b.match.label));
}

// One picker's picks, newest first, each with its match and choice in words and whether it was right once the match
// has a result. A pick a later pick for the same match replaced is marked superseded.
export function matchPickPersonalHistory(state, pickerId) {
  const mine = state.picks.filter(pick => pick.pickerId === pickerId);
  return [...mine]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(pick => {
      const match = state.matches.find(item => item.matchId === pick.matchId);
      const result = resultOf(state, pick.matchId);
      const latest = latestBy(mine.filter(other => other.matchId === pick.matchId), other => other.createdAt);
      return {
        pick,
        matchLabel: match?.label ?? pick.matchId,
        choiceLabel: match?.choices.find(choice => choice.choiceId === pick.choiceId)?.label ?? pick.choiceId,
        resultSummary: result?.summary,
        correct: result ? result.winningChoiceId === pick.choiceId : undefined,
        superseded: latest !== pick,
      };
    });
}
