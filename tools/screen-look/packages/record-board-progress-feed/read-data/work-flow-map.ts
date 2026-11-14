import {
  projectSourceCorrelatedRecords,
  type SourceCorrelatedEvent,
  type SourceRecordRef,
} from './source-correlated-records';

export interface WorkFlowItem {
  source: SourceRecordRef;
  latestEvent: SourceCorrelatedEvent | null;
  events: readonly SourceCorrelatedEvent[];
  taskAddress: string | null;
  availability: 'available' | 'unavailable' | 'stale';
}

function taskAddressFor(event: SourceCorrelatedEvent): string | null {
  const raw = event.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = (raw as Record<string, unknown>).taskAddress;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

/**
 * A view over owner events. This never manufactures a stage transition from a
 * task's current status, a wall clock tick, or the absence of a source event.
 */
export function projectWorkFlowMap(
  rawEvents: readonly unknown[],
  declaredSources: readonly SourceRecordRef[],
  nowMs: number,
  staleAfterMs: number,
): WorkFlowItem[] {
  const projection = projectSourceCorrelatedRecords(rawEvents);
  const byAddress = new Map(projection.rows.map((row) => [row.source.address, row]));
  const sourceAddresses = new Set(declaredSources.map((source) => source.address));
  for (const row of projection.rows) sourceAddresses.add(row.source.address);
  return [...sourceAddresses].map((address) => {
    const row = byAddress.get(address);
    const source = declaredSources.find((entry) => entry.address === address) ?? row?.source ?? { address };
    const eventIds = new Set<string>();
    const events = (row?.events ?? []).filter((event) => {
      if (eventIds.has(event.id)) return false;
      eventIds.add(event.id);
      return true;
    });
    const latestEvent = events.at(-1) ?? null;
    const taskAddress = [...events].reverse().map(taskAddressFor).find(Boolean) ?? null;
    const availability = !latestEvent || source.archived || latestEvent.state === 'source-unavailable'
      ? 'unavailable'
      : staleAfterMs > 0 && nowMs - latestEvent.occurredAtMs > staleAfterMs
        ? 'stale'
        : 'available';
    return { source, latestEvent, events, taskAddress, availability };
  }).sort((left, right) => {
    const byTime = (right.latestEvent?.occurredAtMs ?? -1) - (left.latestEvent?.occurredAtMs ?? -1);
    return byTime || left.source.address.localeCompare(right.source.address);
  });
}
