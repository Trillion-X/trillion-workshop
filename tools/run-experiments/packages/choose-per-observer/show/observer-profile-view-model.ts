// packages/choose-per-observer/show/observer-profile-view-model.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Fold a visitor's append-only fact stream into the three panes of the profile:
//   - attributes  : the visitor's own DATA facts as label/value pairs (left)
//   - timeline    : the activity stream as a visual-database timeline model (center)
//   - rollups     : totals over outcome facts -> one rollup record (right)
//   - why         : the decision transcript translated to plain "why they saw
//                   this" rows (right)
//
// Attributes are EMERGENT from the facts — one, a few, or a thousand — the left
// rail renders whatever is there (the one-or-list law applied to UI). Nothing
// here enumerates attribute names; a fact's own path tail is its human label
// (humanized), its value is its value. Activity kind tone is DATA (the activity
// status descriptor). No fake data: an empty stream yields empty panes (L117).
//
// Pure: no React, no I/O. Node-testable.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { DecodeVisualDatabaseInput } from '@/packages/visual-database/read-data/visual-database';
import type { ObserverFact } from '@/packages/choose-per-observer/read-data/score-candidates';
import {
  PROFILE_ACTIVITY_STATUS_DESCRIPTOR,
  PROFILE_ROLLUP_DESCRIPTORS,
} from '@/packages/choose-per-observer/data/profile-descriptors';

/** One label/value attribute for the left rail (emergent from a fact). */
export interface ProfileAttribute {
  id: string;
  label: string;
  value: string;
}

/** A single "why they saw this" row, translated from the decision transcript. */
export interface WhyRow {
  id: string;
  /** Plain-language: which page/place a version was chosen for. */
  where: string;
  /** Plain-language: which version they got. */
  version: string;
  /** Plain-language: the rule reason, when one is available. */
  reason?: string;
}

/** The decision transcript, in the minimal shape this view needs. The read-data
 *  layer owns the full transcript; the profile only needs human-renderable
 *  fields, so this is a structural subset (extra fields are ignored). */
export interface TranscriptForProfile {
  address?: string;
  /** The chosen version's human label or id. */
  winner_label?: string;
  winner_id?: string;
  /** A plain reason string, when the decider produced one. */
  reason?: string;
}

export interface ObserverProfileViewModel {
  /** Display name (a `name` attribute fact, else the anonymous fallback). */
  displayName: string;
  attributes: readonly ProfileAttribute[];
  /** Visual Database timeline decode input for the activity stream. */
  timelineInput: DecodeVisualDatabaseInput;
  /** One record + the rollup descriptors for RecordMetricRow. */
  rollupInput: DecodeVisualDatabaseInput;
  why: readonly WhyRow[];
  /** True when the stream has at least one activity row. */
  hasActivity: boolean;
}

const SIGNAL_PATH_HEAD = 'signal';
const OUTCOME_PATH_HEAD = 'outcome';

function humanize(segment: string): string {
  return segment
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function pathTail(fact: ObserverFact): string {
  return fact.path[fact.path.length - 1] ?? 'detail';
}

/** Is this fact a stable attribute (a signal/trait) vs a timestamped activity? */
function isAttributeFact(fact: ObserverFact): boolean {
  return fact.path[0] === SIGNAL_PATH_HEAD;
}

/** The activity kind for a fact: the path head for non-signal facts (visit,
 *  click, purchase, outcome). Signals also appear in the timeline as "arrived
 *  with details". Open — an unknown kind renders as a neutral dot (DATA). */
function activityKind(fact: ObserverFact): string {
  const head = fact.path[0];
  if (head === SIGNAL_PATH_HEAD) return 'signal';
  if (head === OUTCOME_PATH_HEAD) {
    const tail = pathTail(fact);
    // An outcome named purchase/buy reads as a purchase; else generic activity.
    return /purchase|buy|paid|order/i.test(tail) ? 'purchase' : tail;
  }
  return head ?? 'visit';
}

function factTimestamp(fact: ObserverFact): string | null {
  // A fact may carry `at` in its value when it is an envelope-style record, or
  // the caller may pass facts already ordered. We read an `at`/`ts` field if the
  // value is an object; otherwise null (undated -> grouped last by timeline).
  const v = fact.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const at = (v as Record<string, unknown>).at ?? (v as Record<string, unknown>).ts;
    if (typeof at === 'string') return at;
    if (typeof at === 'number') return new Date(at).toISOString();
  }
  return null;
}

function factScalar(fact: ObserverFact): string {
  const v = fact.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = (v as Record<string, unknown>).value;
    if (inner !== undefined) return String(inner);
    return '';
  }
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Build the observer-profile view-model from the visitor's facts, the outcome
 * rollups (totals the read-data aggregation computed), and the decision
 * transcript(s).
 */
export function buildObserverProfileViewModel(input: {
  facts: readonly ObserverFact[];
  /** Rollup totals keyed by the rollup descriptors' value keys (visits, clicks,
   *  purchases, spend). Owner aggregation output. */
  rollups: Readonly<Record<string, number>>;
  /** The decision transcripts on record for this visitor (0..inf). */
  transcripts: readonly TranscriptForProfile[];
  anonymousName: string;
}): ObserverProfileViewModel {
  const { facts, rollups, transcripts, anonymousName } = input;

  // Attributes: emergent from signal facts. The path tail is the human label.
  const attributes: ProfileAttribute[] = [];
  let nameValue: string | null = null;
  for (const fact of facts) {
    if (!isAttributeFact(fact)) continue;
    const key = pathTail(fact);
    const value = factScalar(fact);
    if (!value) continue;
    if (key.toLowerCase() === 'name') nameValue = value;
    attributes.push({ id: fact.path.join('.'), label: humanize(key), value });
  }

  // Timeline: every fact becomes one activity record carrying a `kind` (DATA
  // tone), a human title, the scalar detail, and its day.
  const timelineRecords = facts.map((fact, index) => {
    const kind = activityKind(fact);
    const at = factTimestamp(fact);
    const detail = factScalar(fact);
    return {
      address: `activity::${index}::${fact.path.join('.')}`,
      payload: {
        kind,
        title: humanize(pathTail(fact)),
        detail,
        ...(at ? { at } : {}),
      },
    };
  });

  const timelineFields = [
    {
      id: 'title',
      label: 'Activity',
      role: 'title',
      paths: [['payload', 'title'], ['title']],
      editable: false,
    },
    {
      id: 'detail',
      label: 'Detail',
      role: 'body',
      paths: [['payload', 'detail'], ['detail']],
      editable: false,
    },
    {
      id: 'at',
      label: 'When',
      role: 'date',
      paths: [['payload', 'at'], ['at']],
      editable: false,
    },
    PROFILE_ACTIVITY_STATUS_DESCRIPTOR,
  ];

  const timelineView = {
    id: 'activity',
    label: 'Activity',
    kind: 'timeline',
    order: 0,
    lanes: [],
    filters: [],
    dateField: 'at',
    projectionRules: [],
  };

  // Rollups: a single record whose payload carries the totals.
  const rollupRecords = [{ address: `rollups::observer`, payload: { rollups } }];

  // Why: translate transcripts to plain rows.
  const why: WhyRow[] = transcripts.map((t, index) => ({
    id: t.address ? `why::${t.address}` : `why::${index}`,
    where: t.address ? humanizeAddress(t.address) : 'this page',
    version: (t.winner_label && t.winner_label.trim()) || t.winner_id || 'the standard page',
    ...(t.reason ? { reason: t.reason } : {}),
  }));

  return {
    displayName: nameValue ?? anonymousName,
    attributes,
    timelineInput: {
      records: timelineRecords,
      fields: timelineFields,
      views: [timelineView],
      actions: null,
    },
    rollupInput: {
      records: rollupRecords,
      fields: PROFILE_ROLLUP_DESCRIPTORS,
      views: null,
      actions: null,
    },
    why,
    hasActivity: timelineRecords.length > 0,
  };
}

/** Plain-language a resolver address ("page:/master-class" -> "the master-class
 *  page"). Purely cosmetic translation, no vocabulary leak. */
function humanizeAddress(address: string): string {
  const path = address.replace(/^[a-z-]+:/i, '');
  const slug = path.replace(/^\//, '').replace(/[/_]+/g, ' ').trim();
  return slug ? `the ${slug} page` : 'this page';
}
