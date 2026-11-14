export type CustomerLoopEventKind = 'content' | 'result' | 'run' | 'outcome' | 'repeat' | 'share';

export interface CustomerLoopEvent {
  event_ref: string;
  kind: CustomerLoopEventKind;
  occurred_at_ms: number;
  tenant_ref: string;
  recipient_ref: string;
  provider_ref: string;
  result_ref: string;
  result_revision: string;
  job_ref: string;
  job_revision: string;
  run_ref?: string;
  attribution_ref?: string;
  process_completed?: boolean;
  useful?: boolean;
  latency_ms?: number;
  resource_units?: number;
  cost_minor?: number;
}

export interface CustomerLoopMeasurement {
  joined: boolean;
  attribution_status: 'attributed' | 'outside-window' | 'not-attributed';
  process_completion_count: number;
  useful_result_count: number;
  repeat_count: number;
  share_count: number;
  latency_ms: number | null;
  resource_units: number | null;
  total_cost_minor: number | null;
  cost_per_useful_result_minor: number | null;
}

const REQUIRED_LOOP_KINDS: ReadonlyArray<CustomerLoopEventKind> = ['content', 'result', 'run', 'outcome'];

function costPerUsefulResult(totalCostMinor: number, usefulResultCount: number): number | null {
  if (!Number.isFinite(totalCostMinor) || totalCostMinor < 0) return null;
  if (!Number.isSafeInteger(usefulResultCount) || usefulResultCount <= 0) return null;
  return totalCostMinor / usefulResultCount;
}

/**
 * Joins opaque lifecycle facts only when their recipient journey identities
 * agree. Private job input and source content are deliberately absent from the
 * event contract; traffic-attribution owns the window supplied by the caller.
 */
export function measureCustomerLoop(
  events: ReadonlyArray<CustomerLoopEvent>,
  attributionWindowMs: number,
): CustomerLoopMeasurement {
  const byEventRef = new Map<string, CustomerLoopEvent>();
  for (const event of events) {
    if (typeof event.event_ref !== 'string' || event.event_ref.trim() === '' || byEventRef.has(event.event_ref)) continue;
    byEventRef.set(event.event_ref, event);
  }
  const uniqueEvents = [...byEventRef.values()];
  const anchor = uniqueEvents.reduce<CustomerLoopEvent | undefined>(
    (earliest, event) => (!earliest || event.occurred_at_ms < earliest.occurred_at_ms ? event : earliest),
    undefined,
  );
  if (!anchor || !Number.isSafeInteger(attributionWindowMs) || attributionWindowMs <= 0) {
    return {
      joined: false,
      attribution_status: 'not-attributed',
      process_completion_count: 0,
      useful_result_count: 0,
      repeat_count: 0,
      share_count: 0,
      latency_ms: null,
      resource_units: null,
      total_cost_minor: null,
      cost_per_useful_result_minor: null,
    };
  }
  const sameJourney = uniqueEvents.filter((event) => (
    event.tenant_ref === anchor.tenant_ref
    && event.recipient_ref === anchor.recipient_ref
    && event.provider_ref === anchor.provider_ref
    && event.result_ref === anchor.result_ref
    && event.result_revision === anchor.result_revision
    && event.job_ref === anchor.job_ref
    && event.job_revision === anchor.job_revision
  ));
  const kinds = new Set(sameJourney.map((event) => event.kind));
  const joined = REQUIRED_LOOP_KINDS.every((kind) => kinds.has(kind));
  const processCompletionCount = sameJourney.filter((event) => event.kind === 'outcome' && event.process_completed === true).length;
  const usefulResultCount = sameJourney.filter((event) => event.kind === 'outcome' && event.useful === true).length;
  const latencyMs = sameJourney.reduce<number | null>((maximum, event) => {
    const value = event.latency_ms;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return maximum;
    return maximum == null || value > maximum ? value : maximum;
  }, null);
  const resourceUnits = sameJourney.reduce(
    (sum, event) => sum + (typeof event.resource_units === 'number' && Number.isFinite(event.resource_units) && event.resource_units >= 0 ? event.resource_units : 0),
    0,
  );
  const totalCostMinor = sameJourney.reduce(
    (sum, event) => sum + (typeof event.cost_minor === 'number' && Number.isFinite(event.cost_minor) && event.cost_minor >= 0 ? event.cost_minor : 0),
    0,
  );
  const completed = sameJourney.filter(event => event.kind === 'outcome' && event.process_completed === true);
  const hasCompleteUsage = (field: 'resource_units' | 'cost_minor') => completed.length > 0
    && completed.every(event => typeof event[field] === 'number' && Number.isFinite(event[field]) && event[field]! >= 0);
  const measuredResources = hasCompleteUsage('resource_units') ? resourceUnits : null;
  const measuredCost = hasCompleteUsage('cost_minor') ? totalCostMinor : null;
  const attributionEvent = sameJourney.find((event) => event.kind === 'content' && typeof event.attribution_ref === 'string');
  const firstOutcome = sameJourney.find((event) => event.kind === 'outcome');
  const attributionStatus = !attributionEvent || !firstOutcome
    ? 'not-attributed'
    : firstOutcome.occurred_at_ms >= attributionEvent.occurred_at_ms
      && firstOutcome.occurred_at_ms - attributionEvent.occurred_at_ms <= attributionWindowMs
      ? 'attributed'
      : 'outside-window';
  return {
    joined,
    attribution_status: attributionStatus,
    process_completion_count: processCompletionCount,
    useful_result_count: usefulResultCount,
    repeat_count: sameJourney.filter((event) => event.kind === 'repeat').length,
    share_count: sameJourney.filter((event) => event.kind === 'share').length,
    latency_ms: latencyMs,
    resource_units: measuredResources,
    total_cost_minor: measuredCost,
    cost_per_useful_result_minor: measuredCost === null ? null : costPerUsefulResult(measuredCost, usefulResultCount),
  };
}
