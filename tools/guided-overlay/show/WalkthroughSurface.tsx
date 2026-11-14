// packages/guided-overlay/show/WalkthroughSurface.tsx
//
// The orchestrating surface (M-integration). Given ONE folded
// `WalkthroughDefinition`, it runs the tour: holds the cursor (M3), resolves the
// current step's target rect (M2), punches the spotlight (M1), renders the
// anchored coachmark with the step's content (M5), progress (M6) and nav buttons,
// and gates/auto-runs advancement (M4 via `canAdvance`) — branching by answer (M8).
//
// It NEVER branches on content_kind / advance op / progress style / role: every
// one is dispatched through a blind registry seeded with the package defaults
// (which the host may extend with media/quiz renderers at the composition site).
// All copy, thresholds, sides, shapes are DATA carried in the definition.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { Container } from '../../ui/show/container/container';
import { Text } from '../../ui/show/text/Text';
import {
  createAnchorResolverRegistry,
  type AnchorResolverRegistry,
  type Rect,
  type Size,
} from '../../ui/show/anchor-resolver/anchor-resolver';
import { AnchoredCoachmark, type AnchoredCoachmarkProps } from '../../ui/show/anchor-resolver/AnchoredCoachmark';
import {
  computeCutouts,
  scrimIsInvisible,
  type CutoutDescriptor,
} from '../../ui/show/overlay-spotlight/overlay-spotlight';
import { OverlaySpotlight } from '../../ui/show/overlay-spotlight/OverlaySpotlight';
import type { StepContentComponent } from '../../ui/show/step-content-renderer/StepContent';
import {
  createStepContentRegistry,
  type StepContentDescriptor,
  type StepContentRegistry,
} from '../../ui/show/step-content-renderer/step-content-renderer';
import type { StepProgressComponent } from '../../ui/show/step-progress/StepProgress';
import {
  createStepProgressRegistry,
  type StepProgressRegistry,
} from '../../ui/show/step-progress/step-progress';
import { startWalkthrough, advance, retreat, jump, type WalkthroughCursor } from '../engine/cursor-machine';
import { createCursorTransitionQueue, type CursorTransitionOutcome } from '../engine/walkthrough-cursor-queue';
import { canAdvance, type AdvanceCondition, type AdvanceSignals } from '../engine/advance-evaluator';
import type { WalkthroughDefinition, WalkthroughStep } from '../read-data/walkthrough-eeaf';
import {
  registerDefaultContentRenderers,
  FallbackContent,
  WALKTHROUGH_ANSWER_EVENT,
  WALKTHROUGH_ACT_EVENT,
} from './default-content-renderers';
import { registerDefaultProgressVisuals, FallbackProgress } from './default-progress-visuals';
import { NavButtons, buttonLooksOf, type NavButtonSpec } from './NavButtons';
import { StepCardBody } from './StepCardBody';
import { Button } from '../../ui/show/button/Button';
import { NamedIcon } from '../../ui/show/icon/NamedIcon';
import { dispatchStepPerform } from '../do-work/dispatch-step-perform';
import { createActRegistry, readStepAct, registerDefaultActs } from '../do-work/act-on-target';
import {
  PLACEABLE_SURFACE_MIME,
  PLACEABLE_SURFACE_COMPLETED_EVENT,
  emitPlaceableSurfaceIntent,
  readPlaceableSurfacePayloadFromUnknown,
  type PlaceableSurfacePayload,
} from '../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { resolveWalkthroughTarget, type TargetResolutionFailure } from './target-resolution';
import {
  fitCutoutToViewport,
  resolveSpotlightAppearance,
  resolveTargetingOptions,
  walkthroughPresentationRef,
} from './walkthrough-presentation';
import { TargetHighlight } from './TargetHighlight';
import {
  createWalkthroughPresentationRegistry,
  type WalkthroughPresentationRegistry,
} from './presentation-registry';
import defaults from 'trillion-workshop/tools/tours-screen/guided-overlay-defaults.json';

export type WalkthroughExitReason = 'completed' | 'skipped';
export const WALKTHROUGH_TARGET_RESOLUTION_EVENT = 'bitfield:walkthrough-target-resolution';

/**
 * One card shell for every step: pointed at its target, or centred in the visible frame when it has nothing to point
 * at. The card draws no chrome of its own (no header row, no close button): its one way out is the tour's exit control,
 * drawn by the surface from DATA (`exitControlOf`), so a card can never show two exits or none.
 * `full-screen` is an open presentation key: it changes only the generic shell geometry.
 */
function WalkthroughCard({ fullScreen = false, width, paper, children, ...props }: AnchoredCoachmarkProps & {
  fullScreen?: boolean;
  /** The card's width in pixels, from the step's `look.card_width_px`. */
  width?: number;
  /** The card's own paper (a look in guided-overlay-defaults.json `papers`), or the shared card surface. */
  paper?: Paper | null;
}) {
  return (
    <AnchoredCoachmark
      {...props}
      centered={!props.targetRect}
      width={width ?? (props.targetRect ? undefined : fullScreen ? 896 : 336)}
      {...(paper ? { surface: 'content' as const, tailFill: paper.background } : {})}
    >
      {paper ? <Container layout="vertical" data-walkthrough-paper="" style={paperStyle(paper)}>{children}</Container> : children}
    </AnchoredCoachmark>
  );
}

/** A card's paper: how its surface looks, DATA in guided-overlay-defaults.json `papers` (sticky note, notepad, …). */
export type Paper = { background: string; color?: string; border?: string; radius_px?: number; rotate_deg?: number; shadow?: string; font_family?: string; ruled?: string };

/** The paper a tour or step asks for by name (`look.paper`), or null for the shared card surface. */
export function paperOf(definition: Pick<WalkthroughDefinition, 'look'>, step: Pick<WalkthroughStep, 'look'> | null): Paper | null {
  const name = (step?.look as { paper?: unknown } | undefined)?.paper ?? (definition.look as { paper?: unknown } | undefined)?.paper;
  const papers = (defaults as { papers?: Record<string, Paper> }).papers ?? {};
  return typeof name === 'string' && papers[name]?.background ? papers[name] : null;
}

export function paperStyle(paper: Paper): CSSProperties {
  return {
    background: paper.ruled ? `${paper.ruled}, ${paper.background}` : paper.background,
    color: paper.color,
    border: paper.border,
    borderRadius: paper.radius_px ?? 12,
    boxShadow: paper.shadow,
    fontFamily: paper.font_family,
    transform: paper.rotate_deg ? `rotate(${paper.rotate_deg}deg)` : undefined,
    padding: '0.875rem 1rem',
    // Room for the turn, so a turned corner never leaves the visible frame.
    margin: paper.rotate_deg ? `${Math.ceil(Math.abs(paper.rotate_deg) * 4)}px` : undefined,
  };
}

/**
 * The tour's one way out, from DATA: `close` (a small close button on the card's top row) or `end` (an End tour button
 * among the card's buttons). A step's `look.exit` wins over its tour's `look.exit`, which wins over the defaults.
 */
export function exitControlOf(definition: Pick<WalkthroughDefinition, 'look'>, step: Pick<WalkthroughStep, 'look'> | null): 'close' | 'end' {
  const chosen = (step?.look as { exit?: unknown } | undefined)?.exit
    ?? (definition.look as { exit?: unknown } | undefined)?.exit
    ?? defaults.exit;
  return chosen === 'end' ? 'end' : 'close';
}

function isFullScreenPresentation(ref: unknown): boolean {
  return ref === 'guided-overlay.presentation.full-screen';
}

function inlineSurfaceContent(payload: PlaceableSurfacePayload): StepContentDescriptor | null {
  const surfaceInput = payload.surfaceInput ? { surface_input: payload.surfaceInput } : {};
  if (payload.id) {
    return {
      content_kind: 'placeable-surface',
      payload: { surface_id: payload.id, ...surfaceInput },
    };
  }
  if (payload.packageEntry) {
    return {
      content_kind: 'placeable-surface',
      payload: {
        content_ref: `package::${payload.packageEntry.packageName}::placeable-surface::${payload.packageEntry.entryName}`,
        ...surfaceInput,
      },
    };
  }
  return null;
}

function prepareTarget(step: WalkthroughStep, viewport: LiveViewport): boolean {
  const descriptor = step.target_preparation;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false;
  const eventName = (descriptor as { event_name?: unknown }).event_name;
  const maxWidth = (descriptor as { max_viewport_width_px?: unknown }).max_viewport_width_px;
  if (typeof maxWidth === 'number' && viewport.width > maxWidth) return false;
  const surface = readPlaceableSurfacePayloadFromUnknown((descriptor as { surface?: unknown }).surface);
  if (surface && (surface.id || surface.packageEntry || surface.target || surface.materialTarget)) {
    // Placement and existing-tab reuse belong to the arrangement, including
    // when a saved walkthrough resumes while another surface is active.
    return emitPlaceableSurfaceIntent(surface);
  }
  if (typeof eventName !== 'string' || eventName.length === 0) return false;
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: { step_id: step.id, target_ref: step.target_ref },
  }));
  return true;
}

/**
 * Owner-signal bridge (OD-04/OD-05 dependency): resolves a step's declared
 * opaque owner fact refs into live readback values. The bridge is BLIND: it
 * receives the refs a step's `advance_condition.args` declared and returns a map
 * keyed by the same refs. guided-overlay never names an owner; the composition
 * site wires the real owner read operations.
 */
export type OwnerSignalBridge = (
  refs: readonly string[],
  context: { definitionId: string; stepId: string; scopeRef?: string },
) => Promise<Readonly<Record<string, unknown>>>;

/**
 * The app's words for every tour. `end_label` names the control that ends a tour (on every step); `closing_step` is
 * one step (same shape as a tour's steps, usually pointing at where the tours are kept) shown once when a tour is
 * ended before its last step, so the person knows where to take it again.
 */
export interface WalkthroughWords {
  readonly end_label?: string;
  readonly closing_step?: WalkthroughStep;
  /** The button a tour's card carries when other tours wait behind it (`{count}` is how many), with its own `perform`. */
  readonly more_waiting?: NavButtonSpec;
}

export interface WalkthroughSurfaceProps {
  readonly definition: WalkthroughDefinition;
  /** The app's words for every tour (End tour, the closing step). */
  readonly words?: WalkthroughWords;
  /** Buttons the host adds to every card of this run after the step's own (each pressed runs its `perform`, then the
   *  tour closes as ended): the way to the tours waiting behind this one. */
  readonly extraButtons?: readonly NavButtonSpec[];
  /** Called when the tour ends through an explicit Done or Skip control. */
  readonly onExit: (reason: WalkthroughExitReason) => void | Promise<void>;
  /** Release the local overlay without starting or cancelling owner work. */
  readonly onDismiss?: () => void;
  /** Resolve owner-readback advance conditions from live owner state. */
  readonly ownerSignalBridge?: OwnerSignalBridge;
  /** Scope threaded to the owner-signal bridge (run scope / account ref). */
  readonly ownerSignalScopeRef?: string;
  /** DOM root for anchor resolution (default `document`). */
  readonly root?: ParentNode;
  /** Extend/override the default content renderers (e.g. add media/quiz). */
  readonly contentRegistry?: StepContentRegistry<StepContentComponent>;
  /** Extend/override the default progress visuals. */
  readonly progressRegistry?: StepProgressRegistry<StepProgressComponent>;
  /** Extend/override the anchor resolvers. */
  readonly anchorRegistry?: AnchorResolverRegistry;
  /** Extend the open presentation grammar. Unknown refs preserve the default surface. */
  readonly presentationRegistry?: WalkthroughPresentationRegistry;
  /** Durable resume cursor supplied by the package-owned progress projection. */
  readonly initialCursor?: WalkthroughCursor;
  /** Owner operation invoked before a cursor transition becomes visible. */
  readonly onCursorTransition?: (
    previous: WalkthroughCursor,
    next: WalkthroughCursor,
    cause: 'advance' | 'back',
  ) => Promise<CursorTransitionOutcome<WalkthroughCursor> | WalkthroughCursor | null | void>;
}

const DEFAULT_NAV = (isLast: boolean, canGoBack: boolean): NavButtonSpec[] => [
  ...(canGoBack ? [{ role: 'back', label: 'Back' } as const] : []),
  { role: 'advance', label: isLast ? 'Done' : 'Next' },
];

/**
 * A step's own buttons while it shows (not saving, not the closing step), without the tour's way out: the authored
 * `nav.buttons` (or Back and Next/Done), less a plain Skip and End tour, plus Do it for me when nothing authored does the
 * step. The running tour and the canvas draw the same buttons from it.
 */
export function stepButtonsOf(
  definition: Pick<WalkthroughDefinition, 'steps'>,
  step: Pick<WalkthroughStep, 'nav'> | null,
  stepIndex: number,
): { navButtons: readonly NavButtonSpec[]; actionAdded: boolean } {
  const fromData = (step?.nav as { buttons?: NavButtonSpec[] } | undefined)?.buttons;
  const isLast = stepIndex === definition.steps.length - 1;
  const authored = fromData && fromData.length > 0 ? fromData : DEFAULT_NAV(isLast, stepIndex > 0);
  const offered = authored.filter((button) => button.role !== END_ROLE && (button.role !== 'skip' || button.skip_to));
  if (offered.some((button) => ACTION_ROLES.has(button.role))) return { navButtons: offered, actionAdded: false };
  return { navButtons: [...offered, { role: 'advance', label: defaults.words.do_it_label }], actionAdded: true };
}

/** The role of the tour's one exit (`exitControlOf` draws it as the close button or as End tour). */
const END_ROLE = 'end';
/** The roles that do the step and move on: a step has one of them, and it is never a second way out. */
const ACTION_ROLES = new Set(['advance', 'done', 'complete']);

/** Whether Escape may close the tour: the step's own `escapable`, else the tour's, else yes. */
function isEscapable(definition: WalkthroughDefinition, step: WalkthroughStep | null): boolean {
  return step?.escapable ?? definition.escapable ?? true;
}

/** `{field}` filled from an object readback; null when any named field is empty. */
function fillFromReadback(text: string, value: unknown): string | null {
  const fields = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let missing = false;
  const filled = text.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const found = fields[name];
    if (typeof found === 'string' && found.trim()) return found;
    if (typeof found === 'number') return String(found);
    missing = true;
    return '';
  });
  return missing ? null : filled;
}

export interface LiveViewport extends Size {
  /** Visual-viewport origin inside the layout viewport, in CSS pixels. */
  readonly offsetLeft: number;
  readonly offsetTop: number;
}

type TargetState =
  | { readonly status: 'untargeted' }
  | { readonly status: 'resolving'; readonly attempts: number }
  | { readonly status: 'resolved'; readonly rect: Rect; readonly attempts: number }
  | { readonly status: 'failed'; readonly reason: TargetResolutionFailure; readonly attempts: number };

/**
 * The rectangle the founder can actually see. Mobile keyboards and pinch zoom
 * shrink or move the visual viewport without necessarily changing innerWidth /
 * innerHeight, so the layout viewport is only the compatibility fallback.
 */
export function liveViewport(): LiveViewport {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0, offsetLeft: 0, offsetTop: 0 };
  }
  const visual = window.visualViewport;
  if (visual) {
    return {
      width: visual.width,
      height: visual.height,
      offsetLeft: visual.offsetLeft,
      offsetTop: visual.offsetTop,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
  };
}

/** Convert a layout-viewport client rect into the visible viewport's local space. */
export function rectInLiveViewport(rect: Rect, viewport: LiveViewport): Rect {
  return {
    ...rect,
    x: rect.x - viewport.offsetLeft,
    y: rect.y - viewport.offsetTop,
  };
}

export function rectIsFullyVisible(rect: Rect, viewport: LiveViewport): boolean {
  return rect.x >= viewport.offsetLeft
    && rect.y >= viewport.offsetTop
    && rect.x + rect.width <= viewport.offsetLeft + viewport.width
    && rect.y + rect.height <= viewport.offsetTop + viewport.height;
}

/** Run a single walkthrough definition end to end. */
export function WalkthroughSurface({
  definition,
  onExit,
  onDismiss,
  words,
  extraButtons,
  ownerSignalBridge,
  ownerSignalScopeRef,
  root,
  contentRegistry,
  progressRegistry,
  anchorRegistry,
  presentationRegistry,
  initialCursor,
  onCursorTransition,
}: WalkthroughSurfaceProps): ReactElement | null {
  const contentReg = useMemo(
    () => contentRegistry ?? registerDefaultContentRenderers(createStepContentRegistry(FallbackContent)),
    [contentRegistry],
  );
  const progressReg = useMemo(
    () => progressRegistry ?? registerDefaultProgressVisuals(createStepProgressRegistry(FallbackProgress)),
    [progressRegistry],
  );
  const anchorReg = useMemo(() => anchorRegistry ?? createAnchorResolverRegistry(), [anchorRegistry]);
  const presentationReg = useMemo(
    () => presentationRegistry ?? createWalkthroughPresentationRegistry(),
    [presentationRegistry],
  );
  const resolveRoot = root ?? (typeof document !== 'undefined' ? document : undefined);

  const [cursor, setCursor] = useState<WalkthroughCursor>(() => initialCursor ?? startWalkthrough(definition));
  const [targetState, setTargetState] = useState<TargetState>({ status: 'untargeted' });
  const [targetRetryNonce, setTargetRetryNonce] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [viewport, setViewport] = useState<LiveViewport>(liveViewport);
  const [signals, setSignals] = useState<AdvanceSignals>({});
  const ownerReadbacksFor = useRef<{bridge:OwnerSignalBridge|undefined;refs:string;step:string;definition:string;scope:string|undefined}|null>(null);
  const [exitState, setExitState] = useState<'idle' | 'saving' | 'error'>('idle');
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const transitionQueueRef = useRef<ReturnType<typeof createCursorTransitionQueue<WalkthroughCursor>> | null>(null);
  const [pendingExitReason, setPendingExitReason] = useState<WalkthroughExitReason | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  // The tour was ended before its last step and now shows the app's closing step (where tours are kept) once.
  const [closing, setClosing] = useState(false);
  const exitedRef = useRef(false);
  const locallyDismissedRef = useRef(false);
  const exitInFlightRef = useRef(false);
  const closeForNowInFlightRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const stepShownAtRef = useRef(0);
  // The element the current step points at, once found: a step's `act` runs on it.
  const targetElementRef = useRef<Element | null>(null);
  const actRegistry = useMemo(() => registerDefaultActs(createActRegistry()), []);

  const cursorStep: WalkthroughStep | null = useMemo(
    () => definition.steps.find((s) => s.id === cursor.currentStepId) ?? null,
    [definition.steps, cursor.currentStepId],
  );
  const closingStep = words?.closing_step ?? null;
  // What the card shows: the step the cursor is on, or the closing step once the tour was ended early.
  const step: WalkthroughStep | null = closing && closingStep ? closingStep : cursorStep;
  const endLabel = words?.end_label ?? defaults.words.end_label;

  const stepIndex = definition.steps.findIndex((s) => s.id === cursor.currentStepId);
  const authoredContent = step?.content as StepContentDescriptor | undefined;
  const presentationRef = step ? walkthroughPresentationRef(step) : undefined;
  const fullScreen = isFullScreenPresentation(presentationRef);
  const [inlineContent, setInlineContent] = useState<StepContentDescriptor | null>(null);
  const escapable = isEscapable(definition, step);
  const targeting = useMemo(() => resolveTargetingOptions(definition.look), [definition.look]);
  // The tour's spotlight, with the step's own `look.spotlight` laid over it: each step chooses how much the page dims and
  // blurs (a live showcase leaves the workspace clear on one step and dims it on the next).
  const stepLook = step?.look;
  const spotlightAppearance = useMemo(() => {
    const tourLook = (definition.look ?? {}) as { spotlight?: object };
    const own = (stepLook as { spotlight?: object } | undefined)?.spotlight;
    return resolveSpotlightAppearance(own ? { ...tourLook, spotlight: { ...(tourLook.spotlight ?? {}), ...own } } : tourLook);
  }, [definition.look, stepLook]);
  const effectiveSpotlightAppearance = useMemo(
    () => reducedMotion ? { ...spotlightAppearance, transitionMs: 0 } : spotlightAppearance,
    [reducedMotion, spotlightAppearance],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (!step?.target_ref || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(WALKTHROUGH_TARGET_RESOLUTION_EVENT, {
      detail: {
        definition_id: definition.id,
        step_id: step.id,
        status: targetState.status,
        attempts: 'attempts' in targetState ? targetState.attempts : 0,
        ...('reason' in targetState ? { reason: targetState.reason } : {}),
      },
    }));
  }, [definition.id, step, targetState]);

  const dismissLocally = useCallback(() => {
    if (locallyDismissedRef.current) return;
    locallyDismissedRef.current = true;
    setLocallyDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  const closeForNow = useCallback(async () => {
    if (closeForNowInFlightRef.current) return;
    closeForNowInFlightRef.current = true;
    // Closing locally does not claim a saved completion. Transient writes remain in
    // the shared outbox; refused writes must be retried before this tour is saved.
    dismissLocally();
    exitedRef.current = true;
  }, [dismissLocally]);

  const exit = useCallback(
    async (reason: WalkthroughExitReason) => {
      if (exitedRef.current || exitInFlightRef.current) return;
      if (reason === 'skipped') {
        exitInFlightRef.current = true;
        setPendingExitReason(reason);
        setExitState('saving');
        void (async () => {
          const transitionsSaved = await (transitionQueueRef.current?.flush() ?? true);
          if (!transitionsSaved) throw new Error('This tour could not be saved. Try again.');
          await onExit(reason);
          dismissLocally();
          exitedRef.current = true;
        })().catch((error) => {
          console.error('[WalkthroughSurface] Progress save failed:', error);
          exitInFlightRef.current = false;
          setExitState('error');
        });
        return;
      }
      exitInFlightRef.current = true;
      try {
        const transitionsSaved = await (transitionQueueRef.current?.flush() ?? true);
        if (!transitionsSaved) {
          exitInFlightRef.current = false;
          setExitState('error');
          return;
        }
        const finalReason = cursorRef.current.status === 'complete' ? 'completed' : reason;
        setPendingExitReason(finalReason);
        if (finalReason === 'skipped') {
          let persistence: Promise<void>;
          try {
            persistence = Promise.resolve(onExit(finalReason));
          } catch (error) {
            console.error('[WalkthroughSurface] Progress save failed:', error);
            persistence = Promise.resolve();
          }
          dismissLocally();
          exitedRef.current = true;
          await persistence.catch((error) => {
            console.error('[WalkthroughSurface] Progress save failed:', error);
          });
          return;
        }
        setExitState('saving');
        await onExit(finalReason);
        exitedRef.current = true;
      } catch (error) {
        exitInFlightRef.current = false;
        console.error('[WalkthroughSurface] Progress save failed:', error);
        setExitState('error');
      }
    },
    [dismissLocally, onExit],
  );

  const transitionCallbackRef = useRef(onCursorTransition);
  transitionCallbackRef.current = onCursorTransition;
  if (!transitionQueueRef.current) {
    transitionQueueRef.current = createCursorTransitionQueue<WalkthroughCursor>({
      initial: cursor,
      persist: async (transition) => {
        const callback = transitionCallbackRef.current;
        if (!callback) return { kind: 'accepted', cursor: transition.next };
        const result = await callback(transition.previous, transition.next, transition.cause);
        if (result && 'kind' in result) return result;
        if (result) return { kind: 'accepted', cursor: result };
        return { kind: 'stale', cursor: transition.previous };
      },
      same: (left, right) => left.currentStepId === right.currentStepId
        && left.status === right.status
        && left.history.length === right.history.length
        && left.history.every((entry, index) => entry === right.history[index]),
      onVisible: (value) => { cursorRef.current = value; setCursor(value); },
      // Owner writes are serialized in the queue while the visible cursor stays
      // responsive; intermediate persistence is not a user-facing save state.
      onSaving: () => {},
      onFailure: (error) => {
        console.error('[WalkthroughSurface] Cursor save failed:', error);
        setExitState('error');
      },
      onComplete: () => { void exit('completed'); },
    });
  }

  const applyCursorTransition = useCallback((next: WalkthroughCursor, cause: 'advance' | 'back') => {
    if (!onCursorTransition) {
      cursorRef.current = next;
      if (next.status === 'complete') void exit('completed');
      else setCursor(next);
      return;
    }
    if (exitState === 'error' || locallyDismissedRef.current) return;
    transitionQueueRef.current?.enqueue(next, cause);
  }, [exit, exitState, onCursorTransition]);

  const currentCursor = useCallback(() => onCursorTransition
    ? (transitionQueueRef.current?.current ?? cursorRef.current)
    : cursorRef.current, [onCursorTransition]);

  const doAdvance = useCallback(() => {
    const next = advance(definition, currentCursor(), signals.answer);
    applyCursorTransition(next, 'advance');
  }, [definition, signals.answer, applyCursorTransition, currentCursor]);
  // The step on screen now and the advance that fits it, for a press whose answer arrives after a re-render.
  const shownStepRef = useRef(cursor.currentStepId);
  shownStepRef.current = cursor.currentStepId;
  const doAdvanceRef = useRef(doAdvance);
  doAdvanceRef.current = doAdvance;
  // Using the highlighted thing is the person's go: set below, once this step's condition is known.
  const targetUsedRef = useRef<() => void>(() => {});

  // Keep centred and closing cards inside the viewport too. The target resolver
  // below owns additional listeners while it has a target, but targetless steps
  // return before installing them.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateViewport = () => {
      const next = liveViewport();
      setViewport((current) => current.width === next.width
        && current.height === next.height
        && current.offsetLeft === next.offsetLeft
        && current.offsetTop === next.offsetTop
        ? current
        : next);
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
    };
  }, []);

  // Resolve the target after render, scroll it into view, and keep retrying while
  // late-mounted UI arrives. A declared target that never resolves becomes a
  // visible error state instead of silently turning into a centred coachmark.
  useLayoutEffect(() => {
    if (!step || typeof window === 'undefined') return;
    const targetRef = step.target_ref;
    if (!targetRef) {
      setTargetState({ status: 'untargeted' });
      return;
    }
    let cancelled = false;
    let el: Element | null = null;
    let timeout: number | undefined;
    let frame: number | undefined;
    let attempts = 0;
    let scrolled = false;
    let shownRect: Rect | null = null;
    let preparedAt = -Infinity;
    const startedAt = Date.now();
    let resizeObserver: ResizeObserver | null = null;
    const onTargetDown = () => setSignals((s) => ({ ...s, targetInteracted: true }));
    const onTargetKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') setSignals((s) => ({ ...s, targetInteracted: true }));
    };
    // A click (a press, or Enter or Space on a control) has run the highlighted thing's own action by the
    // next task; the tour then moves on from the step it was on, if that step may.
    const onTargetClick = () => {
      const usedOn = shownStepRef.current;
      window.setTimeout(() => { if (shownStepRef.current === usedOn) targetUsedRef.current(); }, 0);
    };
    const detach = () => {
      if (el) {
        el.removeEventListener('pointerdown', onTargetDown);
        el.removeEventListener('keydown', onTargetKeyDown);
        el.removeEventListener('click', onTargetClick);
        resizeObserver?.unobserve(el);
      }
      el = null;
      targetElementRef.current = null;
    };
    const schedule = (delay = targeting.retryIntervalMs) => {
      if (cancelled) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(update, delay);
    };
    const update = () => {
      if (cancelled) return;
      attempts += 1;
      const nextViewport = liveViewport();
      setViewport(nextViewport);
      const res = resolveWalkthroughTarget(anchorReg, targetRef, resolveRoot);
      if (res.status === 'resolved') {
        if (res.element !== el) {
          detach();
          el = res.element;
          targetElementRef.current = el;
          el.addEventListener('pointerdown', onTargetDown);
          el.addEventListener('keydown', onTargetKeyDown);
          el.addEventListener('click', onTargetClick);
          resizeObserver?.observe(el);
        }
        if (!scrolled) {
          scrolled = true;
          const scrollIntoView = (res.element as HTMLElement).scrollIntoView;
          if (typeof scrollIntoView === 'function') {
            scrollIntoView.call(res.element, {
              behavior: reducedMotion ? 'auto' : targeting.scrollBehavior,
              block: targeting.scrollBlock,
              inline: targeting.scrollInline,
            });
            const requestFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
            frame = requestFrame(() => update());
            return;
          }
        }
        if (!rectIsFullyVisible(res.rect, nextViewport)) {
          if (Date.now() - startedAt >= targeting.retryTimeoutMs) {
            setTargetState({ status: 'failed', reason: 'not-visible', attempts });
          } else {
            setTargetState({ status: 'resolving', attempts });
            schedule();
          }
          return;
        }
        shownRect = res.rect;
        setTargetState({ status: 'resolved', rect: rectInLiveViewport(res.rect, nextViewport), attempts });
      } else {
        detach();
        // Something opened after the step asked for its screen (the page's own address, a person's press) and covers it:
        // the step asks again, so its target comes forward instead of the step waiting centred behind another screen.
        if (Date.now() - preparedAt >= targeting.reopenEveryMs && prepareTarget(step, liveViewport())) preparedAt = Date.now();
        if (Date.now() - startedAt >= targeting.retryTimeoutMs) {
          setTargetState({ status: 'failed', reason: res.reason, attempts });
        } else {
          setTargetState({ status: 'resolving', attempts });
          schedule();
        }
      }
    };
    resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule(0)) : null;
    setTargetState({ status: 'resolving', attempts: 0 });
    // A target already on screen (the screen the person just opened, on the thing they opened it on) is used as it is:
    // preparing it again would open that screen a second time with none of its own input.
    const present = resolveWalkthroughTarget(anchorReg, targetRef, resolveRoot).status === 'resolved';
    const prepared = !present && prepareTarget(step, liveViewport());
    if (prepared) preparedAt = Date.now();
    if (prepared) {
      const requestFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
      frame = requestFrame(() => update());
    } else {
      update();
    }
    const observer = typeof MutationObserver === 'function' && resolveRoot instanceof Node
      ? new MutationObserver(() => {
        if (!el || !el.isConnected) schedule(0);
      })
      : null;
    observer?.observe(resolveRoot as Node, { childList: true, subtree: true, attributes: true });
    const onGeometryChange = () => schedule(0);
    // The target can move with nothing resizing it or the page scrolling (a list above it opening, a pane sliding in):
    // its place is read again every frame and the ring and card follow it, so the highlight is always on the element.
    let watchFrame: number | undefined;
    const watch = () => {
      if (cancelled) return;
      if (el && shownRect && el.isConnected) {
        const now = el.getBoundingClientRect();
        if (now.x !== shownRect.x || now.y !== shownRect.y || now.width !== shownRect.width || now.height !== shownRect.height) update();
      }
      watchFrame = window.requestAnimationFrame?.(watch);
    };
    watchFrame = window.requestAnimationFrame?.(watch);
    window.addEventListener('resize', onGeometryChange);
    window.addEventListener('scroll', onGeometryChange, true);
    window.visualViewport?.addEventListener('resize', onGeometryChange);
    window.visualViewport?.addEventListener('scroll', onGeometryChange);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (frame !== undefined) window.cancelAnimationFrame?.(frame);
      if (watchFrame !== undefined) window.cancelAnimationFrame?.(watchFrame);
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onGeometryChange);
      window.removeEventListener('scroll', onGeometryChange, true);
      window.visualViewport?.removeEventListener('resize', onGeometryChange);
      window.visualViewport?.removeEventListener('scroll', onGeometryChange);
      detach();
    };
  }, [step, anchorReg, resolveRoot, targeting, targetRetryNonce, reducedMotion]);

  // Fresh signals each step; stamp when this step was shown (for elapsed-time ops).
  useEffect(() => {
    setSignals({});
    setInlineContent(null);
    stepShownAtRef.current = typeof window !== 'undefined' ? Date.now() : 0;
  }, [cursor.currentStepId]);

  // A full-screen step owns the visible viewport. Opening another surface in the
  // workspace would put it behind the modal and make a successful click look
  // dead. Keep nested surface navigation inside the walkthrough instead. The
  // payload remains generic: the requested surface id/package entry still comes
  // from the emitting component and the shared placeable-surface catalog.
  useEffect(() => {
    if (locallyDismissed || cursor.status === 'complete' || !step || !fullScreen || authoredContent?.content_kind !== 'placeable-surface'
      || typeof window === 'undefined') return;
    const receiveSurfaceIntent = (event: Event) => {
      const payload = readPlaceableSurfacePayloadFromUnknown(
        (event as CustomEvent<unknown>).detail,
      );
      const next = payload ? inlineSurfaceContent(payload) : null;
      if (!next) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setInlineContent(next);
    };
    window.addEventListener(PLACEABLE_SURFACE_MIME, receiveSurfaceIntent, { capture: true });
    return () => window.removeEventListener(PLACEABLE_SURFACE_MIME, receiveSurfaceIntent, { capture: true });
  }, [authoredContent?.content_kind, cursor.status, fullScreen, locallyDismissed, step]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const receiveAnswer = (event: Event) => {
      const answer = (event as CustomEvent<{ answer?: unknown }>).detail?.answer;
      if (typeof answer === 'string' && answer.length > 0) {
        setSignals((current) => ({ ...current, answer }));
      }
    };
    window.addEventListener(WALKTHROUGH_ANSWER_EVENT, receiveAnswer);
    return () => window.removeEventListener(WALKTHROUGH_ANSWER_EVENT, receiveAnswer);
  }, []);

  // A choice that does something (an example ask that puts its words into the box) runs on the step's own control,
  // through the same act registry the step's Next uses; the step stays, so each choice can be tried.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const receiveAct = (event: Event) => {
      const act = readStepAct((event as CustomEvent<{ act?: unknown }>).detail?.act);
      const target = targetElementRef.current;
      if (act && target?.isConnected) actRegistry.run(target, act);
    };
    window.addEventListener(WALKTHROUGH_ACT_EVENT, receiveAct);
    return () => window.removeEventListener(WALKTHROUGH_ACT_EVENT, receiveAct);
  }, [actRegistry]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const receiveCompletion = (event: Event) => {
      const completionRef = (event as CustomEvent<{ completionRef?: unknown }>).detail?.completionRef;
      if (typeof completionRef !== 'string' || !completionRef.trim()) return;
      setSignals((current) => ({
        ...current,
        surfaceCompletionRefs: Array.from(new Set([
          ...(current.surfaceCompletionRefs ?? []),
          completionRef.trim(),
        ])),
      }));
    };
    window.addEventListener(PLACEABLE_SURFACE_COMPLETED_EVENT, receiveCompletion);
    return () => window.removeEventListener(PLACEABLE_SURFACE_COMPLETED_EVENT, receiveCompletion);
  }, []);

  // Owner-signal bridge: resolve this step's declared owner fact refs whenever
  // the step (or bridge identity) changes, then re-read after the previous read
  // finishes. A slow owner read must never create overlapping requests. The
  // surface stays blind: it only collects the opaque refs the step DATA declared.
  const condition = closing ? undefined : step?.advance_condition as AdvanceCondition | undefined;
  const ownerRefs = useMemo(() => {
    const args = condition?.args;
    if (!args || typeof args !== 'object') return [] as string[];
    return [
      args.readback_ref,
      args.answer_fact_ref,
      args.objective_answer_ref,
    ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
  }, [condition]);
  // How often the owner's fact is read again, from the condition's DATA (`every_ms`).
  const readEveryMs = typeof condition?.args?.every_ms === 'number' && condition.args.every_ms > 0 ? condition.args.every_ms : 700;
  const ownerRefsKey = ownerRefs.join('\u0000');
  useEffect(() => {
    ownerReadbacksFor.current = null;
    setSignals(current=>({...current,ownerReadbacks:{}}));
    if (!ownerSignalBridge || ownerRefs.length === 0) return;
    let cancelled = false;
    let reading = false;
    let nextRead: number | undefined;
    const resolve = () => {
      if (cancelled || reading) return;
      reading = true;
      void ownerSignalBridge(ownerRefs, {
        definitionId: definition.id,
        stepId: step?.id ?? '',
        ...(ownerSignalScopeRef ? { scopeRef: ownerSignalScopeRef } : {}),
      }).then((readbacks) => {
        if (cancelled) return;
        ownerReadbacksFor.current = {bridge:ownerSignalBridge,refs:ownerRefsKey,step:step?.id??'',definition:definition.id,scope:ownerSignalScopeRef};
        setSignals((s) => ({ ...s, ownerReadbacks: Object.fromEntries(ownerRefs.map(ref=>[ref,readbacks[ref]??null])) }));
      }).catch((error) => {
        if (!cancelled) {
          ownerReadbacksFor.current = null;
          setSignals(current=>({...current,ownerReadbacks:{}}));
          console.error('[WalkthroughSurface] Owner signal bridge failed:', error);
        }
      }).finally(() => {
        reading = false;
        if (!cancelled) nextRead = window.setTimeout(resolve, readEveryMs);
      });
    };
    // Coming back to the page (from the app where the person was connecting something) reads it again at once.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      if (nextRead !== undefined) window.clearTimeout(nextRead);
      nextRead = undefined;
      resolve();
    };
    document.addEventListener('visibilitychange', onVisible);
    resolve();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (nextRead !== undefined) window.clearTimeout(nextRead);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerSignalBridge, ownerRefsKey, definition.id, step?.id, ownerSignalScopeRef, readEveryMs]);

  // A replaced bridge or ref must be unavailable on the very first render,
  // before effect cleanup, so a former true fact never enables the new step.
  const currentSignals = useMemo(()=>ownerReadbacksFor.current?.bridge===ownerSignalBridge
    && ownerReadbacksFor.current?.refs===ownerRefsKey && ownerReadbacksFor.current?.step===(step?.id??'')
    && ownerReadbacksFor.current?.definition===definition.id && ownerReadbacksFor.current?.scope===ownerSignalScopeRef
    ? signals : {...signals,ownerReadbacks:{}},[signals,ownerSignalBridge,ownerRefsKey,step?.id,definition.id,ownerSignalScopeRef]);
  const canGo = !condition || canAdvance(condition, currentSignals);
  targetUsedRef.current = () => {
    if (closing || exitState !== 'idle' || cursor.status !== 'active') return;
    if (condition && !canAdvance(condition, { ...currentSignals, targetInteracted: true })) return;
    doAdvance();
  };
  // Ending the tour: before its last step it first shows the app's closing step once; from there, it closes.
  const endTour = useCallback(() => {
    if (exitState === 'error') {
      // Close locally without claiming durability. The unsaved completion may appear again.
      void closeForNow();
      return;
    }
    if (exitState !== 'idle') return;
    if (closing || !closingStep) { void exit('skipped'); return; }
    setClosing(true);
  }, [closing, closingStep, closeForNow, exit, exitState]);
  // The card's close button always ends the tour; Escape does only when the tour is escapable.
  const escapeTour = useCallback(() => {
    if (escapable || closing) endTour();
  }, [closing, endTour, escapable]);

  // Keyboard operation mirrors the visible controls. Escape releases an
  // informational overlay only when its DATA policy permits dismissal.
  // Native controls keep their own Enter/Space behavior so a click cannot fire twice.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        escapeTour();
        return;
      }
      if (exitState !== 'idle') return;
      const target = event.target;
      const isInteractiveTarget = target instanceof Element && target.matches(
        'button, a, input, select, textarea, [contenteditable="true"], [role="button"]',
      );
      if (isInteractiveTarget) return;
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && closing) {
        event.preventDefault();
        void exit('skipped');
        return;
      }
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && canGo) {
        event.preventDefault();
        doAdvance();
        return;
      }
      if (event.key === 'ArrowLeft' && !closing) {
        event.preventDefault();
        applyCursorTransition(retreat(currentCursor()), 'back');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyCursorTransition, canGo, closing, cursor, currentCursor, escapeTour, doAdvance, exit, exitState]);

  // Generic re-evaluation ticker: while a step's condition is unmet, keep `elapsedMs`
  // current so ANY time-based advance op (timeout — or a future one) eventually
  // satisfies, WITHOUT the surface knowing the op name. Stops the instant it can go.
  useEffect(() => {
    if (!condition || canGo || typeof window === 'undefined') return;
    const id = window.setInterval(() => {
      setSignals((s) => ({ ...s, elapsedMs: Date.now() - stepShownAtRef.current }));
    }, 200);
    return () => window.clearInterval(id);
  }, [condition, canGo]);

  // The step's buttons, without its way out (drawn once, by `exitControlOf`). A step has one action button that does
  // the step: a plain Skip is gone (it was a second way past the step beside Next, or a second way out beside End tour);
  // a Skip that jumps to another step (`skip_to`) is a choice and stays. A step that waits for the person's own press
  // and authored no action button gets one (Do it for me) that does the step for them.
  const { navButtons, actionAdded } = useMemo((): { navButtons: readonly NavButtonSpec[]; actionAdded: boolean } => {
    const fromData = (step?.nav as { buttons?: NavButtonSpec[] } | undefined)?.buttons;
    if (exitState === 'error') {
      const copy = definition.status_copy as { retry_label?: string; close_for_now_label?: string } | undefined;
      return { navButtons: [
        { role: 'retry', label: copy?.retry_label ?? 'Try again' },
        { role: 'close-for-now', label: copy?.close_for_now_label ?? 'Close for now' },
      ], actionAdded: false };
    }
    // The closing step shows only its own buttons (Got it); every pressed button closes the tour.
    if (closing) return { navButtons: fromData && fromData.length > 0 ? fromData : [{ role: 'done', label: defaults.words.closing_done_label }], actionAdded: false };
    const own = stepButtonsOf(definition, step, stepIndex);
    return extraButtons?.length ? { ...own, navButtons: [...own.navButtons, ...extraButtons] } : own;
  }, [closing, definition.status_copy, exitState, step?.nav, stepIndex, definition.steps.length, extraButtons]);
  const exitControl = exitControlOf(definition, step);
  const looks = useMemo(() => buttonLooksOf(definition, step), [definition, step]);

  // Auto-advance steps whose condition is met but that carry no advance button.
  useEffect(() => {
    if (cursor.status !== 'active' || !condition || exitState !== 'idle') return;
    // A step whose action button was authored waits for it; one that only waits for the person moves on by itself.
    const hasAdvanceBtn = !actionAdded && navButtons.some((b) => ACTION_ROLES.has(b.role));
    if (!hasAdvanceBtn && canAdvance(condition, currentSignals)) doAdvance();
  }, [currentSignals, condition, navButtons, actionAdded, cursor.status, doAdvance, exitState]);

  // A tour that plays itself (`play: { step_ms }`, a live showcase): each step shows for its own `look.hold_ms` (else
  // `step_ms`), then its action button is pressed for the person, running the step's act on the real control. The last
  // step waits for the person (it holds what to do next). The person's own press or key anywhere outside the card hands
  // the workspace to them and the tour stops playing; acts the tour runs are not the person's own (they are untrusted).
  const play = definition.play && typeof definition.play === 'object' ? definition.play as { step_ms?: unknown; after_ms?: unknown } : null;
  const playStepMs = typeof play?.step_ms === 'number' && play.step_ms > 0 ? play.step_ms : null;
  // While it plays, what an act did stays on screen this long before the tour moves on (`play.after_ms`), so a viewer
  // sees the filtered list or the sent message; a person pressing the button themselves gets the usual short pause.
  const playAfterMs = typeof play?.after_ms === 'number' && play.after_ms > 0 ? play.after_ms : null;
  const [handedOver, setHandedOver] = useState(false);
  useEffect(() => {
    if (!playStepMs || handedOver || typeof document === 'undefined') return;
    const takeOver = (event: Event) => {
      if (!event.isTrusted) return;
      const inCard = event.target instanceof Element && event.target.closest('[role="dialog"]');
      if (!inCard) setHandedOver(true);
    };
    document.addEventListener('pointerdown', takeOver, true);
    document.addEventListener('keydown', takeOver, true);
    return () => {
      document.removeEventListener('pointerdown', takeOver, true);
      document.removeEventListener('keydown', takeOver, true);
    };
  }, [playStepMs, handedOver]);
  const onActionRef = useRef<(role: string) => void>(() => {});
  const playsThisStep = Boolean(playStepMs) && !handedOver && !closing && exitState === 'idle' && cursor.status === 'active'
    && stepIndex >= 0 && stepIndex < definition.steps.length - 1 && targetState.status !== 'resolving';
  const actionRole = navButtons.find((button) => ACTION_ROLES.has(button.role))?.role ?? 'advance';
  useEffect(() => {
    if (!playsThisStep || !playStepMs) return;
    const hold = (step?.look as { hold_ms?: unknown } | undefined)?.hold_ms;
    const ms = typeof hold === 'number' && hold > 0 ? hold : playStepMs;
    const playingOn = cursor.currentStepId;
    const timer = window.setTimeout(() => { if (shownStepRef.current === playingOn) onActionRef.current(actionRole); }, ms);
    return () => window.clearTimeout(timer);
  }, [playsThisStep, playStepMs, cursor.currentStepId, actionRole, step?.look]);

  const onAction = useCallback(
    (role: string) => {
      if (role === 'close-for-now') {
        // This only closes the visible card. Any unsaved transition remains in the
        // device outbox for retry, and no durable completion event is emitted.
        void closeForNow();
      } else if (role === 'retry') {
        if (transitionQueueRef.current?.pendingCount) {
          transitionQueueRef.current.retry();
          void transitionQueueRef.current.flush().then((saved) => {
            if (saved) {
              setExitState('idle');
              if (pendingExitReason) void exit(pendingExitReason);
            }
          });
        } else void exit(pendingExitReason ?? 'completed');
      } else if (closing) {
        void exit('skipped');
      } else if (role === END_ROLE) {
        endTour();
      } else if (role === 'back') {
        applyCursorTransition(retreat(currentCursor()), 'back');
      } else {
        // Every button may carry an opaque DATA-described effect. Dispatch it
        // before advancing or exiting so the destination owner acts before the
        // walkthrough disappears. The in-flight guard makes a double click one
        // effect and one completion.
        const perform = navButtons.find((b) => b.role === role)?.perform;
        const finishAction = () => {
          if (ACTION_ROLES.has(role)) {
            setSignals((s) => ({ ...s, nextTapped: true }));
            // A step that does the thing does it on the real control first, through a person's own events, and moves on
            // once the page has had a moment to answer, so the person sees what happened. A step that only waited for
            // the person's press (its action button was added) presses its target for them.
            const act = readStepAct(step?.act) ?? (actionAdded ? { do: 'press' } : null);
            const target = targetElementRef.current;
            const lasts = act && target?.isConnected ? actRegistry.run(target, act) : null;
            if (lasts !== null) {
              // The press may move the tour on by itself (the step waited for it); move on only if it has not, once the
              // act has finished (the last typed letter) and the page has had a moment to answer.
              const pressedOn = currentCursor().currentStepId;
              const after = playStepMs && playAfterMs && !handedOver ? playAfterMs : defaults.act.pause_ms;
              window.setTimeout(() => { if (shownStepRef.current === pressedOn) doAdvanceRef.current(); }, lasts + after);
              return;
            }
            doAdvance();
            return;
          }
          if (role === 'skip') {
            // Skip moves past this one step, whatever its condition: to its `skip_to` step, else the next one
            // (past the last step, the tour is done). Ending the whole tour is the End tour control.
            const skipTo = navButtons.find((b) => b.role === 'skip')?.skip_to;
            applyCursorTransition(typeof skipTo === 'string' ? jump(definition, cursor, skipTo) : advance(definition, cursor), 'advance');
            return;
          }
          void exit('skipped');
        };
        if (!perform) {
          finishAction();
          return;
        }
        if (actionInFlightRef.current) return;
        actionInFlightRef.current = true;
        void dispatchStepPerform(perform)
          .then((value) => {
            // Release the guard on SUCCESS too: a tour whose every step carries a
            // perform (Next auto-opens the target) must not deadlock after the
            // first advance. The flag only suppresses a double click on ONE
            // button, never the whole rest of the tour.
            actionInFlightRef.current = false;
            return value;
          })
          .then(finishAction)
          .catch((error) => {
            actionInFlightRef.current = false;
            console.error('[WalkthroughSurface] Step effect dispatch failed:', error);
          });
      }
    },
    [actRegistry, actionAdded, applyCursorTransition, closing, closeForNow, cursor, currentCursor, definition, doAdvance, endTour, exit, handedOver, pendingExitReason, navButtons, playAfterMs, playStepMs, step],
  );
  onActionRef.current = onAction;

  if (!step || cursor.status === 'complete' || locallyDismissed) return null;

  const content = inlineContent ?? authoredContent;
  const cutoutShapes = (step.cutout as { shapes?: CutoutDescriptor[] } | undefined)?.shapes ?? [];
  // A targetless step (no target_ref at all) renders centred with no spotlight.
  // A step whose target may be absent (a list that is empty for this person) says so in
  // DATA, and is then shown centred with its own words instead of the recovery card.
  const centredWhenMissing = targetState.status === 'failed' && step.centered_when_target_missing === true;
  // While a step's target is still being found (its screen opening, its list loading) the step shows its own words at
  // once, centred with no spotlight, and moves onto the target the moment it is there; it never shows a placeholder or
  // its words on the previous step's spotlight.
  const finding = targetState.status === 'resolving';
  const stepDeclaresTarget = !!step.target_ref && !centredWhenMissing && !finding;
  const targetRect = stepDeclaresTarget && targetState.status === 'resolved' ? targetState.rect : null;
  // The tour's one way out, drawn here and nowhere else: a close button on the card's top row, or End tour first among
  // its buttons (exitControlOf, DATA). The closing step's own button (Got it) is its way out, so it shows neither.
  const showsClose = !closing && exitControl === 'close';
  const cardButtons: readonly NavButtonSpec[] = !closing && exitControl === 'end' ? [{ role: END_ROLE, label: endLabel }, ...navButtons] : navButtons;
  const tourName = typeof definition.title === 'string' && definition.title ? definition.title : 'this tour';
  const closeButton = showsClose ? (
    <Button size="icon-xs" variant="ghost" aria-label={`Close tour: ${tourName}`} title={endLabel} data-walkthrough-exit="close" disabled={exitState === 'saving'} onClick={endTour}>
      <NamedIcon name="X" size="xs" aria-hidden="true" />
    </Button>
  ) : null;
  const paper = paperOf(definition, step);
  const cutouts = targetRect
    ? computeCutouts([targetRect], cutoutShapes).map((cutout) => fitCutoutToViewport(cutout, viewport))
    : [];
  // Click handling is presentation DATA, independently configurable for every tour
  // or step: all page controls, only the highlighted target, or none. Content kind
  // describes the card and never silently changes what a person may press. A scrim
  // nobody can see catches no clicks even when stale DATA asks it to block the page.
  const policy = scrimIsInvisible(effectiveSpotlightAppearance.scrimColor, effectiveSpotlightAppearance.blurPx) ? 'pass-all'
    : effectiveSpotlightAppearance.pointerPolicy;
  const progressStyle = (definition.progress_style as { style?: string } | undefined)?.style ?? 'counter';
  const statusCopy = definition.status_copy as {
    saving?: string;
    error?: string;
    retry_label?: string;
    target_missing?: string;
  } | undefined;
  const safeDefinitionId = definition.id.replace(/[^A-Za-z0-9_-]/g, '-');
  const safeStepId = step.id.replace(/[^A-Za-z0-9_-]/g, '-');
  const dialogTitleId = `${safeDefinitionId}-${safeStepId}-dialog-title`;
  const dialogDescriptionId = `${safeDefinitionId}-${safeStepId}-dialog-description`;
  const exitMessage = exitState === 'error'
      ? statusCopy?.error ?? 'Your choice was not saved. Try again, or close for now. The tour may appear again.'
      : null;
  const Presentation = presentationReg.resolve(presentationRef);
  const cardWidth = (() => {
    const width = (step.look as { card_width_px?: unknown } | undefined)?.card_width_px;
    return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : undefined;
  })();
  // Under the content, while an owner-readback condition waits and once it holds (Connected to Claude): a tone dot
  // and a few of the step's own words, never a sentence; the step stays where the person was reading, and its Next
  // turns on by itself.
  const statusNote = (() => {
    const note = step.status_note as { waiting?: string; ready?: string; ready_without?: string } | undefined;
    if (!note || !condition) return null;
    if (!canGo) return note.waiting ? { text: note.waiting, ready: false } : null;
    const ref = typeof condition.args?.readback_ref === 'string' ? condition.args.readback_ref : '';
    const filled = note.ready ? fillFromReadback(note.ready, currentSignals.ownerReadbacks?.[ref]) : null;
    const text = filled ?? note.ready_without;
    return text ? { text, ready: true } : null;
  })();

  // A target that was never found, on a step that needs it, says so with Try again, Skip and End tour.
  if (targetState.status === 'failed' && !centredWhenMissing) {
    return (
      <Presentation
        presentationRef={presentationRef}
        definition={definition}
        step={step}
        targetRect={targetRect}
      >
      <WalkthroughCard
        open
        targetRect={targetRect}
        width={cardWidth}
        paper={paper}
        viewport={viewport}
        placement={{}}
        showPointer={false}
        ariaLabel={definition.title ?? 'This step is not available'}
        focusKey={`${cursor.currentStepId}:${targetState.status}`}
        fullScreen={fullScreen}
      >
        <Container role="alert" layout="vertical" gap="sm" data-target-resolution-state={targetState.status}>
          <Container layout="horizontal" gap="sm" alignItems="start" justifyContent="between">
            <Text variant="body" weight="bold">
              {statusCopy?.target_missing ?? 'This part is not available yet.'}
            </Text>
            {closeButton}
          </Container>
          <Container layout="horizontal" gap="sm">
            <NavButtons
              looks={looks}
              buttons={[
                ...(!closing && exitControl === 'end' ? [{ role: END_ROLE, label: endLabel }] : []),
                { role: 'retry-target', label: statusCopy?.retry_label ?? 'Try again' },
                // Past this step: the step's own action button, which moves on even with its control missing.
                ...(closing ? [] : navButtons.filter((button) => ACTION_ROLES.has(button.role)).slice(0, 1)),
              ]}
              onAction={(role) => {
                if (role === 'retry-target') {
                  setTargetRetryNonce((value) => value + 1);
                } else {
                  onAction(role);
                }
              }}
            />
          </Container>
        </Container>
      </WalkthroughCard>
      </Presentation>
    );
  }

  return (
    <Presentation
      presentationRef={presentationRef}
      definition={definition}
      step={step}
      targetRect={targetRect}
    >
      <>
      <OverlaySpotlight
        open={!!targetRect}
        viewport={viewport}
        cutouts={cutouts}
        policy={policy}
        scrimColor={effectiveSpotlightAppearance.scrimColor}
        blurPx={effectiveSpotlightAppearance.blurPx}
      />
      <TargetHighlight cutout={cutouts[0] ?? null} viewport={viewport} appearance={effectiveSpotlightAppearance} />
      <WalkthroughCard
        open
        targetRect={targetRect}
        width={cardWidth}
        paper={paper}
        viewport={viewport}
        placement={(step.placement as never) ?? {}}
        showPointer={!!targetRect}
        ariaLabel={typeof definition.title === 'string' ? definition.title : 'Guided walkthrough'}
        ariaLabelledBy={dialogTitleId}
        ariaDescribedBy={dialogDescriptionId}
        focusKey={cursor.currentStepId}
        fullScreen={fullScreen}
      >
        <StepCardBody
          fullScreen={fullScreen}
          closing={closing}
          closeButton={closeButton}
          tourTitle={typeof definition.title === 'string' ? definition.title : 'Walkthrough'}
          stepIndex={stepIndex}
          stepCount={definition.steps.length}
          progressStyle={progressStyle}
          progressReg={progressReg}
          contentReg={contentReg}
          content={content}
          statusNote={statusNote}
          saving={false}
          exitMessage={exitMessage}
          buttons={cardButtons}
          onAction={onAction}
          // The action button always does the step (it no longer waits beside a Skip); only a save in flight holds it.
          isDisabled={() => exitState === 'saving'}
          looks={looks}
          dialogTitleId={dialogTitleId}
          dialogDescriptionId={dialogDescriptionId}
        />
      </WalkthroughCard>
      </>
    </Presentation>
  );
}
