// Saved mutation history for the Visual Database's one writer. This module
// records undo steps without importing the transport owner.

import { StaleHistoryStepError, createCommandHistory, type CommandHistory } from '../../ui/show/canvas-history/command-history';
import type { AddressedWrite, RecordWriter } from './record-writes';
import {
  PUBLISHED_RECORD_PATH,
  clonePayloadValue,
  hasRecordWriteInverse,
  isPlainObject,
  recordWriteInverse,
} from './record-write-builders';

// --- Undo: inverses captured at the ONE write boundary, sequenced by the ONE history owner ---
//
// Every durable write funnels through buildRecordWrite / buildRecordDeletion, which keep
// the payload the record had BEFORE the write beside the write itself. Nothing enters the
// history until the writer has SAVED the write (withRecordHistory), and one saved call —
// a single record or a whole multi-record batch — is ONE step, so Cmd-Z undoes the whole
// action the person took. The steps are sequenced by the shared canvas-history owner, so a
// failed restore stays undoable and an edit made while an undo saves is never lost.
//
// A step restores only the top-level fields its own write changed, and only when the saved
// record still holds the values that write left there; otherwise a newer edit (another
// field editor, another device) came after it, and the step is dropped instead of
// overwriting that edit. The read's payload hash (or its absence) also guards the write atomically.

/** The Visual Database's undo history (the shared owner; one per page, like the
 *  single record writer each surface funnels through). */
export const recordHistory: CommandHistory = createCommandHistory({ limit: 50 });

interface RecordStep {
  addressLabel: string;
  pathLabels?: readonly string[];
  before: unknown;
  after: unknown;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The top-level fields a step's write changed. */
function changedFields(before: unknown, after: unknown): string[] {
  const left = isPlainObject(before) ? before : {};
  const right = isPlainObject(after) ? after : {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => stableJson(left[key]) !== stableJson(right[key]));
}

/** Rewrite each record of one step to its `to` side, guarded against newer edits. */
async function restoreStep(writer: RecordWriter, steps: readonly RecordStep[], to: 'before' | 'after'): Promise<void> {
  const readCurrent = writer.readCurrent;
  if (!readCurrent) throw new Error('This list cannot be read back, so the change cannot be undone safely.');
  const writes: AddressedWrite[] = [];
  for (const step of steps) {
    const target = to === 'before' ? step.before : step.after;
    const expected = to === 'before' ? step.after : step.before;
    const current = await readCurrent(step.addressLabel);
    const fields = changedFields(step.before, step.after);
    if (expected === null || expected === undefined) {
      if (current) throw new StaleHistoryStepError();
    } else if (!current || !isPlainObject(current.payload) || !isPlainObject(expected)
      || fields.some((key) => stableJson((current.payload as Record<string, unknown>)[key]) !== stableJson(expected[key]))) {
      throw new StaleHistoryStepError();
    }
    let payload: unknown;
    if (target === null || target === undefined) payload = null;
    else if (!current || !isPlainObject(target)) payload = clonePayloadValue(target);
    else {
      const merged: Record<string, unknown> = clonePayloadValue(current.payload as Record<string, unknown>);
      for (const key of fields) {
        if (key in target) merged[key] = clonePayloadValue(target[key]);
        else delete merged[key];
      }
      payload = merged;
    }
    writes.push({
      addressLabel: step.addressLabel,
      payload,
      pathLabels: step.pathLabels ?? PUBLISHED_RECORD_PATH,
      // Atomic guard: the record still hashes as just read, or is still absent (a restore never lands on a
      // record re-created at that address meanwhile).
      expectedCurrent: { payloadHash: current ? current.payloadHash : null },
    });
  }
  await (writes.length === 1 ? writer(writes[0]!) : writer.batch(writes));
}

/** The record writer every surface funnels through, recording each SAVED call as one
 *  undo step. A writer that cannot read its records back records nothing: an undo it
 *  could not check against newer edits would risk overwriting them. */
export function withRecordHistory(writer: RecordWriter, history: CommandHistory = recordHistory): RecordWriter {
  const remember = (entries: readonly AddressedWrite[]) => {
    if (!writer.readCurrent) return;
    const steps: RecordStep[] = entries
      .filter(hasRecordWriteInverse)
      .map((entry) => ({
        addressLabel: entry.addressLabel,
        pathLabels: entry.pathLabels,
        before: recordWriteInverse(entry),
        after: entry.payload,
      }));
    if (steps.length === 0) return;
    history.record({
      revert: () => restoreStep(writer, steps, 'before'),
      apply: () => restoreStep(writer, steps, 'after'),
    });
  };
  const wrapped = (async (entry: AddressedWrite) => {
    await writer(entry);
    remember([entry]);
  }) as RecordWriter;
  wrapped.batch = async (entries) => {
    await writer.batch(entries);
    remember(entries);
  };
  for (const key of ['partitionLabel', 'readCurrent'] as const) {
    if (writer[key]) {
      Object.defineProperty(wrapped, key, { configurable: false, enumerable: true, value: writer[key], writable: false });
    }
  }
  return wrapped;
}

