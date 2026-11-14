import type {
  MatchPickHistoryView,
  MatchPickRecord,
  MatchPicksState,
  MatchPickView,
  MatchPickResultRecord,
  PickMatchRecord,
} from './match-picks-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function latestBy<T>(items: readonly T[], getValue: (item: T) => string): T | undefined {
  return [...items].sort((a, b) => getValue(b).localeCompare(getValue(a)))[0];
}

export function readMatchPicksState(rows: unknown): MatchPicksState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    matches: values.filter((value): value is PickMatchRecord => kind(value) === 'pick-match'),
    picks: values.filter((value): value is MatchPickRecord => kind(value) === 'match-pick'),
    results: values.filter((value): value is MatchPickResultRecord => kind(value) === 'match-pick-result'),
  };
}

export function matchPickViews(state: MatchPicksState, pickerId?: string): MatchPickView[] {
  return state.matches
    .map((match) => {
      const picks = state.picks.filter((pick) => pick.matchId === match.matchId);
      const totalPicks = picks.length;
      const result = latestBy(state.results.filter((candidate) => candidate.matchId === match.matchId), (candidate) => candidate.resolvedAt);
      const userPick = pickerId
        ? latestBy(picks.filter((pick) => pick.pickerId === pickerId), (pick) => pick.createdAt)
        : undefined;
      return {
        match,
        totalPicks,
        result,
        userPick,
        choices: match.choices.map((choice) => {
          const pickCount = picks.filter((pick) => pick.choiceId === choice.choiceId).length;
          return {
            ...choice,
            pickCount,
            percentPicked: totalPicks > 0 ? Math.round((pickCount / totalPicks) * 100) : 0,
            selectedByUser: userPick?.choiceId === choice.choiceId,
            winner: result?.winningChoiceId === choice.choiceId,
          };
        }),
      };
    })
    .sort((a, b) => (a.match.startsAt ?? '').localeCompare(b.match.startsAt ?? '') || a.match.label.localeCompare(b.match.label));
}

export function matchPickPersonalHistory(state: MatchPicksState, pickerId: string): MatchPickHistoryView[] {
  return state.picks
    .filter((pick) => pick.pickerId === pickerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((pick) => {
      const match = state.matches.find((candidate) => candidate.matchId === pick.matchId);
      const result = latestBy(state.results.filter((candidate) => candidate.matchId === pick.matchId), (candidate) => candidate.resolvedAt);
      return {
        pick,
        matchLabel: match?.label ?? pick.matchId,
        choiceLabel: match?.choices.find((choice) => choice.choiceId === pick.choiceId)?.label ?? pick.choiceId,
        resultSummary: result?.summary,
        correct: result ? result.winningChoiceId === pick.choiceId : undefined,
      };
    });
}
