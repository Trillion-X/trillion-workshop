// packages/media-composition/show/media-lanes-optimistic-store.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Optimistic EMPTY-TRACK store for the media editor, the lane sibling of
// media-workspace-optimistic-store (which does the same for sources).
//
// "Add tracks" authors `add-track` edit-decision records, but UI authoring goes
// through the write-media-composition-record workflow, which currently lands
// records on the published-record fold rather than the projection path that
// composeTimeline reads. So a freshly authored empty lane would not appear until
// that write path is corrected. This module holds pending empty lanes and merges
// them into the materialised composition so a created track shows up INSTANTLY,
// exactly like an optimistically added source. When a real record for the same
// lane role later materialises, the optimistic copy is dropped (dedupe by role).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Merge is by lane ROLE: a real lane always wins over an optimistic one.
//   2. Optimistic lanes are ALWAYS empty (zero clips, zero duration): they are a
//      placeholder to drop clips onto, never fabricated content.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import type {
  MaterializedComposition,
  MaterializedLane,
} from '../read-data/compose-timeline';

export type PendingLane = {
  role: string;
  label: string;
  tone: string;
};

const pendingLanes = new Map<string, PendingLane>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return version;
}

/** Optimistically register empty lanes so they render before the log round-trip. */
export function addOptimisticLanes(lanes: readonly PendingLane[]) {
  for (const lane of lanes) pendingLanes.set(lane.role, lane);
  emit();
}

/** Test/reset hook. */
export function resetOptimisticLanesForTests() {
  pendingLanes.clear();
  emit();
}

/**
 * Merge any pending empty lanes into a materialised composition. A real lane of
 * the same role always wins, so once an add-track (or an add-source that fills
 * the role) materialises, the optimistic placeholder disappears with no dupes.
 */
export function useOptimisticComposition(composition: MaterializedComposition): MaterializedComposition {
  React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return React.useMemo(() => {
    if (pendingLanes.size === 0) return composition;
    const haveRoles = new Set(composition.lanes.map((lane) => lane.role));
    const extra: MaterializedLane[] = [];
    for (const [role, lane] of pendingLanes) {
      if (haveRoles.has(role)) continue;
      extra.push({ laneId: role, role, label: lane.label, tone: lane.tone, clips: [], duration: 0 });
    }
    if (extra.length === 0) return composition;
    return { ...composition, lanes: [...composition.lanes, ...extra] };
    // version participates so a new optimistic lane re-materialises this memo.
  }, [composition, version]);
}
