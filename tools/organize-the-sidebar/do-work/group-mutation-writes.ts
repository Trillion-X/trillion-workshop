// packages/group/do-work/group-mutation-writes.ts
//
// PURPOSE
// The ONE generic persistence builder for the Universal Addressed Group. Any
// membership change is a leaf transition `before → after` (the caller ran any
// leaf op — addMember/move/group/ungroup/…); this builder turns that transition
// into a single engine write-batch request. There is NO per-operation branching
// — adding a new leaf operation needs ZERO change here (L069/L090): the diff is
// computed from the two graphs, never from the name of what happened.
//
// No I/O here (pure builder, like the forms package's buildSubmitAnswersRequest);
// a thin dispatcher sends the request to the engine target.

import { groupGraphWriteSet } from '../read-data/group-eeaf.ts';
import type { GroupGraph } from '../../ui/show/group/group-graph';

export const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
export const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
export const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

export interface WriteEntry {
  address_label: string;
  address_mode: 'identity_text';
  path_labels: string[];
  payload: Record<string, unknown>;
}

export interface WriteBatchRequest {
  target: typeof ENGINE_OPERATION_LABEL_TARGET;
  payload: {
    operation_label: typeof ENGINE_WRITE_BATCH_OPERATION;
    writes: WriteEntry[];
  };
}

function entry(address: string, payload: Record<string, unknown>): WriteEntry {
  return {
    address_label: address,
    address_mode: 'identity_text',
    path_labels: [...PUBLISHED_RECORD_PATH],
    payload,
  };
}

/**
 * Persist a membership transition. Upserted groups are written verbatim;
 * dissolved groups are tombstoned (status:'deleted' — the fold drops them). A
 * no-op transition yields an empty `writes` array (O(changed), never O(all)).
 */
export function buildGroupWriteBatch(before: GroupGraph, after: GroupGraph): WriteBatchRequest {
  const { upserts, tombstones } = groupGraphWriteSet(before, after);
  const writes: WriteEntry[] = [
    ...upserts.map((u) => entry(u.address, u.value_json as unknown as Record<string, unknown>)),
    ...tombstones.map((t) => entry(t.address, { ...(t.value_json as unknown as Record<string, unknown>), status: 'deleted' })),
  ];
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: { operation_label: ENGINE_WRITE_BATCH_OPERATION, writes },
  };
}

/**
 * Dispatch a membership transition through a caller-supplied sender (the engine
 * target sender). Returns whatever the sender returns. No-op transitions still
 * call the sender with an empty batch — callers may short-circuit on `writes.length`.
 */
export async function persistGroupMutation(
  before: GroupGraph,
  after: GroupGraph,
  send: (request: WriteBatchRequest) => unknown,
): Promise<unknown> {
  if (typeof send !== 'function') throw new Error('A write-batch sender function is required.');
  return send(buildGroupWriteBatch(before, after));
}
