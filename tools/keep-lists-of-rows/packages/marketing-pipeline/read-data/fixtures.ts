// package-set://bitfield-studio/packages/marketing-pipeline/read-data/fixtures.ts
//
// Shared model fixtures. These exercise the SAME generic code path with three
// unrelated product loops (marketing pipeline, relationship work, booking holds)
// to prove the Coordination Workbench carries ZERO domain vocabulary: only the
// descriptor DATA + copy differ. Fixtures are test data — the no-fake-data rule
// (L117) governs PRODUCT state, not fixtures, which exist precisely to render
// every state of the surface.

import type { CoordinationInput } from './read-coordination-records';

export const marketingDescriptorInput: CoordinationInput = {
  surfaceCopy: {
    title: 'Marketing Pipeline',
    emptyText: 'No campaigns yet.',
    emptyActionLabel: 'Start a campaign',
    runningText: 'Work is running',
    defaultViewLabel: 'Board',
  },
  fields: [
    { kind: 'coordination.field.v1', id: 'field.title', label: 'Title', value_shape: 'text', order: 0 },
    { kind: 'coordination.field.v1', id: 'field.state', label: 'Step', value_shape: 'choice', order: 1 },
    { kind: 'coordination.field.v1', id: 'field.owner', label: 'Owner', value_shape: 'person', order: 2 },
    { kind: 'coordination.field.v1', id: 'field.due', label: 'Due', value_shape: 'date', order: 3 },
  ],
  views: [
    { kind: 'coordination.view.v1', id: 'view.board', label: 'Board', arrangement: 'board', group_by: 'field.state', order_by: 'field.title', order: 0 },
    { kind: 'coordination.view.v1', id: 'view.table', label: 'Table', arrangement: 'table', group_by: 'field.state', order_by: 'field.title', order: 1 },
    { kind: 'coordination.view.v1', id: 'view.list', label: 'List', arrangement: 'list', group_by: 'field.state', order: 2 },
  ],
  actions: [
    {
      kind: 'coordination.action.v1',
      id: 'action.prepare-draft',
      label: 'Prepare draft',
      target_ref: 'slot::workflow',
      definition_ref: 'workflow-definition::content-production::draft-from-source',
      receipt_ref: 'coordination.receipt::draft',
      order: 0,
    },
    {
      kind: 'coordination.action.v1',
      id: 'action.send-for-review',
      label: 'Send for review',
      target_ref: 'slot::workflow',
      definition_ref: 'workflow-definition::content-production::send-for-review',
      order: 1,
    },
    {
      kind: 'coordination.action.v1',
      id: 'action.retry-send',
      label: 'Try again',
      target_ref: 'slot::workflow',
      definition_ref: 'workflow-definition::content-production::publish',
      order: 2,
    },
  ],
  recoverableIssues: [
    {
      kind: 'coordination.recoverable-issue.v1',
      record_ref: 'record.echo',
      severity: 'warning',
      message: 'The last send did not complete. Your draft and destination are saved.',
      retry_action_ref: 'action.retry-send',
    },
  ],
  coordinationRecords: [
    {
      kind: 'coordination.record.v1',
      id: 'record.alpha',
      label: 'Launch note',
      field_values: { 'field.title': 'Launch note', 'field.state': 'Drafts', 'field.owner': 'Alex', 'field.due': '2026-06-25' },
      relationships: [{ role: 'source', target_ref: 'package::ideas::record::note-1', owner_ref: 'ideas' }],
      action_descriptor_ids: ['action.prepare-draft', 'action.send-for-review'],
      evidence_refs: [{ role: 'draft', owner_ref: 'publish-composer', summary_ref: 'receipt::draft-1' }],
      process_session_refs: [{ session_ref: 'process-session::draft-1', event_feed_ref: 'events::draft-1' }],
    },
    {
      kind: 'coordination.record.v1',
      id: 'record.bravo',
      label: 'Spring teaser',
      field_values: { 'field.title': 'Spring teaser', 'field.state': 'Drafts', 'field.owner': 'Dana', 'field.due': '2026-06-26' },
      relationships: [{ role: 'source', target_ref: 'package::ideas::record::note-7', owner_ref: 'ideas' }],
      action_descriptor_ids: ['action.prepare-draft', 'action.send-for-review'],
    },
    {
      kind: 'coordination.record.v1',
      id: 'record.charlie',
      label: 'Webinar invite',
      field_values: { 'field.title': 'Webinar invite', 'field.state': 'Review', 'field.owner': 'Alex', 'field.due': '2026-06-24' },
      relationships: [{ role: 'source', target_ref: 'package::content::record::draft-3', owner_ref: 'content' }],
      action_descriptor_ids: ['action.send-for-review'],
      evidence_refs: [{ role: 'draft', owner_ref: 'publish-composer', summary_ref: 'receipt::draft-3', status: 'Review' }],
    },
    {
      kind: 'coordination.record.v1',
      id: 'record.delta',
      label: 'Product update',
      field_values: { 'field.title': 'Product update', 'field.state': 'Scheduled', 'field.owner': 'Dana', 'field.due': '2026-06-27' },
      relationships: [{ role: 'source', target_ref: 'package::content::record::draft-9', owner_ref: 'content' }],
      action_descriptor_ids: ['action.send-for-review'],
      process_session_refs: [{ session_ref: 'process-session::schedule-9', event_feed_ref: 'events::schedule-9', terminal_state_ref: 'Scheduled' }],
    },
    {
      kind: 'coordination.record.v1',
      id: 'record.echo',
      label: 'Newsletter #42',
      field_values: { 'field.title': 'Newsletter #42', 'field.state': 'Blocked', 'field.owner': 'Alex', 'field.due': '2026-06-23' },
      relationships: [{ role: 'source', target_ref: 'package::content::record::draft-12', owner_ref: 'content' }],
      action_descriptor_ids: ['action.retry-send'],
      evidence_refs: [{ role: 'attempt', owner_ref: 'delivery', summary_ref: 'receipt::attempt-3', status: 'Blocked' }],
    },
  ],
};

export const relationshipDescriptorInput: CoordinationInput = {
  surfaceCopy: {
    title: 'Relationship Work',
    emptyText: 'No people yet.',
    emptyActionLabel: 'Add person',
    runningText: 'Work is running',
    defaultViewLabel: 'List',
  },
  fields: [
    { kind: 'coordination.field.v1', id: 'field.person', label: 'Person', value_shape: 'person', order: 0 },
    { kind: 'coordination.field.v1', id: 'field.stage', label: 'Stage', value_shape: 'choice', order: 1 },
    { kind: 'coordination.field.v1', id: 'field.next-touch', label: 'Next touch', value_shape: 'date', order: 2 },
  ],
  views: [
    { kind: 'coordination.view.v1', id: 'view.list', label: 'List', arrangement: 'list', group_by: 'field.stage', order: 0 },
    { kind: 'coordination.view.v1', id: 'view.table', label: 'Table', arrangement: 'table', group_by: 'field.stage', order: 1 },
  ],
  actions: [
    {
      kind: 'coordination.action.v1',
      id: 'action.write-note',
      label: 'Write note',
      target_ref: 'crm.target::request-relationship-work-change',
      order: 0,
    },
  ],
  coordinationRecords: [
    {
      kind: 'coordination.record.v1',
      id: 'record.relationship',
      label: 'Jordan',
      field_values: { 'field.person': 'Jordan', 'field.stage': 'Warm', 'field.next-touch': '2026-06-23' },
      relationships: [{ role: 'contact', target_ref: 'crm::relationship::jordan', owner_ref: 'crm' }],
      action_descriptor_ids: ['action.write-note'],
    },
    {
      kind: 'coordination.record.v1',
      id: 'record.relationship-2',
      label: 'Priya',
      field_values: { 'field.person': 'Priya', 'field.stage': 'New', 'field.next-touch': '2026-06-25' },
      relationships: [{ role: 'contact', target_ref: 'crm::relationship::priya', owner_ref: 'crm' }],
      action_descriptor_ids: ['action.write-note'],
    },
  ],
};

export const bookingDescriptorInput: CoordinationInput = {
  surfaceCopy: {
    title: 'Booking Work',
    emptyText: 'No holds yet.',
    emptyActionLabel: 'Add hold',
    runningText: 'Work is running',
    defaultViewLabel: 'Calendar',
  },
  fields: [
    { kind: 'coordination.field.v1', id: 'field.when', label: 'When', value_shape: 'datetime', order: 0 },
    { kind: 'coordination.field.v1', id: 'field.place', label: 'Place', value_shape: 'text', order: 1 },
  ],
  actions: [
    {
      kind: 'coordination.action.v1',
      id: 'action.reserve-time',
      label: 'Reserve time',
      target_ref: 'calendar.target::request-time-block-change',
      order: 0,
    },
  ],
  coordinationRecords: [
    {
      kind: 'coordination.record.v1',
      id: 'record.booking',
      label: 'Court hold',
      field_values: { 'field.when': '2026-06-24T16:00:00-05:00', 'field.place': 'Court 3' },
      relationships: [{ role: 'calendar', target_ref: 'calendar::time-block::court-3', owner_ref: 'calendar' }],
      action_descriptor_ids: ['action.reserve-time'],
    },
  ],
};
