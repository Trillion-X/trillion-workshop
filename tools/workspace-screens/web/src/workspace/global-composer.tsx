// src/workspace/global-composer.tsx
//
// PURPOSE
//   The one message box for every screen; a screen that adds its own message box repeats it. Every screen can open it:
//   from its sidebar row (surfaces.json trillion.message-box), by its
//   keys from anywhere (the `message-box` rows of keymap.json), or by a host app handing it something to send. It is a screen, and
//   the screen arrangement floats it over the work in its overlay layer (the row's open_placement); it sends once to
//   every AI on the account, or only to the AIs it mentions (src/workspace/send-message.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. It is the shared Composer (parts/ui/show/composer), with the same send owner as Home's box; nothing here sends.
//      Under it, as on Home, the screen the words pick while they are written (instant-screen.tsx).
//   2. The keys are rows of keymap.json (the one keymap) and the words are DATA (global-composer.json).
//   3. Closing its window keeps nothing half-sent: one box is kept for the page, so what was in it is there again the
//      next time the window opens, until it is sent or the page closes.
//   4. Floating over the work is the arrangement's layer; nothing here places itself over the page.
//   5. A host (the iPhone share sheet, the Mac app) opens it with something to send through one entry point,
//      window.trillionComposer.open({ text, links, files: [{ name, type, base64 | url }] }); nothing else reaches into it.
//      A file handed by address is read from there, so a large video never has to cross as text. What happens to
//      something a host handed in is told back as one window event, `trillion-composer`, with { event: 'sent', message }
//      or { event: 'closed' }, so the host can close itself.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Container, NamedIcon } from '../../parts/ui';
import { Composer, type ComposerDraft, type ComposerProps } from '../../parts/ui/show/composer';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import { listWalkthroughs, startListedWalkthrough, type WalkthroughListing } from '../../parts/guided-overlay/show/walkthroughs';
import { exampleAt, freshChange } from './ask-bar-change.mjs';
import { useMentions } from './mentions';
import { useSnippets } from './snippets';
import { readPastedLink } from './send-message';
import { sendNoteAbout, momentWords, type PlayClock } from './say-about-this';
import sayWords from './say-about-this.json';
import { useSendChoices } from './send-choices';
import { JobRuns } from './job-runs-later';
import { InstantScreen } from './instant-screen';
import { openScreen } from './open-screen';
import { PlanNeeded } from './api';
import { planNeededTitle, planState, reasonOf } from './failure';
import settings from './global-composer.json';

const docked = settings.docked;
import { registerVerb } from './keymap-runtime';

type HandedFile = { name: string; type: string; base64?: string; url?: string };
type HandedIn = { text?: string; links?: string[]; files?: HandedFile[] };
type Incoming = ComposerProps['incoming'];

const handedFile = async (file: HandedFile) => new File(
  [file.url ? await (await fetch(file.url)).blob() : Uint8Array.from(atob(file.base64 ?? ''), c => c.charCodeAt(0))],
  file.name, { type: file.type });
const tellHost = (detail: { event: 'sent'; message: string } | { event: 'closed' }) =>
  window.dispatchEvent(new CustomEvent('trillion-composer', { detail }));

// The one box of this page: drawn once, moved into the screen's window each time it opens and out when it closes.
const box = document.createElement('div');
box.className = 'message-box';
let drawn = false;
// Ready shares stay here until the box consumes each one; a render may batch several opens.
let waiting: NonNullable<Incoming>[] = [];
let handIn: ((incoming: Incoming) => void) | null = null;
let fromHost = false;
let handInCount = 0;

let drawnCount = 0;

const remembered = () => { try { return localStorage.getItem(docked.changelog.kept_at) ?? ''; } catch { return ''; } };

function useChange(wanted: boolean): [WalkthroughListing | null, (tour: WalkthroughListing) => void] {
  const [tours, setTours] = React.useState<readonly WalkthroughListing[]>([]);
  const [dismissed, setDismissed] = React.useState(remembered);
  React.useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    void Promise.all([import('trillion-workshop/tools/tours-screen/web/src/workspace/tours-screen.ts').then(module => module.readProgress()), import('trillion-walkthroughs').then(module => module.default)])
      .then(([progress, walkthroughs]) => { if (live) setTours(listWalkthroughs(walkthroughs, progress)); }, () => undefined);
    return () => { live = false; };
  }, [wanted]);
  const dismiss = React.useCallback((tour: WalkthroughListing) => {
    try { localStorage.setItem(docked.changelog.kept_at, tour.id); } catch { /* The pill is hidden for this visit either way. */ }
    setDismissed(tour.id);
  }, []);
  return [React.useMemo(() => freshChange(tours, dismissed, Date.now(), docked.changelog.fresh_days) as WalkthroughListing | null, [tours, dismissed]), dismiss];
}


/** A recording's own box: what is typed can be kept as a note at the moment the player is on (`clock`), instead of asked. */
export type NoteTarget = { record: string; files: readonly { identity: string }[]; clock: PlayClock };

function MessageBox({ placement = 'window', note }: { placement?: 'window' | 'docked'; note?: NoteTarget }) {
  const atWindow = placement === 'window';
  const [incoming, setIncoming] = React.useState<Incoming>(atWindow ? waiting[0] ?? null : null);
  React.useEffect(() => {
    if (!atWindow) return undefined;
    handIn = setIncoming;
    setIncoming(waiting[0] ?? null);
    return () => { handIn = null; };
  }, [atWindow]);
  const takeIncoming = React.useCallback((id: string) => {
    if (waiting[0]?.id !== id) return;
    waiting = waiting.slice(1);
    setIncoming(waiting[0] ?? null);
  }, []);
  const { mentions, mentionKinds, onMentionQuery } = useMentions();
  const snippets = useSnippets();
  // Under the box, as the words are written, the screen they pick (instant-screen.tsx).
  const [written, setWritten] = React.useState('');
  // Where it goes and what the AI does (src/workspace/send-choices.ts): shown only when there is something to choose.
  const { pickers, send, runs } = useSendChoices();
  const [change, dismiss] = useChange(!atWindow);
  const [mode, setMode] = React.useState<'ask' | 'note'>('note');
  const noting = Boolean(note) && mode === 'note';
  const now = React.useSyncExternalStore(note?.clock.subscribe ?? noClock.subscribe, note?.clock.now ?? noClock.now);
  const example = React.useMemo(() => exampleAt(docked.examples, drawnCount++), []);
  const sendAndTell = React.useCallback(async (draft: Parameters<typeof send>[0]) => {
    let message: string;
    // A refusal is said the way every screen says it (failure.ts): a feature the plan does not include is its short
    // plan line, with Plan opened beside the box; anything else is its reason in plain words.
    try {
      message = noting && note ? (await sendNoteAbout({ record: note.record, files: note.files, atSeconds: note.clock.now(), draft })).message
        : await send(atWindow ? draft : { ...draft, text: `${docked.scope}${draft.text}` });
    } catch (error) {
      if (error instanceof PlanNeeded) { planState(error).action?.run(); throw new Error(planNeededTitle(error.upgrade_needed)); }
      throw new Error(reasonOf(error));
    }
    if (atWindow && fromHost) { fromHost = false; tellHost({ event: 'sent', message }); }
    return message;
  }, [send, atWindow, noting, note]);
  // What each send from this box started shows under it, being done (job-run.tsx).
  if (atWindow) return (
    <>
      <Composer onSend={sendAndTell} pickers={pickers} snippets={snippets} readLink={readPastedLink} incoming={incoming}
        onIncomingTaken={takeIncoming}
        mentions={mentions} mentionKinds={mentionKinds} onMentionQuery={onMentionQuery} onWordsChange={setWritten} />
      <InstantScreen words={written} />
      <JobRuns runs={runs} />
    </>
  );
  const words = { label: docked.words.label, send: noting ? docked.words.send_note : docked.words.send,
    placeholder: noting ? sayWords.placeholder : docked.words.example.replace('{ask}', docked.words.placeholder).replace('{example}', example) };
  const pieces = [
    { id: 'changelog', label: docked.changelog.pill, visible: Boolean(change), content: change ? <>
      <Button size="xs" variant="outline" onClick={() => { startListedWalkthrough(change); dismiss(change); }}>
        <NamedIcon name="Sparkles" size="xs" />{docked.changelog.pill.replace('{title}', change.title)} · {docked.changelog.open}
      </Button>
      <Button size="xs" variant="ghost" aria-label={docked.changelog.dismiss} onClick={() => dismiss(change)}><NamedIcon name="X" size="xs" /></Button>
    </> : null },
    { id: 'mode', label: docked.words.modes_label, visible: Boolean(note), content: note ? <Container layout="horizontal" gap="xs" alignItems="center" aria-label={docked.words.modes_label}>
      <Button size="xs" variant={noting ? 'outline' : 'ghost'} aria-pressed={noting} onClick={() => setMode('note')}>{docked.words.mode_note.replace('{time}', momentWords(now))}</Button>
      <Button size="xs" variant={noting ? 'ghost' : 'outline'} aria-pressed={!noting} onClick={() => setMode('ask')}>{docked.words.mode_ask}</Button>
    </Container> : null },
    { id: 'box', label: docked.words.label, content: <>
      <Composer onSend={sendAndTell} pickers={pickers} snippets={snippets} words={words} readLink={readPastedLink}
        mentions={mentions} mentionKinds={mentionKinds} onMentionQuery={onMentionQuery} />
      <JobRuns runs={runs} />
    </> },
  ];
  return <ArrangedContents pieces={pieces} arrangement={docked.composition.arrangement} keptAt={docked.composition.kept_at} words={docked.composition.words} />;
}

/** The same box docked under a note, the Media list or the calendar: asks the person's AIs about their meetings and notes (words in global-composer.json `docked`). */
export function DockedComposer({ note }: { note?: NoteTarget } = {}): React.ReactElement { return <MessageBox placement="docked" note={note} />; }
const noClock: PlayClock = { now: () => 0, subscribe: () => () => {} };

/** The message box screen: the page's one box, in the window the arrangement gives it. */
export function mountMessageBoxScreen(element: HTMLElement): () => void {
  if (!drawn) { drawn = true; createRoot(box).render(<MessageBox />); }
  // Replaces what the pane showed while the screen's code arrived (lazy-screen.ts's loading state).
  element.replaceChildren(box);
  return () => {
    box.remove();
    if (fromHost) { fromHost = false; tellHost({ event: 'closed' }); }
  };
}

// The window the box is in closes by its own close control, as the person would close it.
const closeWindow = () => {
  const frame = box.closest('[data-container-id]');
  const close = frame?.querySelector<HTMLButtonElement>('button[aria-label^="Close"]');
  if (close) close.click(); else box.remove();
};

/** Publishes the box's verb (its keys are rows of keymap.json) and the entry point host apps hand a share through; both open its screen. */
export function publishMessageBox(): void {
  const host = window as unknown as { trillionComposer?: { open: (draft: HandedIn) => Promise<void> } };
  host.trillionComposer = {
    open: async draft => {
      const files = await Promise.all((draft.files ?? []).map(handedFile));
      fromHost = true;
      waiting.push({ id: `host-share:${++handInCount}`, text: draft.text, links: draft.links, files });
      handIn?.(waiting[0]);
      openScreen(settings.surface_id);
    },
  };
  registerVerb('message-box', () => { if (box.isConnected) closeWindow(); else openScreen(settings.surface_id); });
}
