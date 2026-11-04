// Generic action-result readback for destination-keyed effects. The action
// result carries only opaque refs; labels remain on destination DATA and are
// re-resolved live, so a renamed destination is reflected without rewriting an
// immutable result record.

import { readPublishedRecords } from '../../ui/show/placeable-surface-intent';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textAt(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return null;
}

export type DestinationActionReadback = {
  readonly destinationRef: string;
  readonly label: string;
  readonly state: string;
  readonly attemptRef?: string;
  readonly proofRef?: string;
  readonly blockerRef?: string;
};

/** Resolve action result refs against the current live feed. This accepts any
 * result record with a destination_ref + state and never names a channel,
 * transport, package, or a closed lifecycle enum. */
export function resolveDestinationActionReadback(
  resultRefs: readonly string[],
  publishedRows: unknown,
): DestinationActionReadback[] {
  const records = readPublishedRecords(publishedRows);
  const byRef = new Map(records.map((record) => [record.recordId, record.payload]));
  const destinations = new Map<string, unknown>();
  for (const record of records) {
    const payload = record.payload;
    // Result rows also carry destination_ref; only a live human-labelled row
    // is a destination projection. Never let an immutable result overwrite it.
    if (!isRecord(payload) || !textAt(payload, ['label', 'title', 'name'])) continue;
    destinations.set(record.recordId, payload);
    for (const key of ['destination_id', 'destination_ref', 'target_id', 'id']) {
      const ref = textAt(payload, [key]);
      if (ref) destinations.set(ref, payload);
    }
  }
  const result: DestinationActionReadback[] = [];
  for (const resultRef of resultRefs) {
    const payload = byRef.get(resultRef);
    if (!isRecord(payload)) continue;
    const destinationRef = textAt(payload, ['destination_ref']);
    const state = textAt(payload, ['state']);
    if (!destinationRef || !state) continue;
    const destination = destinations.get(destinationRef);
    const label = textAt(destination, ['label', 'title', 'name', 'destination_id']) ?? destinationRef;
    result.push({
      destinationRef,
      label,
      state,
      ...(textAt(payload, ['attempt_ref']) ? { attemptRef: textAt(payload, ['attempt_ref']) as string } : {}),
      ...(textAt(payload, ['proof_ref']) ? { proofRef: textAt(payload, ['proof_ref']) as string } : {}),
      ...(textAt(payload, ['blocker_ref']) ? { blockerRef: textAt(payload, ['blocker_ref']) as string } : {}),
    });
  }
  return result;
}
