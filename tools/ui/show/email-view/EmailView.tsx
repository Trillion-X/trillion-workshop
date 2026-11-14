// parts/ui/show/email-view/EmailView.tsx
//
// PURPOSE
//   One sent or received email drawn the way an email client's reading pane draws it: the subject as the heading and
//   its preview line under it, the sender with their initials and the date on the right, then who it went to (To,
//   Reply to, and each kind of copy the message names), then the body as a formatted document. The body is the
//   message's markdown (or its plain words) read by the one markdown renderer (document-page `markdownHtml`) and drawn
//   in MarkdownWords, so a raw HTML body is never run or framed here.
//   Anatomy taken from real reading panes: Plain's thread message (sender line, "to / from" under the subject, body in
//   its own panel; mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23) and Calendly's sent-email view (sender,
//   "To:" row, date on the right; mobbin.com/screens/e4c1b45c-1f6d-456c-ba0d-ffd1b09fe681).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Composed only from shared parts (Container, Text, PersonTag, MarkdownWords); this file writes no markup.
//   2. Domain-blind: it knows an email's parts (subject, sender, addresses, body), never who sent it or why. Actions
//      (open it where it lives, reply) are the caller's nodes in `actions`.
//   3. A copy's row is named by the copy's own `how` (cc, bcc, or any other a sender names), never an enumerated list.
//   4. An address row with no addresses is left out; a message with no body says so in plain words.
//   4a. The message is one bordered, rounded card, so every screen that reads an email (Mail, Sent) draws the same card.
//   4b. `footer` is the caller's row under the body (reply, forward, a menu of more); the view never names what is in it.
//   5. The body's look is the one markdown document look (screen-look file-preview.css `.file-preview-markdown`).

import React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import { PersonTag } from '../person-tag';
import { MarkdownWords } from '../markdown-block/MarkdownWords';

/** One copy of the message sent to someone beyond its To line: `how` names the kind of copy (cc, bcc, ...). */
export interface EmailCopy {
  to: string;
  how: string;
}

export interface EmailViewProps {
  subject: string;
  /** Who it came from, as the message names them ("Name <address>" or an address). */
  from: string;
  to: readonly string[];
  replyTo?: string | null;
  copies?: readonly EmailCopy[];
  /** The line an inbox shows under the subject. */
  preheader?: string | null;
  /** When it was sent, as an ISO date; drawn in the reader's own locale. */
  sentAt?: string | null;
  /** The body as markdown; preferred over `bodyText`. */
  bodyMarkdown?: string | null;
  /** The body as plain words, when there is no markdown. */
  bodyText?: string | null;
  /** The caller's actions for this message (open it where it lives, reply), drawn beside the subject. */
  actions?: React.ReactNode;
  /** The caller's row under the body (reply, forward, a menu of more), drawn inside the message. */
  footer?: React.ReactNode;
  /** Words shown in place of a missing body. */
  noBody?: string;
}

/** A copy kind's row name from its own `how`: "cc" -> "Cc", "bcc" -> "Bcc". */
export const copyRowLabel = (how: string) => (how ? how.charAt(0).toUpperCase() + how.slice(1) : 'Copy');

/** The address rows under the sender, in the order an email client shows them, each with its addresses. */
export function emailAddressRows(props: Pick<EmailViewProps, 'to' | 'replyTo' | 'copies'>): { label: string; values: string[] }[] {
  const copies = new Map<string, string[]>();
  for (const copy of props.copies ?? []) copies.set(copy.how, [...(copies.get(copy.how) ?? []), copy.to]);
  return [
    { label: 'To', values: [...props.to] },
    ...[...copies].map(([how, values]) => ({ label: copyRowLabel(how), values })),
    { label: 'Reply to', values: props.replyTo ? [props.replyTo] : [] },
  ].filter(row => row.values.length > 0);
}

const sentWhen = (iso: string | null | undefined) => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' })
    : '';
};

/** A name from "Name <address>", else the address itself. */
const displayName = (sender: string) => sender.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || sender;
/** The address from "Name <address>", else the words as they are. */
const addressOf = (sender: string) => /<([^>]+)>\s*$/.exec(sender)?.[1] ?? sender;

export function EmailView({ subject, from, to, replyTo, copies, preheader, sentAt, bodyMarkdown, bodyText, actions, footer, noBody = 'This message has no words.' }: EmailViewProps) {
  const body = bodyMarkdown?.trim() ? bodyMarkdown : bodyText?.trim() ? bodyText : null;
  return (
    <Container layout="vertical" gap="md" padding="lg" minWidth="0" border="all" rounded="lg" data-email-view="">
      <Container layout="horizontal" gap="sm" alignItems="start" justifyContent="between">
        <Container layout="vertical" gap="xs" minWidth="0">
          <Text variant="heading-lg" as="h2">{subject || 'No subject'}</Text>
          {preheader ? <Text variant="caption">{preheader}</Text> : null}
        </Container>
        {actions ? <Container layout="horizontal" gap="xs" alignItems="center">{actions}</Container> : null}
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0">
          <PersonTag name={displayName(from)} size="sm" />
          <Container layout="vertical" gap="none" minWidth="0">
            <Text variant="body" weight="medium" truncate>{displayName(from)}</Text>
            {addressOf(from) !== displayName(from) ? <Text variant="caption" truncate>{addressOf(from)}</Text> : null}
          </Container>
        </Container>
        <Text variant="caption" wrap="nowrap">{sentWhen(sentAt)}</Text>
      </Container>
      <Container layout="vertical" gap="xs" data-email-addresses="">
        {emailAddressRows({ to, replyTo, copies }).map(row => (
          <Container key={row.label} layout="horizontal" gap="sm" alignItems="center" minWidth="0">
            <Text variant="label">{row.label}</Text>
            <Text variant="body-xs">{row.values.join(', ')}</Text>
          </Container>
        ))}
      </Container>
      <Container layout="vertical" minWidth="0" data-email-body="">
        {body
          ? <MarkdownWords words={body} />
          : <Container padding="lg"><Text variant="caption">{noBody}</Text></Container>}
      </Container>
      {footer ? <Container layout="horizontal" gap="xs" alignItems="center" data-email-footer="">{footer}</Container> : null}
    </Container>
  );
}
