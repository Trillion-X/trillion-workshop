import type { UniversalActionEventDescriptorSet, UniversalActionEventRecord } from './universal-action-event-contract.ts';

export const fixtureDescriptors: UniversalActionEventDescriptorSet = {
  fields: [
    { id: 'title', label: 'Title', paths: [['title']], display: { order: 1 } },
    { id: 'note', label: 'Note', paths: [['note']], display: { order: 2 } },
  ],
  domainOptions: [
    { id: 'descriptor:lead', label: 'Lead', role: 'state', group: 'pipeline', tone: 'info', order: 1 },
    { id: 'descriptor:loss', label: 'Loss', role: 'state', group: 'pipeline', tone: 'muted', order: 2 },
    { id: 'descriptor:follow-up', label: 'Follow-up', role: 'next', group: 'next-action', tone: 'warning', order: 3 },
    { id: 'descriptor:campaign', label: 'Campaign', role: 'source', group: 'origin', tone: 'neutral', order: 4 },
    { id: 'descriptor:calendar', label: 'Calendar', role: 'source', group: 'origin', tone: 'neutral', order: 5 },
    { id: 'descriptor:email', label: 'Email', role: 'source', group: 'origin', tone: 'neutral', order: 6 },
  ],
  proofs: [
    { id: 'proof:summary', label: 'Summary', paths: [['proof', 'summary']], disclosure: 'summary', errorText: 'Proof is not available.' },
  ],
  actions: [
    {
      id: 'action:open',
      label: 'Open',
      target: 'slot::workflow',
      definitionId: 'definition:open',
      availability: { requiresRoute: true, disabledReasonId: 'missing-route' },
      inputMapping: [{ key: 'title', from: ['record', 'fieldValues', 'title'] }],
    },
    {
      id: 'action:missing',
      label: 'Unavailable',
      availability: { requiresRoute: true, disabledReasonId: 'missing-route' },
    },
  ],
  views: [
    {
      id: 'view:main',
      label: 'Action events',
      rowFields: ['title', 'note'],
      proofDescriptors: ['proof:summary'],
      actions: ['action:open', 'action:missing'],
      groupByRole: 'state',
      sort: [{ field: 'title', direction: 'asc' }],
      copy: { emptyTitle: 'Nothing yet', emptyDetail: 'Records will appear here.', freshnessLabel: 'Current through' },
    },
  ],
  disabledReasons: {
    'missing-route': 'No owner route is declared.',
  },
};

export const fixtureRecords: UniversalActionEventRecord[] = [
  {
    recordId: 'record:1',
    subjectRefs: ['subject:1'],
    sourceRefs: ['source:1'],
    fieldValues: { title: 'A', note: 'First', proof: { summary: 'Saved' } },
    domainOptionRefs: ['descriptor:lead', 'descriptor:campaign'],
    proofRefs: ['proof:summary'],
    ownerActionRefs: ['action:open', 'action:missing'],
    occurredAt: '2026-06-22T01:00:00.000Z',
  },
  {
    recordId: 'record:2',
    subjectRefs: ['subject:2'],
    sourceRefs: ['source:2'],
    fieldValues: { title: 'B', note: 'Second' },
    domainOptionRefs: ['descriptor:loss', 'descriptor:follow-up', 'descriptor:calendar', 'descriptor:email'],
    proofRefs: ['proof:summary'],
    occurredAt: '2026-06-22T02:00:00.000Z',
  },
];
