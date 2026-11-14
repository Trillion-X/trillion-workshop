// package-set://bitfield-studio/packages/request-intake/show/request-intake-fixtures.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Render-state fixtures for the Requests surface. Each is a plain
// `RequestIntakeProjectionInput` — the SAME shape the live value carries — so the
// matrix test drives the REAL projection + REAL screen model + REAL surface,
// never a mock of any of them. The fixtures cover every honest render state
// (empty · sparse · dense · loading · error · offline · conflict) AND prove
// genericity: the second-domain fixture (a community event intake) carries ZERO
// request-intake vocabulary yet renders through the identical component, so the
// surface can have no domain branch (the Generic / Data-Driven Gate, L063/L090).
//
// Everything a fixture shows — title, fields, statuses, actions, copy — is DATA.
// Adding a field/status/action to a fixture changes what renders with ZERO change
// to any renderer. No fabricated production rows live here: these are test inputs,
// never seeded into live state (L116/L117).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Test-only DATA: imported by the matrix test, never by the mount or any
//    live-seed path. Live state comes from the package value.
// 2. Self-describing: each fixture is a complete projection input — shapes,
//    fields, states, actions, instances, receipts — so the reader produces a
//    real surface.
// 3. Generic proof: the second-domain fixture uses an unrelated domain to prove
//    the renderers carry no request-intake words.
// 4. The error fixture embeds an internal path + hash inside `issues` so the test
//    can prove the surface translates it to calm copy, never displays it raw.
//
// =============================================================================

import type { RequestIntakeProjectionInput } from '@/packages/request-intake/read-data/request-intake-projection';

// ---------------------------------------------------------------------------
// Shared descriptor building blocks (DATA — reused across fixtures)
// ---------------------------------------------------------------------------

const REQUEST_FIELDS = [
  { id: 'requester', shape_id: 'shape.request', label: 'Requester', order: 0, value_kind: 'short-text', required: true },
  { id: 'topic', shape_id: 'shape.request', label: 'Topic', order: 1, value_kind: 'short-text' },
  { id: 'detail', shape_id: 'shape.request', label: 'What they need', order: 2, value_kind: 'long-text', required: true },
  { id: 'budget', shape_id: 'shape.request', label: 'Budget', order: 3, value_kind: 'number' },
];

const REQUEST_SHAPE = {
  id: 'shape.request',
  kind: 'generic.record-shape',
  label: 'Request',
  order: 0,
  version_ref: 'v1',
};

const REQUEST_STATES = [
  { id: 'state.new', kind: 'generic.state-descriptor', label: 'New', order: 0 },
  { id: 'state.in-review', kind: 'generic.state-descriptor', label: 'In review', order: 1 },
  { id: 'state.accepted', kind: 'generic.state-descriptor', label: 'Accepted', order: 2 },
  { id: 'state.declined', kind: 'generic.state-descriptor', label: 'Declined', order: 3 },
];

const REQUEST_VIEWS = [
  { id: 'view.all', kind: 'generic.view-descriptor', label: 'All requests', order: 0 },
  { id: 'view.open', kind: 'generic.view-descriptor', label: 'Needs review', order: 1 },
];

// Actions are DATA. "Accept" / "Decline" are not a hardcoded won/lost worldview —
// they are two ordinary owner-action rows. Add a third row and a third button
// appears with zero code change. One action declares a field, so the composer
// renders an input for it; the others run on click.
const REQUEST_ACTIONS = [
  {
    id: 'action.accept',
    kind: 'generic.owner-action-descriptor',
    label: 'Accept request',
    order: 0,
    target: 'slot::workflow',
    operation: 'execute',
    definition_id: 'owner-action.accept-request',
    copy: [
      { key: 'helper', value: 'Move this request forward.' },
      { key: 'record_ref', from: 'request.recordRef' },
    ],
  },
  {
    id: 'action.decline',
    kind: 'generic.owner-action-descriptor',
    label: 'Decline request',
    order: 1,
    target: 'slot::workflow',
    operation: 'execute',
    definition_id: 'owner-action.decline-request',
    fields: [
      { id: 'reason', label: 'Reason', order: 0, value_kind: 'long-text', required: true },
    ],
    copy: [
      { key: 'helper', value: 'Let them know this one is a no.' },
      { key: 'record_ref', from: 'request.recordRef' },
    ],
  },
];

const REQUEST_SHARE_POLICIES = [
  {
    id: 'share.public-link',
    kind: 'generic.share-policy-descriptor',
    label: 'Anyone with the link',
    order: 0,
    copy: [{ key: 'helper', value: 'Anyone who has the link can send a request.' }],
  },
  {
    id: 'share.invite-only',
    kind: 'generic.share-policy-descriptor',
    label: 'Invited people only',
    order: 1,
    copy: [{ key: 'helper', value: 'Only people you invite can send a request.' }],
  },
];

function requestInstance(
  id: string,
  title: string,
  stateId: string,
  values: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    shape_id: 'shape.request',
    title,
    state_id: stateId,
    field_values: values,
    action_descriptor_ids: ['action.accept', 'action.decline'],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// empty — an honest first-run state with a real share action, never a dead label
// ---------------------------------------------------------------------------

export const emptyRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'empty',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  sharePolicies: REQUEST_SHARE_POLICIES,
  instances: [],
};

// ---------------------------------------------------------------------------
// sparse — a couple of requests waiting on the owner
// ---------------------------------------------------------------------------

export const sparseRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'sparse',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  sharePolicies: REQUEST_SHARE_POLICIES,
  receipts: [
    {
      ref: 'receipt.r1',
      kind: 'generic.owner-receipt',
      owner_ref: 'package::inbox::email::e-1',
      title: 'Form submitted',
      summary: 'Came in through the public link.',
      time: '2 hours ago',
      state: 'received',
    },
  ],
  instances: [
    requestInstance('req-1', 'Logo redesign', 'state.new', {
      requester: 'Dana Lee',
      topic: 'Branding',
      detail: 'We need a fresh logo before our launch.',
      budget: 1200,
    }, { source_label: 'Public link', received_at: 'Today', linked_receipt_refs: ['receipt.r1'] }),
    requestInstance('req-2', 'Podcast intro music', 'state.in-review', {
      requester: 'Sam Ortiz',
      topic: 'Audio',
      detail: 'A 10 second intro sting for the show.',
      budget: 400,
    }, { source_label: 'Direct', received_at: 'Yesterday' }),
  ],
};

// ---------------------------------------------------------------------------
// dense — many requests grouped for fast scanning (> 12 -> derived "dense")
// ---------------------------------------------------------------------------

const DENSE_TOPICS = ['Branding', 'Audio', 'Web', 'Video', 'Print', 'Photo'];
const DENSE_STATES = ['state.new', 'state.in-review', 'state.accepted', 'state.declined'];

export const denseRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'dense',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  sharePolicies: REQUEST_SHARE_POLICIES,
  instances: Array.from({ length: 14 }, (_, index) =>
    requestInstance(
      `req-${index + 1}`,
      `Request ${index + 1}`,
      DENSE_STATES[index % DENSE_STATES.length],
      {
        requester: `Person ${index + 1}`,
        topic: DENSE_TOPICS[index % DENSE_TOPICS.length],
        detail: 'A short description of what they need from you.',
        budget: (index + 1) * 100,
      },
      { source_label: index % 2 === 0 ? 'Public link' : 'Direct', received_at: 'This week' },
    ),
  ),
};

// ---------------------------------------------------------------------------
// loading — handled by the surface's `loading` prop; the data is still honest
// ---------------------------------------------------------------------------

export const loadingRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'loading',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  instances: [],
};

// ---------------------------------------------------------------------------
// error — the surface routes a hard error through the safe error card. The
// `issues` carry an INTERNAL path + hash so the test can prove they are
// translated to calm copy, never displayed raw.
// ---------------------------------------------------------------------------

export const errorRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'error',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  actions: REQUEST_ACTIONS,
  instances: [],
  issues: [
    'package::request-intake::published-record::row-3 failed to decode (hash a1b2c3d4e5f6).',
  ],
};

// ---------------------------------------------------------------------------
// offline — saved requests are visible; new changes wait for the connection
// ---------------------------------------------------------------------------

export const offlineRequestIntakeInput: RequestIntakeProjectionInput = {
  status: 'offline',
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  instances: [
    requestInstance('req-1', 'Event flyer', 'state.new', {
      requester: 'Priya Nair',
      topic: 'Print',
      detail: 'A one page flyer for the school fair.',
      budget: 250,
    }, { source_label: 'Public link', received_at: 'Yesterday' }),
  ],
};

// ---------------------------------------------------------------------------
// conflict — one saved change needs review before it can continue. The record
// carries an `issue`; the projection derives the "conflict" status from it.
// ---------------------------------------------------------------------------

export const conflictRequestIntakeInput: RequestIntakeProjectionInput = {
  shapes: [REQUEST_SHAPE],
  fields: REQUEST_FIELDS,
  states: REQUEST_STATES,
  views: REQUEST_VIEWS,
  actions: REQUEST_ACTIONS,
  issues: ['One request was changed in two places and needs your review.'],
  instances: [
    requestInstance('req-1', 'Wedding photos', 'state.in-review', {
      requester: 'Marco Diaz',
      topic: 'Photo',
      detail: 'Full day coverage with two photographers.',
      budget: 3000,
    }, {
      source_label: 'Direct',
      received_at: 'Today',
      issue: 'Edited on another device while you were offline.',
    }),
  ],
};

// ---------------------------------------------------------------------------
// Genericity proof — a community-event intake (a non-request-intake domain)
// ---------------------------------------------------------------------------

/**
 * The SAME surface rendering a volunteer sign-up intake. No request-intake
 * vocabulary anywhere — if a request-intake word appeared on screen here it could
 * only have come from renderer code, which the genericity test forbids.
 */
export const eventIntakeInput: RequestIntakeProjectionInput = {
  shapes: [{ id: 'shape.signup', kind: 'generic.record-shape', label: 'Sign-up', order: 0, version_ref: 'v2' }],
  fields: [
    { id: 'volunteer', shape_id: 'shape.signup', label: 'Volunteer', order: 0, value_kind: 'short-text', required: true },
    { id: 'shift', shape_id: 'shape.signup', label: 'Shift', order: 1, value_kind: 'short-text' },
    { id: 'notes', shape_id: 'shape.signup', label: 'Notes', order: 2, value_kind: 'long-text' },
  ],
  states: [
    { id: 'state.pending', kind: 'generic.state-descriptor', label: 'Pending', order: 0 },
    { id: 'state.confirmed', kind: 'generic.state-descriptor', label: 'Confirmed', order: 1 },
  ],
  views: [{ id: 'view.signups', kind: 'generic.view-descriptor', label: 'Sign-ups', order: 0 }],
  actions: [
    {
      id: 'action.confirm',
      kind: 'generic.owner-action-descriptor',
      label: 'Confirm spot',
      order: 0,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.confirm-spot',
      copy: [{ key: 'helper', value: 'Save their place for the shift.' }],
    },
  ],
  sharePolicies: [
    {
      id: 'share.team',
      kind: 'generic.share-policy-descriptor',
      label: 'Team only',
      order: 0,
      copy: [{ key: 'helper', value: 'Only your team can sign up.' }],
    },
  ],
  instances: [
    {
      id: 'signup-1',
      shape_id: 'shape.signup',
      title: 'Saturday cleanup',
      state_id: 'state.pending',
      field_values: { volunteer: 'Iris Bloom', shift: 'Morning', notes: 'Can bring extra gloves.' },
      action_descriptor_ids: ['action.confirm'],
      source_label: 'Team link',
      received_at: 'Today',
    },
  ],
};
