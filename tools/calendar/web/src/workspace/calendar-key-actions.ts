// src/workspace/calendar-key-actions.ts
//
// PURPOSE
//   The Calendar's actions on one event that its source makes possible, as context actions (the right-click menu and the
//   keys of src/workspace/keymap.json (the calendar rows) run the same ones): answer an invitation, make the event private or not,
//   change its colour, join its call. Each is built from the rows of calendar-key-actions.json and shown only for an
//   event whose source declares what the action needs (an action naming it as its `command`, an edit action with a
//   privacy or colour property, a call address, the done boxes turned on), so no key does nothing silently and no source is named here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows a source: what an event can do is read from the source's declared actions and properties.
//   2. An action that asks "are you sure" (a source action with `confirm`) is never run by a key: it is handed to the
//      screen to ask first. Every other action runs and says what it did, or says what refused it.
//   3. The edit an action sends is the whole event as it stands plus the one change, in the same shape the event editor
//      sends, so a source that replaces an event never loses its title, place, notes or times.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { NodeActionCapability, NodeRef } from '../../parts/ui/show/node-actions';
import { addDays } from '../../parts/ui';
import { KEYMAP, onMac, type EffectiveRow } from './keymap-runtime';
import { shownChord } from './keymap.mjs';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import data from './calendar-key-actions.json';

type Row = { id: string; label: string; icon: string; kind: string; [more: string]: unknown };
const rows = data.actions as Row[];

/** What an event is, as far as these actions read it. */
export interface KeyActionEvent {
  id: string; source: string; source_id: string; title: string; about: string | null; location?: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean; may_move: boolean; conference_url?: string | null;
  color_id?: string | null; visibility?: string | null;
}
export interface KeyActionSourceAction { id: string; command?: string; confirm?: unknown; shows_when?: { field: string; is: unknown } }
export interface KeyActionSource {
  actions?: KeyActionSourceAction[];
  calendar_actions?: Record<string, unknown>;
  event_properties?: Partial<Record<'color' | 'privacy', { input_field: string; choices: { value: string; label: string; input_value?: string | null }[] }>>;
  event_colors?: { value: string; label: string }[];
}

export interface KeyActionDeps {
  /** The event with this id, or null (a task or an unknown id). */
  eventOf(id: string): KeyActionEvent | null;
  sourceOf(event: KeyActionEvent): KeyActionSource | undefined;
  /** The source actions offered for this event now (their `shows_when` already applied). */
  actionsOf(event: KeyActionEvent): KeyActionSourceAction[];
  /** Run a source action and read the calendar again. */
  runAction(event: KeyActionEvent, action: KeyActionSourceAction): Promise<void>;
  /** Show the screen's own question for an action that asks first. */
  askAction(event: KeyActionEvent, action: KeyActionSourceAction): void;
  /** Send an edit of this event to its source and read the calendar again. */
  writeEdit(event: KeyActionEvent, input: Record<string, unknown>): Promise<void>;
  /** The input fields a property choice means for this source (the event editor's own mapping). */
  propertyFields(source: KeyActionSource | undefined, draft: Record<string, { kind: 'set'; value: string }>): Record<string, unknown>;
  join(event: KeyActionEvent): void;
  /** Whether the person turned on the done boxes of events, whether this event is marked done, and marking it. */
  doneOffered(): boolean;
  isDone(id: string): boolean;
  setDone(id: string, done: boolean): void;
  say(words: string, kind: 'done' | 'info' | 'error'): void;
}

/** The edit that keeps an event as it is and changes only what `extra` names. */
export function wholeEventEdit(event: KeyActionEvent, extra: Record<string, unknown>, zone: string): Record<string, unknown> {
  const start = event.starts_at;
  const end = event.ends_at ?? new Date(Date.parse(start) + 3_600_000).toISOString();
  return {
    event_id: event.source_id, title: event.title, description: event.about ?? '', location: event.location ?? '',
    start: event.all_day ? { date: start.slice(0, 10) } : { dateTime: new Date(start).toISOString(), timeZone: zone },
    end: event.all_day ? { date: event.ends_at ? event.ends_at.slice(0, 10) : addDays(start.slice(0, 10), 1) } : { dateTime: new Date(end).toISOString(), timeZone: zone },
    ...extra,
  };
}

const colorsOf = (source: KeyActionSource | undefined) => (source?.event_properties?.color?.choices ?? []).filter(choice => choice.value !== 'default');
const canEdit = (event: KeyActionEvent, source: KeyActionSource | undefined) => Boolean(event.may_move && source?.calendar_actions?.edit);
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const idOf = (node: NodeRef) => node.family === 'schedule-calendar-item' ? node.parts?.id : undefined;

/** The context actions, one per row of calendar-key-actions.json, each accepting only an event that can do it. */
export function calendarKeyActions(deps: KeyActionDeps, shortcutOf: (actionId: string) => string | undefined, zone: string): NodeActionCapability[] {
  const eventFor = (node: NodeRef) => { const id = idOf(node); return id ? deps.eventOf(id) : null; };
  return rows.map((row): NodeActionCapability => {
    const base = { id: row.id, label: row.label, icon: row.icon, shortcut: shortcutOf(row.id) };
    if (row.kind === 'source_action') {
      const actionFor = (event: KeyActionEvent) => deps.actionsOf(event).find(action => action.command === row.id);
      return { ...base, accepts: node => { const event = eventFor(node); return Boolean(event && actionFor(event)); },
        run: async node => {
          const event = eventFor(node), action = event && actionFor(event);
          if (!event || !action) return;
          if (action.confirm) deps.askAction(event, action); else await deps.runAction(event, action);
        } };
    }
    if (row.kind === 'privacy') {
      const declaration = (event: KeyActionEvent) => deps.sourceOf(event)?.event_properties?.privacy;
      return { ...base, accepts: node => { const event = eventFor(node); return Boolean(event && canEdit(event, deps.sourceOf(event)) && declaration(event)); },
        run: async node => {
          const event = eventFor(node), source = event && deps.sourceOf(event);
          if (!event || !canEdit(event, source)) return;
          const wanted = event.visibility === row.private ? String(row.otherwise) : String(row.private);
          try {
            await deps.writeEdit(event, wholeEventEdit(event, deps.propertyFields(source, { privacy: { kind: 'set', value: wanted } }), zone));
            deps.say(String(wanted === row.private ? row.private_said : row.public_said), 'done');
          } catch (error) { deps.say(errorWords(error), 'error'); }
        } };
    }
    if (row.kind === 'color_menu' || row.kind === 'color_key') {
      const setColor = async (event: KeyActionEvent, value: string) => {
        const source = deps.sourceOf(event);
        try {
          await deps.writeEdit(event, wholeEventEdit(event, deps.propertyFields(source, { color: { kind: 'set', value } }), zone));
          deps.say(String(rows.find(item => item.kind === 'color_key')?.said ?? ''), 'done');
        } catch (error) { deps.say(errorWords(error), 'error'); }
      };
      const usable = (node: NodeRef) => { const event = eventFor(node); return event && canEdit(event, deps.sourceOf(event)) && colorsOf(deps.sourceOf(event)).length > 0 ? event : null; };
      if (row.kind === 'color_menu') {
        return { ...base, accepts: node => Boolean(usable(node) && node.parts?.choice === undefined),
          submenu: node => { const event = usable(node); return event ? colorsOf(deps.sourceOf(event)).map(choice => ({
            id: `${row.id}.${choice.value}`, label: choice.label, icon: row.icon, accepts: () => true, run: () => setColor(event, choice.value),
          })) : []; } };
      }
      // The key: only a keyboard press carries the number it chose.
      return { ...base, accepts: node => Boolean(usable(node) && node.parts?.choice !== undefined),
        run: async node => {
          const event = usable(node), number = Number(node.parts?.choice);
          if (!event) return;
          const choice = colorsOf(deps.sourceOf(event))[number - 1];
          if (!choice) { deps.say(fill(String(row.none), { number: String(number) }), 'info'); return; }
          await setColor(event, choice.value);
        } };
    }
    if (row.kind === 'event_done' || row.kind === 'event_reopen') {
      const wanted = row.kind === 'event_done';
      return { ...base, accepts: node => { const id = idOf(node); return Boolean(id && deps.eventOf(id) && deps.doneOffered() && deps.isDone(id) !== wanted); },
        run: node => { const id = idOf(node); if (id) deps.setDone(id, wanted); } };
    }
    return { ...base, accepts: node => Boolean(eventFor(node)?.conference_url), run: node => { const event = eventFor(node); if (event) deps.join(event); } };
  });
}

/** The keys the keymap gives a context action (the person's own when they changed them), drawn as one line ("⌘D"), or nothing when no row runs it. */
export function shortcutOfAction(rows: readonly EffectiveRow[], actionId: string): string | undefined {
  const row = rows.find(candidate => candidate.chord && Array.isArray(candidate.with?.action) && (candidate.with.action as string[]).includes(actionId));
  return row?.chord ? shownChord(row.chord, KEYMAP, onMac()).join('') : undefined;
}
