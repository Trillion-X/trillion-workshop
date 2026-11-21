// src/workspace/messages-screen.tsx
//
// The Messages screen: the person's conversations in a list beside the one open. A conversation is the messages their
// apps told (iMessage, WhatsApp) or the conversation kept with one of their AIs. Its messages are bubbles, the person's
// on the right and the other side's on the left, grouped by day, by who said them and by time; a photo shows as a tile
// with its name, since its picture is not reachable from here. Each conversation's app picture (activity-providers.json)
// or initials stand for who it is with. The words are messages-words.json and the rows come from the owners' tables
// through chat-records.ts. Replying is not built here yet, so the composer is shown and says so.
// This file only starts the records the screen reads (chat-records.ts: the conversation list and each open conversation's
// lines) and mounts the screen on the conversation a sidebar row or an address names, or the newest one.

import React from 'react';
import { MessageSquare } from 'lucide-react';
import { Button, Card, Container, EmptyPlaceholder, Text, notify } from '../../../../ui';
import { Composer } from '../../../../ui/show/composer';
import { DisplayMark } from '../../../../ui/show/display-mark';
import { HoverRevealGroup, HoverRevealItem } from '../../../../ui/show/hover-reveal';
import { SearchField } from '../../../../ui/show/search-field/SearchField';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { canRetainAfterReadFailure, ScreenState, useScreenLoad } from '../../../../ui/show/screen-state';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { CONVERSATIONS_ADDRESS, canonicalConversationId, forgetInConversation, openConversation, startChatRecords, windowAddressOf, type Line } from './chat-records';
import { readRecordAt, showRecords, subscribeRecordLabel } from './records';
import { refusal } from './failure';
import liveScopes from '../live-scopes.json';
import { AI_MESSAGES, onStoreChange, watchWindow } from './store-changes';
import { daysOf, type Turn } from './messages-turns';
import words from './messages-words.json';

// How many of the newest messages the screen holds as a window the store keeps current (src/live-scopes.json).
const MESSAGE_WINDOW = liveScopes.windows.find(window => window.list === 'messages')?.watch ?? 50;
const useRecord = <T,>(label: string) => React.useSyncExternalStore(React.useCallback((listener: () => void) => subscribeRecordLabel(label, listener), [label]), () => readRecordAt<T>(label), () => readRecordAt<T>(label));

/** The mark a name is drawn with: the app's picture, the initials of a name, or a person glyph when the name is only a
 *  number or a handle (initials of a phone number mean nothing). */
const markOf = (name: string, image: string | null) => (image ? { name, image } : /\p{L}/u.test(name) ? { name } : { name, glyph: 'User' });

const clockOf = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function FileTile({ name, contentType }: { name: string; contentType: string }) {
  const photo = contentType.startsWith('image/');
  return (
    <Card variant="nested" radius="lg" padding="sm">
      <Text variant="caption" color="muted">{photo ? words.photo : words.file}</Text>
      {name ? <Text variant="body-xs">{name}</Text> : null}
    </Card>
  );
}

function ForgetButton({ onForget }: { onForget: () => void }) {
  const [armed, setArmed] = React.useState(false);
  return (
    <Button variant="ghost" size="sm" onBlur={() => setArmed(false)} onClick={() => (armed ? onForget() : setArmed(true))}>
      {armed ? words.forget_confirm : words.forget}
    </Button>
  );
}

function BubbleLine({ line, mine, onForget }: { line: Line; mine: boolean; onForget: (atomRef: string) => void }) {
  return (
    <Container layout="vertical" gap="xs" alignItems={mine ? 'end' : 'start'}>
      {line.files?.map(file => <FileTile key={file.key || file.name} name={file.name} contentType={file.contentType} />)}
      {line.content ? (
        <HoverRevealGroup layout="horizontal" gap="xs" alignItems="center" justifyContent={mine ? 'end' : 'start'}>
          {mine && line.forgettable ? <HoverRevealItem><ForgetButton onForget={() => onForget(line.atomRef)} /></HoverRevealItem> : null}
          <Card variant={mine ? 'solid' : 'bubble'} radius="pill" padding="sm">
            <Text variant="body">{line.content}</Text>
          </Card>
          {!mine && line.forgettable ? <HoverRevealItem><ForgetButton onForget={() => onForget(line.atomRef)} /></HoverRevealItem> : null}
        </HoverRevealGroup>
      ) : null}
    </Container>
  );
}

function TurnView({ turn, title, logoUrl, onForget }: { turn: Turn; title: string; logoUrl: string | null; onForget: (atomRef: string) => void }) {
  // In a one-to-one conversation the author is the conversation itself, so only a group names who is talking.
  const speaker = turn.author && turn.author !== title ? turn.author : null;
  return (
    <Container layout="horizontal" gap="sm" alignItems="end" justifyContent={turn.mine ? 'end' : 'start'}>
      {!turn.mine && speaker ? <DisplayMark spec={markOf(speaker, null)} size="sm" /> : null}
      {!turn.mine && !speaker ? <DisplayMark spec={markOf(title, logoUrl)} size="sm" /> : null}
      <Container layout="vertical" gap="xs" alignItems={turn.mine ? 'end' : 'start'} width="min(72%, 34rem)">
        {speaker ? <Text variant="caption" color="muted">{speaker}</Text> : null}
        {turn.lines.map(line => <BubbleLine key={line.atomRef} line={line} mine={turn.mine} onForget={onForget} />)}
        <Text variant="caption" color="faint">{clockOf(turn.time)}</Text>
      </Container>
    </Container>
  );
}

/** The open conversation: its header, its messages as turns of talk, and the composer (not built yet, so it says so). */
function OpenConversation({ focus, row }: { focus: string; row: ConversationRow }) {
  const window = useRecord<Window>(windowAddressOf(focus));
  const loaded = useScreenLoad(windowAddressOf(focus), {
    loading: { label: words.loading, layout: 'rows' },
    read: async () => {
      try { await openConversation(focus); return true; }
      catch (error) {
        if (!canRetainAfterReadFailure(error)) showRecords({ [windowAddressOf(focus)]: null });
        throw error;
      }
    },
    failed: refusal(words.failed_title, { label: words.failed_action, run: () => location.assign('/messages') }),
  });
  React.useEffect(() => onStoreChange(loaded.reload, AI_MESSAGES), [loaded.reload]);
  // The newest messages are a window the store keeps up to date by ops: a change in them reads this screen again.
  React.useEffect(() => watchWindow('messages', MESSAGE_WINDOW).stop, []);
  const state = loaded.state?.status === 'loading' && window ? null : loaded.state;
  const lines = window?.lines ?? [];
  const days = React.useMemo(() => daysOf(lines, new Date(), words), [lines]);
  const onForget = React.useCallback((atomRef: string) => {
    forgetInConversation(focus, atomRef)
      .then(() => notify(words.forgotten))
      .catch((error: unknown) => notify(errorWords(error, words.forget_failed), { kind: 'error' }));
  }, [focus]);
  const name = row.title;
  return (
    <Container layout="vertical" flex="1" minWidth="0" minHeight="0" aria-label={name}>
      <Container layout="horizontal" gap="sm" alignItems="center" padding="sm">
        <DisplayMark spec={markOf(name, row.logoUrl)} size="md" />
        <Container layout="vertical" minWidth="0">
          <Text variant="heading-xs">{name}</Text>
          <Text variant="caption" color="muted">{words.source_names[row.source as keyof typeof words.source_names] ?? row.source}</Text>
        </Container>
      </Container>
      {state ? <ScreenState state={window && state.status === 'failed' ? { ...state, inline: true } : state} /> : null}
      {!state || window ? (
        <Container layout="vertical" flex="1" minHeight="0" overflow="y-auto" padding="md" gap="md">
          {days.length ? days.map(day => (
            <Container key={day.key} layout="vertical" gap="sm">
              <Container layout="horizontal" justifyContent="center"><Text variant="caption" color="muted">{day.label}</Text></Container>
              {day.turns.map((turn, index) => <TurnView key={turn.lines[0].atomRef || index} turn={turn} title={name} logoUrl={row.logoUrl} onForget={onForget} />)}
            </Container>
          )) : <Container layout="horizontal" justifyContent="center"><Text variant="caption" color="muted">{words.empty_thread}</Text></Container>}
        </Container>
      ) : null}
      <Container layout="vertical" padding="sm">
        <Composer disabled onSend={() => Promise.reject(new Error(words.no_reply))} words={{ placeholder: words.composer_placeholder }} />
      </Container>
    </Container>
  );
}

/** The conversation list (search, newest first) beside the open conversation. Until the owners' tables are read, or when
 *  none of them holds a conversation yet, the list says Trillion is connecting to the person's messages. */
function MessagesChooser({ given }: { given?: string }) {
  const [picked, setPicked] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [read, setRead] = React.useState(false);
  const conversations = useRecord<Conversations>(CONVERSATIONS_ADDRESS);
  const rows = conversations?.rows ?? [];
  React.useEffect(() => {
    let live = true;
    const done = () => { if (live) setRead(true); };
    startChatRecords().then(done, done);
    return () => { live = false; };
  }, []);
  const requested = picked ?? (given ? canonicalConversationId(given) : null);
  const focus = rows.some(row => row.recordId === requested) ? requested : rows[0]?.recordId ?? null;
  const shown = rows.filter(row => {
    const match = query.trim().toLocaleLowerCase();
    return !match || row.title.toLocaleLowerCase().includes(match) || (row.lastMessagePreview ?? '').toLocaleLowerCase().includes(match);
  });
  const open = rows.find(row => row.recordId === focus);
  return (
    <Container as="main" layout="horizontal" height="full" minHeight="0" aria-label={words.title}>
      <Container layout="vertical" width="320px" minHeight="0" padding="sm" gap="sm" overflow="y-auto">
        <Container layout="vertical" padding="xs">
          <Text variant="heading-xs">{words.title}</Text>
        </Container>
        <SearchField label={words.search} placeholder={words.search} value={query} onChange={event => setQuery(event.currentTarget.value)} />
        {!read && !rows.length ? <ScreenState state={{ status: 'loading', label: words.loading, layout: 'rows' }} /> : null}
        {read && !rows.length ? <EmptyPlaceholder icon={MessageSquare} title={words.connecting_title} message={words.connecting_body} /> : null}
        {rows.length && !shown.length ? <Text variant="caption" color="muted">{words.no_matches}</Text> : null}
        <Container layout="vertical" gap="xs" aria-label={words.conversations}>
          {shown.map(row => {
            const preview = row.lastMessagePreview === null ? '' : row.lastMessagePreview || words.photo;
            const mine = row.lastMessageRole === 'human';
            return (
              <Card as="button" type="button" key={row.recordId} variant="ghost" interactive selected={row.recordId === focus} className="text-left"
                aria-current={row.recordId === focus ? 'true' : undefined} onClick={() => setPicked(row.recordId)} padding="sm">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <DisplayMark spec={markOf(row.title, row.logoUrl)} size="md" />
                  <Container layout="vertical" minWidth="0" flex="1">
                    <Text variant="body" color="strong">{row.title}</Text>
                    <Text variant="caption" color="muted">{`${mine ? words.you_prefix : ''}${preview}`}</Text>
                  </Container>
                </Container>
              </Card>
            );
          })}
        </Container>
      </Container>
      {open ? <OpenConversation key={open.recordId} focus={open.recordId} row={open} /> : (
        read ? <EmptyPlaceholder icon={MessageSquare} title={words.connecting_title} message={words.connecting_body} fill /> : null
      )}
    </Container>
  );
}

export function mountMessagesScreen(element: HTMLElement, props?: { surfaceInput?: { conversation?: string } }): () => void {
  return mountReactSurface(element, <MessagesChooser given={props?.surfaceInput?.conversation} />);
}
