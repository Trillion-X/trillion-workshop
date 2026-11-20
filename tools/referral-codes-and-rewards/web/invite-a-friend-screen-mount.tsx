// tools/referral-codes-and-rewards/web/invite-a-friend-screen-mount.tsx
//
// PURPOSE
//   The "invite a friend" screen as a screen module: the one file the screen's row names (`screen.module.entry` of
//   tool:make-a-referral-code), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). The surface is ../show/InviteAFriend.tsx. This file reads the person's own
//   referral answer from the address the host passes (`referral_address`, which answers { code, link }) and gives the
//   surface the host's words and that link.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The link is the host's answer from its address, never built here; this file writes nothing.
//   2. Every word is the host's (`words`); a read that fails draws the host's `unavailable` words, never a half link.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, Text, mountReactSurface } from '../../ui';
import { InviteAFriend, type InviteAFriendWords } from '../show/InviteAFriend';

type InviteScreenInput = { referral_address?: string; words?: InviteAFriendWords & { unavailable: string } };
type ReferralAnswer = { link?: unknown };

function InviteScreen({ address, words }: { address: string; words: InviteAFriendWords & { unavailable: string } }) {
  const [link, setLink] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let gone = false;
    fetch(address, { cache: 'no-store' })
      .then(answer => (answer.ok ? answer.json() : Promise.reject(new Error(String(answer.status)))))
      .then((answer: ReferralAnswer) => {
        if (gone) return;
        if (typeof answer.link === 'string' && answer.link) setLink(answer.link);
        else setFailed(true);
      })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [address]);
  if (failed) return <Text variant="body-sm" color="secondary">{words.unavailable}</Text>;
  if (link === null) return null;
  return (
    <ErrorBoundary zoneName="invite a friend">
      <InviteAFriend words={words} link={link} />
    </ErrorBoundary>
  );
}

/** The screen's mount: the signed-in person's own referral link, drawn with the host's words. */
export function mount(element: HTMLElement, props: InviteScreenInput = {}) {
  if (!props.words || !props.referral_address) throw new Error('The invite a friend screen needs its words and its address from the host.');
  return mountReactSurface(element, <InviteScreen address={props.referral_address} words={props.words} />);
}
