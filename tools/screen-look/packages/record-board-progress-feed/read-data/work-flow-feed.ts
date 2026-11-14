import {
  projectSourceCorrelatedRecords,
  type ProgressDiagnostic,
  type SourceRecordRef,
} from './source-correlated-records';
import { projectWorkFlowMap, type WorkFlowItem } from './work-flow-map';

export type WorkFlowFeedState = 'ready' | 'empty' | 'stale' | 'unavailable' | 'invalid';

export interface WorkFlowFeedView {
  items: readonly WorkFlowItem[];
  state: WorkFlowFeedState;
  diagnostics: readonly ProgressDiagnostic[];
}

/**
 * Adapter for a declared owner event feed. The feed must supply an array of
 * source-correlated events; absence, malformed data, and stale data remain
 * visible states rather than being converted into a plausible work journey.
 */
export function projectWorkFlowFeed(
  rawEvents: unknown,
  declaredSources: readonly SourceRecordRef[],
  nowMs: number,
  staleAfterMs: number,
  feedAvailable: boolean,
): WorkFlowFeedView {
  if (!feedAvailable) {
    return { items: projectWorkFlowMap([], declaredSources, nowMs, staleAfterMs), state: 'unavailable', diagnostics: [] };
  }
  if (!Array.isArray(rawEvents)) {
    return {
      items: projectWorkFlowMap([], declaredSources, nowMs, staleAfterMs),
      state: 'invalid',
      diagnostics: [{ code: 'event-feed-invalid', message: 'The event feed is not an array.' }],
    };
  }
  const projection = projectSourceCorrelatedRecords(rawEvents);
  const items = projectWorkFlowMap(rawEvents, declaredSources, nowMs, staleAfterMs);
  if (projection.events.length === 0) {
    return { items, state: projection.diagnostics.length > 0 ? 'invalid' : 'empty', diagnostics: projection.diagnostics };
  }
  return {
    items,
    state: items.every((item) => item.availability !== 'available') ? 'stale' : 'ready',
    diagnostics: projection.diagnostics,
  };
}
