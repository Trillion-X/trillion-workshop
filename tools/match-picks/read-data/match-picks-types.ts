export type MatchPickChoice = {
  choiceId: string;
  label: string;
};

export type PickMatchRecord = {
  kind: 'pick-match';
  matchId: string;
  label: string;
  startsAt?: string;
  choices: MatchPickChoice[];
  status: 'open' | 'closed';
};

export type MatchPickRecord = {
  kind: 'match-pick';
  pickId: string;
  matchId: string;
  pickerId: string;
  choiceId: string;
  createdAt: string;
};

export type MatchPickResultRecord = {
  kind: 'match-pick-result';
  resultId: string;
  matchId: string;
  winningChoiceId: string;
  summary: string;
  resolvedAt: string;
};

export type MatchPicksRecord =
  | PickMatchRecord
  | MatchPickRecord
  | MatchPickResultRecord;

export type MatchPicksState = {
  matches: PickMatchRecord[];
  picks: MatchPickRecord[];
  results: MatchPickResultRecord[];
};

export type MatchPickChoiceView = MatchPickChoice & {
  pickCount: number;
  percentPicked: number;
  selectedByUser: boolean;
  winner: boolean;
};

export type MatchPickView = {
  match: PickMatchRecord;
  choices: MatchPickChoiceView[];
  totalPicks: number;
  result?: MatchPickResultRecord;
  userPick?: MatchPickRecord;
};

export type MatchPickHistoryView = {
  pick: MatchPickRecord;
  matchLabel: string;
  choiceLabel: string;
  resultSummary?: string;
  correct?: boolean;
};
