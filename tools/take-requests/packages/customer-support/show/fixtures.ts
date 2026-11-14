// package-set://bitfield-studio/packages/customer-support/show/fixtures.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Render-state fixtures for the Support Workbench. They are plain
// `RecordWorkGraphInput` values — the SAME shape the live `record-work` value
// carries — so the matrix test drives the REAL reader + REAL surface, never a
// mock of either. The fixtures cover every honest render state (empty, sparse,
// dense, with-issue) AND prove genericity: the relationship + booking inputs
// carry ZERO support vocabulary and render through the identical component, so
// the surface can have no domain branch (the Generic / Data-Driven Gate).
//
// Everything a fixture shows — title, fields, statuses, actions, copy — is DATA.
// Adding a field/status/action/copy line to a fixture changes what renders with
// ZERO change to any renderer (L063/L090). No fabricated production rows live
// here: these are test inputs, never seeded into live state (L117).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Test-only DATA: fixtures are imported by the matrix test, never by the
//    mount or any live-seed path. Live state comes from the `record-work` value.
// 2. Self-describing: each fixture is a complete workspace input — records,
//    descriptors, evidence, and copy — so the reader produces a real workspace.
// 3. Generic proof: the non-support fixtures use unrelated domains (relationship
//    work, court bookings) to prove the renderers carry no support words.
//
// =============================================================================

import type { RecordWorkGraphInput } from '../read-data/record-work-graph';

/** The live value shape the mount maps to: a graph input plus an optional status hint. */
export type WorkspaceFixture = RecordWorkGraphInput & { status?: string };

// ---------------------------------------------------------------------------
// Customer support — dense (the realistic multi-ticket workbench)
// ---------------------------------------------------------------------------

/**
 * A populated support workspace: five tickets across open / waiting / resolved,
 * two views (Inbox + Priority), reply + resolve actions, real upstream
 * connections, owner activity, and one record whose owner activity is still
 * being gathered (exercises the calm issue banner). Used for dense / desktop /
 * view-switch / no-ref-leak.
 */
export const supportDescriptorInput: WorkspaceFixture = {
  workRecords: [
    {
      id: 'ticket-1',
      label: 'Refund not received',
      state_refs: ['urgent', 'open'],
      field_values: { requester: 'Dana Lee', topic: 'Billing', promise: 'Today, 5:00 PM' },
      relation_refs: ['package::inbox::email::e-1'],
      action_refs: ['action.reply', 'action.resolve'],
      owner_refs: ['evidence-1'],
    },
    {
      id: 'ticket-2',
      label: 'Login link expired',
      state_refs: ['open'],
      field_values: { requester: 'Sam Ortiz', topic: 'Access', promise: 'Tomorrow, 9:00 AM' },
      relation_refs: ['package::inbox::chat::c-2'],
      action_refs: ['action.reply', 'action.resolve'],
      // Points at activity that has not arrived yet -> drives the issue banner.
      owner_refs: ['evidence-pending'],
    },
    {
      id: 'ticket-3',
      label: 'Add dark mode to the app',
      state_refs: ['waiting'],
      field_values: { requester: 'Priya Nair', topic: 'Feature request', promise: 'This week' },
      relation_refs: ['package::inbox::email::e-3'],
      action_refs: ['action.reply'],
      owner_refs: [],
    },
    {
      id: 'ticket-4',
      label: 'Cannot upload a profile photo',
      state_refs: ['open'],
      field_values: { requester: 'Marco Diaz', topic: 'Bug', promise: 'Today, 6:00 PM' },
      relation_refs: ['package::inbox::chat::c-4'],
      action_refs: ['action.reply', 'action.resolve'],
      owner_refs: [],
    },
    {
      id: 'ticket-5',
      label: 'Charged twice this month',
      state_refs: ['resolved'],
      field_values: { requester: 'Iris Bloom', topic: 'Billing', promise: 'Done' },
      relation_refs: ['package::inbox::email::e-5'],
      action_refs: ['action.reply'],
      owner_refs: ['evidence-5'],
    },
  ],
  viewDescriptors: [
    {
      id: 'view.inbox',
      kind: 'record-work.view-descriptor',
      label: 'Inbox',
      order: 0,
      empty_copy: 'No support tickets yet.',
      fields: [
        { id: 'requester', label: 'Requester', order: 0 },
        { id: 'topic', label: 'Topic', order: 1 },
        { id: 'promise', label: 'Promised by', order: 2 },
      ],
    },
    {
      id: 'view.priority',
      kind: 'record-work.view-descriptor',
      label: 'Priority',
      order: 1,
      fields: [
        { id: 'requester', label: 'Requester', order: 0 },
        { id: 'promise', label: 'Promised by', order: 1 },
      ],
    },
  ],
  actionDescriptors: [
    {
      id: 'action.reply',
      kind: 'record-work.action-descriptor',
      label: 'Reply',
      order: 0,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.reply',
      permission_ref: 'permission::reply',
      copy: [
        { key: 'body', from: 'answers.body' },
        { key: 'work_record_id', from: 'request.workRecordId' },
      ],
    },
    {
      id: 'action.resolve',
      kind: 'record-work.action-descriptor',
      label: 'Mark resolved',
      order: 1,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.resolve',
      // No `answers.*` rule -> runs on click, no composer.
      copy: [{ key: 'work_record_id', from: 'request.workRecordId' }],
    },
  ],
  ownerEvidence: [
    {
      ref: 'evidence-1',
      owner_ref: 'package::inbox::email::e-1',
      label: 'Email from Dana Lee',
      summary: 'I was promised a refund last week and it still has not arrived.',
      time: '2 hours ago',
      state_label: 'Received',
    },
    {
      ref: 'evidence-5',
      owner_ref: 'package::inbox::email::e-5',
      label: 'Refund issued',
      summary: 'A duplicate charge was reversed to the original card.',
      time: 'Yesterday',
      state_label: 'Done',
    },
  ],
  copyDescriptors: [
    { id: 'title', label: 'Support' },
    { id: 'empty', label: 'No tickets need you right now.' },
    { id: 'empty.action', label: 'Connect a channel' },
    { id: 'issue.missing-owner-evidence', label: 'Some activity is still being gathered.' },
    { id: 'issue.missing-owner-evidence.severity', label: 'info' },
  ],
};

// ---------------------------------------------------------------------------
// Customer support — empty (an honest first-run state with a real starter action)
// ---------------------------------------------------------------------------

/**
 * No tickets yet. Carries one real, wired, input-free action so the empty state
 * shows a working starter button — never a dead label (L117).
 */
export const emptySupportInput: WorkspaceFixture = {
  workRecords: [],
  actionDescriptors: [
    {
      id: 'action.connect',
      kind: 'record-work.action-descriptor',
      label: 'Connect a channel',
      order: 0,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.connect',
      copy: [{ key: 'work_record_id', from: 'request.workRecordId' }],
    },
  ],
  copyDescriptors: [
    { id: 'title', label: 'Support' },
    { id: 'empty', label: 'No tickets need you right now.' },
    { id: 'empty.action', label: 'Connect a channel' },
  ],
};

// ---------------------------------------------------------------------------
// Genericity proof #1 — relationship work (a non-support domain)
// ---------------------------------------------------------------------------

/**
 * The SAME surface rendering a CRM-style relationship workspace. No support
 * vocabulary anywhere — if a support word appeared on screen here it could only
 * have come from renderer code, which the no-leak / genericity tests forbid.
 */
export const relationshipDescriptorInput: WorkspaceFixture = {
  workRecords: [
    {
      id: 'person-1',
      label: 'Jordan Avery',
      state_refs: ['active'],
      field_values: { company: 'Northwind', lastTouch: '3 days ago' },
      action_refs: ['rel.note'],
      owner_refs: [],
    },
    {
      id: 'person-2',
      label: 'Riley Chen',
      state_refs: ['warm'],
      field_values: { company: 'Brightwave', lastTouch: 'Last week' },
      action_refs: ['rel.note'],
      owner_refs: [],
    },
  ],
  viewDescriptors: [
    {
      id: 'view.people',
      kind: 'record-work.view-descriptor',
      label: 'People',
      order: 0,
      fields: [
        { id: 'company', label: 'Company', order: 0 },
        { id: 'lastTouch', label: 'Last touch', order: 1 },
      ],
    },
  ],
  actionDescriptors: [
    {
      id: 'rel.note',
      kind: 'record-work.action-descriptor',
      label: 'Write note',
      order: 0,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.note',
      copy: [
        { key: 'note', from: 'answers.note' },
        { key: 'work_record_id', from: 'request.workRecordId' },
      ],
    },
  ],
  copyDescriptors: [
    { id: 'title', label: 'Relationship Work' },
    { id: 'empty', label: 'No people yet.' },
  ],
};

// ---------------------------------------------------------------------------
// Genericity proof #2 — court bookings (a sparse single-record domain)
// ---------------------------------------------------------------------------

/**
 * A single booking hold. Sparse single-record state through the same component;
 * its one action is input-free (runs on click). One view -> no view switch.
 */
export const bookingDescriptorInput: WorkspaceFixture = {
  workRecords: [
    {
      id: 'hold-1',
      label: 'Court hold',
      state_refs: ['pending'],
      field_values: { when: 'Saturday, 9:00 AM', court: 'Court 2' },
      action_refs: ['book.reserve'],
      owner_refs: [],
    },
  ],
  viewDescriptors: [
    {
      id: 'view.holds',
      kind: 'record-work.view-descriptor',
      label: 'Holds',
      order: 0,
      fields: [
        { id: 'when', label: 'When', order: 0 },
        { id: 'court', label: 'Court', order: 1 },
      ],
    },
  ],
  actionDescriptors: [
    {
      id: 'book.reserve',
      kind: 'record-work.action-descriptor',
      label: 'Reserve time',
      order: 0,
      target: 'slot::workflow',
      operation: 'execute',
      definition_id: 'owner-action.reserve',
      copy: [{ key: 'work_record_id', from: 'request.workRecordId' }],
    },
  ],
  copyDescriptors: [{ id: 'title', label: 'Bookings' }],
};
