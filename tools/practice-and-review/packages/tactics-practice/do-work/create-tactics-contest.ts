import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  DecisionEvidence,
  DecisionPrompt,
} from '@/packages/practice-decision-loop/read-data/practice-decision-loop-types';
import type {
  CourtZone,
  TacticsPeerVote,
  TacticsScenario,
  TacticsConfig,
  TacticsConfigKind,
  TacticsContest,
} from '../read-data/tactics-practice-types';

export const CREATE_DAILY_TACTICS_CONTEST_ACTION = 'action:tactics-practice.create-daily-contest';
export const CREATE_ONE_ON_ONE_TACTICS_CONTEST_ACTION = 'action:tactics-practice.create-one-on-one-contest';
export const RECORD_PEER_VOTE_ACTION = 'action:tactics-practice.record-peer-vote';

type RecordWrite = {
  address: string;
  path: string[];
  payload: unknown;
};

export type CreateTacticsContestDraft = {
  contestId: string;
  configKind: Exclude<TacticsConfigKind, 'season-tactics-tournament'>;
  label: string;
  scenarioId: string;
  promptId: string;
  evidenceId: string;
  participantRefs?: string[];
  title: string;
  situation: string;
  choices: Array<{ choiceId: string; label: string }>;
  courtZones: CourtZone[];
  startsAt?: string;
  closesAt?: string;
  createdAt: string;
};

export type CreateTacticsContestInput = {
  contest_id: string;
  scenario_id: string;
  evidence_id: string;
  prompt_id: string;
  config_record: TacticsConfig;
  contest_record: TacticsContest;
  scenario_record: TacticsScenario;
  evidence_record: DecisionEvidence;
  prompt_record: DecisionPrompt;
  record_writes: RecordWrite[];
};

export type RecordPeerVoteDraft = {
  voteId: string;
  promptId: string;
  responseId: string;
  voterId: string;
  vote: TacticsPeerVote['vote'];
  createdAt: string;
};

export type RecordPeerVoteInput = {
  vote_id: string;
  vote_record: TacticsPeerVote;
  record_writes: RecordWrite[];
};

export function buildCreateTacticsContestInput(draft: CreateTacticsContestDraft): CreateTacticsContestInput {
  const subject = { id: draft.scenarioId, kind: 'tactical-scenario', label: draft.title };
  const participantRefs = draft.participantRefs ?? [];
  const input: CreateTacticsContestInput = {
    contest_id: draft.contestId,
    scenario_id: draft.scenarioId,
    evidence_id: draft.evidenceId,
    prompt_id: draft.promptId,
    config_record: {
      kind: 'tactics-config',
      configId: draft.contestId,
      configKind: draft.configKind,
      label: draft.label,
      scenarioRefs: [draft.scenarioId],
      contestRefs: [draft.contestId],
      ratingSystemRef: 'tactical-rating',
      createdAt: draft.createdAt,
    },
    contest_record: {
      kind: 'tactics-contest',
      contestId: draft.contestId,
      configKind: draft.configKind,
      label: draft.label,
      promptRefs: [draft.promptId],
      participantRefs,
      startsAt: draft.startsAt ?? draft.createdAt,
      closesAt: draft.closesAt,
      createdAt: draft.createdAt,
    },
    scenario_record: {
      kind: 'tactical-scenario',
      scenarioId: draft.scenarioId,
      title: draft.title,
      situation: draft.situation,
      courtZones: draft.courtZones,
      evidenceRefs: [draft.evidenceId],
      promptRef: draft.promptId,
      createdAt: draft.createdAt,
    },
    evidence_record: {
      kind: 'decision-evidence',
      evidenceId: draft.evidenceId,
      subject,
      evidenceKind: 'tactics-scenario',
      source: {
        id: 'source:tactics-practice',
        label: 'Tactics practice',
        visibility: 'system',
      },
      payload: {
        situation: draft.situation,
        courtZones: draft.courtZones,
      },
      createdAt: draft.createdAt,
    },
    prompt_record: {
      kind: 'decision-prompt',
      promptId: draft.promptId,
      subject,
      promptKind: 'tactical-choice',
      title: draft.title,
      body: draft.situation,
      choices: draft.choices,
      evidenceRefs: [draft.evidenceId],
      createdAt: draft.createdAt,
    },
    record_writes: [],
  };
  input.record_writes = [
    {
      address: `package::tactics-practice::config::${draft.contestId}`,
      path: ['current-item', 'published-record'],
      payload: input.config_record,
    },
    {
      address: `package::tactics-practice::contest::${draft.contestId}`,
      path: ['current-item', 'published-record'],
      payload: input.contest_record,
    },
    {
      address: `package::tactics-practice::scenario::${draft.scenarioId}`,
      path: ['current-item', 'published-record'],
      payload: input.scenario_record,
    },
    {
      address: `package::practice-decision-loop::evidence::${draft.evidenceId}`,
      path: ['current-item', 'published-record'],
      payload: input.evidence_record,
    },
    {
      address: `package::practice-decision-loop::prompt::${draft.promptId}`,
      path: ['current-item', 'published-record'],
      payload: input.prompt_record,
    },
  ];
  return input;
}

function contestActionId(configKind: CreateTacticsContestInput['config_record']['configKind']): string {
  return configKind === 'one-on-one-tactics-contest'
    ? CREATE_ONE_ON_ONE_TACTICS_CONTEST_ACTION
    : CREATE_DAILY_TACTICS_CONTEST_ACTION;
}

export function buildRecordPeerVoteInput(draft: RecordPeerVoteDraft): RecordPeerVoteInput {
  const voteRecord: TacticsPeerVote = {
    kind: 'tactics-peer-vote',
    voteId: draft.voteId,
    promptId: draft.promptId,
    responseId: draft.responseId,
    voterId: draft.voterId,
    vote: draft.vote,
    createdAt: draft.createdAt,
  };
  return {
    vote_id: draft.voteId,
    vote_record: voteRecord,
    record_writes: [{
      address: `package::tactics-practice::peer-vote::${draft.voteId}`,
      path: ['current-item', 'published-record'],
      payload: voteRecord,
    }],
  };
}

export function createTacticsContest(input: CreateTacticsContestInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: contestActionId(input.config_record.configKind),
      include_steps: false,
      include_output: false,
      input,
    },
  });
}

export function recordPeerVote(input: RecordPeerVoteInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_PEER_VOTE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
