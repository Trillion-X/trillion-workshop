import { decodeUniversalActionEventDescriptors, decodeUniversalActionEventRecords } from '../read-data/decode-universal-action-event-inputs.ts';
import { projectUniversalActionEvents } from '../read-data/project-universal-action-events.ts';

export function projectOwnerActionEventLogForJscore(input: unknown) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const descriptors = decodeUniversalActionEventDescriptors(source.descriptors);
  const records = decodeUniversalActionEventRecords(source.records);
  return projectUniversalActionEvents({
    records,
    descriptors,
    viewId: typeof source.viewId === 'string' ? source.viewId : undefined,
    selectedId: typeof source.selectedId === 'string' ? source.selectedId : undefined,
    freshness: source.freshness && typeof source.freshness === 'object' ? source.freshness as { value?: string } : undefined,
  });
}

export default projectOwnerActionEventLogForJscore;
