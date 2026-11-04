import * as React from 'react';
import { Button, Container, Dropdown, Text } from '../../ui';
import type { MeetingCalendarContext } from '../do-work/meeting-join-recording';

export type MeetingAssociationPiece = { id: string; label: string; content: React.ReactNode };
export type MeetingAssociationWords = {
  title: string; unreadable: string; missing: string; detached: string;
  loading: string; failed: string; retry: string; partial: string; empty: string; choose: string;
  link: string; change: string; unlink: string; open: string; refresh: string; search: string;
  /** Compact mode: the Change menu's trigger, and the captions over its two groups. */
  change_short: string; meetings_group: string; actions_group: string;
};

/** Controlled recording metadata. The caller owns reads, persistence and arrangement. */
export function MeetingAssociationPanel({
  state, context, contextLabel, options, loadState, selected, busy, message, words,
  onSelect, onLink, onUnlink, onOpen, onRefresh, renderPieces, compact = false,
}: {
  state: 'attached' | 'detached' | 'missing' | 'unreadable';
  context: MeetingCalendarContext | null; contextLabel: string;
  options: { value: string; label: string }[];
  loadState: 'loading' | 'ready' | 'partial' | 'failed';
  selected: string; busy: boolean; message: string; words: MeetingAssociationWords;
  onSelect: (value: string) => void; onLink: (value?: string) => void; onUnlink: () => void;
  onOpen: () => void; onRefresh: () => void;
  renderPieces?: (pieces: readonly MeetingAssociationPiece[]) => React.ReactNode;
  /** One row (Meeting, what it is, a Change menu holding the meetings and Unlink, Open, Refresh) instead of the four-piece panel. */
  compact?: boolean;
}): React.ReactElement {
  const mayChange = state === 'attached' || state === 'detached';
  const status = loadState === 'loading' ? words.loading : loadState === 'failed' ? words.failed
    : loadState === 'partial' ? words.partial : options.length ? '' : words.empty;
  if (compact) {
    const act = (id: string) => ({ unlink: onUnlink, open: onOpen, refresh: onRefresh })[id]?.();
    const items = [
      ...(mayChange ? options.map(option => ({ value: option.value, label: option.label, section: words.meetings_group })) : []),
      ...(context ? [{ value: 'action:unlink', label: words.unlink, icon: 'Unlink', section: words.actions_group }, { value: 'action:open', label: words.open, icon: 'ExternalLink', section: words.actions_group }] : []),
      { value: 'action:refresh', label: words.refresh, icon: 'RefreshCw', section: words.actions_group },
    ];
    return <Container layout="vertical" gap="xs" padding="sm" aria-label={words.title}>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <Text variant="body" color="subtle">{words.title}</Text>
        <Text variant="body" color="strong">{context ? contextLabel : words[state === 'attached' ? 'unreadable' : state]}</Text>
        <Dropdown items={items} value="" searchable searchLabel={words.search} aria-label={words.change} placeholder={words.change_short} scrollable align="start"
          header={loadState === 'partial' || (loadState === 'ready' && !options.length) ? (loadState === 'partial' ? words.partial : words.empty) : undefined}
          disabled={busy}
          onValueChange={value => { if (value.startsWith('action:')) act(value.slice('action:'.length)); else if (typeof value === 'string') { onSelect(value); onLink(value); } }} />
      </Container>
      {loadState === 'loading' || loadState === 'failed' ? <Text variant="body-sm" color="subtle" role="status">{loadState === 'loading' ? words.loading : words.failed}</Text> : null}
      {loadState === 'failed' ? <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>{words.retry}</Button> : null}
      {message ? <Text variant="body-sm" color="subtle" role="status">{message}</Text> : null}
    </Container>;
  }
  const pieces: MeetingAssociationPiece[] = [
    { id: 'current', label: words.title, content: <Container layout="vertical" gap="xs">
      <Text variant="heading-sm" color="strong">{words.title}</Text>
      <Text variant="body" color="subtle">{context ? contextLabel : words[state === 'attached' ? 'unreadable' : state]}</Text>
    </Container> },
    { id: 'choice', label: words.choose, content: <Container layout="vertical" gap="xs">
      {status ? <Text variant="body" color="subtle" role="status">{status}</Text> : null}
      {options.length ? <Dropdown items={options} value={selected} searchable searchLabel={words.search} aria-label={words.choose} placeholder={words.choose}
        disabled={busy || !mayChange || loadState === 'loading'} scrollable onValueChange={onSelect} /> : null}
    </Container> },
    { id: 'actions', label: words.link, content: <Container layout="horizontal" gap="sm" wrap alignItems="center">
      <Button variant="outline" size="sm" disabled={busy || !mayChange || !selected || !['ready', 'partial'].includes(loadState)} onClick={onLink}>{context ? words.change : words.link}</Button>
      {context ? <Button variant="ghost" size="sm" disabled={busy} onClick={onUnlink}>{words.unlink}</Button> : null}
      {context ? <Button variant="ghost" size="sm" disabled={busy} onClick={onOpen}>{words.open}</Button> : null}
      <Button variant="ghost" size="sm" disabled={busy || loadState === 'loading'} onClick={onRefresh}>{words.refresh}</Button>
    </Container> },
    { id: 'message', label: words.title, content: message ? <Text variant="body" color="subtle" role="status">{message}</Text> : null },
  ];
  return <Container layout="vertical" gap="sm" padding="sm" aria-label={words.title}>
    {renderPieces ? renderPieces(pieces) : pieces.map(piece => <React.Fragment key={piece.id}>{piece.content}</React.Fragment>)}
  </Container>;
}
