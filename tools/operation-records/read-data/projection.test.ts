import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildOperationProjection, decodeOperationLensDescriptor, projectMode } from './projection.ts';
import type { OperationRecord } from './operation-records.ts';

function operation(id: string, patch: Partial<OperationRecord>): OperationRecord {
  return {
    id,
    ownerPackage: 'test',
    source: { package: 'test', type: 'thing', id },
    kindDescriptor: 'kind:test',
    stateDescriptor: 'state:test',
    priority: 'normal',
    priorityDescriptor: 'priority:normal',
    linkRefs: [],
    dependencyRefs: [],
    evidenceRefs: [],
    candidateFactRefs: [],
    transitions: [],
    display: { title: id, status: 'Status', reason: 'Reason', detail: [] },
    privacyClass: 'public',
    modeHints: ['next'],
    sortKey: id,
    ...patch,
  };
}

describe('operation projection', () => {
  it('projects one now focus without hiding timeline, inventory, and risk modes', () => {
    const reservation = operation('reservation:changed', {
      ownerPackage: 'reservation-tracker',
      stateDescriptor: 'reservation.state.changed',
      priority: 'high',
      modeHints: ['now', 'risks', 'timeline'],
      timeWindow: { startsAt: '2026-06-05 14:10' },
      transitions: [{ id: 'confirm', ownerPackage: 'reservation-tracker', actionDefinitionId: 'action:reservation-tracker:update-status', label: 'Confirm change', input: { reservationId: 'r1', status: 'confirmed' }, modeHints: ['now'] }],
    });
    const packing = operation('packing:missing', {
      ownerPackage: 'packing-list',
      stateDescriptor: 'packing.state.missing',
      priority: 'high',
      modeHints: ['now', 'inventory', 'risks'],
      sortKey: '2026-06-04',
    });
    const projection = buildOperationProjection([reservation, packing]);

    expect(projection.modes.now.focus?.id).toBe('packing:missing');
    expect(projection.modes.inventory.queue.map((record) => record.id)).toEqual(['packing:missing']);
    expect(projection.modes.timeline.queue.map((record) => record.id)).toEqual(['reservation:changed']);
    expect(projection.modes.risks.queue).toHaveLength(2);
  });

  it('keeps completed operations out of next while preserving explicit review candidates', () => {
    const complete = operation('packed', { priority: 'done', stateDescriptor: 'packing.state.packed' });
    const review = operation('candidate', { candidateFactRefs: ['candidate:1'], modeHints: ['review'] });
    const lenses = [
      { id: 'next', label: 'Next', sortRank: 0, match: { excludeDone: true } },
      { id: 'review', label: 'Review', sortRank: 1, match: { hasCandidateFacts: true } },
    ];

    expect(projectMode([complete, review], 'next', lenses).queue.map((record) => record.id)).toEqual(['candidate']);
    expect(projectMode([complete, review], 'review', lenses).focus?.id).toBe('candidate');
  });

  it('preserves zero lens sort ranks as explicit data', () => {
    expect(decodeOperationLensDescriptor({ id: 'now', sortRank: 0 })?.sortRank).toBe(0);
  });

  it('composes primitive operation states without package-specific branches', () => {
    const operations = ['split', 'merge', 'defer', 'reopen', 'complete', 'supersede', 'link', 'unlink', 'block', 'unblock', 'accept', 'reject'];
    const records = operations.flatMap((left) => operations.map((right) => operation(`${left}:${right}`, {
      kindDescriptor: `operation.kind.${left}`,
      stateDescriptor: `operation.state.${right}`,
      priority: right === 'complete' ? 'done' : 'normal',
      modeHints: right === 'block' ? ['risks'] : ['next'],
    })));

    const projection = buildOperationProjection(records);
    expect(projection.recordsById.size).toBe(144);
    expect(projection.modes.risks.queue.every((record) => record.stateDescriptor.endsWith('block'))).toBe(true);
  });

  it('auto-projects owner-defined lens hints without changing primitive code', () => {
    const call = operation('reservation:call', {
      ownerPackage: 'reservation-tracker',
      modeHints: ['call-provider'],
      priority: 'high',
    });

    const projection = buildOperationProjection([call]);
    expect(projection.modes['call-provider'].focus?.id).toBe('reservation:call');
    expect(projection.lenses.map((lens) => lens.mode)).toContain('call-provider');
  });

  it('uses descriptor data for ranking and lens placement instead of owner-package branches', () => {
    const inventory = operation('custom:inventory', {
      ownerPackage: 'not-packing-list',
      stateDescriptor: 'custom.state.inventory',
      priorityDescriptor: 'custom.priority.hot',
      modeHints: [],
    });
    const focus = operation('custom:focus', {
      stateDescriptor: 'custom.state.focus',
      priorityDescriptor: 'custom.priority.hot',
      modeHints: [],
    });

    const projection = buildOperationProjection([inventory, focus], [
      {
        id: 'custom.state.inventory',
        family: 'state',
        label: 'Inventory',
        shortLabel: 'Inventory',
        tone: 'info',
        sortRank: 5,
        defaultModes: ['inventory'],
        privacyClass: 'public',
      },
      {
        id: 'custom.state.focus',
        family: 'state',
        label: 'Focus',
        shortLabel: 'Focus',
        tone: 'info',
        sortRank: 1,
        defaultModes: ['now'],
        privacyClass: 'public',
      },
    ]);

    expect(projection.focus?.id).toBe('custom:focus');
    expect(projection.modes.inventory.queue.map((record) => record.id)).toEqual(['custom:inventory']);
    expect(projection.modes.now.queue.map((record) => record.id)).toEqual(['custom:focus']);
  });

  it('accepts arbitrary priority and completion classes from config data', () => {
    const escalated = operation('escalated', {
      priority: 'regulated-board-review',
      priorityDescriptor: 'priority.regulated-board-review',
    });
    const parked = operation('parked', {
      priority: 'parked-by-owner',
      priorityDescriptor: 'priority.parked-by-owner',
    });

    const projection = buildOperationProjection([parked, escalated], [
      {
        id: 'priority.regulated-board-review',
        family: 'priority',
        label: 'Board review',
        shortLabel: 'Board',
        tone: 'urgent',
        sortRank: 1,
        defaultModes: ['next'],
        privacyClass: 'regulated',
      },
      {
        id: 'priority.parked-by-owner',
        family: 'priority',
        label: 'Parked',
        shortLabel: 'Parked',
        tone: 'quiet',
        sortRank: 900,
        defaultModes: ['archive'],
        privacyClass: 'private-to-owner',
      },
    ], [], {
      donePriorities: ['parked-by-owner'],
      doneStateDescriptorIncludes: [],
    });

    expect(projection.focus?.id).toBe('escalated');
    expect(projection.queue.map((record) => record.id)).toEqual(['escalated']);
    expect(projection.modes.archive.queue.map((record) => record.id)).toEqual(['parked']);
  });

  it('keeps descriptor ranking separated by operation slot instead of collapsing slots into one minimum', () => {
    const critical = operation('critical-state-later', {
      priority: 'critical',
      priorityDescriptor: 'priority.critical',
      stateDescriptor: 'state.changed',
      sortKey: 'z',
    });
    const highWithUrgentState = operation('high-state-first', {
      priority: 'high',
      priorityDescriptor: 'priority.high',
      stateDescriptor: 'state.missing',
      sortKey: 'a',
    });

    const projection = buildOperationProjection([highWithUrgentState, critical], [
      {
        id: 'priority.critical',
        family: 'priority',
        label: 'Critical',
        shortLabel: 'Critical',
        tone: 'error',
        sortRank: 0,
        defaultModes: ['now'],
        privacyClass: 'public',
      },
      {
        id: 'priority.high',
        family: 'priority',
        label: 'High',
        shortLabel: 'High',
        tone: 'warning',
        sortRank: 10,
        defaultModes: ['now'],
        privacyClass: 'public',
      },
      {
        id: 'state.changed',
        family: 'state',
        label: 'Changed',
        shortLabel: 'Changed',
        tone: 'warning',
        sortRank: 10,
        defaultModes: ['now'],
        privacyClass: 'public',
      },
      {
        id: 'state.missing',
        family: 'state',
        label: 'Missing',
        shortLabel: 'Missing',
        tone: 'error',
        sortRank: 0,
        defaultModes: ['now'],
        privacyClass: 'public',
      },
    ]);

    expect(projection.focus?.id).toBe('critical-state-later');
    expect(projection.modes.now.queue.map((record) => record.id)).toEqual(['critical-state-later', 'high-state-first']);
  });

  it('uses owner-published sort keys before raw time when descriptor ranks are equal or absent', () => {
    const timeless = operation('timeless', {
      sortKey: '1:owner-secondary',
      modeHints: ['now'],
    });
    const timed = operation('timed', {
      sortKey: '0:owner-primary',
      timeWindow: { startsAt: '2026-06-03T08:20:00Z' },
      modeHints: ['now'],
    });

    const projection = buildOperationProjection([timeless, timed]);

    expect(projection.modes.now.queue.map((record) => record.id)).toEqual(['timed', 'timeless']);
  });
});
