// parts/guided-overlay/do-work/walkthrough-progress.ts
//
// PURPOSE
// The one place a person's tour progress is written. A person has ONE progress record
// (label `guided-overlay::walkthrough-progress`), kept in their own Trillion store by the
// workspace's label-addressed records (src/workspace/records.ts, saved through
// /work/api/records), so a finished tour stays finished on every browser they sign in on.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A transition is compare-and-set on the tour's own cursor: it is accepted only
//      from the step and revision the run last saw. A different run of the same tour
//      (a replay, another tab) starts its own cursor at revision 0.
//   2. Consuming a once_key records when it was consumed; a key is consumed once, and
//      its first time is kept. A tour that stands for others (catch-up) consumes their
//      keys in the same write (`also_once_keys`).
//   3. The same transition sent twice is answered from the record, not applied twice.
//   4. Nothing here names a tour, a step, or a trigger reason: they are DATA.

import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  readSavedRecordFromOwner,
  savedRecordWritesAreReadOnly,
  sendRequestToBitfieldTarget,
  trackSavedRecordAcceptance,
} from '#workspace-records';
import { WALKTHROUGH_PROGRESS_KIND } from '../read-data/walkthrough-eeaf';

export const WALKTHROUGH_PROGRESS_LABEL = 'guided-overlay::walkthrough-progress';
/** How many recent transitions the record keeps to answer a repeated send. */
const KEPT_TRANSITIONS = 32;
const ACCEPTANCE_WAIT_MS = 15_000;

export interface ProgressTransitionRequest {
  readonly run_id: string;
  readonly definition_id: string;
  readonly definition_revision: number;
  readonly expected_cursor_revision: number;
  readonly from_step_id: string;
  readonly to_step_id: string;
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
  readonly cause: 'advance' | 'back';
  readonly once_key?: string | null;
  /** More once_keys consumed with `once_key`: the catch-up tours this one stood for. */
  readonly also_once_keys?: readonly string[];
}

export interface ProgressTransitionReceipt {
  readonly accepted: boolean;
  readonly deduplicated: boolean;
  readonly transition_ref: string;
  readonly run_id: string;
  readonly definition_id: string;
  readonly cursor_revision: number;
  readonly current_step_id: string;
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
  readonly reason?: 'stale-cursor' | 'cursor-mismatch';
}

interface SavedCursor {
  run_id: string;
  definition_revision: number;
  current_step_id: string;
  history: string[];
  status: 'active' | 'complete';
  cursor_revision: number;
}

export interface ProgressRecord {
  kind: typeof WALKTHROUGH_PROGRESS_KIND;
  consumed_once_keys: string[];
  consumed_at: Record<string, string>;
  cursors: Record<string, SavedCursor>;
  transitions: ProgressTransitionReceipt[];
}

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord => (value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** The saved record in its canonical shape; anything unreadable becomes an empty record. */
export function readProgressRecord(value: unknown): ProgressRecord {
  const source = object(value);
  const consumedAt: Record<string, string> = {};
  for (const [key, at] of Object.entries(object(source.consumed_at))) if (typeof at === 'string') consumedAt[key] = at;
  const cursors: Record<string, SavedCursor> = {};
  for (const [definitionId, raw] of Object.entries(object(source.cursors))) {
    const cursor = object(raw);
    if (typeof cursor.current_step_id !== 'string') continue;
    cursors[definitionId] = {
      run_id: typeof cursor.run_id === 'string' ? cursor.run_id : '',
      definition_revision: Number.isSafeInteger(cursor.definition_revision) ? Number(cursor.definition_revision) : 1,
      current_step_id: cursor.current_step_id,
      history: strings(cursor.history),
      status: cursor.status === 'complete' ? 'complete' : 'active',
      cursor_revision: Number.isSafeInteger(cursor.cursor_revision) ? Number(cursor.cursor_revision) : 0,
    };
  }
  return {
    kind: WALKTHROUGH_PROGRESS_KIND,
    consumed_once_keys: [...new Set(strings(source.consumed_once_keys))].sort(),
    consumed_at: consumedAt,
    cursors,
    transitions: Array.isArray(source.transitions)
      ? source.transitions.filter((item): item is ProgressTransitionReceipt => typeof object(item).transition_ref === 'string')
      : [],
  };
}

function transitionRef(request: ProgressTransitionRequest): string {
  return [request.definition_id, request.definition_revision, request.run_id, request.expected_cursor_revision,
    request.from_step_id, request.to_step_id, request.status, request.cause]
    .map((part) => encodeURIComponent(String(part))).join('::');
}

/** Apply one transition to the saved record: the next record and the answer to give. */
export function applyProgressTransition(
  currentValue: unknown,
  request: ProgressTransitionRequest,
  now: string,
): { readonly state: ProgressRecord; readonly receipt: ProgressTransitionReceipt } {
  const current = readProgressRecord(currentValue);
  const ref = transitionRef(request);
  const prior = current.transitions.find((receipt) => receipt.transition_ref === ref);
  if (prior) return { state: current, receipt: { ...prior, deduplicated: true } };

  const saved = current.cursors[request.definition_id];
  // Another run of this tour (a replay, another tab) begins its own cursor.
  const sameRun = saved && saved.run_id === request.run_id && saved.definition_revision === request.definition_revision;
  const revision = sameRun ? saved.cursor_revision : 0;
  const stepId = sameRun ? saved.current_step_id : request.from_step_id;
  if (request.expected_cursor_revision !== revision || stepId !== request.from_step_id) {
    return { state: current, receipt: {
      accepted: false, deduplicated: false, transition_ref: ref, run_id: request.run_id, definition_id: request.definition_id,
      cursor_revision: revision, current_step_id: stepId, history: sameRun ? saved.history : [],
      status: sameRun ? saved.status : 'active',
      reason: request.expected_cursor_revision !== revision ? 'stale-cursor' : 'cursor-mismatch',
    } };
  }
  const receipt: ProgressTransitionReceipt = {
    accepted: true, deduplicated: false, transition_ref: ref, run_id: request.run_id, definition_id: request.definition_id,
    cursor_revision: revision + 1, current_step_id: request.to_step_id, history: [...request.history], status: request.status,
  };
  const consumed = new Set(current.consumed_once_keys);
  const consumedAt = { ...current.consumed_at };
  const keys = request.once_key ? [request.once_key, ...(request.also_once_keys ?? [])] : [];
  for (const key of keys) {
    if (typeof key !== 'string' || !key || consumed.has(key)) continue;
    consumed.add(key);
    consumedAt[key] = now;
  }
  return { state: {
    kind: WALKTHROUGH_PROGRESS_KIND,
    consumed_once_keys: [...consumed].sort(),
    consumed_at: consumedAt,
    cursors: { ...current.cursors, [request.definition_id]: {
      run_id: request.run_id, definition_revision: request.definition_revision, current_step_id: request.to_step_id,
      history: [...request.history], status: request.status, cursor_revision: receipt.cursor_revision,
    } },
    transitions: [...current.transitions, receipt].slice(-KEPT_TRANSITIONS),
  }, receipt };
}

type Sender = (request: { target: string; payload: unknown }) => Promise<{ payload: Uint8Array }>;

/** The workspace's label-addressed writer answers with the number of records it saved. */
function writtenCount(reply: { payload: Uint8Array }): number {
  const bytes = reply.payload;
  if (bytes.byteLength === 8) {
    let count = 0;
    for (let shift = 7; shift >= 0; shift -= 1) count = count * 256 + bytes[shift]!;
    return Number.isSafeInteger(count) ? count : 0;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { written?: unknown; write_count?: unknown };
    const count = value.written ?? value.write_count;
    return typeof count === 'number' && Number.isSafeInteger(count) ? count : 0;
  } catch {
    return 0;
  }
}

/** A late or lost outbox reply is settled only by a fresh read from the saved-record owner. */
async function awaitProgressAcceptance(
  accepted: Promise<unknown>,
  acceptanceWaitMs: number,
  confirms: (saved: ProgressRecord) => boolean,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const acknowledged = await Promise.race([
      accepted.then(() => true),
      new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), acceptanceWaitMs); }),
    ]);
    if (acknowledged) return;
    const remote = await readSavedRecordFromOwner(WALKTHROUGH_PROGRESS_LABEL);
    if (!remote.found || !confirms(readProgressRecord(remote.value))) {
      throw new Error('Your tour could not finish yet. Try again.');
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Save one transition in the person's progress record and answer whether it was accepted. */
export async function commitWalkthroughProgress(
  request: ProgressTransitionRequest,
  send: Sender = sendRequestToBitfieldTarget,
  now: () => string = () => new Date().toISOString(),
  acceptanceWaitMs = ACCEPTANCE_WAIT_MS,
): Promise<ProgressTransitionReceipt> {
  const read = decodeEngineReadCurrentReply((await send(buildEngineReadCurrentRequestFromLabels('person', WALKTHROUGH_PROGRESS_LABEL))).payload);
  const current = read.found ? JSON.parse(new TextDecoder().decode(read.payload)) : null;
  const { state, receipt } = applyProgressTransition(current, request, now());
  if (receipt.accepted) {
    const writeRequest = buildEngineWriteBatchRequestFromLabels([{
      addressLabel: WALKTHROUGH_PROGRESS_LABEL,
      payload: state,
      expectedIdentity: read.contentHash,
    }], { conflictPolicy: 'retry' });
    const outgoing = (writeRequest.payload as { writes: Array<{ address_label: string; payload: unknown; expected_identity?: string | null }> }).writes[0]!;
    const durable = send === sendRequestToBitfieldTarget && !savedRecordWritesAreReadOnly()
      ? trackSavedRecordAcceptance(WALKTHROUGH_PROGRESS_LABEL, outgoing.payload, outgoing.expected_identity, 'retry') : null;
    try {
      const written = await send(writeRequest);
      if (writtenCount(written) !== 1) throw new Error('The tour progress could not be saved.');
      if (durable) {
        const keys = request.once_key ? [request.once_key, ...(request.also_once_keys ?? [])] : [];
        await awaitProgressAcceptance(durable.accepted, acceptanceWaitMs, saved => {
          const cursor = saved.cursors[request.definition_id];
          const exactTransition = saved.transitions.some(item => item.accepted && item.transition_ref === receipt.transition_ref);
          const exactCursor = cursor?.run_id === request.run_id
            && cursor.definition_revision === request.definition_revision
            && cursor.cursor_revision === request.expected_cursor_revision + 1
            && cursor.current_step_id === request.to_step_id
            && cursor.status === request.status
            && JSON.stringify(cursor.history) === JSON.stringify(request.history);
          return (exactTransition || exactCursor) && keys.every(key => saved.consumed_once_keys.includes(key));
        });
        durable.cancel();
      }
    } catch (error) {
      durable?.cancel();
      throw error;
    }
  }
  return receipt;
}

/** Consume one DATA key without changing a tour cursor; other pending transitions keep their place. */
export async function consumeWalkthroughProgressKey(
  onceKey: string,
  send: Sender = sendRequestToBitfieldTarget,
  now: () => string = () => new Date().toISOString(),
  acceptanceWaitMs = ACCEPTANCE_WAIT_MS,
): Promise<boolean> {
  if (!onceKey) throw new Error('A tour progress key is required.');
  const read = decodeEngineReadCurrentReply((await send(buildEngineReadCurrentRequestFromLabels('person', WALKTHROUGH_PROGRESS_LABEL))).payload);
  const current = read.found ? JSON.parse(new TextDecoder().decode(read.payload)) : null;
  const state = readProgressRecord(current);
  // A read can include a local optimistic write whose durable acceptance failed or timed out. Even when
  // the key is already visible, retry an accepted write before saying it is consumed. Keep its first time.
  const next: ProgressRecord = {
    ...state,
    consumed_once_keys: [...new Set([...state.consumed_once_keys, onceKey])].sort(),
    consumed_at: { ...state.consumed_at, [onceKey]: state.consumed_at[onceKey] ?? now() },
  };
  const writeRequest = buildEngineWriteBatchRequestFromLabels([{
    addressLabel: WALKTHROUGH_PROGRESS_LABEL, payload: next, expectedIdentity: read.contentHash,
  }], { conflictPolicy: 'retry' });
  const outgoing = (writeRequest.payload as { writes: Array<{ address_label: string; payload: unknown; expected_identity?: string | null }> }).writes[0]!;
  const durable = send === sendRequestToBitfieldTarget && !savedRecordWritesAreReadOnly()
    ? trackSavedRecordAcceptance(WALKTHROUGH_PROGRESS_LABEL, outgoing.payload, outgoing.expected_identity, 'retry') : null;
  try {
    const written = await send(writeRequest);
    if (writtenCount(written) !== 1) throw new Error('The tour progress could not be saved.');
    if (durable) {
      await awaitProgressAcceptance(durable.accepted, acceptanceWaitMs, saved => saved.consumed_once_keys.includes(onceKey));
      durable.cancel();
    }
    return true;
  } catch (error) {
    durable?.cancel();
    throw error;
  }
}
