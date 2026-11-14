// packages/ui/show/dockable-placement/dockable-placement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// THE generic dockable-placement primitive (L088 bedrock): placement state
// for ANY dockable/floatable chrome — a sidebar, a drawing toolbar, a future
// inspector, anything that docks to an edge, collapses, floats, drags, and
// resizes. One primitive, N consumers.
//
// What lives here (Physics):
//   - placement state types + defaults + generic decode/clamp
//   - pure selectors (vertical/floating/orientation)
//   - a per-instance optimistic store with persist-reconcile (the proven
//     sidebar pattern, generalized: stage local -> persist -> reconcile when
//     the owner feed catches up)
//   - the controller hook that binds store + owner state + persist callback
//
// What NEVER lives here (Society): data reads, action names, input names,
// stage insets, content. Consumers inject their owner state and persistence.
// The sidebar persists through its package action records; the drawing
// toolbar persists ephemerally; a future consumer can do either.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO @bitfield/runtime-kit imports — consumers own data and persistence
// 2. Stores are PER-INSTANCE (createDockablePlacementStore), never module
//    singletons — two dockables on one screen never share state
// 3. Selectors are pure functions of state
// 4. Optimistic staging never loses a newer owner value: reconcile drops the
//    pending stage only when the owner echoes it (or nothing is pending)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type DockPosition = 'left' | 'right' | 'top' | 'bottom';
export type DockState = 'docked' | 'floating';
/** `folded`: only a small handle shows, wherever the person put it (`foldedAt`); it opens the thing over the work. */
export type DockMode = 'expanded' | 'collapsed' | 'auto' | 'folded';

/**
 * A seam of an arrangement: the line between child `after` and child `after + 1` of the split at `split` (the path of
 * child indexes from the root, [] for the root itself). Docked on a seam, a thing sits between those two panes and
 * lies along the seam: down it between panes side by side, across it between panes stacked.
 */
export interface DockSeam {
  split: number[];
  after: number;
}

/** A point as shares of the room it sits in (0 the left or top edge, 1 the right or bottom), so a window resize keeps it in place. */
export interface DockPoint {
  x: number;
  y: number;
}

/** How many rows a thin bar shows before the rest go behind its More button; absent bounds fit the room. */
export interface DockFit {
  min?: number;
  max?: number;
}

export interface DockFloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Project a saved rectangle into current bounds without rewriting the saved preference. */
export function fitDockFloatRect(rect: DockFloatRect, bounds: { width: number; height: number }): DockFloatRect {
  const w = Math.max(0, Math.min(rect.w, bounds.width));
  const h = Math.max(0, Math.min(rect.h, bounds.height));
  return { w, h, x: Math.max(0, Math.min(rect.x, bounds.width - w)), y: Math.max(0, Math.min(rect.y, bounds.height - h)) };
}

export interface DockablePlacementState {
  position: DockPosition;
  dockState: DockState;
  mode: DockMode;
  /** Size on the primary axis (width when vertical, height when horizontal). */
  size: number;
  floatRect: DockFloatRect;
  /** Docked on this seam of the arrangement instead of on `position`; `position` is where it goes when the seam is gone. */
  seam?: DockSeam;
  /** Where the folded handle sits; absent is the docked side's bottom corner. */
  foldedAt?: DockPoint;
  /** How many rows show when it is a thin bar. */
  fit?: DockFit;
}

export const DEFAULT_DOCKABLE_PLACEMENT_STATE: DockablePlacementState = {
  position: 'left',
  dockState: 'docked',
  mode: 'expanded',
  size: 280,
  floatRect: { x: 100, y: 100, w: 280, h: 600 },
};

// ---------------------------------------------------------------------------
// DECODE (generic — consumers decode their own feed rows, then hand a plain
// value here; unknown fields fall back per-field to the supplied defaults)
// ---------------------------------------------------------------------------

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function decodeDockablePlacementValue(
  value: unknown,
  defaults: DockablePlacementState = DEFAULT_DOCKABLE_PLACEMENT_STATE,
): DockablePlacementState {
  const record = readRecord(value);
  if (!record) return defaults;

  const rect = readRecord(record.floatRect) ?? {};
  const position: DockPosition =
    record.position === 'left' || record.position === 'right' || record.position === 'top' || record.position === 'bottom'
      ? record.position
      : defaults.position;
  const dockState: DockState = record.dockState === 'floating'
    ? 'floating'
    : record.dockState === 'docked' ? 'docked' : defaults.dockState;
  const mode: DockMode =
    record.mode === 'collapsed' || record.mode === 'auto' || record.mode === 'expanded' || record.mode === 'folded'
      ? record.mode
      : defaults.mode;
  const seam = decodeDockSeam(record.seam);
  const foldedAt = decodeDockPoint(record.foldedAt);
  const fit = decodeDockFit(record.fit);

  return {
    position,
    dockState,
    mode,
    size: readFiniteNumber(record.size ?? record.width, defaults.size),
    floatRect: {
      x: readFiniteNumber(rect.x, defaults.floatRect.x),
      y: readFiniteNumber(rect.y, defaults.floatRect.y),
      w: readFiniteNumber(rect.w, defaults.floatRect.w),
      h: readFiniteNumber(rect.h, defaults.floatRect.h),
    },
    ...(seam ? { seam } : {}),
    ...(foldedAt ? { foldedAt } : {}),
    ...(fit ? { fit } : {}),
  };
}

const isWholeAtLeast = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= least;

/** A seam as saved, or undefined when it is not one. */
export function decodeDockSeam(value: unknown): DockSeam | undefined {
  const record = readRecord(value);
  if (!record || !Array.isArray(record.split) || !record.split.every((step) => isWholeAtLeast(step, 0)) || !isWholeAtLeast(record.after, 0)) return undefined;
  return { split: [...record.split] as number[], after: record.after };
}

/** A point as saved, kept inside its room, or undefined when it is not one. */
export function decodeDockPoint(value: unknown): DockPoint | undefined {
  const record = readRecord(value);
  if (!record || typeof record.x !== 'number' || typeof record.y !== 'number' || !Number.isFinite(record.x) || !Number.isFinite(record.y)) return undefined;
  return { x: Math.min(1, Math.max(0, record.x)), y: Math.min(1, Math.max(0, record.y)) };
}

/** A fit as saved: whole bounds of at least one, the smaller first; undefined when it bounds nothing. */
export function decodeDockFit(value: unknown): DockFit | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const min = isWholeAtLeast(record.min, 1) ? record.min : undefined;
  const max = isWholeAtLeast(record.max, 1) ? record.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max: min !== undefined ? Math.max(min, max) : max } : {}) };
}

/** The key one seam goes by, the same for the same seam everywhere. */
export function dockSeamKey(seam: DockSeam): string {
  return `${seam.split.join('.')}/${seam.after}`;
}

// ---------------------------------------------------------------------------
// SELECTORS (pure)
// ---------------------------------------------------------------------------

export function selectDockIsVertical(state: Pick<DockablePlacementState, 'position'>): boolean {
  return state.position === 'left' || state.position === 'right';
}

export function selectDockIsFloating(state: Pick<DockablePlacementState, 'dockState'>): boolean {
  return state.dockState === 'floating';
}

export function selectDockOrientation(state: Pick<DockablePlacementState, 'position'>): 'vertical' | 'horizontal' {
  return selectDockIsVertical(state) ? 'vertical' : 'horizontal';
}

// ---------------------------------------------------------------------------
// PER-INSTANCE OPTIMISTIC STORE
// ---------------------------------------------------------------------------

export interface DockablePlacementStore {
  get: () => DockablePlacementState;
  /** Stage a local (optimistic) value; remembered until the owner echoes it. */
  stage: (next: DockablePlacementState) => void;
  /** Feed the latest owner value; ignored while a different stage is pending. */
  reconcile: (ownerState: DockablePlacementState) => void;
  subscribe: (listener: () => void) => () => void;
}

function serialize(state: DockablePlacementState): string {
  return JSON.stringify(state);
}

export function createDockablePlacementStore(
  initial: DockablePlacementState = DEFAULT_DOCKABLE_PLACEMENT_STATE,
): DockablePlacementStore {
  let state = initial;
  let pendingSerialized: string | null = null;
  const listeners = new Set<() => void>();

  const set = (next: DockablePlacementState) => {
    if (serialize(state) === serialize(next)) return;
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    get: () => state,
    stage: (next) => {
      pendingSerialized = serialize(next);
      set(next);
    },
    reconcile: (ownerState) => {
      const ownerSerialized = serialize(ownerState);
      if (pendingSerialized && pendingSerialized !== ownerSerialized) return;
      pendingSerialized = null;
      set(ownerState);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CONTROLLER HOOK
// ---------------------------------------------------------------------------

export interface DockablePlacementController extends DockablePlacementState {
  setPosition: (position: DockPosition) => void;
  setDockState: (dockState: DockState) => void;
  setMode: (mode: DockMode) => void;
  setSize: (size: number) => void;
  setFloatRect: (rect: Partial<DockFloatRect>) => void;
  /** Atomic multi-field commit reading the LIVE store value (never a stale render snapshot). */
  set: (patch: Partial<DockablePlacementState>) => void;
  /** Docks it on a window edge, or on a seam between two panes as a thin bar; either way it unfolds and docks. */
  placeAt: (at: { position: DockPosition } | { seam: DockSeam }) => void;
  /** Folds it to its handle, at a point of its room (shares of its width and height) when given. */
  foldAt: (point?: DockPoint) => void;
  /** How many rows its thin bar shows; undefined fits the room. */
  setFit: (fit: DockFit | undefined) => void;
}

/** The fields a placement changes to dock on an edge or a seam, from its current mode: on a seam it is always the thin
 * bar; on an edge it unfolds to the form it had (its last open or thin form, never `folded`). */
export function placeAtPatch(mode: DockMode, at: { position: DockPosition } | { seam: DockSeam }): Pick<DockablePlacementState, 'mode' | 'dockState'> & { position?: DockPosition; seam?: DockSeam } {
  return 'seam' in at
    ? { seam: at.seam, mode: 'collapsed', dockState: 'docked' }
    : { position: at.position, seam: undefined, mode: mode === 'folded' ? 'collapsed' : mode, dockState: 'docked' };
}

/** The fields a placement changes to fold to its handle, at a point when given. */
export function foldAtPatch(point?: DockPoint): Pick<DockablePlacementState, 'mode' | 'foldedAt'> {
  return point ? { mode: 'folded', foldedAt: point } : { mode: 'folded' };
}

/**
 * Bind a per-instance store to the consumer's owner state + persistence.
 * `ownerState` is whatever the consumer's durable feed currently says
 * (pass the staged default for ephemeral consumers). `persist` is called with
 * every staged change — durable consumers write records, ephemeral consumers
 * may pass undefined.
 */
export function useDockablePlacement(
  store: DockablePlacementStore,
  ownerState: DockablePlacementState,
  persist?: (next: DockablePlacementState) => void,
): DockablePlacementController {
  const state = React.useSyncExternalStore(store.subscribe, store.get, store.get);

  React.useEffect(() => {
    store.reconcile(ownerState);
  }, [store, ownerState]);

  // Patches read the LIVE store value, so several setter calls inside one
  // event handler compose instead of overwriting each other with a stale
  // render snapshot.
  const commitPatch = React.useCallback((patch: Partial<DockablePlacementState>) => {
    const current = store.get();
    const next: DockablePlacementState = {
      ...current,
      ...patch,
      floatRect: patch.floatRect
        ? { ...current.floatRect, ...patch.floatRect }
        : current.floatRect,
    };
    store.stage(next);
    persist?.(next);
  }, [store, persist]);

  return React.useMemo<DockablePlacementController>(() => ({
    ...state,
    setPosition: (position) => commitPatch({ position }),
    setDockState: (dockState) => commitPatch({ dockState }),
    setMode: (mode) => commitPatch({ mode }),
    setSize: (size) => commitPatch({ size }),
    setFloatRect: (rect) => commitPatch({ floatRect: rect as DockFloatRect }),
    set: commitPatch,
    placeAt: (at) => commitPatch(placeAtPatch(store.get().mode, at)),
    foldAt: (point) => commitPatch(foldAtPatch(point)),
    setFit: (fit) => commitPatch({ fit }),
  }), [state, commitPatch, store]);
}
