// parts/ui/show/screen-state/ScreenState.tsx
//
// PURPOSE
//   The one way a screen says where its read stands: still loading, answered with nothing, partly unavailable, or refused. A screen hands
//   over its read and what nothing and a refusal mean to it; this part draws the loading rows first, then the empty,
//   unavailable or failed state, or the screen's own drawing, and keeps what is drawn when a later read fails transiently. A new screen
//   that reads through `loadScreen` (imperative hosts) or `useScreenLoad` (React) has all three states by construction.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is invented while loading: the loading rows, under the one loading animation (../loading-mark, the
//      needle and thread), show until the first read answers, and not before the wait has lasted about 300 ms.
//   2. Every failed state offers a way forward: it first tries again by itself (`again`: after each wait it names,
//      saying so in its Try again button), then its first action is the retry the screen handed over, and its second
//      asks the person's own AI (`ask`: the shared OpenChoice, opening the AI they chose with words about what failed).
//      A failed state never shows an error's own words, an id or a reference: only the screen's title and description.
//   3. A transient failure after something was drawn keeps the drawing and says so in a notification. An authoritative
//      refusal (a missing resource, lost access or plan requirement) replaces that drawing with the refused state;
//      previously readable content is not evidence that it is still available to this person.
//   4. The part names no screen, record or product word. The words are the caller's; the look is screen-look's
//      screen-state.css and media-loading.css.
//   5. The load states are closed by what a read can do (pending, answered with nothing, refused); anything a screen
//      shows beyond them is its own drawing.
//   6. A read may answer at once from a copy kept on this computer (../request/kept-answers.ts). What it drew is read
//      again when the network's answer differs, and drawn again from nothing (cleared, then drawn) only when it
//      differs, so a screen that draws its first answer once still shows the fresh one, and an unchanged one is
//      never drawn twice.
//
// KEY CONCEPTS
//   ScreenStateValue  the state to draw: { status: 'loading' | 'empty' | 'unavailable' | 'failed', ... }.
//   loadScreen        the lifecycle for an element: loading, then failed / empty / draw, with reload and dispose.
//   useScreenLoad     the same lifecycle for a React screen: returns the state to draw, or the answer.

import React from 'react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../shadcn/empty';
import { Skeleton } from '../shadcn/skeleton';
import { LoadingMark } from 'trillion-workshop/tools/ui/show/loading-mark/index.ts';
import { useStillWorking } from '../still-working/use-still-working';
import { Button } from '../coss/ui/button';
import { OpenChoice, openChoice, type OpenableChoice, type OpenChoiceWords } from '../choice-tiles/OpenChoice';
import { rememberedChoice } from '../choice-tiles/remembered-choice';
import { NamedIcon } from '../icon/NamedIcon';
import { mountSharedContent } from '../coss/shared-content';
import { notify } from '../coss/notifications';
import { releaseNode } from '../one-owner-per-node';
import { keptAnswersServed, onKeptAnswerReplaced, readWithKeptAnswers } from '../request/kept-answers';

/** How the loading rows are laid out, to look like what is coming: a list, a grid of cards, one preview, a form. */
export type LoadingLayout = 'rows' | 'gallery' | 'preview' | 'editor' | 'board' | 'table';
/** One way forward: a label and what pressing it does. */
export type StateAction = { label: string; run: () => void };

export type LoadingState = { status: 'loading'; label: string; layout?: LoadingLayout };
export type EmptyScreenState = {
  status: 'empty';
  /** What is here, in the person's words ("No decisions yet"). */
  title: string;
  /** What will fill it, or what the person can do. */
  description?: string;
  /** A Lucide icon name for the picture above the title. */
  icon?: string;
  action?: StateAction;
  secondary?: StateAction;
  /** The person's own AI, offered to do what this screen is waiting for. */
  ask?: AskYourAi;
};
/** The person's own AI, offered as the second way forward: the AIs to choose from, the name the choice is remembered
 *  under, the button's words, and the words handed to the AI (what failed). */
export type AskYourAi = { choices: OpenableChoice[]; remember: string; labels: OpenChoiceWords; words: string };
export type FailedScreenState = {
  status: 'failed';
  /** What could not happen, in the person's words ("Your files could not load"). */
  title: string;
  /** Why, in plain words, when that is known. */
  description?: string;
  /** What the failure left as it was, only when that is known (a refused read changes nothing): "Nothing was lost." */
  kept?: string;
  icon?: string;
  /** Always offered first: read again. */
  retry: StateAction;
  /** Tried again by itself first: after each wait (ms) in `after`, saying `label` in the Try again button meanwhile. */
  again?: { label: string; after: number[] };
  /** Set by the lifecycle while it is about to try again by itself. */
  retrying?: boolean;
  /** The second way forward: the person's own AI. */
  ask?: AskYourAi;
  /** The one place to go instead, when the screen has one. */
  secondary?: StateAction;
  /** A compact notice alongside retained content after a partial read failure. */
  inline?: boolean;
};
export type UnavailableScreenState = {
  status: 'unavailable';
  /** What could not be reached, in the screen's own plain words. */
  title: string;
  description?: string;
  icon?: string;
  retry?: StateAction;
  /** A compact notice alongside results that remain useful. */
  inline?: boolean;
};
export type ScreenStateValue = LoadingState | EmptyScreenState | FailedScreenState | UnavailableScreenState;

const DEFAULT_ICON: Record<'empty' | 'failed' | 'unavailable', string> = { empty: 'Inbox', failed: 'CircleAlert', unavailable: 'CloudOff' };

function Loading({ label, layout = 'rows' }: { label: string; layout?: LoadingLayout }) {
  // A load that runs long says it is still working, and that it was asked again (../still-working).
  const later = useStillWorking(true, label);
  const frame = (children: React.ReactNode) => (
    <div className="shared-media-loading" data-screen-state="loading" data-loading-layout={layout} role="status" aria-label={later ?? label} aria-busy="true">
      <div className="screen-state-loading-mark"><LoadingMark size="lg" /></div>
      {later ? <p className="screen-state-still-working" aria-live="polite">{later}</p> : null}
      {children}
    </div>
  );
  if (layout === 'rows') return frame([0, 1, 2, 3].map(i => (
    <div key={i} className="shared-media-loading-row" aria-hidden="true">
      <Skeleton className="shared-media-loading-row-leading" />
      <span className="shared-media-loading-row-copy"><Skeleton className="shared-media-loading-row-title" /><Skeleton className="shared-media-loading-row-detail" /></span>
    </div>
  )));
  if (layout === 'preview') return frame(
    <div className="shared-media-loading-preview" aria-hidden="true">
      <Skeleton className="shared-media-loading-preview-frame" />
      <span className="shared-media-loading-preview-copy"><Skeleton className="shared-media-loading-preview-title" /><Skeleton className="shared-media-loading-preview-detail" /></span>
      <span className="shared-media-loading-preview-lines">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="shared-media-loading-preview-line" />)}</span>
    </div>,
  );
  if (layout === 'board') return frame(
    <div className="shared-media-loading-board" aria-hidden="true">
      {[3, 4, 2, 3].map((cards, column) => (
        <div key={column} className="shared-media-loading-column">
          <Skeleton className="shared-media-loading-column-title" />
          {Array.from({ length: cards }, (_, card) => (
            <div key={card} className="shared-media-loading-card">
              <Skeleton className="shared-media-loading-card-title" />
              <Skeleton className="shared-media-loading-card-detail" />
            </div>
          ))}
        </div>
      ))}
    </div>,
  );
  if (layout === 'table') return frame(
    <div className="shared-media-loading-table" aria-hidden="true">
      {Array.from({ length: 8 }, (_, row) => (
        <div key={row} className="shared-media-loading-table-row" data-head={row === 0 ? '' : undefined}>
          {Array.from({ length: 4 }, (_, cell) => <Skeleton key={cell} className="shared-media-loading-table-cell" />)}
        </div>
      ))}
    </div>,
  );
  if (layout === 'editor') return frame(
    <div className="shared-media-loading-editor" aria-hidden="true">
      <div className="shared-media-loading-editor-fields">{[0, 1, 2, 3].map(i => <span key={i}><Skeleton className="shared-media-loading-editor-label" /><Skeleton className="shared-media-loading-editor-field" /></span>)}</div>
      <Skeleton className="shared-media-loading-editor-action" />
    </div>,
  );
  return frame([0, 1, 2].map(i => <div key={i} aria-hidden="true"><Skeleton className="shared-media-loading-poster" /><Skeleton className="shared-media-loading-title" /></div>));
}

function Failed({ state }: { state: FailedScreenState }) {
  return (
    <Empty className="screen-state" data-screen-state="failed" data-inline={state.inline || undefined} role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="screen-state-icon"><NamedIcon name={state.icon ?? DEFAULT_ICON.failed} /></EmptyMedia>
        <EmptyTitle className="screen-state-title">{state.title}</EmptyTitle>
        {state.description ? <EmptyDescription className="screen-state-description">{state.description}</EmptyDescription> : null}
        {state.kept ? <EmptyDescription className="screen-state-description">{state.kept}</EmptyDescription> : null}
      </EmptyHeader>
      <EmptyContent className="screen-state-actions">
        <Button variant="default" work={state.retrying ? 'pending' : null} pendingLabel={state.again?.label} onClick={state.retry.run}>
          <NamedIcon name="RotateCw" aria-hidden />{state.retry.label}
        </Button>
        {state.ask ? <OpenChoice choices={state.ask.choices} remember={state.ask.remember} labels={state.ask.labels} words={state.ask.words} /> : null}
        {state.secondary ? <Button variant="ghost" onClick={state.secondary.run}>{state.secondary.label}</Button> : null}
      </EmptyContent>
    </Empty>
  );
}

function Unavailable({ state }: { state: UnavailableScreenState }) {
  return (
    <Empty className="screen-state" data-screen-state="unavailable" data-inline={state.inline || undefined} role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="screen-state-icon"><NamedIcon name={state.icon ?? DEFAULT_ICON.unavailable} /></EmptyMedia>
        <EmptyTitle className="screen-state-title">{state.title}</EmptyTitle>
        {state.description ? <EmptyDescription className="screen-state-description">{state.description}</EmptyDescription> : null}
      </EmptyHeader>
      {state.retry ? <EmptyContent className="screen-state-actions"><Button variant="outline" onClick={state.retry.run}><NamedIcon name="RotateCw" aria-hidden />{state.retry.label}</Button></EmptyContent> : null}
    </Empty>
  );
}

function Answered({ state }: { state: EmptyScreenState | FailedScreenState | UnavailableScreenState }) {
  if (state.status === 'failed') return <Failed state={state} />;
  if (state.status === 'unavailable') return <Unavailable state={state} />;
  const first = state.action;
  return (
    <Empty className="screen-state" data-screen-state="empty">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="screen-state-icon"><NamedIcon name={state.icon ?? DEFAULT_ICON.empty} /></EmptyMedia>
        <EmptyTitle className="screen-state-title">{state.title}</EmptyTitle>
        {state.description ? <EmptyDescription className="screen-state-description">{state.description}</EmptyDescription> : null}
      </EmptyHeader>
      {first || state.secondary || state.ask ? (
        <EmptyContent className="screen-state-actions">
          {first ? <Button variant="outline" onClick={first.run}>{first.label}</Button> : null}
          {state.ask ? <OpenChoice choices={state.ask.choices} remember={state.ask.remember} labels={state.ask.labels} words={state.ask.words} /> : null}
          {state.secondary ? <Button variant="ghost" onClick={state.secondary.run}>{state.secondary.label}</Button> : null}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** Draws one screen state. */
export function ScreenState({ state }: { state: ScreenStateValue }) {
  return state.status === 'loading' ? <Loading label={state.label} layout={state.layout} /> : <Answered state={state} />;
}

/** Draws one screen state into `host`, taking the element over from whoever drew there before. */
export function mountScreenState(host: HTMLElement, state: ScreenStateValue): void {
  mountSharedContent(host, <ScreenState state={state} />);
}

/** Lets go of the state drawn in `host`, so another writer can draw there. */
export function releaseScreenState(host: HTMLElement): void {
  releaseNode(host);
}

/** The state for a refused read, given the retry to offer (a plan refusal may be an empty state with its own way). */
export type Refusal = (error: unknown, retry: () => void) => FailedScreenState | EmptyScreenState;

/** A temporary read failure may leave a previous answer visible; a definitive refusal may not. This also lets
 *  record owners invalidate their kept answer using the same rule, without naming any screen or resource. */
export function canRetainAfterReadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const failure = error as { status?: unknown; name?: unknown; upgrade_needed?: unknown };
  if (failure.name === 'PlanNeeded' || failure.upgrade_needed) return false;
  const status = failure.status;
  return !(typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429);
}

export type ScreenLoad<T> = {
  /** What the loading rows say to a screen reader, and how they are laid out. */
  loading: Omit<LoadingState, 'status'>;
  /** The read. Anything the drawing needs before it can draw belongs here, so the drawing itself never waits. */
  read: () => Promise<T>;
  /** What nothing means here: the empty state when the answer holds nothing to draw, else null. */
  empty?: (value: T) => EmptyScreenState | null;
  /** Draws the answer into the host; called again with each later answer while it stays drawn. */
  draw: (value: T) => void;
  /** Updates an existing drawing without remounting it, including a changed network answer replacing a kept copy. */
  update?: (value: T) => void;
  /** Undoes the drawing, when a state takes its place or the screen goes. */
  clear?: () => void;
  failed: Refusal;
  /** A later transient failure while the drawing stays: said in a notification unless the screen says it otherwise. */
  laterFailure?: (error: unknown) => void;
};

// A later failure, said in a notification in the state's own words (never the error's), with the person's chosen AI as
// its action when they have chosen one.
const sayLater = (state: FailedScreenState) => {
  const chosenId = state.ask ? rememberedChoice(state.ask.remember) : null;
  const chosen = chosenId ? state.ask?.choices.find(choice => choice.id === chosenId) : undefined;
  const ask = chosen && state.ask
    ? [{ label: chosen.button ?? state.ask.labels.chosen.replace('{label}', chosen.label), onAction: () => openChoice(chosen, state.ask?.words ?? '') }]
    : [];
  notify(state.title, { kind: 'error', ...(state.description ? { detail: state.description } : {}), ...(ask.length ? { actions: ask } : {}) });
};

/** The wait before the next try a failed state makes by itself, or null when it has made them all. */
const nextTry = (state: ScreenStateValue, tries: number): number | null =>
  (state.status === 'failed' && state.again && tries < state.again.after.length ? state.again.after[tries] : null);

export type LoadedScreen = {
  /** Reads again: from the loading rows when nothing is drawn, in place when something is. */
  reload: () => Promise<void>;
  /** Puts a state in place of whatever is drawn (an action refused by the person's plan, say). */
  show: (state: ScreenStateValue) => void;
  dispose: () => void;
};

/** Runs a screen's read into `host`: loading rows, then the failed state, the empty state or the screen's drawing. */
export function loadScreen<T>(host: HTMLElement, load: ScreenLoad<T>): LoadedScreen {
  let disposed = false;
  let drawn = false;
  let reading = 0;
  // What is drawn, as text, when it came from a kept copy: the read that replaces it draws only when it differs.
  let drawnText: string | null = null;
  let readInProgress = false;
  let replacementDuringRead = false;
  let readUsedKept = false;
  // The tries a failed state has made by itself since the last answer, and the one waiting to start.
  let tries = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const undraw = () => { if (drawn) { drawn = false; drawnText = null; load.clear?.(); } };
  const show = (state: ScreenStateValue) => { undraw(); mountScreenState(host, state); };
  const stopWaiting = onKeptAnswerReplaced(() => {
    if (readInProgress) { replacementDuringRead = true; return; }
    if (readUsedKept) { readUsedKept = false; void reload(); }
  });

  async function reload(): Promise<void> {
    if (disposed) return;
    const mine = ++reading;
    if (!drawn) show({ status: 'loading', ...load.loading });
    readInProgress = true;
    replacementDuringRead = false;
    const servedBefore = keptAnswersServed();
    let value: T;
    try { value = await readWithKeptAnswers(load.read); } catch (error) {
      if (disposed || mine !== reading) return;
      readInProgress = false;
      const retain = canRetainAfterReadFailure(error);
      if (retain && replacementDuringRead && readUsedKept) { replacementDuringRead = false; readUsedKept = false; void reload(); return; }
      replacementDuringRead = false;
      const state = load.failed(error, () => void reload());
      if (drawn && state.status === 'failed' && retain) { if (load.laterFailure) load.laterFailure(error); else sayLater(state); return; }
      readUsedKept = false;
      const wait = nextTry(state, tries);
      if (wait === null) { show(state); return; }
      tries += 1;
      show({ ...state, retrying: true } as FailedScreenState);
      again = setTimeout(() => { again = null; if (!disposed && mine === reading) void reload(); }, wait);
      return;
    }
    if (disposed || mine !== reading) return;
    tries = 0;
    const kept = keptAnswersServed() !== servedBefore;
    readInProgress = false;
    readUsedKept = kept;
    if (kept && replacementDuringRead) { replacementDuringRead = false; readUsedKept = false; void reload(); return; }
    replacementDuringRead = false;
    const wasKept = drawn && drawnText !== null;
    const text = kept || wasKept ? JSON.stringify(value) : null;
    const nothing = load.empty?.(value) ?? null;
    if (nothing) { show(nothing); return; }
    if (wasKept && text === drawnText) { drawnText = kept ? text : null; return; }
    if (drawn && load.update) { drawnText = kept ? text : null; load.update(value); return; }
    // A kept copy replaced by a different answer is drawn again from nothing, since a screen may draw only once.
    if (wasKept) load.clear?.();
    // The element is handed from the state to the drawing: whatever state was drawn there lets go of it first.
    if (!drawn) releaseNode(host);
    drawn = true;
    drawnText = kept ? text : null;
    load.draw(value);
  }

  void reload();
  return { reload, show: state => { if (!disposed) { reading += 1; show(state); } }, dispose: () => { disposed = true; if (again) clearTimeout(again); stopWaiting(); undraw(); releaseNode(host); } };
}

export type ScreenRead<T> =
  | { state: ScreenStateValue; value?: undefined; reload: () => Promise<void> }
  | { state: null; value: T; reload: () => Promise<void> };

/** A React screen's read: the state to draw until there is an answer to draw, then the answer. `key` names what is
 *  read (an id); a new key reads again from the loading rows. */
export function useScreenLoad<T>(key: string, load: Omit<ScreenLoad<T>, 'draw' | 'clear'>): ScreenRead<T> {
  // A key visited again has a new lifetime: callbacks retained by its previous children stay retired.
  const lifetime = React.useMemo(() => ({ active: false }), [key]);
  const latest = React.useRef(load);
  // Speculative renders must not replace the committed screen's reader or retire its pending answer.
  React.useLayoutEffect(() => { latest.current = load; });
  React.useLayoutEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; };
  }, [lifetime]);
  const [answer, setAnswer] = React.useState<{ key: string; value: T } | null>(null);
  const [state, setState] = React.useState<{ key: string; state: ScreenStateValue } | null>(null);
  const shown = React.useRef<{ key: string; value: T } | null>(null);
  React.useLayoutEffect(() => { shown.current = answer?.key === key ? answer : null; });
  const reading = React.useRef(0);
  // As in loadScreen: what is shown, as text, when it came from a kept copy, and the wait for the network's answer.
  const shownText = React.useRef<string | null>(null);
  const readInProgress = React.useRef(false);
  const replacementDuringRead = React.useRef(false);
  const readUsedKept = React.useRef(false);
  // As in loadScreen: the tries a failed state made by itself since the last answer, and the one waiting to start.
  const tries = React.useRef(0);
  const again = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = React.useCallback(async () => {
    if (!lifetime.active) return;
    const mine = ++reading.current;
    const current = latest.current;
    if (!shown.current) setState({ key, state: { status: 'loading', ...current.loading } });
    readInProgress.current = true;
    replacementDuringRead.current = false;
    const servedBefore = keptAnswersServed();
    let value: T;
    try { value = await readWithKeptAnswers(current.read); } catch (error) {
      if (!lifetime.active || mine !== reading.current) return;
      readInProgress.current = false;
      const retain = canRetainAfterReadFailure(error);
      if (retain && replacementDuringRead.current && readUsedKept.current) { replacementDuringRead.current = false; readUsedKept.current = false; void reload(); return; }
      replacementDuringRead.current = false;
      const refused = current.failed(error, () => void reload());
      if (shown.current && refused.status === 'failed' && retain) { if (current.laterFailure) current.laterFailure(error); else sayLater(refused); return; }
      shown.current = null;
      shownText.current = null;
      readUsedKept.current = false;
      setAnswer(null);
      const wait = nextTry(refused, tries.current);
      if (wait === null) { setState({ key, state: refused }); return; }
      tries.current += 1;
      setState({ key, state: { ...refused, retrying: true } as FailedScreenState });
      again.current = setTimeout(() => { again.current = null; if (mine === reading.current) void reload(); }, wait);
      return;
    }
    if (!lifetime.active || mine !== reading.current) return;
    tries.current = 0;
    const kept = keptAnswersServed() !== servedBefore;
    readInProgress.current = false;
    readUsedKept.current = kept;
    if (kept && replacementDuringRead.current) { replacementDuringRead.current = false; readUsedKept.current = false; void reload(); return; }
    replacementDuringRead.current = false;
    const wasKept = shown.current !== null && shownText.current !== null;
    const text = kept || wasKept ? JSON.stringify(value) : null;
    const nothing = current.empty?.(value) ?? null;
    if (nothing) { shownText.current = null; setAnswer(null); setState({ key, state: nothing }); return; }
    const same = wasKept && text === shownText.current;
    shownText.current = kept ? text : null;
    if (!same) setAnswer({ key, value });
  }, [key, lifetime]);

  React.useEffect(() => {
    const stopWaiting = onKeptAnswerReplaced(() => {
      if (readInProgress.current) { replacementDuringRead.current = true; return; }
      if (readUsedKept.current) { readUsedKept.current = false; void reload(); }
    });
    void reload();
    return () => { reading.current += 1; tries.current = 0; if (again.current) clearTimeout(again.current); again.current = null; shownText.current = null; readInProgress.current = false; replacementDuringRead.current = false; readUsedKept.current = false; stopWaiting(); };
  }, [reload]);
  if (answer?.key === key) return { state: null, value: answer.value, reload };
  return { state: state?.key === key ? state.state : { status: 'loading', ...load.loading }, reload };
}
