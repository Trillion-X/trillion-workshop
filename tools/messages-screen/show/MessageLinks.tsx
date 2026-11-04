// parts/chat/show/MessageLinks.tsx
//
// PURPOSE
//   The links in one message, drawn under its words: a link whose card is ready is the shared LinkPreview (parts/ui/show/
//   link-preview); one still being read, or that could not be read yet, is its address with a quiet line in the person's
//   words (message-link-words.json). The cards come from the host (src/link-previews.mjs through the message window);
//   nothing here reads a page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every card field and word is DATA the host gave; nothing here names a site.
//   2. No raw interactive HTML: the card is LinkPreview, the rest is Container and Text.

import React from 'react';
import { Container, Text } from '../../ui';
import { LinkPreview } from '../../ui/show/link-preview';
import words from './message-link-words.json';

export type MessageLink = { url: string; state: 'pending' | 'ready' | 'failed'; card?: Record<string, string> };

export function MessageLinks({ links }: { links: readonly MessageLink[] }) {
  return (
    <Container layout="vertical" gap="sm" padding="none" maxWidth="sm" data-message-links="">
      {links.map(link => (link.state === 'ready' && link.card ? (
        <LinkPreview key={link.url} url={link.card.final_url || link.card.url || link.url} title={link.card.title || link.card.host || link.url}
          site={link.card.site || link.card.host} icon={link.card.icon} picture={link.card.image} description={link.card.description} />
      ) : (
        <Container key={link.url} layout="vertical" gap="none" padding="none" data-message-link-state={link.state}>
          <Text variant="caption" color="muted" truncate>{link.url}</Text>
          <Text variant="caption" color="faint" role="status">{link.state === 'failed' ? words.failed : words.pending}</Text>
        </Container>
      )))}
    </Container>
  );
}
