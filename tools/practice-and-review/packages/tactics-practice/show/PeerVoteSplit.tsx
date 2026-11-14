import * as React from 'react';
import { Bar } from '@/packages/ui/show/bar/Bar';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import type { TacticsPeerVote } from '@/packages/tactics-practice/read-data/tactics-practice-types';

// Peer vote / result split.
//
// Reference anatomy (Mobbin, 2026-06-20): horizontal percentage-fill bar per
// option with a right-aligned vote count, the viewer's own pick marked, and a
// compact participation total.
//   Brave Browser  de504f51  (% fill bars + (n) counts)
//   Twitch (web)   a47d5347 / 337c56f4  (live %/(n) + voted state)
//   Spotify Creators a4aeaf2e ; Grab 7b201480  (option bars + total)
// Banned transfers (rejected): chat-app dark chrome, a "change vote" affordance
// after the tactic is answered, and any poll-authoring control — players answer
// tactics, they never author them.

type VoteKind = TacticsPeerVote['vote'];

const ORDER: VoteKind[] = ['stronger', 'same', 'weaker', 'unsafe'];

const LABEL: Record<VoteKind, string> = {
  stronger: 'Stronger play',
  same: 'About the same',
  weaker: 'Weaker play',
  unsafe: 'Too risky',
};

const TONE: Record<VoteKind, 'success' | 'info' | 'warning' | 'error'> = {
  stronger: 'success',
  same: 'info',
  weaker: 'warning',
  unsafe: 'error',
};

export type PeerVoteSplitProps = {
  votes: TacticsPeerVote[];
  /** The viewer, so their own vote can be marked. */
  viewerId?: string;
};

export function PeerVoteSplit({ votes, viewerId }: PeerVoteSplitProps) {
  const total = votes.length;
  const viewerVote = viewerId ? votes.find((vote) => vote.voterId === viewerId)?.vote : undefined;
  const counts = React.useMemo(() => {
    const tally: Record<VoteKind, number> = { stronger: 0, same: 0, weaker: 0, unsafe: 0 };
    for (const vote of votes) tally[vote.vote] += 1;
    return tally;
  }, [votes]);

  if (total === 0) {
    return (
      <Text variant="body-xs" color="muted">
        No peer votes yet. Be the first to weigh in.
      </Text>
    );
  }

  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Text variant="heading-xs">How players rated this tactic</Text>
        <Text variant="caption" color="muted">
          {total} {total === 1 ? 'vote' : 'votes'}
        </Text>
      </Container>
      {ORDER.map((kind) => {
        const count = counts[kind];
        const percent = total > 0 ? Math.round((count / total) * 100) : 0;
        const isViewer = viewerVote === kind;
        return (
          <Container key={kind} layout="vertical" gap="xs">
            <Container layout="horizontal" justifyContent="between" alignItems="center">
              <Text variant="body-xs" color={isViewer ? 'strong' : 'default'}>
                {LABEL[kind]}
                {isViewer ? ' · your pick' : ''}
              </Text>
              <Text variant="caption" color="muted">
                {percent}% · {count}
              </Text>
            </Container>
            <Bar height="sm" segments={[{ percent, variant: TONE[kind], title: `${LABEL[kind]}: ${percent}%` }]} />
          </Container>
        );
      })}
    </Container>
  );
}
