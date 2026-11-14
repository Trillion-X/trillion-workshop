import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PeerVoteSplit } from '@/packages/tactics-practice/show/PeerVoteSplit';
import { TacticalRatingStandings } from '@/packages/tactics-practice/show/TacticalRatingStandings';
import { OneOnOneContestPanel } from '@/packages/tactics-practice/show/OneOnOneContestPanel';
import { SeasonTournamentPanel } from '@/packages/tactics-practice/show/SeasonTournamentPanel';
import { humanizeRef } from '@/packages/tactics-practice/show/humanize-ref';
import type {
  TacticsPeerVote,
  TacticsSeasonTournamentView,
  TacticalRatingEffect,
  TacticsContestView,
} from '@/packages/tactics-practice/read-data/tactics-practice-types';

afterEach(cleanup);

// The translation-boundary forbids these tokens from any customer-facing string.
const BANNED = [
  'package', 'package set', 'workflow', 'slot', 'envelope', 'payload', 'fact',
  'address', 'descriptor', 'CAS', 'runtime', 'source path', 'raw id', 'debug',
  'acceptance criteria', 'build plan', 'MCP', 'Mobbin', 'optional', 'preview only',
  'dev only',
];

function assertNoBackendWords(text: string) {
  const haystack = text.toLowerCase();
  for (const word of BANNED) {
    expect(haystack.includes(word.toLowerCase()), `banned token "${word}" leaked into UI`).toBe(false);
  }
}

const vote = (id: string, voterId: string, v: TacticsPeerVote['vote']): TacticsPeerVote => ({
  kind: 'tactics-peer-vote',
  voteId: id,
  promptId: 'prompt:daily',
  responseId: `response:${id}`,
  voterId,
  vote: v,
  createdAt: '2026-06-20T00:00:00.000Z',
});

const effect = (id: string, playerId: string, delta: number): TacticalRatingEffect => ({
  kind: 'tactical-rating-effect',
  effectId: id,
  playerId,
  promptId: 'prompt:daily',
  responseId: `response:${id}`,
  delta,
  reason: 'tactical-result',
  createdAt: '2026-06-20T00:00:00.000Z',
});

describe('PeerVoteSplit', () => {
  it('empty state renders a human prompt and no backend words', () => {
    const { container } = render(<PeerVoteSplit votes={[]} viewerId="player:ada" />);
    expect(container.textContent).toContain('No peer votes yet');
    assertNoBackendWords(container.textContent ?? '');
  });

  it('dense state shows all categories, a total, and marks the viewer pick', () => {
    const votes = [
      vote('v1', 'player:ada', 'stronger'),
      vote('v2', 'player:ben', 'stronger'),
      vote('v3', 'player:cy', 'weaker'),
      vote('v4', 'player:dee', 'unsafe'),
    ];
    const { container } = render(<PeerVoteSplit votes={votes} viewerId="player:ada" />);
    const text = container.textContent ?? '';
    expect(text).toContain('Stronger play');
    expect(text).toContain('Too risky');
    expect(text).toContain('4 votes');
    expect(text).toContain('your pick');
    assertNoBackendWords(text);
  });
});

describe('TacticalRatingStandings', () => {
  it('empty state renders a human prompt', () => {
    const { container } = render(<TacticalRatingStandings effects={[]} />);
    expect(container.textContent).toContain('No tactical ratings yet');
    assertNoBackendWords(container.textContent ?? '');
  });

  it('dense state ranks by points, marks the viewer, and shows a promotion line', () => {
    const effects = [
      effect('e1', 'player:ada', 30),
      effect('e2', 'player:ada', 10),
      effect('e3', 'player:ben', 50),
      effect('e4', 'player:cy', 5),
    ];
    const { container } = render(
      <TacticalRatingStandings effects={effects} viewerId="player:ada" promotionCount={2} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Ben');
    expect(text).toContain('Ada');
    expect(text).toContain('· you');
    expect(text).toContain('Promotion line');
    assertNoBackendWords(text);
  });
});

describe('OneOnOneContestPanel', () => {
  const view: TacticsContestView = {
    config: {
      kind: 'tactics-config',
      configId: 'config:1v1',
      configKind: 'one-on-one-tactics-contest',
      label: 'One-on-one',
      scenarioRefs: ['scenario:1'],
      contestRefs: ['contest:1'],
      createdAt: '2026-06-20T00:00:00.000Z',
    },
    contest: {
      kind: 'tactics-contest',
      contestId: 'contest:1',
      configKind: 'one-on-one-tactics-contest',
      label: 'Round 1',
      promptRefs: ['prompt:daily'],
      participantRefs: ['player:ada', 'player:ben'],
      startsAt: '2026-06-20T00:00:00.000Z',
      createdAt: '2026-06-20T00:00:00.000Z',
    },
    scenarios: [
      {
        kind: 'tactical-scenario',
        scenarioId: 'scenario:1',
        title: 'Second serve under pressure',
        situation: 'Break point down, deuce court.',
        courtZones: ['A', 'B'],
        evidenceRefs: [],
        promptRef: 'prompt:daily',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ],
    prompts: [],
    votes: [vote('v1', 'player:ada', 'stronger'), vote('v2', 'player:ben', 'same')],
    ratingEffects: [effect('e1', 'player:ada', 40), effect('e2', 'player:ben', 25)],
  };

  it('renders the head-to-head, leader, scenario, and vote split', () => {
    const { container } = render(<OneOnOneContestPanel view={view} viewerId="player:ada" />);
    const text = container.textContent ?? '';
    expect(text).toContain('One-on-one tactics');
    expect(text).toContain('Second serve under pressure');
    expect(text).toContain('VS');
    expect(text).toContain('is ahead');
    expect(text).toContain('How players rated this tactic');
    assertNoBackendWords(text);
  });
});

describe('SeasonTournamentPanel', () => {
  const baseSeason: TacticsSeasonTournamentView['season'] = {
    kind: 'tactics-season',
    seasonId: 'season:1',
    label: 'Summer Tactics Season',
    inviteOnly: true,
    weekCount: 8,
    divisionRefs: ['division:1'],
    bracketRefs: ['match:1'],
    weeklyScenarioRefs: ['scenario:1'],
    inviteRefs: ['invite:1'],
    createdAt: '2026-06-20T00:00:00.000Z',
  };

  const denseView: TacticsSeasonTournamentView = {
    config: undefined,
    season: baseSeason,
    invites: [
      { kind: 'tactics-season-invite', inviteId: 'invite:1', seasonId: 'season:1', playerRef: 'player:ada', state: 'accepted', createdAt: '2026-06-20T00:00:00.000Z' },
      { kind: 'tactics-season-invite', inviteId: 'invite:2', seasonId: 'season:1', playerRef: 'player:ben', state: 'invited', createdAt: '2026-06-20T00:00:00.000Z' },
    ],
    divisions: [
      { kind: 'tactics-division', divisionId: 'division:1', seasonId: 'season:1', label: 'Gold Division', playerRefs: ['player:ada', 'player:ben'] },
    ],
    brackets: [
      { kind: 'tactics-bracket-match', matchId: 'match:1', seasonId: 'season:1', round: 'semifinal', playerRefs: ['player:ada', 'player:ben'], winnerRef: 'player:ada' },
      { kind: 'tactics-bracket-match', matchId: 'match:2', seasonId: 'season:1', round: 'final', playerRefs: ['player:ada', 'player:cy'], winnerRef: 'player:ada' },
    ],
    weeklyScenarios: [
      { kind: 'tactical-scenario', scenarioId: 'scenario:1', title: 'Approach shot choice', situation: 'Short ball mid-court.', courtZones: ['C'], evidenceRefs: [], promptRef: 'prompt:wk1', createdAt: '2026-06-20T00:00:00.000Z' },
    ],
    weeklyPrompts: [],
    weeklyEvidence: [],
    results: [],
    championResult: {
      kind: 'tactics-season-result', resultId: 'result:champ', seasonId: 'season:1', resultKind: 'champion', playerRef: 'player:ada', score: 120, evidenceRefs: [], createdAt: '2026-06-20T00:00:00.000Z',
    },
    coachReviews: [
      { kind: 'tactics-season-coach-review', coachReviewId: 'review:1', seasonId: 'season:1', promptRefs: ['prompt:wk1'], title: 'Net play improving', points: ['Closed the net faster', 'Watch the backhand approach'], nextPromptRefs: ['prompt:wk2'], createdAt: '2026-06-20T00:00:00.000Z' },
    ],
    profiles: [
      { kind: 'tactics-profile-link', profileId: 'profile:1', subjectRef: 'player:ada', seasonId: 'season:1', promptRefs: ['prompt:wk1'], evidenceRefs: [] },
    ],
  };

  it('dense state shows champion, division, bracket, scenario, coach review, invites', () => {
    const { container } = render(<SeasonTournamentPanel view={denseView} viewerId="player:ada" />);
    const text = container.textContent ?? '';
    expect(text).toContain('Summer Tactics Season');
    expect(text).toContain('Invite only');
    expect(text).toContain('Season champion');
    expect(text).toContain('Gold Division');
    expect(text).toContain('Semifinal');
    expect(text).toContain('Final');
    expect(text).toContain('Approach shot choice');
    expect(text).toContain('Net play improving');
    expect(text).toContain('Advances');
    assertNoBackendWords(text);
  });

  it('sparse state (season only) renders without optional sections', () => {
    const sparseView: TacticsSeasonTournamentView = {
      config: undefined,
      season: { ...baseSeason, inviteOnly: false },
      invites: [],
      divisions: [],
      brackets: [],
      weeklyScenarios: [],
      weeklyPrompts: [],
      weeklyEvidence: [],
      results: [],
      championResult: undefined,
      coachReviews: [],
      profiles: [],
    };
    const { container } = render(<SeasonTournamentPanel view={sparseView} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Summer Tactics Season');
    expect(text).toContain('Open season');
    expect(text).not.toContain('Season champion');
    assertNoBackendWords(text);
  });
});

describe('humanizeRef', () => {
  it('reshapes refs without leaking raw ids', () => {
    expect(humanizeRef('player:ada-lovelace')).toBe('Ada Lovelace');
    expect(humanizeRef('person:ben-okri')).toBe('Ben Okri');
    expect(humanizeRef('a1b2c3d4e5')).toMatch(/^Player [0-9A-F]{4}$/);
  });
});
