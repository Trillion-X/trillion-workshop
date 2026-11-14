// packages/media-playback/do-work/reorder-queue.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Persists the current playback queue's ordered-id list as a single scoped
// published-record. This is the ONLY place media-playback writes state (every
// other file in this package is a pure read/render projection). The record is
// source-agnostic: it stores generic media-source ids, never a provider name,
// so a queue can mix a Spotify track, an Apple Music track, and a local file
// in one ordered list with zero branching.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure builder functions (buildReorderQueueWrite / buildReorderQueueRequest)
//    are exported and testable without any network/dispatch dependency —
//    mirrors ask-questions-sort-answers-follow-up/do-work/answer-fact-writes.ts.
// 2. `reorderQueue` is the thin I/O wrapper that dispatches the built request —
//    mirrors this package's own record-playback-event.ts convention.
// 3. Payload carries ONLY generic ids + kind — zero provider vocabulary
//    (Spotify/Apple Music/local-files never appear in this file).
// 4. Single scoped address (`package::media-playback::queue::current`) — one
//    queue per install, last-write-wins. Multi-queue/multi-device is Society
//    scope not required by the current UI (single mini-player + one queue
//    surface); a future multi-queue need is an additional address, not a
//    change to this write shape.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const QUEUE_ADDRESS = 'package::media-playback::queue::current';
const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

export interface ReorderQueueWrite {
  address_label: string;
  address_mode: 'identity_text';
  path_labels: string[];
  payload: {
    kind: 'media-queue';
    ordered_ids: string[];
  };
}

export interface ReorderQueueRequest {
  target: string;
  payload: {
    operation_label: string;
    writes: ReorderQueueWrite[];
  };
}

type ReorderQueueInput = {
  ordered_ids: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('ordered_ids must be an array');
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  if (ids.length === 0) throw new Error('ordered_ids must contain at least one media id');
  return ids;
}

function readInput(value: unknown): ReorderQueueInput {
  if (!isRecord(value)) throw new Error('reorder-queue input must be an object');
  return { ordered_ids: readOrderedIds(value.ordered_ids) };
}

/** Pure builder: one write-batch entry that replaces the current queue order. */
export function buildReorderQueueWrite(orderedIds: string[]): ReorderQueueWrite {
  return {
    address_label: QUEUE_ADDRESS,
    address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'],
    payload: {
      kind: 'media-queue',
      ordered_ids: orderedIds,
    },
  };
}

/** Pure builder: the full engine.operation.write-batch request for a new queue order. */
export function buildReorderQueueRequest(orderedIds: string[]): ReorderQueueRequest {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [buildReorderQueueWrite(orderedIds)],
    },
  };
}

/** I/O wrapper: dispatches the built request through the generic target sender. */
export async function reorderQueue(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget(buildReorderQueueRequest(request.ordered_ids));
}
