// src/workspace/calendar-screen-core.ts
//
// PURPOSE
//   What the Calendar screen and its event forms (calendar-event-forms.tsx) both read: the shape of an item and of a source,
//   how a source's row is found, the words for a time, and the two roads that run a source's action (an action row's own
//   road, and a provider write that is only done when Workshop says it completed).

import type { EventPropertyChoice, EventPropertySetting } from '../../parts/ui';
import type { TaskRecurrenceValue } from '../../parts/ui/show/task-recurrence/TaskRecurrence';
import sourceData from '../calendar.json';
import screenData from './shared-calendar.json';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { postJson } from './api';
import { openAddress, openScreen } from './open-screen';
import type { CalendarSelection } from './calendar-controls';

const words = screenData.words;

export type Item = {
  id: string; source: string; source_id: string; title: string; about: string | null; starts_at: string; ends_at: string | null; all_day: boolean;
  space_id: string | null; space_title: string | null; going: boolean | null; may_move: boolean; may_cancel?: boolean; status: string | null; link: string | null;
  location?: string | null; conference_url?: string | null; attendees?: { name?: string; email?: string }[];
  day?: string; day_end?: string;
  recurring_event_id?: string | null;
  color_id?: string | null; visibility?: string | null; transparency?: string | null;
};

export type EventPropertyName = 'color' | 'privacy' | 'availability';
export type EventPropertyDeclaration = { input_field: string; choices: (EventPropertyChoice & { input_value?: string | null })[] };
export type EventPropertyDraft = Record<EventPropertyName, EventPropertySetting>;
export type Source = { id: string; look?: { label: string; icon?: string; tone?: string }; move?: Road; actions?: Action[]; calendar_actions?: Record<string, { tool: string; supports_all_day?: boolean }>; connect?: { label: string; href: string }; event_properties?: Partial<Record<EventPropertyName, EventPropertyDeclaration>>; event_colors?: EventPropertyChoice[]; event_colors_unavailable?: boolean };

export type SourceState = { id: string; label: string; read: boolean; connected?: boolean; said?: string; complete?: boolean; next_cursor?: string | null; base_source?: string; look?: Source['look']; selection?: CalendarSelection; writable?: boolean; calendar_actions?: Source['calendar_actions']; actions?: Action[]; move?: Road; connect?: Source['connect']; event_properties?: Source['event_properties']; event_colors?: EventPropertyChoice[]; event_colors_unavailable?: boolean };

export type Road = { post?: string; body?: Record<string, unknown>; href?: string; opens?: string; said?: string; calendar_action?: string };
export type Action = Road & { id: string; label: string; shows_when?: { field: string; is: unknown }; tone?: string; confirm?: { asks: string; yes: string; no: string } };

export const SOURCES = new Map((sourceData.sources as Source[]).map(source => [source.id, source]));
export const sourceFor = (id: string, states: SourceState[] = []) => {
  const state = states.find(source => source.id === id);
  const base = sourceData.sources.find(source => source.id === (state?.base_source ?? id)) as Source | undefined;
  return state ? { ...base, ...state } as Source : SOURCES.get(id);
};
export const fill = (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const fillAll = (value: unknown, values: Record<string, unknown>): unknown => (typeof value === 'string' ? fill(value, values)
  : Array.isArray(value) ? value.map(item => fillAll(item, values))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillAll(item, values)])) : value);
export const whenWords = (item: Item) => (item.all_day ? `${new Date(item.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${words.all_day}`
  : `${new Date(item.starts_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${item.ends_at ? ` – ${new Date(item.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`);
export const minutesOf = (item: Item) => (item.ends_at ? Math.max(15, (Date.parse(item.ends_at) - Date.parse(item.starts_at)) / 60_000) : undefined);
export const localInput = (iso: string) => { const at = new Date(iso); return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
export const sourceLabel = (id: string, states: SourceState[] = []) => sourceFor(id, states)?.look?.label ?? id;

export const itemActions = (item: Item, sources: SourceState[]) => (sourceFor(item.source, sources)?.actions ?? []).filter(action => !action.shows_when || (item as Record<string, unknown>)[action.shows_when.field] === action.shows_when.is);

/** Runs one road a source's row names for an item (a post, an address, a screen), saying what happened. */
export async function runRoad(road: Road, values: Record<string, unknown>): Promise<boolean> {
  if (road.calendar_action) {
    await calendarWrite(String(values.source), road.calendar_action, { event_id: values.source_id, ...(road.calendar_action === 'move' ? { start: values.at, end: values.ends_at } : {}) });
    return true;
  }
  if (road.opens) { openScreen(road.opens); return false; }
  if (road.href) {
    const address = fill(road.href, values);
    if (!openAddress(address)) window.open(address, address.startsWith('/') ? '_self' : '_blank', 'noopener');
    return false;
  }
  if (!road.post) return false;
  const answer = await postJson<{ displaced?: string[]; undo?: unknown }>(fill(road.post, values), fillAll(road.body ?? {}, values));
  if (road.said) notify(road.said, { kind: 'done' });
  // A move over tasks the planner placed took them off the calendar (when the person chose that): say so, with the way back.
  if (answer?.displaced?.length) {
    notify(fill(words.refit_moved, { count: String(answer.displaced.length) }), {
      kind: 'info', timeout: 2 * 60 * 1000, key: 'refit-moved',
      actions: [
        ...(answer.undo ? [{ id: 'undo', label: words.undo, onAction: () => { void postJson('/work/api/calendar/tasks', answer.undo).catch(error => notify(errorWords(error), { kind: 'error' })); } }] : []),
        { id: 'disable', label: words.refit_disable, onAction: () => { void postJson('/work/api/calendar/tasks', { action: 'set_preferences', refit_on_move: false }).catch(error => notify(errorWords(error), { kind: 'error' })); } },
      ],
    });
  }
  return true;
}

/** A provider write is only successful when Workshop says it completed. Pending work stays visible in Runs. */
export async function calendarWrite(source: string, action: string, input: Record<string, unknown>, key = crypto.randomUUID()) {
  const answer = await postJson<{ state: string; error?: unknown; task_id?: string }>('/work/api/calendar/actions', { source, action, input, request_key: key });
  if (answer.state !== 'completed') {
    const detail = typeof answer.error === 'string' ? answer.error : (answer.error as { message?: string })?.message;
    throw new Error(detail || (answer.state === 'failed' || answer.state === 'refused' ? words.write_failed : words.write_pending));
  }
  return answer;
}


/** One personal task, as /work/api/calendar/tasks answers it (src/calendar-tasks.mjs taskOf). */
export type Task = {
  id: string; title: string; manual_order?: string | null; parent_id?: string | null; collection_id?: string | null; duplicate_of?: string | null; description?: string;
  priority?: string | null; labels?: string[]; recurrence?: TaskRecurrenceValue | null; duration_minutes: number; due: string | null;
  minimum_duration_minutes?: number | null; slice_of?: string | null; deadline_type?: string | null; start_on?: string | null; blocked_by?: string[];
  pinned_until?: string | null; snoozed_until?: string | null; reminder_at?: string | null; reminder_delivered_at?: string | null;
  created_at?: string | null; time_spent_minutes?: number; smart_list?: string | null;
  auto_placed?: boolean; starts_at: string | null; ends_at: string | null; status: string; source_url?: string | null; source_id?: string | null;
};
/** One of the person's own task lists, with the settings the Todos page keeps on it. */
export type TaskCollection = {
  id: string; title: string; color?: string | null; default_calendar?: { source_id: string; calendar_id: string } | null; archived?: boolean;
  ai_scheduling?: boolean | null; preferred_times?: { start_minute: number; end_minute: number; weekdays?: number[] } | null;
};
