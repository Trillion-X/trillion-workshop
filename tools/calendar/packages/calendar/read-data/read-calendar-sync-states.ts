import type {
  CalendarActionDescriptorTemplate,
  CalendarTimeBlock,
  CalendarTimeBlockLens,
  CalendarRow,
} from './read-calendar-time-blocks';
import { projectCalendarTimeBlock } from './read-calendar-time-blocks';

export type CalendarQueuedChangeRecord = CalendarRow & {
  id: string;
  affected_block_ref: string;
  proposed_start?: string;
  proposed_end?: string;
  queue_state?: string;
  retry_descriptor?: CalendarActionDescriptorTemplate;
};

export type CalendarConflictRecord = CalendarRow & {
  id: string;
  affected_block_ref: string;
  original_start: string;
  original_end: string;
  proposed_start: string;
  proposed_end: string;
  owner_message_ref?: string;
  resolve_descriptors?: CalendarActionDescriptorTemplate[];
};

export type CalendarSyncStateProjection = {
  queuedBlocks: CalendarTimeBlock[];
  conflictBlocks: CalendarTimeBlock[];
  diagnostics: {
    queuedCount: number;
    conflictCount: number;
  };
};

const QUEUED_LENS: CalendarTimeBlockLens = {
  kind: 'time-block-lens',
  lens_id: 'queued-change',
  input_address: 'calendar.queued-changes',
  owner_ref: 'calendar',
  owner_label: 'Calendar',
  selectors: {
    identity: 'id',
    start: { path: 'proposed_start', fallback: '' },
    end: { path: 'proposed_end', fallback: '' },
    title: { path: 'label', fallback: 'Waiting to sync' },
    state: { path: 'queue_state', fallback: 'waiting-to-sync' },
    lane: { path: 'affected_block_ref', fallback: 'queued' },
  },
  relations: {
    affectedBlock: 'affected_block_ref',
  },
};

const CONFLICT_LENS: CalendarTimeBlockLens = {
  kind: 'time-block-lens',
  lens_id: 'conflict',
  input_address: 'calendar.conflicts',
  owner_ref: 'calendar',
  owner_label: 'Calendar',
  selectors: {
    identity: 'id',
    start: 'proposed_start',
    end: 'proposed_end',
    title: { path: 'label', fallback: 'Resolve conflict' },
    state: { path: 'conflict_state', fallback: 'conflict' },
    lane: { path: 'affected_block_ref', fallback: 'conflict' },
  },
  relations: {
    affectedBlock: 'affected_block_ref',
    ownerMessage: 'owner_message_ref',
  },
};

function withActions(
  block: CalendarTimeBlock | null,
  actions: CalendarActionDescriptorTemplate[] | undefined,
): CalendarTimeBlock | null {
  return block ? { ...block, actions: actions ?? [] } : null;
}

export function readCalendarSyncStates(
  queuedChanges: CalendarQueuedChangeRecord[],
  conflicts: CalendarConflictRecord[],
): CalendarSyncStateProjection {
  const queuedBlocks = queuedChanges
    .map((record) => withActions(projectCalendarTimeBlock(QUEUED_LENS, record), (
      record.retry_descriptor ? [record.retry_descriptor] : []
    )))
    .filter((block): block is CalendarTimeBlock => !!block);

  const conflictBlocks = conflicts
    .map((record) => withActions(projectCalendarTimeBlock(CONFLICT_LENS, record), record.resolve_descriptors))
    .filter((block): block is CalendarTimeBlock => !!block)
    .map((block, index) => ({
      ...block,
      relations: {
        ...block.relations,
        originalInterval: [
          conflicts[index].original_start,
          conflicts[index].original_end,
        ],
      },
    }));

  return {
    queuedBlocks,
    conflictBlocks,
    diagnostics: {
      queuedCount: queuedBlocks.length,
      conflictCount: conflictBlocks.length,
    },
  };
}
