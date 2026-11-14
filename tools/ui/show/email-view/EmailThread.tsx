// parts/ui/show/email-view/EmailThread.tsx
//
// PURPOSE
//   A conversation drawn in the order it happened, oldest first: every message but the open one is one quiet row
//   (sender with initials, date, the line it starts with), and the open message is the caller's own node (an EmailView
//   card) in its place in the order. Picking a row asks the caller to open that message; the view keeps no state of
//   which one is open.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Composed only from shared parts (Container, Text, Button, PersonTag); this file writes no markup and no appearance.
//   2. Domain-blind: it knows a row's sender, date, preview line and whether it is unread, never how a message is read or
//      acted on. The open message's node, the words about a conversation cut short and the loading words are the caller's.
//   3. Entries are drawn in the order given; this view never sorts or hides one.
//   4. The open entry is brought into view when it changes, so a message in the middle of a long conversation is found.

import * as React from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { PersonTag } from '../person-tag';

/** One message of the conversation. `content` is set on the open message only: the caller's card for it. */
export interface EmailThreadEntry {
  id: string;
  /** Who it came from, as the message names them ("Name <address>" or an address). */
  from: string;
  /** When it was sent, as an ISO date; drawn in the reader's own locale. */
  sentAt?: string | null;
  /** The line the message starts with. */
  preview?: string | null;
  unread?: boolean;
  content?: React.ReactNode;
}

export interface EmailThreadProps {
  entries: readonly EmailThreadEntry[];
  onOpen: (id: string) => void;
  /** Said above the first message when the conversation has older messages that are not drawn. */
  earlier?: string | null;
  /** Said under the messages while the rest of the conversation is read, or when it could not be. */
  note?: string | null;
  /** Names the list for a screen reader. */
  label: string;
}

const shortWhen = (iso: string | null | undefined) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
    : '';
};
const displayName = (sender: string) => sender.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || sender;

export function EmailThread({ entries, onOpen, earlier, note, label }: EmailThreadProps) {
  const openRef = React.useRef<HTMLDivElement | null>(null);
  const openId = entries.find(entry => entry.content)?.id;
  React.useEffect(() => { openRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [openId, entries.length]);
  return (
    <Container layout="vertical" gap="xs" minWidth="0" role="list" aria-label={label} data-email-thread="">
      {earlier ? <Text variant="caption" color="muted" role="note" data-email-thread-earlier="">{earlier}</Text> : null}
      {entries.map(entry => entry.content
        ? <Container key={entry.id} ref={openRef} layout="vertical" minWidth="0" role="listitem" data-email-thread-open={entry.id}>{entry.content}</Container>
        : <Container key={entry.id} layout="vertical" minWidth="0" role="listitem">
          <Button variant="ghost" size="option-row" data-email-thread-message={entry.id} onClick={() => onOpen(entry.id)} aria-label={`${displayName(entry.from)}, ${shortWhen(entry.sentAt)}. ${entry.preview ?? ''}`.trim()}>
            <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0" flex={1}>
              <PersonTag name={displayName(entry.from)} size="sm" />
              <Text variant="body-sm" weight={entry.unread ? 'semibold' : 'medium'} truncate>{displayName(entry.from)}</Text>
              <Container minWidth="0" flex={1}><Text variant="caption" color="muted" truncate>{entry.preview ?? ''}</Text></Container>
              <Text variant="caption" wrap="nowrap">{shortWhen(entry.sentAt)}</Text>
            </Container>
          </Button>
        </Container>)}
      {note ? <Text variant="caption" color="muted" role="status" data-email-thread-note="">{note}</Text> : null}
    </Container>
  );
}
