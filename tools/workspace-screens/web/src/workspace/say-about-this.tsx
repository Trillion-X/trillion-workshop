// src/workspace/say-about-this.tsx
//
// PURPOSE
//   Say about this: under anything opened in its own tab (a recording, a picture, a document), what the person said
//   about it and a message box to say more, right where they are looking. On a recording each note is kept at the
//   moment the player is on, listed with that moment, and pressing the moment plays from there. The box sends to the
//   person's own AIs, so the same words are a note to themselves and a request to their AI ("make this part slower",
//   "no reframe here"); the work their AI starts shows under the box while it is done. A host opening a shared room
//   item instead supplies that room and item: its critiques are ordinary room replies, visible to its members.
//
//   It composes parts that already exist, nothing new underneath:
//     - the shared Composer (parts/ui/show/composer) and its send road, the one every message to every AI takes
//       (/work/api/messages/send-all), with `anchor` { record, part } (src/responses.mjs): the thing and, on a
//       recording, the moment ({ kind: say-about-this.json part_kind, start_ms });
//     - the person store's read of every message that names one record (GET /work/api/messages/about, through the
//       index of what names what, src/record-scope.mjs recordsNaming);
//     - the work view every box shows (job-run.tsx JobRuns).
//     - the existing room response read and item writer for a shared audience (/work/api/spaces/<id>/responses and
//       /items): the same anchor, reply_to, attachment sharing and revision notifications every room already uses.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of file or a screen: the host hands the record, its files, its title and, for a
//      recording, a clock (where it is playing) and a way to move it.
//   2. Words are DATA (say-about-this.json).
//   3. A note is a kept message for the thing's audience: the person's own AIs for a private record, or members of
//      its supplied room. It lists here from that audience's store; nothing is kept in this page.
//   4. The list is read again whenever the person's store changes, never on a timer.
//   5. A React host that plays the thing follows its player through usePlayClock; a DOM host builds the same PlayClock.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Button, Container, NamedIcon, Text } from '../../parts/ui';
import { Composer, type ComposerDraft } from '../../parts/ui/show/composer';
import { postJson, readItemJson, readJson } from './api';
import { reasonOf } from './failure';
import { JobRuns, type RunRef } from 'trillion-workshop/tools/hand-work-to-ais/web/src/workspace/job-run.tsx';
import { keepFiles, postToAllAis, wordsWithLinks } from './send-message';
import { AI_MESSAGES, onStoreChange } from './store-changes';
import { momentInWords } from '../../parts/ui/show/relative-time/relative-time';
import words from './say-about-this.json';

/** Whether a file of this type plays over time, so a note about it is kept at a moment. */
export const isRecording = (contentType: string) => /^(audio|video)\//i.test(contentType);
/** Where a recording is playing, for a host that follows its player. */
export type PlayClock = { now: () => number; subscribe: (listener: () => void) => () => void };
type Part = { kind: string; start_ms?: number };
type Note = { id: string; text: string; at: string | null; speaker: string | null; app: string | null; part?: Part };
export type NoteSpace = { id: string; title: string };
type SharedNote = { item_id: string; kind: string; body?: { text?: string } | string | null;
  part?: Part; anchor?: { part?: Part }; provenance?: { by?: string; by_you?: boolean; added_at?: string } };
type NotePage = { scope: string; notes: Note[] | null; next: string | null; failed: string | null; more: boolean };

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
const two = (value: number) => String(value).padStart(2, '0');
/** A moment as a player shows it: 0:42, 12:05, 1:02:05. */
export function momentWords(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours ? `${hours}:${two(minutes)}:${two(whole % 60)}` : `${minutes}:${two(whole % 60)}`;
}
const momentOf = (note: Note) => (note.part?.kind === words.part_kind && Number.isFinite(note.part.start_ms) ? (note.part.start_ms as number) / 1000 : null);
const whenWords = (at: string | null) => momentInWords(at);
const stillClock: PlayClock = { now: () => 0, subscribe: () => () => {} };
const ordered = (notes: Note[]) => notes.slice().sort((a, b) => (momentOf(a) ?? Infinity) - (momentOf(b) ?? Infinity) || String(b.at).localeCompare(String(a.at)));

/** A player's clock for a React host: `heard` goes to the player's onTimeChange, `seekRequest` to its seekRequest, and
 *  `clock` and `seek` to SayAboutThis, so a note is kept at the moment playing and pressing a note plays from there. */
export function usePlayClock(): { clock: PlayClock; heard: (seconds: number) => void; seek: (seconds: number) => void; seekRequest: { requestId: number; seconds: number } | null } {
  const [seekRequest, setSeekRequest] = React.useState<{ requestId: number; seconds: number } | null>(null);
  const kept = React.useRef({ at: 0, listeners: new Set<() => void>() });
  const clock = React.useMemo<PlayClock>(() => ({
    now: () => kept.current.at,
    subscribe: listener => { kept.current.listeners.add(listener); return () => { kept.current.listeners.delete(listener); }; },
  }), []);
  const heard = React.useCallback((seconds: number) => { kept.current.at = seconds; kept.current.listeners.forEach(listener => listener()); }, []);
  const seek = React.useCallback((seconds: number) => setSeekRequest(previous => ({ requestId: (previous?.requestId ?? 0) + 1, seconds })), []);
  return { clock, heard, seek, seekRequest };
}

function NoteRow({ note, onSeek }: { note: Note; onSeek?: (seconds: number) => void }) {
  const moment = momentOf(note);
  return (
    <Container as="li" layout="horizontal" gap="sm" minWidth="0" data-note={note.id}>
      {moment !== null && onSeek ? (
        <Button variant="secondary" size="sm" aria-label={fill(words.play_from, { time: momentWords(moment) })} onClick={() => onSeek(moment)}>
          <NamedIcon name={words.moment_icon} size="xs" aria-hidden="true" />
          {momentWords(moment)}
        </Button>
      ) : null}
      <Container layout="vertical" gap="xs" minWidth="0" flex={1}>
        <Text variant="body" className="whitespace-pre-wrap break-words">{note.text}</Text>
        <Text variant="caption">{[note.speaker === 'person' ? words.you : note.app ?? note.speaker, whenWords(note.at)].filter(Boolean).join(' · ')}</Text>
      </Container>
    </Container>
  );
}

/** The window event `sendNoteAbout` raises once a note is kept, so the notes listed for that thing read themselves again at once. */
export const NOTE_KEPT = 'trillion-note-kept';

/** What the person said about a thing, sent to every AI and anchored to the thing (and, when `atSeconds` is given, to that moment of it). The one send under both the note box here and the docked composer. */
export async function sendNoteAbout({ record, files, atSeconds, draft }: { record: string; files: readonly { identity: string }[]; atSeconds: number | null; draft: ComposerDraft }) {
  const anchor = { record, ...(atSeconds === null ? {} : { part: { kind: words.part_kind, start_ms: Math.round(atSeconds * 1000) } }) };
  const kept = await keepFiles(draft);
  const sent = await postToAllAis<{ message: string; message_id?: string }>({
    text: wordsWithLinks(draft),
    files: [...files, ...kept.map(file => ({ identity: file.identity }))],
    mentions: draft.mentions,
    anchor,
  }, draft);
  window.dispatchEvent(new CustomEvent(NOTE_KEPT, { detail: { record } }));
  return sent;
}

export function SayAboutThis({ record, files, title, clock, onSeek, space, composer = true }: {
  record: string;
  files: readonly { identity: string }[];
  title: string;
  clock?: PlayClock | null;
  onSeek?: (seconds: number) => void;
  space?: NoteSpace;
  /** False when the page's one docked composer (global-composer.tsx DockedComposer) is where a note is written. */
  composer?: boolean;
}) {
  const playing = clock ?? stillClock;
  const now = React.useSyncExternalStore(playing.subscribe, playing.now);
  const scope = JSON.stringify([space?.id ?? null, record]);
  const current = React.useRef({ scope, read: 0, alive: true });
  current.current.scope = scope;
  const [page, setPage] = React.useState<NotePage>({ scope, notes: null, next: null, failed: null, more: false });
  const notes = page.scope === scope ? page.notes : null;
  const failed = page.scope === scope ? page.failed : null;
  const [runs, setRuns] = React.useState<RunRef[]>([]);
  const spaceId = space?.id;
  const room = spaceId ? `/work/api/spaces/${encodeURIComponent(spaceId)}` : null;
  const read = React.useCallback(async (cursor?: string) => {
    const reading = ++current.current.read;
    const applies = () => current.current.alive && current.current.scope === scope && current.current.read === reading;
    if (cursor) setPage(previous => previous.scope === scope ? { ...previous, more: true, failed: null } : previous);
    try {
      const answer = room
        ? await readItemJson<{ items: SharedNote[]; next_after?: string | null }>(`${room}/responses?${new URLSearchParams({ record, all_parts: 'true', limit: '40', ...(cursor ? { before: cursor } : {}) })}`)
        : await readJson<{ notes: Note[] }>(`/work/api/messages/about?${new URLSearchParams({ record })}`);
      if (!answer || !Array.isArray('items' in answer ? answer.items : answer.notes)) throw new Error('The saved notes could not be read.');
      const incoming = 'items' in answer ? answer.items.filter(item => item.kind === 'message').map(item => ({
        id: item.item_id, text: typeof item.body === 'string' ? item.body : item.body?.text ?? '',
        at: item.provenance?.added_at ?? null, speaker: item.provenance?.by_you ? 'person' : item.provenance?.by ?? words.member,
        app: null, part: item.anchor?.part ?? item.part,
      })) : answer.notes;
      if (!applies()) return;
      setPage(previous => ({ scope, notes: ordered([...new Map([...(cursor && previous.scope === scope ? previous.notes ?? [] : []), ...incoming].map(note => [note.id, note])).values()]),
        next: 'items' in answer ? answer.next_after ?? null : null, failed: null, more: false }));
    } catch (error) {
      const refused = Boolean(room) || [401, 403, 404].includes(Number((error as { status?: number }).status));
      if (applies()) setPage(previous => ({ scope, notes: cursor && !refused && previous.scope === scope ? previous.notes : null, next: cursor && !refused && previous.scope === scope ? previous.next : null, failed: reasonOf(error), more: false }));
    }
  }, [record, room, scope]);
  React.useEffect(() => {
    current.current.alive = true;
    setRuns([]);
    void read();
    const stop = onStoreChange(() => read(), AI_MESSAGES);
    const kept = (event: Event) => { if ((event as CustomEvent<{ record?: string }>).detail?.record === record) void read(); };
    window.addEventListener(NOTE_KEPT, kept);
    return () => { current.current.alive = false; current.current.read += 1; stop(); window.removeEventListener(NOTE_KEPT, kept); };
  }, [read]);

  const targetContext = clock
    ? [{ id: 'moment', label: fill(words.at, { time: momentWords(now) }), icon: words.moment_icon }]
    : [{ id: 'about', label: fill(words.about, { title }), icon: words.about_icon }];
  const context = space ? [...targetContext, { id: 'audience', label: fill(words.shared_with, { title: space.title }), icon: words.about_icon }] : targetContext;
  const send = async (draft: ComposerDraft) => {
    const at = clock ? clock.now() : null;
    const anchor = { record, ...(at === null ? {} : { part: { kind: words.part_kind, start_ms: Math.round(at * 1000) } }) };
    try {
      if (room) {
        const kept = await keepFiles(draft);
        const about: string[] = [];
        for (const file of kept) about.push((await postJson<{ item_id: string }>(`${room}/share`, { file: file.name })).item_id);
        await postJson(`${room}/items`, { items: [{ kind: 'message', body: { text: wordsWithLinks(draft), mentions: draft.mentions },
          reply_to: record, anchor, ...(about.length ? { about } : {}) }] });
        if (current.current.alive && current.current.scope === scope) void read();
        return fill(words.shared_sent, { title: space?.title ?? title });
      }
      const sent = await sendNoteAbout({ record, files, atSeconds: at, draft });
      if (current.current.alive && current.current.scope === scope) {
        if (sent.message_id) setRuns(previous => [{ message: sent.message_id as string }, ...previous].slice(0, 3));
        void read();
      }
      return sent.message;
    } catch (error) { throw new Error(reasonOf(error)); }
  };

  return (
    <Container as="section" layout="vertical" gap="md" minWidth="0" aria-label={words.heading} data-say-about-this="">
      <Text as="h2" variant="heading-xs">{words.heading}</Text>
      {failed ? <Container layout="horizontal" gap="sm" alignItems="center"><Text variant="caption">{`${words.failed}: ${failed}`}</Text><Button variant="secondary" size="sm" onClick={() => read()}>{words.retry}</Button></Container> : null}
      {notes && notes.length ? (
        <Container as="ul" layout="vertical" gap="md" minWidth="0">
          {notes.map(note => <NoteRow key={note.id} note={note} onSeek={onSeek} />)}
        </Container>
      ) : notes ? <Text variant="caption">{space ? words.shared_empty : words.empty}</Text> : null}
      {page.scope === scope && page.next ? <Button variant="secondary" size="sm" disabled={page.more} onClick={() => read(page.next!)}>{words.more}</Button> : null}
      {composer ? <Composer key={scope} onSend={send} context={context} words={{ label: words.label, placeholder: space ? words.shared_placeholder : words.placeholder }} /> : null}
      {space || !composer ? null : <JobRuns runs={runs} />}
    </Container>
  );
}
