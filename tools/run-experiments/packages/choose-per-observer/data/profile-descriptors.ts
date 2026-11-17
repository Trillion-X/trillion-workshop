// packages/choose-per-observer/data/profile-descriptors.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DATA that configures the observer-profile (customer-360) surface. The
// surface is a record-detail: left attributes, center activity timeline, right
// rollups + "why they saw this". Which attributes show, which rollups show, and
// how the timeline reads to a human are ALL data here — never in the .tsx.
//
//   - `PROFILE_ROLLUP_DESCRIPTORS`  : the right-rail rollup metric columns
//     (totals over the visitor's activity), same shape + formatter as the
//     scoreboard metrics.
//   - `PROFILE_ACTIVITY_STATUS_DESCRIPTOR` : DATA-driven tone for each activity
//     kind dot in the timeline (a viewed/clicked/purchased dot color is DATA).
//   - `PROFILE_COPY` : plain human copy (translation boundary).
//
// THE GENERIC TEST (must stay YES): a new rollup or a new activity kind appears
// by adding ONE row here; ZERO change to ObserverProfileSurface.tsx. The surface
// has no attribute list, no rollup array, and no `if kind === ...` for activity.
//
// Attributes themselves are NOT enumerated here: they are emergent from the
// visitor's own DATA facts (the fold of `trust:*`-tagged facts the view-model
// builds). The left rail renders whatever attributes the fact stream carries —
// one, a few, or a thousand — same code (the one-or-list law applied to UI).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { VisualDatabaseFieldDescriptor } from '../../../../keep-lists-of-rows/read-data/visual-database';

function rollup(
  id: string,
  label: string,
  valueKey: string,
  format: string,
): VisualDatabaseFieldDescriptor {
  return {
    id,
    label,
    role: 'metric',
    paths: [['payload', 'rollups', valueKey], ['rollups', valueKey]],
    domain: { details: [{ id: 'format', label: format, paths: [] }] },
    editable: false,
  };
}

/** Right-rail rollup totals over the visitor's recorded activity. Add a rollup
 *  → add a row; the surface renders it with zero change. */
export const PROFILE_ROLLUP_DESCRIPTORS: readonly VisualDatabaseFieldDescriptor[] = [
  rollup('visits', 'Visits', 'visits', 'integer'),
  rollup('clicks', 'Clicks', 'clicks', 'integer'),
  rollup('purchases', 'Purchases', 'purchases', 'integer'),
  rollup('spend', 'Total spent', 'spend', 'currency'),
];

// ---------------------------------------------------------------------------
// Activity-kind tone (DATA-driven dot color in the timeline)
//
// The timeline groups the append-only fact stream by day. Each activity row
// shows a status dot whose tone is the option tone for that activity kind. A
// new activity kind (a fact path the visitor accrues) renders as a quiet neutral
// dot with zero code; an owner can mint a tone option for it as DATA.
// ---------------------------------------------------------------------------

export const PROFILE_ACTIVITY_STATUS_FIELD_ID = 'kind';

export const PROFILE_ACTIVITY_STATUS_DESCRIPTOR: VisualDatabaseFieldDescriptor = {
  id: PROFILE_ACTIVITY_STATUS_FIELD_ID,
  label: 'Activity',
  role: 'status',
  paths: [['payload', 'kind'], ['kind']],
  editable: false,
  domain: {
    values: [
      { id: 'visit', label: 'Visited a page', tone: 'info', order: 1 },
      { id: 'click', label: 'Clicked', tone: 'info', order: 2 },
      { id: 'signal', label: 'Arrived with details', tone: 'neutral', order: 3 },
      { id: 'purchase', label: 'Made a purchase', tone: 'success', pulse: false, order: 4 },
    ],
    open: true,
  },
};

// ---------------------------------------------------------------------------
// Human copy (translation boundary — §6 of the contract)
// ---------------------------------------------------------------------------

export const PROFILE_COPY = {
  identityHeading: 'About',
  activityHeading: 'Activity',
  rollupHeading: 'Totals',
  whyHeading: 'Why they saw this',
  /** When the visitor has no recorded activity yet. */
  emptyTimeline: 'No activity yet.',
  /** When there is no decision on record (they saw the default page). */
  noDecision: 'They saw the standard page — no version was chosen for them yet.',
  /** Mobile tab labels. */
  tabAbout: 'About',
  tabActivity: 'Activity',
  tabTotals: 'Totals',
  /** Loading + error. */
  errorMessage: "Couldn't load this visitor.",
  /** Fallback display name when the visitor has no name attribute. */
  anonymousName: 'Visitor',
  currencySymbol: '$',
} as const;

export type ProfileCopy = typeof PROFILE_COPY;
