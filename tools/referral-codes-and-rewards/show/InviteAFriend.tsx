// tools/referral-codes-and-rewards/show/InviteAFriend.tsx
//
// PURPOSE
//   The "invite a friend" surface: one person's own referral link, drawn with a copy button. It draws only what the
//   host gives it: every word in `words`, and the link in `link`. It reads nothing and writes nothing; the screen
//   module (../web/invite-a-friend-screen-mount.tsx) does the reading.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word drawn is in `words`, passed by the host; nothing is written in this file.
//   2. The link drawn is the one passed in; it is never built or changed here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Text } from '../../ui/show/text';
import { CopyButton } from '../../ui/show/copy-button/CopyButton';

export type InviteAFriendWords = { heading: string; body: string; copy: string; copied: string; failed: string };
export type InviteAFriendProps = { words: InviteAFriendWords; link: string };

export function InviteAFriend({ words, link }: InviteAFriendProps) {
  return (
    <section aria-label={words.heading} className="grid w-full gap-2.5">
      <Text variant="title">{words.heading}</Text>
      <Text color="muted">{words.body}</Text>
      <Text className="[overflow-wrap:anywhere]">{link}</Text>
      <div>
        <CopyButton text={link} label={words.copy} copiedLabel={words.copied} failedLabel={words.failed} />
      </div>
    </section>
  );
}
