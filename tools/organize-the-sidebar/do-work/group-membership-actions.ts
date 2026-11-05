// packages/group/do-work/group-membership-actions.ts
//
// PURPOSE
// The ONE addressable mutation door for the Universal Addressed Group (master
// plan §4.1 T1). Any surface (sidebar lists, New-tab folders, saved layouts,
// archives, vision boards, AI curation) edits membership by dispatching a
// self-describing op payload here — never by writing group records itself.
//
// SHAPE (L069/L090): `runGroupMutation(op)` where `op` carries its own
// discriminant (`op.kind`) plus the leaf operation's arguments as DATA. Dispatch
// goes through an injected-shape capability map from kind → leaf transition; the
// executor itself never branches on what a mutation MEANS, never enumerates
// member families, and never inspects role/presentation payloads. Adding a new
// leaf op = one map entry, ZERO executor changes.
//
// FLOW per invocation:
//   read reachable group records (loadGroupGraphFromRoots — the ONE live read
//   path) → leaf op (before → after) → buildGroupWriteBatch (diff, O(changed))
//   → ONE engine write-batch. Persistence addressing is entirely owned by
//   group-eeaf + group-mutation-writes (SSOT); nothing here invents addresses.
//
// NON-NEGOTIABLE INVARIANTS
//   - BLIND: ops carry meaning; the executor carries mechanics. No `if (kind)`
//     business logic — only table dispatch.
//   - SSOT: membership rules live in the leaf; record shape in group-eeaf;
//     write protocol in group-mutation-writes. This module only sequences them.
//   - APPEND-ONLY: deletes are tombstones (status:'deleted') emitted by the
//     write-set diff — never blind removals of log history.
//   - PURE CORE: `applyGroupOp` is a pure graph transition (unit-testable with
//     zero I/O); `runGroupMutation` adds only the read/write sequencing.

import type { AddressRef, GroupGraph } from '../../ui/show/group/group-graph';
import { emptyGraph } from '../../ui/show/group/group-graph';
import {
  loadGroupGraphFromRoots,
  type BoardRequestSender,
} from '../read-data/read-group-board.ts';
import { buildGroupWriteBatch, type WriteBatchRequest } from './group-mutation-writes.ts';
import { readTrustedRuntimePartitionIfPresent, sendRequestToBitfieldTarget } from '#workspace-records';

/**
 * Which app's store a group read or write lands in is HOST identity, so it comes
 * from the runtime, never from a literal in this package.
 *
 * These doors used to default to `'bitfield-studio'`, which is a RETIRED app. The
 * write door already omitted the partition when it had none (see
 * `applyGroupMutationTarget`), while the read door substituted the dead name, so a
 * read and a write on the same group could address two different stores with no
 * error, no empty result, and nothing to notice. The sidebar is the caller of both
 * doors, which is how a collection could be written and then not be there.
 *
 * The group read path goes through `buildEngineReadCurrentRequestFromLabels`, the
 * binary frame, whose `partitionBytes()` requires exactly one of a label or a
 * multihash. So this value cannot simply be dropped the way an optional field on
 * the JSON path can. It has to be a real one, and it fails closed when it is not.
 */
function resolveHostPartition(context: unknown, callerSupplied: unknown): string {
  const trusted = readTrustedRuntimePartitionIfPresent(context);
  if (trusted) return trusted;
  if (typeof callerSupplied === 'string' && callerSupplied.length > 0) return callerSupplied;
  throw new Error(
    'group: the runtime supplied no trusted partition label and the caller named none, '
      + 'so this read cannot know which app store to use; substituting a literal would '
      + 'address whichever app that name belongs to',
  );
}

export { OP_TRANSITIONS, applyGroupOp, opRoots, type GroupMutationOp, type GroupOpTransition } from './group-op-transitions.ts';
import { applyGroupOp, opRoots, type GroupMutationOp } from './group-op-transitions.ts';

export interface GroupMutationResult {
  readonly before: GroupGraph;
  readonly after: GroupGraph;
  readonly batch: WriteBatchRequest;
  /** The engine reply (null when the transition was a no-op — nothing written). */
  readonly reply: unknown;
}

/**
 * The live executor: read → leaf op(s) → diff → ONE write-batch. This is the
 * package-target entry (`group.apply-mutation`) — the only door any surface
 * uses to edit membership at runtime. A LIST of ops is one atomic transition:
 * all ops fold over one loaded graph, then ONE diff and ONE write-batch (e.g.
 * "save arrangement as preset" = ensure-group + N add-members in one batch).
 */
export async function runGroupMutation(
  opOrOps: GroupMutationOp | readonly GroupMutationOp[],
  options?: { partitionLabel?: string; sender?: BoardRequestSender },
): Promise<GroupMutationResult> {
  const ops = Array.isArray(opOrOps) ? opOrOps : [opOrOps as GroupMutationOp];
  // No default. Both package-target doors above resolve the host partition and pass
  // it, so an absent one here means an internal caller forgot rather than that a
  // fallback is wanted. Failing loudly is the point: a silent default sends the
  // write to whichever app owns that name.
  const partition = resolveHostPartition(undefined, options?.partitionLabel);
  const sender = options?.sender ?? (sendRequestToBitfieldTarget as BoardRequestSender);
  const roots = ops.flatMap((o) => (o?.groupRef ? opRoots(o) : []));
  const before = roots.length > 0
    ? await loadGroupGraphFromRoots(partition, roots, sender)
    : emptyGraph();
  const after = ops.reduce((graph, o) => applyGroupOp(graph, o), before);
  const batch = buildGroupWriteBatch(before, after);
  const reply = batch.payload.writes.length > 0
    ? await sender(batch as unknown as Parameters<BoardRequestSender>[0])
    : null;
  return { before, after, batch, reply };
}

/**
 * The read door (`group.load-graph`): callers hand roots (AddressRef list) and
 * get the folded GroupGraph back — the L098 translation boundary. Consumers
 * (sidebar, screen-arrangement, anything) never import group internals and
 * never learn the record shape or address family; they speak AddressRefs in,
 * graph out.
 */
export async function loadGroupGraphTarget(input: unknown, context?: unknown): Promise<{
  ok: boolean;
  graph: GroupGraph | null;
  error: string | null;
}> {
  try {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const roots = Array.isArray(raw.roots) ? (raw.roots as AddressRef[]) : [];
    if (roots.length === 0) throw new Error('group.load-graph requires roots: AddressRef[]');
    const partitionLabel = resolveHostPartition(context, raw.partition_label);
    const graph = await loadGroupGraphFromRoots(partitionLabel, roots);
    return { ok: true, graph, error: null };
  } catch (error) {
    return { ok: false, graph: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The package-target export (`package-target-descriptor` → `group.apply-mutation`).
 * Accepts the raw envelope input, validates the minimum shape, executes, and
 * returns a machine-readable receipt (never the raw graphs — callers re-read).
 */
export async function applyGroupMutationTarget(input: unknown, context?: unknown): Promise<{
  ok: boolean;
  kind: string | null;
  writes: number;
  error: string | null;
}> {
  try {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const ops: GroupMutationOp[] = Array.isArray(raw.ops)
      ? (raw.ops as GroupMutationOp[])
      : [((raw.op && typeof raw.op === 'object' ? raw.op : raw) as GroupMutationOp)];
    for (const op of ops) {
      if (!op?.kind || typeof op.kind !== 'string') throw new Error('group mutation requires op.kind');
      if (!op.groupRef || typeof op.groupRef !== 'object') throw new Error('group mutation requires op.groupRef');
    }
    // Resolved the same way as the read door, so a write and a subsequent read of
    // the same group can never land in two different app stores.
    const partitionLabel = resolveHostPartition(context, raw.partition_label);
    const result = await runGroupMutation(ops, { partitionLabel });
    return { ok: true, kind: ops.map((o) => o.kind).join(','), writes: result.batch.payload.writes.length, error: null };
  } catch (error) {
    return {
      ok: false,
      kind: (input as { kind?: string } | null)?.kind ?? null,
      writes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
