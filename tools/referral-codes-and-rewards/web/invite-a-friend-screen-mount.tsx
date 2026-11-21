// tools/referral-codes-and-rewards/web/invite-a-friend-screen-mount.tsx
//
// PURPOSE
//   The "Refer a friend" screen as a screen module: the one file the screen's row names (`screen.module.entry` of
//   tool:make-a-referral-code), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). This file reads the person's own referral answer from the address the host passes
//   (`referral_address`, which answers { code, link }) and draws it with the shared guide (tools/ui/show/coss/guide.tsx): the
//   same section the Invite friends screen drew before, with the link sheet and its places. The section is built by
//   ../read-data/invite-share.mjs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The link is the host's answer from its address, never built here; this file writes nothing.
//   2. Every word is the host's (`words`); a read that fails draws the host's `unavailable` words, never a half link.
//   3. The link sheet and its places are the shared sheet and the DATA rows in read-data/share-places.json.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, Text, mountReactSurface } from '../../ui';
import { ScreenState } from '../../ui/show/screen-state';
import { Guide } from '../../ui/show/coss/guide';
import { inviteSection } from '../read-data/invite-share.mjs';

export type InviteWords = {
  heading: string; body: string; link: string; share: string; share_title: string; share_text: string; copy: string; copied: string; failed: string;
  unavailable: string; empty: string; person: string; joined_on: string; paid_on: string; credit_added: string;
  stats: { joined: string; paying: string; earned: string };
  status: { joined: string; paying: string; credited: string };
};
type InviteScreenInput = { referral_address?: string; words?: InviteWords };
type Stats = { joined: number; paying: number; credit_given_cents: number; people: { joined_at: string; paid_at: string | null; reward: 'given' | 'none'; amount_cents: number | null; currency: string | null }[] };
type ReferralAnswer = { link?: unknown; stats?: Stats };
type NotForPersonAnswer = { not_for_person?: { title?: unknown; description?: unknown } };

const noAction = () => undefined;

function InviteScreen({ address, words }: { address: string; words: InviteWords }) {
  const [reply, setReply] = React.useState<{ link: string; stats: Stats } | null>(null);
  const [failed, setFailed] = React.useState(false);
  // The host says when the link is not for this person (its own words, in the answer): a plain state with no retry.
  const [notForPerson, setNotForPerson] = React.useState<{ title: string; description?: string } | null>(null);
  React.useEffect(() => {
    let gone = false;
    fetch(address, { cache: 'no-store' })
      .then(async answer => {
        if (answer.ok) return answer.json() as Promise<ReferralAnswer>;
        const body = await answer.json().catch(() => ({})) as NotForPersonAnswer;
        if (answer.status === 403 && typeof body.not_for_person?.title === 'string') {
          if (!gone) setNotForPerson({ title: body.not_for_person.title, ...(typeof body.not_for_person.description === 'string' ? { description: body.not_for_person.description } : {}) });
          return null;
        }
        throw new Error(String(answer.status));
      })
      .then(answer => {
        if (gone || answer === null) return;
        if (typeof answer.link === 'string' && answer.link && answer.stats) setReply({ link: answer.link, stats: answer.stats });
        else setFailed(true);
      })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [address]);
  const description = React.useMemo(() => reply === null ? null : { title: words.heading, hide_header: true, sections: [inviteSection({ ...reply, words })] }, [reply, words]);
  if (notForPerson) return <ScreenState state={{ status: 'empty', icon: 'Lock', ...notForPerson }} />;
  if (failed) return <Text variant="body-sm" color="secondary">{words.unavailable}</Text>;
  if (description === null) return null;
  return (
    <ErrorBoundary zoneName="invite a friend">
      <Guide description={description} onAction={noAction} />
    </ErrorBoundary>
  );
}

/** The screen's mount: the signed-in person's own referral link, drawn with the host's words. */
export function mount(element: HTMLElement, props: InviteScreenInput = {}) {
  if (!props.words || !props.referral_address) throw new Error('The invite a friend screen needs its words and its address from the host.');
  return mountReactSurface(element, <InviteScreen address={props.referral_address} words={props.words} />);
}
