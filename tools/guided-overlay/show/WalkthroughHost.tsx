// parts/guided-overlay/show/WalkthroughHost.tsx
//
// The LIVE intake (M7 host). Folds the tours it is handed (DATA the app ships) and
// the person's one progress record (read by name through `useBitfieldData`), and
// listens for host events: on mount it raises `app-opened`; any surface can dispatch
// a `bitfield:walkthrough-event` CustomEvent (`{ event_kind, ...fields }`) to signal
// a screen opened, a replay asked for, or a tour an AI started. The tours the person's own
// AIs wrote (input `own-walkthroughs`) run beside the app's, and an AI's ask to show one now
// (input `walkthrough-show-asked`) starts it once. The first trigger
// whose event matches, whose `once_key` is not yet consumed and whose requirements
// are met starts its tour; each step it moves and the end it reaches are saved in
// the person's progress record ("don't show again", and where they got to).
//
// BLIND: it never names a tour, reason, or event kind; all routing is DATA via
// `selectWalkthroughForEvent`. Mounting this once at the app shell makes EVERY
// authored tour live with zero per-tour code.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { addressLabelForInput, readSavedLabels, subscribeSavedChanges, useBitfieldData } from '#workspace-records';
import { useAskedNow } from '../../ui/show/asked-now/use-asked-now';
import { sayHappened } from '../../ui/show/happened/happened';
import { showOf, showReady, useShowChange } from '../../ui/show/show-rules/show-of';
import { OWN_WALKTHROUGHS_INPUT, WALKTHROUGH_SHOW_ASKED_INPUT } from 'trillion-workshop/tools/tours-screen/read-data/tour-library.ts';
import {
  foldWalkthroughRecords,
  foldWalkthroughProgress,
  selectWalkthroughForEvent,
  tourFacts,
} from 'trillion-workshop/tools/tours-screen/read-data/walkthrough-eeaf.ts';
import type { HostEvent } from 'trillion-workshop/tools/tours-screen/engine/trigger-intake.ts';
import { eventMatchesTrigger } from 'trillion-workshop/tools/tours-screen/engine/trigger-intake.ts';
import { WALKTHROUGH_DEFINITIONS_OFFERED, WALKTHROUGH_DISMISS_REQUESTED, WALKTHROUGH_EVENT, WALKTHROUGH_HOST_AVAILABLE, announceWalkthroughEnded, toWalkthroughRecords } from './walkthrough-events';
import { commitWalkthroughProgress, consumeWalkthroughProgressKey } from '../do-work/walkthrough-progress';
import { WalkthroughSurface, type WalkthroughExitReason, type OwnerSignalBridge, type WalkthroughWords } from './WalkthroughSurface';
import { tourAsChanged } from './changed-tour';
import { onLockChange, setArrangementLockTourActive, tourMayShow } from '../../screen-arrangement/show/arrangement-lock';
import type { WalkthroughCursor } from '../engine/cursor-machine';
import type { StepContentComponent } from '../../ui/show/step-content-renderer/StepContent';
import type { StepContentRegistry } from '../../ui/show/step-content-renderer/step-content-renderer';
import type { StepProgressComponent } from '../../ui/show/step-progress/StepProgress';
import type { StepProgressRegistry } from '../../ui/show/step-progress/step-progress';
import type { AnchorResolverRegistry } from '../../ui/show/anchor-resolver/anchor-resolver';
import type { WalkthroughPresentationRegistry } from './presentation-registry';
import defaults from 'trillion-workshop/tools/tours-screen/guided-overlay-defaults.json';

const HOST_OWNER_ATTRIBUTE = 'data-guided-overlay-host-owner';
const HOST_AVAILABLE_EVENT = WALKTHROUGH_HOST_AVAILABLE;
/** Trigger reasons whose tours catch the person up in one card instead of queueing (guided-overlay-defaults.json). */
const CATCH_UP_REASONS: ReadonlySet<string> = new Set(defaults.catch_up_reasons);
/** How much a tour matters (guided-overlay-defaults.json `urgency`): its place in `levels`, lowest first. */
const URGENCY = defaults.urgency;
const urgencyRank = (definition: unknown): number => {
  const id = (definition as { urgency?: unknown } | undefined)?.urgency ?? URGENCY.when_unset;
  return URGENCY.levels.findIndex(level => level.id === id);
};
let hostSequence = 0;
/** How long, and how many, of the page's own events an offered tour is tried against. */
const RECENT_EVENT_MS = 60_000;
const RECENT_EVENTS_KEPT = 12;
/** How long an offered tour turned away by a tour already showing waits for that one to close. */
const OFFERED_HELD_MS = 30 * 60_000;


/** The person's progress record, read by this input name wherever the host is mounted. */
export const WALKTHROUGH_PROGRESS_INPUT = 'walkthrough-progress';

export interface WalkthroughHostProps {
  /** DOM root for anchor resolution (default `document`). */
  readonly root?: ParentNode;
  /** The tours this app ships (DATA), each a `walkthrough-definition`. */
  readonly definitions: unknown;
  readonly contentRegistry?: StepContentRegistry<StepContentComponent>;
  readonly progressRegistry?: StepProgressRegistry<StepProgressComponent>;
  readonly anchorRegistry?: AnchorResolverRegistry;
  readonly presentationRegistry?: WalkthroughPresentationRegistry;
  /** Owner-readback signal bridge threaded to the surface (opaque refs only). */
  readonly ownerSignalBridge?: OwnerSignalBridge;
  /** The app's words for every tour: the End tour label and the one step shown when a tour is ended early. */
  readonly words?: WalkthroughWords;
}

// What a tour is to the person's show rules (parts/ui/show/show-rules): a tour, with its id and title, and whether it
// started by itself. A tour the rules hide is turned away without being marked seen, so it waits for another open; a
// tour asked for by name, or a trigger marked `takes_over`, is never held.
const TOUR_SUBJECT = 'tour';

type ActiveRun = {
  readonly definitionId: string;
  readonly onceKey: string | null;
  /** The other catch-up tours that would have shown with this one: they stay waiting, and the card opens their list. */
  readonly alsoWaiting: readonly string[];
  readonly event: HostEvent;
  readonly runId: string;
  cursorRevision: number;
  cursor: WalkthroughCursor;
};

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `walkthrough-run-${Date.now()}-${++hostSequence}`;
}

/** Mount once at the app shell so it runs whichever authored tour a host event triggers. */
export function WalkthroughHost({
  root,
  definitions,
  contentRegistry,
  progressRegistry,
  anchorRegistry,
  presentationRegistry,
  ownerSignalBridge,
  words,
}: WalkthroughHostProps): ReactElement | null {
  const hostTokenRef = useRef(`guided-overlay-host-${++hostSequence}`);
  const [ownsHost, setOwnsHost] = useState(false);
  const progressRaw = useBitfieldData(WALKTHROUGH_PROGRESS_INPUT);
  const ownRaw = useBitfieldData(OWN_WALKTHROUGHS_INPUT);
  const showAsked = useBitfieldData(WALKTHROUGH_SHOW_ASKED_INPUT);
  // Tours a screen offered for what it shows (offerWalkthroughDefinitions: a pursuit's own tour), kept for this page.
  const [offered, setOffered] = useState<readonly Record<string, unknown>[]>([]);
  // The app's tours, the person's own and the offered ones, one set the same fold reads (an own tour's id never names
  // an app tour; an offered tour never replaces one the app or the person keeps).
  const defs = useMemo(() => {
    const kept = foldWalkthroughRecords([...toWalkthroughRecords(definitions), ...toWalkthroughRecords(ownRaw)]);
    const extra = foldWalkthroughRecords(toWalkthroughRecords(offered.filter(one => !(String(one.id) in kept))));
    return { ...extra, ...kept };
  }, [definitions, ownRaw, offered]);
  const progress = useMemo(() => foldWalkthroughProgress([{ address: '', value_json: progressRaw }]), [progressRaw]);

  const [active, setActive] = useState<ActiveRun | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  const transitionRef = useRef<{ runId: string; toStepId: string } | null>(null);
  const [transitionEpoch, setTransitionEpoch] = useState(0);
  const pendingEventsRef = useRef<HostEvent[]>([]);
  const firedAppOpened = useRef(false);

  // Scene composition can accidentally mount the same host contribution more
  // than once. Elect exactly one document owner so duplicate hosts cannot stack
  // scrims or consume the same trigger twice. A waiting host takes over if the
  // owner unmounts.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const token = hostTokenRef.current;
    const claim = () => {
      const current = document.documentElement.getAttribute(HOST_OWNER_ATTRIBUTE);
      if (!current || current === token) {
        document.documentElement.setAttribute(HOST_OWNER_ATTRIBUTE, token);
        setOwnsHost(true);
      }
    };
    // The owner says it is available only once it listens (the effect below), so nothing said to it is lost.
    claim();
    window.addEventListener(HOST_AVAILABLE_EVENT, claim);
    return () => {
      window.removeEventListener(HOST_AVAILABLE_EVENT, claim);
      if (document.documentElement.getAttribute(HOST_OWNER_ATTRIBUTE) === token) {
        document.documentElement.removeAttribute(HOST_OWNER_ATTRIBUTE);
        window.dispatchEvent(new CustomEvent(HOST_AVAILABLE_EVENT));
      }
    };
  }, []);

  // Keep the latest folded state for the event handlers without re-binding them.
  const stateRef = useRef({ defs, consumed: progress.consumedOnceKeys, consumedAt: progress.consumedAt, cursors: progress.cursors });
  stateRef.current = { defs, consumed: progress.consumedOnceKeys, consumedAt: progress.consumedAt, cursors: progress.cursors };
  // The keys this host is consuming now (an associated task just completed): the page already shows them consumed
  // before the store accepts the write, but a tour someone asks for by name meanwhile is a new run they chose, so the
  // key does not turn it away; once accepted it is consumed for every later ask and every other host.
  const consumingRef = useRef<Set<string>>(new Set());
  // Whether the person's progress record has been read from their store. Until it has, no tour starts by itself: a
  // read that failed or has not answered is not "never seen", and treating it so drew the Welcome over a workspace the
  // person had long since toured whenever their store answered busy (2026-10-30, Mac app). The read is asked again on
  // every change the store reports and every `progress_read_again_ms`, until one answers.
  const [progressRead, setProgressRead] = useState(false);
  const progressReadRef = useRef(false);
  progressReadRef.current = progressRead;
  useEffect(() => {
    if (!ownsHost || progressRead || typeof window === 'undefined') return;
    let stopped = false;
    const label = addressLabelForInput(WALKTHROUGH_PROGRESS_INPUT);
    const read = () => { void readSavedLabels([label]).then(() => { if (!stopped) setProgressRead(true); }, () => {}); };
    read();
    const stopHearing = subscribeSavedChanges(read);
    const again = window.setInterval(read, defaults.progress_read_again_ms);
    return () => { stopped = true; stopHearing(); window.clearInterval(again); };
  }, [ownsHost, progressRead]);

  const tryStart = useCallback((event: HostEvent, startedBy: 'itself' | 'asked' = 'itself', onlyIds?: ReadonlySet<string>): 'started' | 'queued' | 'rejected' => {
    // A tour asked for by name (Show me) always starts, in place of whatever tour is running,
    // seen or not; a tour that would start by itself waits until none is running.
    // A trigger marked `takes_over` (a step something else needs, such as connecting an AI) does the same.
    const askedByName = typeof event.walkthrough_id === 'string';
    if (Object.keys(stateRef.current.defs).length === 0) {
      if (activeRef.current && !askedByName) return 'rejected';
      pendingEventsRef.current.push(event);
      return 'queued';
    }
    // A tour that would start by itself waits for the show rules and the person's progress to load, then starts only if
    // they let it show: each
    // candidate is asked with its own facts (reason, urgency, hours since one like it), so one a rule holds waits and
    // never hides the next, and an urgent one can be let through while the rest wait.
    if (!askedByName && (!showReady() || !progressReadRef.current)) { pendingEventsRef.current.push(event); return 'queued'; }
    // A locked arrangement (a must-do held on the screen) decides whether any tour may show over it: only one the person
    // asked for by name inside it. Anything else asked by name is turned away, so no tour duplicates the held thing; one
    // that would start by itself waits and is tried again once the lock lets go.
    if (!tourMayShow({ askedByName })) {
      if (askedByName) return 'rejected';
      pendingEventsRef.current.push(event);
      return 'queued';
    }
    const { defs: everyDef, consumedAt } = stateRef.current;
    const consumed = askedByName && consumingRef.current.size > 0
      ? new Set([...stateRef.current.consumed].filter(key => !consumingRef.current.has(key)))
      : stateRef.current.consumed;
    const shipped = onlyIds ? Object.fromEntries(Object.entries(everyDef).filter(([id]) => onlyIds.has(id))) as typeof everyDef : everyDef;
    const now = Date.now();
    const hit = selectWalkthroughForEvent(shipped, event, consumed, consumedAt, CATCH_UP_REASONS, {
      shows: (id, trigger) => askedByName || trigger.takes_over === true
        || !showOf(TOUR_SUBJECT, tourFacts(shipped, id, trigger, consumedAt, { now, startedBy, urgencyWhenUnset: URGENCY.when_unset })).hidden,
      rank: id => urgencyRank(shipped[id]),
    });
    if (!hit) return 'rejected';
    const takesOver = askedByName || hit.trigger.takes_over === true;
    if (activeRef.current && !takesOver) return 'rejected';
    const definition = stateRef.current.defs[hit.definitionId];
    const saved = stateRef.current.cursors[hit.definitionId];
    const definitionRevision = definition.revision ?? 1;
    // A trigger may start the tour at one of its steps (DATA `start_step`); otherwise it starts at its entry step.
    const startStep = typeof hit.trigger.start_step === 'string' && definition.steps.some((step) => step.id === hit.trigger.start_step)
      ? hit.trigger.start_step
      : definition.entry_step;
    // The connect surface can ask for the same step while it is mounting, even
    // before the current advance has saved. Keep that run instead of remounting
    // the overlay. An explicit request to replay a tour still starts it anew.
    if (
      activeRef.current
      && activeRef.current.definitionId === hit.definitionId
      && !askedByName
      && hit.trigger.takes_over === true
      && (activeRef.current.cursor.currentStepId === startStep
        || (transitionRef.current?.runId === activeRef.current.runId
          && transitionRef.current.toStepId === startStep))
    ) return 'rejected';
    // A tour someone asked for by name (Show me, Show me again) or a step something needs starts where it says;
    // one that started on its own picks up where they left it.
    const asked = takesOver && (!askedByName || event.walkthrough_id === hit.definitionId);
    const resumable = !asked
      && saved
      && saved.status === 'active'
      && saved.definitionRevision === definitionRevision
      && definition.steps.some((step) => step.id === saved.currentStepId);
    const next: ActiveRun = {
      definitionId: hit.definitionId,
      onceKey: hit.trigger.once_key ?? null,
      alsoWaiting: hit.alsoWaiting,
      event,
      runId: resumable && saved.runId ? saved.runId : createRunId(),
      cursorRevision: resumable ? saved.cursorRevision : 0,
      cursor: resumable
        ? { currentStepId: saved.currentStepId, history: saved.history, status: 'active' }
        : { currentStepId: startStep, history: [], status: 'active' },
    };
    activeRef.current = next;
    setArrangementLockTourActive(event.event_kind === 'walkthrough-requested' && typeof event.walkthrough_id === 'string');
    setActive(next);
    return 'started';
  }, []);

  // Every way a tour closes goes through here, and says so once the overlay has gone, so a
  // screen whose own tour was turned away while this one showed can offer it again.
  const closeRun = useCallback((runId?: string, { announce = true }: { announce?: boolean } = {}) => {
    if (runId && activeRef.current?.runId !== runId) return;
    activeRef.current = null;
    setArrangementLockTourActive(false);
    setActive(null);
    if (announce) setTimeout(announceWalkthroughEnded, 0);
  }, []);

  // Current definitions can arrive in separate snapshots. An unrelated tour
  // must not consume app-opened before its matching definition arrives.
  // A tour held while the show rules loaded is tried again once they answer.
  const showRevision = useShowChange();
  // The running tour as the person's rules leave it (words and looks changed on the canvas), made again only when its
  // definition or a rule changes, so an edit shows on the running tour at once and nothing else redraws it.
  const activeDefinition = active ? defs[active.definitionId] : undefined;
  const shownDefinition = useMemo(() => (activeDefinition ? tourAsChanged(activeDefinition) : null), [activeDefinition, showRevision]);
  // The lock changing (held, let go) tries the tours that waited for it again.
  const [lockRevision, setLockRevision] = useState(0);
  useEffect(() => onLockChange(() => setLockRevision(revision => revision + 1)), []);
  useEffect(() => {
    if (!ownsHost || !progressRead || firedAppOpened.current || Object.keys(defs).length === 0 || !showReady() || !tourMayShow({ askedByName: false })) return;
    const queued = pendingEventsRef.current.splice(0);
    for (const event of queued) {
      if (tryStart(event) === 'started') {
        firedAppOpened.current = true;
        return;
      }
    }
    if (tryStart({ event_kind: 'app-opened' }) === 'started') firedAppOpened.current = true;
  }, [defs, ownsHost, progressRead, tryStart, showRevision, lockRevision]);

  // Where someone GOT TO arrives after the tour has already started.
  //
  // Definitions ship with the app, so they exist on the first frame, while the
  // saved cursor can only come from the live feed. The run therefore begins at
  // the entry step and the cursor lands a moment later, and without this it was
  // simply ignored: the tour restarted from slide one on EVERY page load,
  // including the reload straight after signing in. Somebody who had just
  // finished signing in was put back at the beginning, and the only way out was
  // to click through the whole thing faster than the feed could answer.
  //
  // The feed may arrive while the person advances the first step. Let the
  // in-flight save settle before adopting or closing from a late snapshot.
  useEffect(() => {
    const run = activeRef.current;
    if (!active || !run || run.cursor.history.length > 0 || transitionRef.current?.runId === run.runId) return;
    // Only the run that opening the app started. Someone who ASKED for a tour
    // gets the tour, even if they have seen it before and even if a save for an
    // older run is still in flight, so late progress never reaches back into a
    // run they deliberately began.
    if (run.event.event_kind !== 'app-opened') return;
    const saved = progress.cursors[run.definitionId];
    // Somebody who already finished this tour is shown it again for exactly the
    // same reason, since "you are done" also arrives late. Close it rather than
    // making them sit through it a second time.
    if (
      (saved && saved.status !== 'active')
      || (run.onceKey && progress.consumedOnceKeys.has(run.onceKey))
    ) {
      closeRun();
      return;
    }
    if (!saved || saved.status !== 'active' || !saved.runId) return;
    const definition = defs[run.definitionId];
    if (!definition || (definition.revision ?? 1) !== saved.definitionRevision) return;
    if (!definition.steps.some((step) => step.id === saved.currentStepId)) return;
    if (saved.currentStepId === run.cursor.currentStepId && saved.runId === run.runId) return;
    const resumed: ActiveRun = {
      ...run,
      runId: saved.runId,
      cursorRevision: saved.cursorRevision,
      cursor: { currentStepId: saved.currentStepId, history: saved.history, status: 'active' },
    };
    activeRef.current = resumed;
    setActive(resumed);
  }, [active, defs, progress.cursors, progress.consumedOnceKeys, closeRun, transitionEpoch]);

  // What the page said lately (a screen opening), so a tour offered a moment later for that screen is tried against it.
  const recentEventsRef = useRef<{ event: HostEvent; at: number }[]>([]);
  const offeredWaitingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ownsHost || typeof window === 'undefined') return;
    const onOffered = (ev: Event) => {
      const list = (ev as CustomEvent<{ definitions?: unknown }>).detail?.definitions;
      if (!Array.isArray(list)) return;
      const fresh = list.filter((one): one is Record<string, unknown> => !!one && typeof one === 'object' && typeof (one as { id?: unknown }).id === 'string');
      if (!fresh.length) return;
      for (const one of fresh) offeredWaitingRef.current.add(String(one.id));
      setOffered(current => [...current.filter(one => !fresh.some(next => next.id === one.id)), ...fresh]);
    };
    window.addEventListener(WALKTHROUGH_DEFINITIONS_OFFERED, onOffered);
    return () => window.removeEventListener(WALKTHROUGH_DEFINITIONS_OFFERED, onOffered);
  }, [ownsHost]);
  // Offered tours that arrived while another tour showed, with what the page had said then: tried once that one closes.
  const offeredHeldRef = useRef<{ ids: Set<string>; events: HostEvent[]; at: number } | null>(null);
  // Once offered tours are folded in, each is tried against what the page said in the last minute, newest first. A
  // screen's own tour usually arrives after the screen's event already started the app's tour for that screen; it then
  // waits for that tour to close instead of being lost.
  useEffect(() => {
    const waiting = offeredWaitingRef.current;
    if (!ownsHost || !waiting.size) return;
    const ready = new Set([...waiting].filter(id => id in defs));
    if (!ready.size) return;
    for (const id of ready) waiting.delete(id);
    const since = Date.now() - RECENT_EVENT_MS;
    const events = [...recentEventsRef.current].reverse().filter(one => one.at >= since).map(one => one.event);
    if (activeRef.current) {
      const held = offeredHeldRef.current;
      offeredHeldRef.current = { ids: new Set([...(held?.ids ?? []), ...ready]), events: [...events, ...(held?.events ?? [])].slice(0, RECENT_EVENTS_KEPT), at: Date.now() };
      return;
    }
    for (const event of events) if (tryStart(event, 'itself', ready) === 'started') break;
  }, [defs, ownsHost, tryStart]);
  useEffect(() => {
    const held = offeredHeldRef.current;
    if (!ownsHost || active || activeRef.current || !held) return;
    offeredHeldRef.current = null;
    if (Date.now() - held.at > OFFERED_HELD_MS) return;
    for (const event of held.events) if (tryStart(event, 'itself', held.ids) === 'started') break;
  }, [active, ownsHost, tryStart]);

  // Listen for surface-dispatched events.
  useEffect(() => {
    if (!ownsHost || typeof window === 'undefined') return;
    const onEvent = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as HostEvent | undefined;
      if (detail && typeof detail.event_kind === 'string') {
        recentEventsRef.current = [...recentEventsRef.current.filter(one => one.at >= Date.now() - RECENT_EVENT_MS), { event: detail, at: Date.now() }].slice(-RECENT_EVENTS_KEPT);
      }
      if (detail && typeof detail.event_kind === 'string' && tryStart(detail) !== 'rejected') {
        ev.preventDefault();
      }
    };
    window.addEventListener(WALKTHROUGH_EVENT, onEvent);
    // Listening now: anything said before this (a new account's first-use-ready) is said again.
    window.dispatchEvent(new CustomEvent(HOST_AVAILABLE_EVENT));
    return () => window.removeEventListener(WALKTHROUGH_EVENT, onEvent);
  }, [ownsHost, tryStart]);

  // A tour made for a waiting item no longer has a useful target after that
  // item is completed. Release only that tour and do not wake automatic tours
  // over the next item in the same queue.
  useEffect(() => {
    if (!ownsHost || typeof window === 'undefined') return;
    const onDismiss = (event: Event) => {
      const id = (event as CustomEvent<{ walkthrough_id?: unknown }>).detail?.walkthrough_id;
      const current = activeRef.current;
      if (typeof id === 'string' && current?.definitionId === id) closeRun(current.runId, { announce: false });
    };
    window.addEventListener(WALKTHROUGH_DISMISS_REQUESTED, onDismiss);
    return () => window.removeEventListener(WALKTHROUGH_DISMISS_REQUESTED, onDismiss);
  }, [ownsHost, closeRun]);

  // Trigger DATA may name an event that consumes its key without starting the
  // tour. This keeps task associations generic and prevents a stale show-now
  // record on another device from reopening a completed task's tour.
  useEffect(() => {
    if (!ownsHost || typeof window === 'undefined') return;
    let stopped = false;
    const onAssociatedEvent = (event: Event) => {
      const detail = (event as CustomEvent<HostEvent>).detail;
      if (!detail || typeof detail.event_kind !== 'string') return;
      const matches = Object.values(stateRef.current.defs).flatMap(definition =>
        definition.triggers
          .filter(trigger => typeof trigger.once_key === 'string'
            && trigger.consume_on?.some(on => eventMatchesTrigger({ ...trigger, on_event: on }, detail)))
          .map(trigger => ({ definition, trigger })),
      );
      void (async () => {
        for (const { definition, trigger } of matches) {
          if (typeof trigger.once_key !== 'string') continue;
          const activeRunId = activeRef.current?.definitionId === definition.id ? activeRef.current.runId : null;
          let accepted = false;
          consumingRef.current.add(trigger.once_key);
          try {
            for (let attempt = 0; attempt < 3 && !accepted && !stopped; attempt += 1) {
              try {
                accepted = await consumeWalkthroughProgressKey(trigger.once_key);
              } catch {
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
              }
            }
          } finally {
            consumingRef.current.delete(trigger.once_key);
          }
          if (!accepted || stopped) continue;
          const activeRun = activeRef.current;
          if (activeRunId !== null && activeRun?.definitionId === definition.id && activeRun.runId === activeRunId) {
            closeRun(activeRunId, { announce: false });
          }
        }
      })();
    };
    window.addEventListener(WALKTHROUGH_EVENT, onAssociatedEvent);
    return () => {
      stopped = true;
      window.removeEventListener(WALKTHROUGH_EVENT, onAssociatedEvent);
    };
  }, [ownsHost, closeRun]);


  // A tour the person's AI asked to show now starts as one asked for by name, once per ask, when the person's show
  // rules let a tour started by an ask show (subject tour, started_by asked); a held ask waits until they do. An ask
  // for the next waiting tour (`next`, a schedule or workflow running tool:show-a-tour) starts the one an opening would
  // start, each candidate asked as started by an ask, so "only on my schedule" is a rule holding started_by itself.
  const askedNext = (showAsked as { next?: unknown } | null)?.next === true;
  const askedTourId = typeof (showAsked as { tour_id?: unknown } | null)?.tour_id === 'string' ? (showAsked as { tour_id: string }).tour_id : null;
  const askedTourHeld = askedTourId !== null && (!showReady()
    || showOf(TOUR_SUBJECT, tourFacts(defs, askedTourId, null, progress.consumedAt, { now: Date.now(), startedBy: 'asked', urgencyWhenUnset: URGENCY.when_unset })).hidden);
  useAskedNow(showAsked, 'guided-overlay:show-asked-seen', (asked) => {
    if (typeof asked.tour_id === 'string') tryStart({ event_kind: 'walkthrough-requested', walkthrough_id: asked.tour_id });
    else if (asked.next === true) tryStart({ event_kind: 'app-opened' }, 'asked');
  }, ownsHost && ((askedTourId !== null && Boolean(defs[askedTourId]) && !askedTourHeld) || (askedNext && Object.keys(defs).length > 0 && showReady())));

  if (!ownsHost || !active) return null;
  const definition = defs[active.definitionId];
  if (!definition) return null;
  // Each surface retains its own run even after it is hidden or another tour
  // takes over. Queued saves must never read or close the replacement run.
  const run = active;
  // Done ends the run through its last transition (which consumes the once_key); Skip
  // saves the run as finished where it stood before releasing the overlay.
  const onExit = async (reason: WalkthroughExitReason) => {
    if (reason === 'skipped' && run.cursor.status !== 'complete') {
      const receipt = await commitWalkthroughProgress({
        run_id: run.runId,
        definition_id: definition.id,
        definition_revision: definition.revision ?? 1,
        expected_cursor_revision: run.cursorRevision,
        from_step_id: run.cursor.currentStepId,
        to_step_id: run.cursor.currentStepId,
        history: run.cursor.history,
        status: 'complete',
        cause: 'advance',
        once_key: run.onceKey,
      });
      if (!receipt.accepted) throw new Error('This tour could not be saved as finished. Try again.');
    }
    closeRun(run.runId);
    // A tour taken to its end is a good thing that happened; whoever answers it (parts/delight-moments) plays its moment.
    if (reason === 'completed') sayHappened({ event_kind: 'tour-finished', walkthrough_id: definition.id });
  };

  // A local close after a refused save leaves the page quiet. Drop only this
  // page's deferred offers, not their definitions, progress or outbox entries:
  // a fresh screen event or an explicit replay can still start them later.
  const onDismiss = () => {
    if (activeRef.current?.runId !== run.runId) return;
    offeredHeldRef.current = null;
    offeredWaitingRef.current.clear();
    recentEventsRef.current = [];
    pendingEventsRef.current = [];
    firedAppOpened.current = true;
    closeRun(run.runId, { announce: false });
  };

  // A card other tours wait behind carries the app's way to their list (words `more_waiting`, `{count}` filled in).
  const moreWaiting = active.alsoWaiting.length && words?.more_waiting
    ? [{ ...words.more_waiting, label: words.more_waiting.label.replace('{count}', String(active.alsoWaiting.length)) }]
    : undefined;

  const onCursorTransition = async (
    previous: WalkthroughCursor,
    next: WalkthroughCursor,
    cause: 'advance' | 'back',
  ): Promise<{ readonly kind: 'accepted' | 'stale'; readonly cursor: WalkthroughCursor }> => {
    const pending = { runId: run.runId, toStepId: next.currentStepId };
    transitionRef.current = pending;
    try {
      const receipt = await commitWalkthroughProgress({
        run_id: run.runId,
        definition_id: definition.id,
        definition_revision: definition.revision ?? 1,
        expected_cursor_revision: run.cursorRevision,
        from_step_id: previous.currentStepId,
        to_step_id: next.currentStepId,
        history: next.history,
        status: next.status,
        cause,
        once_key: next.status === 'complete' ? run.onceKey : null,
      });
      const persisted: WalkthroughCursor = {
        currentStepId: receipt.current_step_id,
        history: receipt.history,
        status: receipt.status,
      };
      run.cursorRevision = receipt.cursor_revision;
      run.cursor = persisted;
      return { kind: receipt.accepted ? 'accepted' : 'stale', cursor: persisted };
    } finally {
      if (transitionRef.current === pending) transitionRef.current = null;
      setTransitionEpoch((epoch) => epoch + 1);
    }
  };

  return (
    <WalkthroughSurface
      // The surface reads `initialCursor` once, on mount. Adopting the saved
      // run replaces the run identity, so keying on it is what makes a late
      // answer about where someone got to actually move them there. An ordinary
      // step advance keeps the same run and does not remount.
      key={active.runId}
      definition={shownDefinition ?? definition}
      onExit={onExit}
      onDismiss={onDismiss}
      root={root}
      initialCursor={active.cursor}
      onCursorTransition={onCursorTransition}
      contentRegistry={contentRegistry}
      progressRegistry={progressRegistry}
      anchorRegistry={anchorRegistry}
      presentationRegistry={presentationRegistry}
      ownerSignalBridge={ownerSignalBridge}
      words={words}
      extraButtons={moreWaiting}
    />
  );
}
