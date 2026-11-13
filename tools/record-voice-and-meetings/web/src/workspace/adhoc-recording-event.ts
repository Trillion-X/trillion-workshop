// src/workspace/adhoc-recording-event.ts
//
// PURPOSE
//   "Create calendar events for ad-hoc recordings": once a recording that belongs to no calendar event is kept, and the
//   person turned that setting on (parts/record-audio/read-data/meeting-settings.mjs), an event spanning the recording
//   is put on their default calendar through the same calendar action road the Calendar screen writes with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The default calendar is the one saved in the `calendar-settings` preference; with none saved, the first
//      connected calendar that accepts new events. With no such calendar nothing is written and the person is told.
//   2. One recording makes at most one event: the request key is the recording's own id, so a retry is the same write.
//   3. A failure never loses the recording; the person is told in the DATA words (meeting-settings.json adhoc_event).

import settingsWords from '../../../read-data/meeting-settings.json';
import { adhocEventInput } from '../../../read-data/meeting-settings.mjs';
import type { RecordingSavedFact } from '../../parts/record-audio/show/RecordAudioPanel';
import { notify } from '../../parts/ui/show/coss/notifications';
import { postJson, readJson } from './api';
import { readWorkspacePreference } from './records';

type Selection = { source_id?: string; connection_id?: string; calendar_id?: string };
type Source = { id: string; connected?: boolean; writable?: boolean; calendar_actions?: { create?: unknown }; selection?: Selection };
type DefaultCalendar = { source_id?: string; connection_id?: string; calendar_id?: string };

const words = settingsWords.adhoc_event;

function target(sources: Source[]): Source | null {
  const writable = sources.filter(source => source.connected !== false && source.writable === true && source.calendar_actions?.create);
  const saved = readWorkspacePreference<{ defaultCalendar?: DefaultCalendar }>('calendar-settings')?.defaultCalendar;
  const chosen = saved ? writable.find(source => source.selection?.source_id === saved.source_id
    && source.selection?.connection_id === saved.connection_id && source.selection?.calendar_id === saved.calendar_id) : undefined;
  return chosen ?? writable[0] ?? null;
}

/** Puts the event for one kept recording on the default calendar when the setting is on and no event owns it. */
export async function keepAdhocRecordingEvent(settings: unknown, saved: RecordingSavedFact): Promise<void> {
  if (saved.hasMeetingEvent) return;
  const event = adhocEventInput(settings, { startedAt: saved.startedAt, endedAt: saved.endedAt });
  if (!event) return;
  try {
    const listed = await readJson<{ sources?: Source[] }>(`/work/api/calendar?from=${encodeURIComponent(event.start)}&to=${encodeURIComponent(event.end)}`);
    const source = target(listed.sources ?? []);
    if (!source) { notify(words.no_calendar, { kind: 'info' }); return; }
    const answer = await postJson<{ state: string }>('/work/api/calendar/actions', {
      source: source.id, action: 'create', request_key: `adhoc-recording:${saved.recordingId}`,
      input: { ...event, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    if (answer.state !== 'completed') throw new Error(words.failed);
    notify(words.kept.replace('{title}', event.title), { kind: 'done' });
  } catch {
    notify(words.failed, { kind: 'error' });
  }
}
