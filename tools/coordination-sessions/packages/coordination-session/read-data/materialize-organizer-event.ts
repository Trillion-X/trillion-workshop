import {
  createCoordinationSession,
  type CandidateOccurrence,
  type CoordinationSession,
} from '../do-work/session-lifecycle-operations';
import {
  publishSessionCatalogEntry,
  type SessionCatalogEntry,
} from './read-session-catalog';

/** Capacity settings carried by this event projection as data. */
export interface OrganizerEventCapacityPolicy {
  policy_ref: string;
  total: number;
  reserved_by_class: Record<string, number>;
  oversubscription_policy: Record<string, unknown>;
  release_policy: Record<string, unknown>;
}

export type OrganizerEventMode = 'online' | 'in-person' | 'hybrid';
export type OrganizerEventVisibility = 'public' | 'unlisted' | 'invite-only' | 'member-only';

export interface OrganizerEventDraft {
  idempotency_key: string;
  /** Existing group identity selected by the containing owner; not derived from its label. */
  host_group_ref: string;
  host_label: string;
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
  place_label: string;
  mode: OrganizerEventMode;
  visibility: OrganizerEventVisibility;
  capacity: number;
  host_origin: string;
  catalog_path?: string;
}

export interface OrganizerEventPublicationPlan {
  kind: 'coordination-session.organizer-publication-plan';
  owner_ref: 'package::public-site-publisher::request-configured-action';
  preview_path: string;
  live_path: string;
  share_url: string;
  route_policy_ref: 'policy::public-events::owning-host-opaque-detail-route';
  effect_state: 'preview-only';
}

export interface OrganizerEventAccessPolicy {
  kind: 'coordination-session.organizer-access-policy';
  owner_ref: 'package::access-rule::subject-action-resource-evaluation';
  resource_ref: string;
  organizer_action_ref: 'action::coordination-session::manage-event';
  visitor_action_ref: 'action::coordination-session::view-event';
  visibility_predicate_ref: string;
}

export interface OrganizerEventIntakePlan {
  kind: 'coordination-session.organizer-intake-plan';
  owner_ref: 'request-intake.structured-selection';
  catalog_entry_id: string;
  session_refs: string[];
  ranked_preference_dimensions: ['time', 'place', 'mode'];
  submission_recovery: 'draft-token-required';
}

export interface OrganizerEventProjection {
  kind: 'coordination-session.organizer-visual-projection';
  owner_ref: 'package::visual-database::projection';
  source_record_refs: string[];
  row_identity: 'one-row-per-session-submission-relation';
}

export interface OrganizerEventBranding {
  kind: 'coordination-session.organizer-branding';
  brand_name: string;
  catalog_overline: string;
  catalog_title: string;
  catalog_description: string;
}

export interface MaterializedOrganizerEvent {
  session: CoordinationSession;
  capacity_policy: OrganizerEventCapacityPolicy;
  catalog_entry: SessionCatalogEntry;
  branding: OrganizerEventBranding;
  access_policy: OrganizerEventAccessPolicy;
  intake_plan: OrganizerEventIntakePlan;
  publication: OrganizerEventPublicationPlan;
  visual_projection: OrganizerEventProjection;
}

const MODE_DESCRIPTORS: Record<OrganizerEventMode, { key: string; descriptor_ref: string }> = {
  online: {
    key: 'mode:online',
    descriptor_ref: 'descriptor::coordination-session::mode:online',
  },
  'in-person': {
    key: 'mode:in-person',
    descriptor_ref: 'descriptor::coordination-session::mode:in-person',
  },
  hybrid: {
    key: 'mode:hybrid',
    descriptor_ref: 'descriptor::coordination-session::mode:hybrid',
  },
};

const VISIBILITY_PREDICATES: Record<OrganizerEventVisibility, string> = {
  public: 'predicate::coordination-session::visibility:public',
  unlisted: 'predicate::coordination-session::visibility:unlisted',
  'invite-only': 'predicate::coordination-session::visibility:invite-only',
  'member-only': 'predicate::coordination-session::visibility:member-only',
};

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
    throw new Error('host_origin must use https except for loopback proof');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('host_origin must not contain credentials, query, or fragment');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function occurrence(
  draft: OrganizerEventDraft,
  routeKey: string,
  rank: 'primary' | 'alternate',
): CandidateOccurrence | null {
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
    availability_owner_ref: 'package::availability::placeable-ranked-choices',
  };
}

export function materializeOrganizerEvent(draft: OrganizerEventDraft): MaterializedOrganizerEvent {
  const idempotencyKey = requiredText(draft.idempotency_key, 'idempotency_key');
  if (!/^[a-f0-9]{32}$/.test(idempotencyKey)) throw new Error('idempotency_key must be an owner-allocated 128-bit hex identity');
  const hostRef = requiredText(draft.host_group_ref, 'host_group_ref');
  const hostLabel = requiredText(draft.host_label, 'host_label');
  const eventLabel = requiredText(draft.event_label, 'event_label');
  const focusLabel = requiredText(draft.focus_label, 'focus_label');
  const publicSummary = requiredText(draft.public_summary, 'public_summary');
  const detailIntro = requiredText(draft.detail_intro, 'detail_intro');
  const scheduleIntent = requiredText(draft.schedule_intent, 'schedule_intent');
  const placeLabel = draft.place_label.trim();
  const capacity = Number(draft.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
    throw new Error('capacity must be an integer from 1 through 1,000,000');
  }

  const routeKey = idempotencyKey;
  const sessionRef = `session:${routeKey}`;
  const recordRef = `coordination-session.session.${routeKey}`;
  const catalogEntryId = `catalog-entry:${routeKey}`;
  const focusSlug = slugPart(focusLabel, 'focus');
  const detailPathPrefix = normalizedPath(draft.catalog_path, '/events');
  const catalogPath = detailPathPrefix;
  const livePath = `${detailPathPrefix}/${encodeURIComponent(routeKey)}`;
  const origin = normalizedOrigin(draft.host_origin);
  const mode = Object.hasOwn(MODE_DESCRIPTORS, draft.mode) ? MODE_DESCRIPTORS[draft.mode] : null;
  if (!mode) throw new Error('mode must be online, in-person, or hybrid');
  const visibilityPredicateRef = Object.hasOwn(VISIBILITY_PREDICATES, draft.visibility) ? VISIBILITY_PREDICATES[draft.visibility] : null;
  if (!visibilityPredicateRef) {
    throw new Error('visibility must be public, unlisted, invite-only, or member-only');
  }

  const occurrences = [
    occurrence(draft, routeKey, 'primary'),
    occurrence(draft, routeKey, 'alternate'),
  ].filter((value): value is CandidateOccurrence => value !== null);
  if (!occurrences.some(value => value.occurrence_id.endsWith(':primary'))) {
    throw new Error('primary occurrence requires both starts_at and ends_at');
  }

  const session = createCoordinationSession({
    schema: 'bitfield.coordination-session/material-session',
    record_kind: 'coordination-session',
    record_ref: recordRef,
    label: eventLabel,
    source_config_ref: `coordination-session.organizer-creation#${idempotencyKey}`,
    session_id: sessionRef,
    purpose_contract: {
      key: `focus:${focusSlug}`,
      descriptor_ref: `data::coordination-session::focus:${focusSlug}`,
      data: {
        primitive_ref: 'primitive:organizer-authored-gathering',
        schedule_intent: scheduleIntent,
        schedule_status: 'candidate-details-unconfirmed',
        signup_label: `${eventLabel} signup`,
        public_summary: publicSummary,
        detail_intro: detailIntro,
        primary_action_label: 'Sign up',
      },
    },
    candidate_occurrences: occurrences,
    candidate_places: placeLabel ? [{ choice_descriptor: {
      key: 'organizer-described-place', descriptor_ref: 'descriptor::place-choice::organizer-described',
      data: { label: placeLabel },
    } }] : [],
    candidate_modes: [mode],
    capacity_plan: {
      capacity_policy_ref: `policy::coordination-session::capacity:${routeKey}`,
      seat_ledger_ref: `seat-ledger:${routeKey}`,
    },
    participation_policy: {
      visibility_predicate_ref: visibilityPredicateRef,
      eligibility_predicate_ref: 'predicate::coordination-session::signup-eligible',
      guest_policy_ref: 'policy::guest:configured-by-data',
      host_policy_ref: 'policy::host:configured-by-data',
      cancellation_policy_ref: 'policy::cancellation:configured-by-data',
    },
    lifecycle_state: {
      key: 'interest-open-details-unconfirmed',
      descriptor_ref: 'descriptor::coordination-session::lifecycle:interest-open-details-unconfirmed',
    },
    workflow_definition_ref: 'coordination-session.generic-event-platform',
    participant_provenance: [],
    preference_provenance: [],
  }) as CoordinationSession;

  const catalog_entry = publishSessionCatalogEntry({
    schema: 'bitfield.coordination-session/material-session-catalog-entry',
    record_kind: 'session-catalog-entry',
    catalog_entry_id: catalogEntryId,
    owning_group_refs: [hostRef],
    session_refs: [sessionRef],
    catalog_visibility_predicate: { policy_ref: visibilityPredicateRef },
    recommendation_policy_ref: 'policy::coordination-session::recommend-by-organizer-data',
    cross_offer_policy: [],
    presentation_surface_refs: [
      'coordination-session.catalog',
      'coordination-session.session-detail',
    ],
    visual_projection_ref: 'package::visual-database::projection',
  });

  return {
    session,
    capacity_policy: {
      policy_ref: session.capacity_plan.capacity_policy_ref,
      total: capacity,
      reserved_by_class: {},
      oversubscription_policy: {},
      release_policy: {},
    },
    catalog_entry,
    branding: {
      kind: 'coordination-session.organizer-branding',
      brand_name: hostLabel,
      catalog_overline: `${hostLabel} events`,
      catalog_title: 'Events',
      catalog_description: `Choose a ${focusLabel.toLowerCase()} gathering prepared by ${hostLabel}.`,
    },
    access_policy: {
      kind: 'coordination-session.organizer-access-policy',
      owner_ref: 'package::access-rule::subject-action-resource-evaluation',
      resource_ref: catalogEntryId,
      organizer_action_ref: 'action::coordination-session::manage-event',
      visitor_action_ref: 'action::coordination-session::view-event',
      visibility_predicate_ref: visibilityPredicateRef,
    },
    intake_plan: {
      kind: 'coordination-session.organizer-intake-plan',
      owner_ref: 'request-intake.structured-selection',
      catalog_entry_id: catalogEntryId,
      session_refs: [sessionRef],
      ranked_preference_dimensions: ['time', 'place', 'mode'],
      submission_recovery: 'draft-token-required',
    },
    publication: {
      kind: 'coordination-session.organizer-publication-plan',
      owner_ref: 'package::public-site-publisher::request-configured-action',
      preview_path: `${catalogPath}?preview=${encodeURIComponent(routeKey)}`,
      live_path: livePath,
      share_url: `${origin}${livePath}`,
      route_policy_ref: 'policy::public-events::owning-host-opaque-detail-route',
      effect_state: 'preview-only',
    },
    visual_projection: {
      kind: 'coordination-session.organizer-visual-projection',
      owner_ref: 'package::visual-database::projection',
      source_record_refs: [recordRef, catalogEntryId],
      row_identity: 'one-row-per-session-submission-relation',
    },
  };
}
