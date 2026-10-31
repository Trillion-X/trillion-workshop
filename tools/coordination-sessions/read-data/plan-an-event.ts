// tools/coordination-sessions/read-data/plan-an-event.ts
//
// An organizer's draft of one gathering becomes the records it needs: a session, a catalog entry that offers it, the
// capacity ledger to open for its places (the input of tools/reservations' open-a-capacity-ledger), and the address
// people will find it at. It plans only: nothing is kept, published or sent. The same draft always gives the same plan,
// so a retry changes nothing. Labels are the organizer's own words in any language; mode and visibility are open
// words the organizer chooses, not lists kept here.
import { createCoordinationSession, type CandidateOccurrence, type CoordinationSession } from '../do-work/session-lifecycle.ts';
import { publishSessionCatalogEntry, type SessionCatalogEntry } from './session-catalog.ts';

export interface EventDraft {
  /** A retained 128-bit hexadecimal identity the caller allocated. Short label hashes and render ids are not unique. */
  idempotency_key: string;
  /** The group that owns the event, chosen by the caller; never derived from a label. */
  host_group_ref: string;
  event_label: string;
  focus_label: string;
  public_summary: string;
  detail_intro: string;
  schedule_intent: string;
  primary_starts_at: string;
  primary_ends_at: string;
  alternate_starts_at?: string;
  alternate_ends_at?: string;
  time_zone: string;
  place_label?: string;
  /** Any word the organizer uses, like "online" or "in person". */
  mode: string;
  /** Any word the organizer uses, like "public" or "members". It names the visibility rule the person keeps. */
  visibility: string;
  capacity: number;
  host_origin: string;
  catalog_path?: string;
  /** The session's lifecycle state key ("draft" when left out). */
  lifecycle_state?: string;
  /** The person's workflow that runs for the session. */
  workflow_definition_ref: string;
}

export interface EventCapacityLedger {
  ledger_id: string;
  scope_ref: string;
  total: number;
  policy_ref: string;
}

export interface EventPlan {
  session: CoordinationSession;
  capacity_ledger: EventCapacityLedger;
  catalog_entry: SessionCatalogEntry;
  preview_path: string;
  live_path: string;
  share_url: string;
}

function requiredText(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
}

function slugPart(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function normalizedPath(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return fallback;
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*\/?$/.test(trimmed)) {
    throw new Error('catalog_path must be an absolute path without query or fragment');
  }
  return trimmed.replace(/\/+$/, '') || '/';
}

function normalizedOrigin(value: string): string {
  const suffix = requiredText(value, 'host_origin').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(suffix);
  } catch {
    throw new Error('host_origin must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
    throw new Error('host_origin must use https except for loopback');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('host_origin must not contain credentials, query, or fragment');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function occurrence(draft: EventDraft, routeKey: string, rank: 'primary' | 'alternate'): CandidateOccurrence | null {
  const startsAt = (rank === 'primary' ? draft.primary_starts_at : draft.alternate_starts_at)?.trim() ?? '';
  const endsAt = (rank === 'primary' ? draft.primary_ends_at : draft.alternate_ends_at)?.trim() ?? '';
  if (!startsAt && !endsAt) return null;
  if (!startsAt || !endsAt) {
    throw new Error(`${rank} occurrence requires both starts_at and ends_at`);
  }
  for (const value of [startsAt, endsAt]) {
    const parsed = new Date(`${value}:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
      || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value) {
      throw new Error(`${rank} occurrence requires valid local dates and times`);
    }
  }
  if (endsAt <= startsAt) throw new Error(`${rank} occurrence must end after it starts`);
  const timeZone = requiredText(draft.time_zone, 'time_zone');
  new Intl.DateTimeFormat('en', { timeZone });
  return {
    occurrence_id: `occurrence:${routeKey}:${rank}`,
    starts_at: startsAt,
    ends_at: endsAt,
    time_zone: timeZone,
    calendar_system: 'gregorian',
  };
}

export function planAnEvent(draft: EventDraft): EventPlan {
  const idempotencyKey = requiredText(draft.idempotency_key, 'idempotency_key');
  if (!/^[a-f0-9]{32}$/.test(idempotencyKey)) throw new Error('idempotency_key must be an owner-allocated 128-bit hex identity');
  const hostRef = requiredText(draft.host_group_ref, 'host_group_ref');
  const eventLabel = requiredText(draft.event_label, 'event_label');
  const focusLabel = requiredText(draft.focus_label, 'focus_label');
  const publicSummary = requiredText(draft.public_summary, 'public_summary');
  const detailIntro = requiredText(draft.detail_intro, 'detail_intro');
  const scheduleIntent = requiredText(draft.schedule_intent, 'schedule_intent');
  const mode = requiredText(draft.mode, 'mode');
  const visibility = requiredText(draft.visibility, 'visibility');
  const workflowRef = requiredText(draft.workflow_definition_ref, 'workflow_definition_ref');
  const placeLabel = (draft.place_label ?? '').trim();
  const capacity = Number(draft.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
    throw new Error('capacity must be an integer from 1 through 1,000,000');
  }

  const routeKey = idempotencyKey;
  const sessionRef = `session:${routeKey}`;
  const catalogEntryId = `catalog-entry:${routeKey}`;
  const focusSlug = slugPart(focusLabel, 'focus');
  const catalogPath = normalizedPath(draft.catalog_path, '/events');
  const livePath = `${catalogPath}/${encodeURIComponent(routeKey)}`;
  const origin = normalizedOrigin(draft.host_origin);
  const visibilityRef = `visibility:${slugPart(visibility, 'visibility')}`;

  const occurrences = [occurrence(draft, routeKey, 'primary'), occurrence(draft, routeKey, 'alternate')]
    .filter((value): value is CandidateOccurrence => value !== null);
  if (!occurrences.some((value) => value.occurrence_id.endsWith(':primary'))) {
    throw new Error('primary occurrence requires both starts_at and ends_at');
  }

  const capacityPolicyRef = `capacity-policy:${routeKey}`;
  const ledgerId = `ledger:${routeKey}`;
  const session = createCoordinationSession({
    session_id: sessionRef,
    purpose_contract: {
      key: `focus:${focusSlug}`,
      descriptor_ref: `focus:${focusSlug}`,
      data: {
        label: eventLabel,
        schedule_intent: scheduleIntent,
        schedule_status: 'candidate',
        public_summary: publicSummary,
        detail_intro: detailIntro,
      },
    },
    candidate_occurrences: occurrences,
    candidate_places: placeLabel ? [{ choice_descriptor: { key: 'organizer-described-place', descriptor_ref: 'place:organizer-described', data: { label: placeLabel } } }] : [],
    candidate_modes: [{ key: `mode:${slugPart(mode, 'mode')}`, descriptor_ref: `mode:${slugPart(mode, 'mode')}`, data: { label: mode } }],
    capacity_plan: { capacity_policy_ref: capacityPolicyRef, seat_ledger_ref: ledgerId },
    participation_policy: { visibility_predicate_ref: visibilityRef, eligibility_predicate_ref: `eligible:${visibilityRef}` },
    lifecycle_state: { key: slugPart(draft.lifecycle_state ?? 'draft', 'draft'), descriptor_ref: `lifecycle:${slugPart(draft.lifecycle_state ?? 'draft', 'draft')}` },
    workflow_definition_ref: workflowRef,
    participant_provenance: [],
    preference_provenance: [],
  });

  const catalog_entry = publishSessionCatalogEntry({
    catalog_entry_id: catalogEntryId,
    owning_group_refs: [hostRef],
    session_refs: [sessionRef],
    catalog_visibility_predicate: { policy_ref: visibilityRef },
    recommendation_policy_ref: `recommend:${routeKey}`,
    cross_offer_policy: [],
    presentation_surface_refs: [],
  });

  return {
    session,
    capacity_ledger: { ledger_id: ledgerId, scope_ref: sessionRef, total: capacity, policy_ref: capacityPolicyRef },
    catalog_entry,
    preview_path: `${catalogPath}?preview=${encodeURIComponent(routeKey)}`,
    live_path: livePath,
    share_url: `${origin}${livePath}`,
  };
}
