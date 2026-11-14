// packages/calendar-booker/do-work/scheduling-offer-feed.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The SOLE owner-translation boundary (L098) for the calendar-booker package.
// Every screen (owner availability setup, booking-link setup, public guest
// page, guest result/preview, owner follow-up list) is produced HERE as an
// already-translated `ViewDescriptor[]` tree. Downstream, the blind
// `DescriptorSurface` renderer prints labels VERBATIM and never humanizes.
//
// This module is the ONE place where:
//   • internal booking state keys  -> human status text + owner tone vocabulary
//     (read from the `display_label_descriptor` SSOT — never invented here)
//   • internal owner-action refs    -> human button labels (NEVER the internal
//     `proof_label`, which is CPD/engine-internal prose and is BANNED from UI)
//   • internal field keys           -> human field labels (curated allow-list;
//     plumbing keys are hidden, not humanized into internal-looking copy)
//   • projection identity           -> human section label + helper text
//
// SSOT DISCIPLINE: the *structure* of a surface (which sources, which actions)
// comes from the projection-descriptor DATA passed in; this feed only owns the
// *translation* of that structure into human words. It never re-decides which
// actions a surface has — that stays in the package's projection records.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No `proof_label` value EVER reaches an emitted label/help/status field.
//    The owner vocabularies below are the only human words the UI shows.
// 2. Status text + tone come from the `display_label_descriptor` SSOT via
//    `indexDisplayLabels` — this feed never hardcodes the 7 booking labels.
// 3. Emitted descriptors carry ONLY generic `render_kind` shape keys (the
//    package's screen vocabulary), never raw internal record/field/action refs
//    as visible copy. `flattenViewLabels` + the U1 ban test prove this.
// 4. `tone_ref` stays the OPEN owner tone vocabulary (`attention`/`positive`/
//    `danger`/`neutral`); the leaf capability pack maps it to a ui tone. This
//    feed never names a ui tone or a color.
//
// =============================================================================

import type {
  AnyRecord,
  CalendarBookerWorkGraph,
} from '../read-data/read-calendar-booker-work-graph';
import type {
  ActionDescriptor,
  StatusDescriptor,
  ViewDescriptor,
  ViewOption,
} from '../show/view-descriptor';

// ---------------------------------------------------------------------------
// RENDER-KIND SHAPE KEYS (the package's own screen vocabulary — data the feed
// emits; the blind renderer binds them, this feed selects them)
// ---------------------------------------------------------------------------

const KIND = {
  group: 'group',
  statusRow: 'status.row',
  statusCard: 'status.card',
  fieldText: 'field.text',
  fieldNumber: 'field.number',
  fieldDateTime: 'field.datetime',
  fieldStructured: 'field.structured',
  fieldList: 'field.list',
  chips: 'chips.single-select',
  actionBar: 'action.bar',
  preview: 'preview.embed',
  table: 'table',
} as const;

// ---------------------------------------------------------------------------
// OWNER VOCABULARY — section labels (keyed by projection identity)
// ---------------------------------------------------------------------------

interface SectionLabel {
  label: string;
  help?: string;
  emptyHelp?: string;
}

const SECTION_LABELS: Readonly<Record<string, SectionLabel>> = {
  'calendar-booker.availability-setup': {
    label: 'Availability',
    help: 'When people can book time with you.',
  },
  'calendar-booker.booking-links.setup': {
    label: 'Booking link setup',
    help: 'Set up the page people use to book time with you.',
  },
  'calendar-booker.booking-links.public-entry': {
    label: 'Pick a time',
    help: 'Choose a time that works for you.',
  },
  'calendar-booker.booking-links.result': {
    label: 'Your booking',
  },
  'calendar-booker.booking-links.owner-follow-up': {
    label: 'Bookings',
    help: 'Requests waiting on you and confirmed bookings.',
  },
};

const FALLBACK_SECTION: SectionLabel = { label: 'Booking' };

type AvailabilitySetupCopyKey =
  | 'section_label'
  | 'section_help'
  | 'empty_help'
  | 'publish_action_label'
  | 'saved_badge'
  | 'saved_button_label'
  | 'day_label'
  | 'days_aria_label'
  | 'all_days_label'
  | 'from_label'
  | 'to_label'
  | 'duration_label'
  | 'save_error'
  | 'template_name';

export type AvailabilitySetupPresentationProfile = {
  kind?: string;
  profile_id?: string;
  audience?: string;
  surface?: string;
  surface_id?: string;
  intent?: string;
  copy_map?: Partial<Record<AvailabilitySetupCopyKey, string>>;
};

export type AvailabilitySetupPresentation = Required<Record<AvailabilitySetupCopyKey, string>> & {
  audience: string;
  intent: string;
};

const OPERATOR_AVAILABILITY_SETUP_PRESENTATION: AvailabilitySetupPresentation = {
  audience: 'operator',
  intent: 'Publish recurring time windows other people can request.',
  section_label: 'Availability',
  section_help: 'When people can book time with you.',
  empty_help: 'Nothing here yet.',
  publish_action_label: 'Publish availability',
  saved_badge: "You're bookable",
  saved_button_label: 'Availability saved',
  day_label: 'Days',
  days_aria_label: 'Days you are available',
  all_days_label: 'Every day',
  from_label: 'From',
  to_label: 'To',
  duration_label: 'Session length',
  save_error: "That didn't save. Try again.",
  template_name: 'My availability',
};

const MEMBER_AVAILABILITY_SETUP_PRESENTATION: AvailabilitySetupPresentation = {
  audience: 'member',
  intent: 'Member declares recurring court windows the AI coach can use to plan practice.',
  section_label: 'When can you practice?',
  section_help: "Set the days and times you're on court. Your AI coach uses these windows to plan your practice sessions.",
  empty_help: 'No practice windows yet. Save the times you can usually get on court.',
  publish_action_label: 'Save my practice windows',
  saved_badge: 'Practice windows saved',
  saved_button_label: 'Practice windows saved',
  day_label: 'Days on court',
  days_aria_label: 'Days you can practice',
  all_days_label: 'Every day',
  from_label: 'From',
  to_label: 'To',
  duration_label: 'Practice length',
  save_error: "That didn't save. Try again.",
  template_name: 'My practice windows',
};

export function resolveAvailabilitySetupPresentationProfile(
  profile?: AvailabilitySetupPresentationProfile | null,
  audience?: string,
): AvailabilitySetupPresentation {
  const selectedAudience = asText(profile?.audience ?? audience, 'operator');
  const base = selectedAudience === 'member'
    ? MEMBER_AVAILABILITY_SETUP_PRESENTATION
    : OPERATOR_AVAILABILITY_SETUP_PRESENTATION;
  const copyMap = profile?.copy_map ?? {};
  return {
    ...base,
    audience: selectedAudience,
    intent: asText(profile?.intent, base.intent),
    section_label: asText(copyMap.section_label, base.section_label),
    section_help: asText(copyMap.section_help, base.section_help),
    empty_help: asText(copyMap.empty_help, base.empty_help),
    publish_action_label: asText(copyMap.publish_action_label, base.publish_action_label),
    saved_badge: asText(copyMap.saved_badge, base.saved_badge),
    saved_button_label: asText(copyMap.saved_button_label, base.saved_button_label),
    day_label: asText(copyMap.day_label, base.day_label),
    days_aria_label: asText(copyMap.days_aria_label, base.days_aria_label),
    all_days_label: asText(copyMap.all_days_label, base.all_days_label),
    from_label: asText(copyMap.from_label, base.from_label),
    to_label: asText(copyMap.to_label, base.to_label),
    duration_label: asText(copyMap.duration_label, base.duration_label),
    save_error: asText(copyMap.save_error, base.save_error),
    template_name: asText(copyMap.template_name, base.template_name),
  };
}

// ---------------------------------------------------------------------------
// OWNER VOCABULARY — action button labels (keyed by normalized action name).
// NOTE: these are the ONLY human words shown on action controls. The internal
// `proof_label` on the owner-action descriptor is engine prose and is BANNED.
// ---------------------------------------------------------------------------

const ACTION_LABELS: Readonly<Record<string, string>> = {
  'generate-availability-slots': 'Publish availability',
  'publish-availability-policy': 'Publish availability',
  'find-availability': 'Find available times',
  'request-booking': 'Request booking',
  'confirm-booking': 'Confirm',
  'cancel-booking': 'Cancel',
  'list-bookings': 'View bookings',
  'list-calendar-events': 'View calendar',
};

// ---------------------------------------------------------------------------
// OWNER VOCABULARY — field labels (curated human allow-list). A field key NOT
// in this map is plumbing and is hidden from product UI (never humanized into
// internal-looking copy — L118). The map is the owner's field Society.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  title: 'Title',
  slug: 'Link',
  description: 'Description',
  timezone: 'Time zone',
  requester_timezone: 'Their time zone',
  duration_minutes: 'Duration',
  start_time: 'Start',
  end_time: 'End',
  scheduled_start: 'Start',
  scheduled_end: 'End',
  status: 'Status',
  meeting_url: 'Meeting link',
  reason: 'Reason',
  cancellation_reason: 'Reason',
  booking_window_days: 'How far ahead people can book',
  min_notice_hours: 'Minimum notice',
  confirmation_required: 'Needs your confirmation',
  is_active: 'Active',
  created_at: 'Created',
};

// ---------------------------------------------------------------------------
// OWNER VOCABULARY — selection sources. A projection whose PRIMARY source schema
// is one of these renders its real records as single-select chips (a "pick one"
// surface) instead of a field group / table. Keyed by the schema source ref the
// projection itself declares — data-driven: a new selectable surface adds ONE
// row here, ZERO renderer change (L090 / Generic-Data-Driven Gate). The guest
// page sources `availability-slot`; the chips are real open times, honest-empty
// when none (L117). `dateFacet`/`timeFacet` are the owner words for the two
// pick steps; `valueKey` is the record field carrying the instant to select on.
// ---------------------------------------------------------------------------

interface SelectionSourceVocab {
  valueKey: string;
  dateFacet: string;
  timeFacet: string;
  emptyHelp: string;
}

const SELECTION_SOURCES: Readonly<Record<string, SelectionSourceVocab>> = {
  'package::calendar-booker::schema::availability-slot': {
    valueKey: 'start_time',
    dateFacet: 'Day',
    timeFacet: 'Time',
    emptyHelp: 'No open times right now. Check back soon.',
  },
};

// Field keys whose value is a date/time and should render with the datetime
// primitive instead of plain text.
const DATETIME_FIELD_KEYS: ReadonlySet<string> = new Set([
  'start_time',
  'end_time',
  'scheduled_start',
  'scheduled_end',
  'created_at',
  'cancelled_at',
  'actual_start',
  'actual_end',
]);

// Stable display order for curated fields (keys earlier appear first).
const FIELD_ORDER: readonly string[] = [
  'name',
  'title',
  'slug',
  'description',
  'status',
  'start_time',
  'end_time',
  'scheduled_start',
  'scheduled_end',
  'duration_minutes',
  'timezone',
  'requester_timezone',
  'meeting_url',
  'booking_window_days',
  'min_notice_hours',
  'confirmation_required',
  'is_active',
  'reason',
  'cancellation_reason',
  'created_at',
];

// ---------------------------------------------------------------------------
// DISPLAY-LABEL SSOT (status text + owner tone) — read from the graph, never
// hardcoded. `applies_to_ref` (state key) -> { label, tone_ref, order }.
// ---------------------------------------------------------------------------

export interface DisplayLabelEntry {
  label: string;
  tone_ref: string;
  order: number;
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Index the 7 `display_label_descriptor` records by their state key. */
export function indexDisplayLabels(graph: CalendarBookerWorkGraph): Map<string, DisplayLabelEntry> {
  const index = new Map<string, DisplayLabelEntry>();
  for (const descriptor of graph.displayLabelDescriptors) {
    const raw = descriptor.raw;
    const key = asText(raw.applies_to_ref);
    if (!key) continue;
    index.set(key, {
      label: asText(raw.label_text, key),
      tone_ref: asText(raw.tone_ref, 'neutral'),
      order: asNumber(raw.order),
    });
  }
  return index;
}

/**
 * Translate an internal booking/readiness state key into an owner-translated
 * `StatusDescriptor`. Text + tone come from the SSOT; an unknown key gets a
 * neutral tone and a non-leaking generic label (rare — all known states are in
 * the SSOT).
 */
export function bookingStatusDescriptor(
  stateKey: string,
  index: Map<string, DisplayLabelEntry>,
  reason?: string,
): StatusDescriptor {
  const entry = index.get(stateKey);
  if (entry) {
    return { tone_ref: entry.tone_ref, label: entry.label, reason };
  }
  return { tone_ref: 'neutral', label: 'status pending', reason };
}

// ---------------------------------------------------------------------------
// ACTION TRANSLATION
// ---------------------------------------------------------------------------

/** Reduce any ref form (`package::…::owner-action::x`, `action:pkg.x`, `descriptor:…:owner-action:x`) to its trailing name `x`. */
function normalizeActionName(ref: string): string {
  const flattened = ref.replace(/::/g, ':');
  const lastColon = flattened.split(':').pop() ?? flattened;
  return lastColon.split('.').pop() ?? lastColon;
}

function actionLabel(ref: string, presentation?: AvailabilitySetupPresentation): string {
  const normalized = normalizeActionName(ref);
  if (
    presentation
    && (normalized === 'generate-availability-slots' || normalized === 'publish-availability-policy')
  ) {
    return presentation.publish_action_label;
  }
  return ACTION_LABELS[normalized] ?? 'Continue';
}

/** Translate projection action refs into human `ActionDescriptor`s (stable order preserved). */
export function translateActions(
  actionRefs: readonly string[],
  disabledReasonByRef?: Readonly<Record<string, string>>,
  presentation?: AvailabilitySetupPresentation,
): ActionDescriptor[] {
  return actionRefs.map((action_ref) => {
    const disabled = disabledReasonByRef?.[action_ref];
    return disabled
      ? { action_ref, label: actionLabel(action_ref, presentation), disabled_reason: disabled }
      : { action_ref, label: actionLabel(action_ref, presentation) };
  });
}

// ---------------------------------------------------------------------------
// FIELD TRANSLATION (record -> human field descriptors / table rows)
// ---------------------------------------------------------------------------

interface HumanField {
  key: string;
  label: string;
  value: unknown;
  datetime: boolean;
}

function recordId(record: AnyRecord, index: number): string {
  return asText(record.id ?? record.booking_id ?? record.slot_id, `row-${index}`);
}

/** Curated, ordered human fields present on a record. Plumbing keys are dropped. */
function humanFields(record: AnyRecord): HumanField[] {
  const present = Object.keys(record).filter((key) => key in FIELD_LABELS);
  present.sort((left, right) => {
    const li = FIELD_ORDER.indexOf(left);
    const ri = FIELD_ORDER.indexOf(right);
    return (li === -1 ? Number.MAX_SAFE_INTEGER : li) - (ri === -1 ? Number.MAX_SAFE_INTEGER : ri);
  });
  return present.map((key) => ({
    key,
    label: FIELD_LABELS[key],
    value: record[key],
    datetime: DATETIME_FIELD_KEYS.has(key),
  }));
}

function fieldDescriptor(recordIdValue: string, field: HumanField, editable: boolean): ViewDescriptor {
  const render_kind = field.datetime
    ? KIND.fieldDateTime
    : typeof field.value === 'number'
    ? KIND.fieldNumber
    : typeof field.value === 'object' && field.value !== null
    ? KIND.fieldStructured
    : KIND.fieldText;
  return {
    id: `${recordIdValue}:${field.key}`,
    render_kind,
    label: field.label,
    value: field.value,
    editable,
  };
}

// ---------------------------------------------------------------------------
// SURFACE ASSEMBLY
// ---------------------------------------------------------------------------

export interface SurfaceStatusInput {
  stateKey: string;
  reason?: string;
  emphasis?: 'row' | 'card';
}

export interface SchedulingOfferInput {
  /** A hyphen `projection-descriptor` record: supplies `projection_id` + `actions`. */
  projection: AnyRecord;
  /** Work graph (display-label SSOT + counts). */
  graph: CalendarBookerWorkGraph;
  /** Live source records to display for this surface (already scoped by caller). */
  records?: AnyRecord[];
  /** Optional status to surface (booking/readiness state key). */
  status?: SurfaceStatusInput;
  /** True for owner-editable surfaces; false for read-only guest views. */
  editable?: boolean;
  /** Per-action disabled reasons (already human). */
  disabledReasonByRef?: Readonly<Record<string, string>>;
  /** Audience-selected copy profile for availability setup, supplied as DATA by the composing app. */
  availabilitySetupPresentationProfile?: AvailabilitySetupPresentationProfile | null;
  /** Shortcut selector when no full profile record is supplied. */
  audience?: string;
}

function sectionLabel(
  projectionId: string,
  presentation?: AvailabilitySetupPresentation,
): SectionLabel {
  if (projectionId === 'calendar-booker.availability-setup' && presentation) {
    return {
      label: presentation.section_label,
      help: presentation.section_help,
      emptyHelp: presentation.empty_help,
    };
  }
  return SECTION_LABELS[projectionId] ?? FALLBACK_SECTION;
}

function projectionActions(projection: AnyRecord): string[] {
  const actions = projection.actions;
  return Array.isArray(actions) ? actions.filter((ref): ref is string => typeof ref === 'string') : [];
}

function statusDescriptorNode(
  projectionId: string,
  status: SurfaceStatusInput,
  index: Map<string, DisplayLabelEntry>,
): ViewDescriptor {
  return {
    id: `${projectionId}:status`,
    render_kind: status.emphasis === 'card' ? KIND.statusCard : KIND.statusRow,
    status: bookingStatusDescriptor(status.stateKey, index, status.reason),
  };
}

function tableNode(projectionId: string, records: AnyRecord[]): ViewDescriptor {
  // Union of curated columns across rows, in stable FIELD_ORDER.
  const columnKeys: string[] = [];
  for (const record of records) {
    for (const field of humanFields(record)) {
      if (!columnKeys.includes(field.key)) columnKeys.push(field.key);
    }
  }
  const columns = columnKeys.map((key) => ({ key, label: FIELD_LABELS[key] }));
  const rows = records.map((record, index) => {
    const row: AnyRecord = { id: recordId(record, index) };
    for (const key of columnKeys) {
      const value = record[key];
      row[key] = value === null || value === undefined ? '' : value;
    }
    return row;
  });
  return {
    id: `${projectionId}:table`,
    render_kind: KIND.table,
    value: { columns, rows },
  };
}

function recordGroupNode(
  projectionId: string,
  record: AnyRecord,
  editable: boolean,
): ViewDescriptor {
  const idValue = recordId(record, 0);
  const children = humanFields(record).map((field) => fieldDescriptor(idValue, field, editable));
  return {
    id: `${projectionId}:record:${idValue}`,
    render_kind: KIND.group,
    children,
  };
}

function emptyNode(projectionId: string, help?: string): ViewDescriptor {
  return {
    id: `${projectionId}:empty`,
    render_kind: KIND.group,
    help: help ?? 'Nothing here yet.',
  };
}

/**
 * Build the owner-translated `ViewDescriptor[]` tree for one surface. Returns a
 * single root group whose children are (optional status) + record display +
 * (optional action bar). Already human — printed verbatim downstream.
 */
export function buildSchedulingOfferView(input: SchedulingOfferInput): ViewDescriptor[] {
  const projectionId = asText(input.projection.projection_id, 'calendar-booker.unknown');
  const availabilityPresentation = projectionId === 'calendar-booker.availability-setup'
    ? resolveAvailabilitySetupPresentationProfile(input.availabilitySetupPresentationProfile, input.audience)
    : undefined;
  const section = sectionLabel(projectionId, availabilityPresentation);
  const index = indexDisplayLabels(input.graph);
  const records = (input.records ?? []).filter(
    (record): record is AnyRecord => !!record && typeof record === 'object' && !Array.isArray(record),
  );
  const editable = input.editable ?? false;

  const children: ViewDescriptor[] = [];

  if (input.status) {
    children.push(statusDescriptorNode(projectionId, input.status, index));
  }

  if (records.length === 0) {
    if (!input.status) children.push(emptyNode(projectionId, section.emptyHelp));
  } else if (records.length === 1) {
    children.push(recordGroupNode(projectionId, records[0], editable));
  } else {
    children.push(tableNode(projectionId, records));
  }

  const actionRefs = projectionActions(input.projection);
  if (actionRefs.length > 0) {
    children.push({
      id: `${projectionId}:actions`,
      render_kind: KIND.actionBar,
      actions: translateActions(actionRefs, input.disabledReasonByRef, availabilityPresentation),
    });
  }

  return [
    {
      id: projectionId,
      render_kind: KIND.group,
      label: section.label,
      help: section.help,
      children,
    },
  ];
}

// ---------------------------------------------------------------------------
// LABEL COLLECTION (for proof + ban tests + U6 visual evidence)
// ---------------------------------------------------------------------------

/** Collect every human string this feed emits, walking the descriptor tree. */
export function flattenViewLabels(views: readonly ViewDescriptor[]): string[] {
  const labels: string[] = [];
  const visit = (node: ViewDescriptor): void => {
    if (node.label) labels.push(node.label);
    if (node.help) labels.push(node.help);
    if (node.status?.label) labels.push(node.status.label);
    if (node.status?.reason) labels.push(node.status.reason);
    for (const option of node.options ?? []) labels.push(option.label);
    for (const action of node.actions ?? []) {
      labels.push(action.label);
      if (action.disabled_reason) labels.push(action.disabled_reason);
    }
    for (const child of node.children ?? []) visit(child);
  };
  views.forEach(visit);
  return labels;
}

/**
 * Substrings that must NEVER appear in an emitted label — internal refs, engine
 * vocabulary, raw state/field keys (an underscore in a visible label means a raw
 * key leaked; the owner vocabulary uses spaces). Used by the U1 ban test.
 */
export const BANNED_LABEL_SUBSTRINGS: readonly string[] = [
  'descriptor:',
  'package::',
  'slot::',
  'execute_definition',
  'owner_action_descriptor',
  'projection-descriptor',
  'proof_label',
  'CPD-',
  'EEAF',
  'internal-routing',
  '_',
];

export type { ActionDescriptor, StatusDescriptor, ViewDescriptor, ViewOption };
