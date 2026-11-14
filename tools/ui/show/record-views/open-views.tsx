// parts/ui/show/record-views/open-views.tsx
//
// PURPOSE
//   The kinds of view an opened record can be drawn in beside a record list (record-set.tsx): `email` draws it the way
//   an email client's reading pane does (../email-view), `text` draws its title, who it went to, when, and its words.
//   A record set's DATA picks the view by id (its kind row's view id) and names, per role, which record fields the view
//   reads, so a view never knows which list it is drawing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A view reads a record only through `role(name)`: the record set's DATA maps each role to the record's fields.
//   2. Views are a registry: another part adds one with registerOpenView; the list screen never branches on a view id.
//      An unknown id draws the record set's fallback view.
//   3. Composed only from shared parts (Container, Text, EmailView, MarkdownWords); no markup is written here, and a
//      record's words are drawn from markdown or plain text by the one markdown renderer, never run as HTML.

import React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import { EmailView, type EmailCopy } from '../email-view';
import { MarkdownWords } from '../markdown-block/MarkdownWords';

export type OpenViewProps = {
  record: unknown;
  /** The record's value for one role, as the record set's DATA maps roles to fields (first non-empty field wins). */
  role: (name: string) => unknown;
  /** The label of the record's kind row, when the record set has kinds. */
  kindLabel: string | null;
  /** The caller's buttons for this record (open it where it lives, close). */
  actions: React.ReactNode;
};
export type OpenView = (props: OpenViewProps) => React.ReactElement;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : text(value) ? [value as string] : []);
const copiesOf = (value: unknown): EmailCopy[] => (Array.isArray(value)
  ? value.filter((one): one is EmailCopy => Boolean(one) && typeof (one as EmailCopy).to === 'string' && typeof (one as EmailCopy).how === 'string')
  : []);
const exactWhen = (iso: string | null) => {
  const at = new Date(iso ?? '');
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
};

/** An email, as an email client's reading pane shows it. */
function EmailOpenView({ role, actions }: OpenViewProps) {
  return (
    <EmailView
      subject={text(role('subject')) ?? ''}
      from={text(role('from')) ?? ''}
      to={texts(role('to'))}
      replyTo={text(role('reply_to'))}
      copies={copiesOf(role('copies'))}
      preheader={text(role('preheader'))}
      sentAt={text(role('when'))}
      bodyMarkdown={text(role('markdown'))}
      bodyText={text(role('text'))}
      actions={actions}
    />
  );
}

/** Anything else: its kind, its title, who it went to, when, and its words. */
function TextOpenView({ role, kindLabel, actions }: OpenViewProps) {
  const words = text(role('words'));
  const to = texts(role('to'));
  return (
    <Container layout="vertical" gap="md" padding="lg" minWidth="0" data-open-view="text">
      <Container layout="horizontal" gap="sm" alignItems="start" justifyContent="between">
        <Container layout="vertical" gap="xs" minWidth="0">
          {kindLabel ? <Text variant="label">{kindLabel}</Text> : null}
          <Text variant="heading-lg" as="h2">{text(role('title')) ?? 'Untitled'}</Text>
        </Container>
        <Container layout="horizontal" gap="xs" alignItems="center">{actions}</Container>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="body-xs" truncate>{to.length ? `To ${to.join(', ')}` : ''}</Text>
        <Text variant="caption" wrap="nowrap">{exactWhen(text(role('when')))}</Text>
      </Container>
      <Container layout="vertical" border="all" rounded="lg" minWidth="0">
        {words
          ? <MarkdownWords words={words} breaks />
          : <Container padding="lg"><Text variant="caption">No words were kept for this.</Text></Container>}
      </Container>
    </Container>
  );
}

const OPEN_VIEWS = new Map<string, OpenView>([['email', EmailOpenView], ['text', TextOpenView]]);

/** Adds (or replaces) the view drawn for `id`. */
export function registerOpenView(id: string, view: OpenView): void {
  OPEN_VIEWS.set(id, view);
}

/** The view registered for `id`, else the one for `fallback`, else `text`. */
export function openViewFor(id: string | null | undefined, fallback: string): OpenView {
  return (id ? OPEN_VIEWS.get(id) : undefined) ?? OPEN_VIEWS.get(fallback) ?? TextOpenView;
}
