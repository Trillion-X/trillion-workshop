// src/workspace/shared-calendar-screen.tsx
//
// PURPOSE
//   The one Calendar: every dated thing the person can see (the meetings of every space they are in, their posts, their
//   own Google Calendar) on the shared ScheduleCalendar's week, month and day, with shared search and view controls
//   in the task pane and calendar actions above the grid. It reads /work/api/calendar (src/calendar.mjs), which the workspace's focus
//   narrows like every list: switched to a space, the calendar is that space's, the same records everyone in it sees.
//   While the focus is one space, the people looking at its calendar see each other here (their cursors and who is
//   here, src/board-room.mjs through useSurfacePresence). A meeting is put on for a space from New meeting, moved by
//   dragging it when its space lets the person move it, and opened beside the calendar with what its source offers
//   (Going, Not going, Add to your calendar, Open in Google Calendar...). A space has no calendar of its own: its
//   Calendar place opens this screen (src/workspace/space-kinds.json places).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every element is a shared component; this file writes no markup.
//   2. Words, views and roads are DATA (shared-calendar.json); how each source's items look and what they offer is its
//      row of src/calendar.json. Nothing here names a source, a space or a kind of thing.
//   3. Only the span on screen is read (visibleRange of the shown view), again when the person moves, when their store
//      changes and when the focus changes.
//   4. Presence never names anyone itself: the room gives each person the name they show in the space.

import React from 'react';
import { mountRecordViews, RecordViews, type FieldDescriptor, type RecordView, type RecordViewContext, type RecordViewsOptions } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { Button, Container, Input, QuickCreate, type SelectionFormatCommand, ScheduleCalendar, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Tabs, TabsContent, TaskProperties, Text, addDays, dayStart, dayKey, planSchedule, timeboxEvent, visibleDays, visibleRange, type ScheduleRange, type ScheduleVerbRegistrar, type SchedulePlan, type ScheduleView } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { DatePicker } from '../../parts/ui/show/date-picker/DatePicker';
import { TaskRecurrence, type TaskRecurrenceValue } from '../../parts/ui/show/task-recurrence/TaskRecurrence';
import { LiveSurfacePeopleOverlay, LiveSurfacePeopleRoster } from '../../parts/ui/show/live-surface-people';
import { useSurfacePresence } from '../../parts/group/show/use-surface-presence';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { BulkSelectBar } from '../../parts/ui/show/bulk-select-bar';
import { bindContainerSize } from '../../parts/ui/show/container-size';
import type { NodeActionCapability, NodeRef } from '../../parts/ui/show/node-actions';
import screenData from './shared-calendar.json';
import sourceData from '../calendar.json';
import { postJson, postJsonByKey, readJson } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { onStoreChange } from './store-changes';
import { focusChoices, focusNow, onFocusChange, type Dimension } from './scope-focus';
import { openAddress, openScreen, openScreenOn } from './open-screen';
import { readSavedLabels, readWorkspacePreference, writeWorkspacePreference, writeConfirmedWorkspacePreference } from './records';
import { runCalendarBatchRemoval } from './calendar-batch-actions.mjs';
import { recordConfigurationSource } from './record-configurations';
import { makeConfigurationController } from '../../../../keep-lists-of-rows/read-data/configuration-controller.mjs';
import taskListData from '../calendar-tasks.json';
import listData from '../lists.json';
import { ArrangedContents } from '../../parts/screen-arrangement/show/ArrangedContents';
import { PlanningSettings } from './planning-settings';
import { TodoListsSettings } from './todo-lists-settings';
import { EmailTodoSettings } from './email-todo-settings';
import { OpenItem, EventEditor, NewMeeting, joinCall, newEventPropertyDraft, eventPropertyFields, MeetingProviderSettings, ShowDeclinedSetting, useShowDeclined } from './calendar-event-forms';
import { SOURCES, calendarWrite, fill, itemActions, localInput, minutesOf, runRoad, sourceFor, whenWords, type Action, type Item, type Road, type Source, type SourceState, type Task, type TaskCollection } from './calendar-screen-core';
import trayData from './calendar-task-tray.json';
import { deadlineTone, displayFrom, durationWords, effectiveListId, levelsOf, inList, instantOf, localDay, moveTarget, nowDay, parseQuickTask, rangeIds, cycleId, sortTasks, stepId, tabsFor, visibleTasks } from '../calendar-task-views.mjs';
import { TaskDisplayMenu, TaskListTabs, TaskMarkedBar, type TaskDisplay } from './task-tray';
import { KEYMAP, currentRows, onMac, registerVerb, subscribeKeymap, type EffectiveRow } from './keymap-runtime';
import { shownChord } from './keymap.mjs';
import { calendarKeyActions, shortcutOfAction } from './calendar-key-actions';
import { TASK_KEY, VerbList, VerbPanel, taskVerbs, verbForKey, verbsAsNodeActions, type Verb, type VerbContext } from './task-verbs';
import { formatElapsed, useElapsedSeconds } from '../../parts/group/show/use-elapsed';
import { CalendarControls, calendarFormatChoice, calendarZoneGutters, type CalendarAccount, type CalendarControlPreferences, type CalendarSelection } from './calendar-controls';
import { itemsOf } from '../calendar.mjs';
import { EmailSurface, type MailMessageFacts } from './email-screen';
import { Checkbox } from '../../parts/ui/show/coss/ui/checkbox';
import { Popover, PopoverTrigger, PopoverPopup } from '../../parts/ui/show/coss/ui/popover';
import { later } from '../../parts/ui/show/load-later/later';
import { timeAt } from '../../parts/ui/show/schedule-calendar';
import { addRange } from '../../parts/calendar-booker/show/slot-ranges.mjs';
import slotWords from '../../parts/calendar-booker/read-data/slot-sharing.json';
import { NamedIcon } from '../../parts/ui/show/icon';
import { mountSharedContent } from '../../parts/ui/show/coss/shared-content';
import { releaseNode } from '../../parts/ui/show/one-owner-per-node';
import { DockedComposer } from './global-composer';

/** One day's change to the standing working hours (the planner subtracts it). */
type DayHours = { day: string; off?: boolean; start_minute?: number; end_minute?: number; blocks?: { start_minute: number; end_minute: number }[] };
type TaskPage = { complete: boolean; next_cursor: string | null };
type TaskOrdering = { ready: boolean; index: string };
type Calendar = { from: string; to: string; items: Item[]; sources: SourceState[]; tasks?: Task[]; tasksPage?: TaskPage; taskOrdering?: TaskOrdering; collections?: TaskCollection[]; collectionsPage?: TaskPage; taskPreferences?: Record<string, unknown> };
type TaskTrayGroup = { id: string; label: string; count: number; listId: string | null };
type TaskTrayProjection = { records: Task[]; groups: TaskTrayGroup[]; groupById: ReadonlyMap<string, string>; detailsById: ReadonlyMap<string, string>; hasNonManualSort: boolean; filtering?: 'applying' | 'failed' | null };
/** One member of a focused space and whether their own calendar is connected (POST /community/<space>/free-times). */
type MemberCalendar = { name: string; you: boolean; connected: boolean; shares: boolean; account?: string; connect?: { service: string } };
/** A member of the focused space as the calendar can draw them: their busy stretches (start and end only) or why there are none. */
type ColleaguesAnswer = { rows: Colleague[]; connectYours: string | null };
type Colleague = { ref: string; name: string; tone: string; busy: { start: string; end: string }[]; note?: string };
type Row = { id: string; title: string; at: string; when: string; source: string; place: string };

const taskListKinds = new Map((listData.field_kinds as {id: string; label: string; icon?: string; kind: string; ruleKind: string; document?: boolean}[]).map(kind => [kind.id, kind]));
const taskListFieldIds = taskListData.list.fields.map(field => field.id);
const taskStatusField = taskListData.list.fields.find(field => field.id === 'status');
const initialTaskRules: NonNullable<RecordViewsOptions['initialRules']> = {
  kind: 'group', combinator: 'and', negate: false,
  rules: taskStatusField?.starts ? [{kind: 'rule', field: 'status', operator: 'is_any_of', params: {values: [taskStatusField.starts]}}] : [],
};

function taskTrayFields(tasks: Task[], collections: TaskCollection[]): FieldDescriptor[] {
  const taskNames = Object.fromEntries(tasks.map(task => [task.id, {label: task.title}]));
  const collectionNames = Object.fromEntries(collections.map(collection => [collection.id, {label: collection.title}]));
  return taskListData.list.fields.map((field, index) => {
    const kind = taskListKinds.get(field.kind);
    const values = field.choices
      ? Object.fromEntries(field.choices.map(value => [value, {label: value}]))
      : field.links_to === taskListData.list.id ? taskNames
      : field.links_to === taskListData.collections.id ? collectionNames
      : undefined;
    const read = (task: Task) => (task as unknown as Record<string, unknown>)[field.id] ?? '';
    const date = kind?.ruleKind === 'date';
    return {
      id: field.id, label: field.label, icon: kind?.icon, kind: kind?.kind ?? 'text', ruleKind: kind?.ruleKind ?? 'text',
      read, filterable: true, sortable: true, groupable: kind?.kind === 'tag', width: index === 0 ? 260 : 180,
      ...(field.hidden_by_default === true ? {hiddenByDefault: true} : {}),
      ...(field.editable === false ? {editable: false} : {}),
      ...(kind?.document ? {document: true} : {}),
      ...(values ? {values} : {}),
      ...(date ? {relativeDates: true} : {}),
      ...(date ? {factValue: (task: Task) => {const value = read(task); const at = typeof value === 'number' ? value : Date.parse(String(value)); return Number.isFinite(at) ? at : null;}} : {}),
    };
  });
}

/** Tasks grouped by the list each is in, the lists in the order of the tabs and any other in the order first met. */
function groupedByList(records: Task[], lists: { id: string; label: string }[]): { groups: TaskTrayGroup[]; groupById: Map<string, string> } {
  const found = new Map<string | null, TaskTrayGroup>();
  const groupById = new Map<string, string>();
  for (const task of records) {
    const listId = effectiveListId(task);
    const group = found.get(listId) ?? { id: `list:${listId ?? ''}`, label: lists.find(row => row.id === listId)?.label ?? listId ?? '', count: 0, listId };
    group.count += 1;
    found.set(listId, group);
    groupById.set(task.id, group.id);
  }
  const rank = (group: TaskTrayGroup) => { const at = lists.findIndex(row => row.id === group.listId); return at < 0 ? lists.length : at; };
  return { groups: [...found.values()].sort((a, b) => rank(a) - rank(b)), groupById };
}

function taskTrayProjection(records: Task[], sections: NonNullable<RecordViewContext['sections']>, sort: NonNullable<RecordViewContext['sort']>, visibleFields: FieldDescriptor[], formatFieldValue: RecordViewContext['formatFieldValue'], filtering: RecordViewContext['filtering'] = null): TaskTrayProjection {
  const hasNonManualSort = sort.length > 0 && !(sort.length === 1 && sort[0].field === 'manual_order' && sort[0].direction === 'asc');
  const groups: TaskTrayGroup[] = [];
  const groupById = new Map<string, string>();
  const visit = (nodes: NonNullable<RecordViewContext['sections']>, path: string[]) => {
    for (const node of nodes) {
      const labels = [...path, node.label];
      if (node.children.length) visit(node.children, labels);
      else {
        groups.push({id: node.key, label: labels.join(' · '), count: node.records.length, listId: null});
        for (const task of node.records as Task[]) if (!groupById.has(task.id)) groupById.set(task.id, node.key);
      }
    }
  };
  visit(sections, []);
  const detailsById = new Map(records.map(task => {
    const details = visibleFields.filter(field => field.id !== 'title').flatMap(field => {
      const value = formatFieldValue(field, task);
      return value ? [`${field.label}: ${value}`] : [];
    });
    return [task.id, details.join(' · ')];
  }));
  return {records, groups, groupById, detailsById, hasNonManualSort, filtering};
}

function TaskTrayRecordView({tasks, collections, configuration, groupLevels, onGroupLevelsChange, onProjection, onLoadMore, hasMore, loadingMore, toolbarEnd}: {
  tasks: Task[]; collections: TaskCollection[]; configuration: Partial<RecordViewsOptions>; groupLevels: NonNullable<RecordViewsOptions['groupLevels']>; onGroupLevelsChange: NonNullable<RecordViewsOptions['onGroupLevelsChange']>;
  onProjection: (projection: TaskTrayProjection) => void; onLoadMore: () => void; hasMore: boolean; loadingMore: boolean; toolbarEnd?: React.ReactNode;
}) {
  const fields = React.useMemo(() => taskTrayFields(tasks, collections), [tasks, collections]);
  const view = React.useMemo<RecordView>(() => ({
    id: 'table', label: words.tasks_heading, ownsEmpty: true,
    render: context => <TaskTrayProjectionView context={context} onProjection={onProjection}/>,
  }), [onProjection]);
  return <RecordViews
    label={words.tasks_heading} fields={fields} records={tasks} identify={(task: Task) => task.id}
    preferenceKey="trillion-list-calendar-tasks" identity="list:calendar-tasks"
    views={[view]} onlyTheseViews view={view.id} count={false} detailLevels={null}
    groupLevels={groupLevels} onGroupLevelsChange={onGroupLevelsChange} defaultRules={initialTaskRules} {...recordFilter} {...configuration}
    toolbarEnd={<>{toolbarEnd}{hasMore ? <Button size="xs" variant="outline" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? words.loading : words.load_more_tasks}</Button> : null}</>}
    emptyMessage={words.task_empty}
  />;
}

function TaskTrayProjectionView({context, onProjection}: {context: RecordViewContext; onProjection: (projection: TaskTrayProjection) => void}) {
  const projection = React.useMemo(() => taskTrayProjection(context.records as Task[], context.sections ?? [], context.sort ?? [], context.visibleFields, context.formatFieldValue, context.filtering),
    [context.records, context.sections, context.sort, context.visibleFields, context.formatFieldValue, context.filtering]);
  React.useEffect(() => onProjection(projection), [onProjection, projection]);
  return null;
}

const words = screenData.words;
// Sharing time is drawn only once opened or entered, so its code is fetched then.
const ShareLinksMenu = later(() => import('../../parts/calendar-booker/show/SlotSharing'), module => module.ShareLinksMenu);
const SlotBar = later(() => import('../../parts/calendar-booker/show/SlotSharing'), module => module.SlotBar);

const VIEWS = screenData.views as { id: string; label: string; icon: string; view: ScheduleView }[];
/** The calendar screens' keys are the rows of the one keymap whose scope is one of these; the calendar names what it can do and the keymap binds keys. */
const CALENDAR_SCOPES = ['calendar', 'calendar-event'];
const bindCalendarVerb: ScheduleVerbRegistrar = (verb, run) => registerVerb(verb, (row, event) => run(row.with, event));
/** The shortcuts sheet: the keymap's calendar rows in the person's own keys, grouped by where they work. Rows that say the same thing
 *  (the second key of one command) show once, and a run of numbered keys shows as its first and last. */
function calendarShortcutGroups(rows: readonly EffectiveRow[]) {
  const mac = onMac();
  return CALENDAR_SCOPES.flatMap(scope => {
    const heard = rows.filter(row => row.scope === scope && row.chord);
    const said = [...new Set(heard.map(row => row.words))];
    const shown = said.map(words => {
      const same = heard.filter(row => row.words === words);
      const keys = same.map(row => shownChord(row.chord!, KEYMAP, mac));
      const digits = keys.length > 1 && keys.every(key => /^\d$/.test(key.at(-1)!));
      return { label: words, keys: digits ? [...keys[0].slice(0, -1), `${keys[0].at(-1)}–${keys.at(-1)!.at(-1)}`] : keys[0] };
    });
    return shown.length ? [{ heading: KEYMAP.scopes.find(row => row.id === scope)?.label ?? scope, rows: shown }] : [];
  });
}
const rowOf = (item: Item): Row => ({ id: item.id, title: item.title, at: item.starts_at, when: whenWords(item), source: item.source, place: item.space_title ?? '' });
const taskLabelOptions = (selected: readonly string[], offered: readonly string[], query: string) => {
  const seen = new Set<string>();
  return [...selected, ...offered, query.trim()].filter(label => {
    const key = label.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const FIELDS: FieldDescriptor[] = [
  { id: 'title', label: words.field_title, icon: 'LayoutList', ruleKind: 'text', filterable: true, sortable: true, width: 320 },
  { id: 'when', label: words.field_when, icon: 'CalendarClock', ruleKind: 'date', filterable: true, sortable: true, width: 220,
    sortValue: (row: Row) => Date.parse(row.at), factValue: (row: Row) => Date.parse(row.at) },
  { id: 'source', label: words.field_source, icon: 'Layers', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 180,
    values: Object.fromEntries([...SOURCES].map(([id, source]) => [id, { label: source.look?.label ?? id, tone: source.look?.tone ?? 'grey' }])) },
  { id: 'place', label: words.field_place, icon: 'Boxes', ruleKind: 'text', filterable: true, groupable: true, width: 220 },
];

/** Timers running now, by task: they keep running while the card is closed and the screen is redrawn. */
const runningTimers = new Map<string, number>();

/** Play and stop for the time a task takes: stopping logs the whole minutes on the task, and the total is shown beside it. */
function TaskTimer({ task, disabled, onLog }: { task: Task; disabled: boolean; onLog: (task: Task, minutes: number) => Promise<void> }) {
  const [started, setStarted] = React.useState<number | null>(() => runningTimers.get(task.id) ?? null);
  const seconds = useElapsedSeconds(started);
  const toggle = async () => {
    if (started === null) { const at = Date.now(); runningTimers.set(task.id, at); setStarted(at); return; }
    runningTimers.delete(task.id); setStarted(null);
    const minutes = Math.floor((Date.now() - started) / 60_000);
    if (minutes < 1) { notify(trayData.words.timer_short, { kind: 'info' }); return; }
    await onLog(task, minutes);
  };
  return <Container layout="horizontal" gap="xs" alignItems="center" data-task-timer={started === null ? 'stopped' : 'running'}>
    <Button size="sm" variant="outline" disabled={disabled} aria-pressed={started !== null} aria-label={started === null ? trayData.words.timer_start : trayData.words.timer_stop} onClick={() => toggle()}>
      <NamedIcon name={started === null ? 'Play' : 'Square'} size="xs" aria-hidden />
      {started !== null ? <Text variant="caption">{formatElapsed(seconds ?? 0)}</Text> : null}
    </Button>
    {task.time_spent_minutes ? <Text variant="caption" color="muted">{fill(trayData.words.timer_spent, { minutes: task.time_spent_minutes })}</Text> : null}
  </Container>;
}

type TaskDraft = { title: string; parent: string | null; collection: string | null; description: string; priority: string | null; labels: string[]; labelQuery: string; recurrence: TaskRecurrenceValue | null; duration: string; due: string; at: string; request: { value: string; key: string } };

/** Tasks and their children are rows of the existing Lists, with independent completion and time. */
function TaskEditor({ task, tasks, collections, initialParent, initialCollection, initialSmartList, drafts, labelOptions, partial, loadingMore, collectionsPartial, loadingCollections, onMore, onMoreCollections, changingTasks, onOpen, onAddSubtask, onChildCompletion, onDuplicate, onOpenInPane, menuVerbs, onLogTime, onClose, onKept }: {
  task: Task | null; tasks: Task[]; collections: TaskCollection[]; initialParent: string | null; initialCollection: string | null; initialSmartList: string | null; drafts: Map<string, TaskDraft>; labelOptions: string[];
  partial: boolean; loadingMore: boolean; collectionsPartial: boolean; loadingCollections: boolean; onMore: () => void; onMoreCollections: () => void; changingTasks: Set<string>; onOpen: (id: string) => void;
  onAddSubtask: (id: string) => void; onChildCompletion: (task: Task, checked: boolean) => void; onDuplicate: (task: Task) => void; onClose: () => void; onKept: () => void;
  onOpenInPane?: (task: Task) => void; menuVerbs: Verb[]; onLogTime: (task: Task, minutes: number) => Promise<void>;
}) {
  const draftId = task?.id ?? `new:${initialParent ?? ''}`;
  const draft = drafts.get(draftId);
  const [title, setTitle] = React.useState(draft?.title ?? task?.title ?? '');
  const [parent, setParent] = React.useState<string | null>(draft ? draft.parent : task?.parent_id ?? initialParent);
  const [collection, setCollection] = React.useState<string | null>(draft ? draft.collection : task?.collection_id ?? initialCollection);
  const [description, setDescription] = React.useState(draft?.description ?? task?.description ?? '');
  const [priority, setPriority] = React.useState<string | null>(draft ? draft.priority : task?.priority ?? null);
  const [labels, setLabels] = React.useState<string[]>(draft?.labels ?? task?.labels ?? []);
  const [labelQuery, setLabelQuery] = React.useState(draft?.labelQuery ?? '');
  const [recurrence, setRecurrence] = React.useState<TaskRecurrenceValue | null>(draft ? draft.recurrence : task?.recurrence ?? null);
  const [duration, setDuration] = React.useState(draft?.duration ?? String(task?.duration_minutes ?? 30));
  const [due, setDue] = React.useState(draft?.due ?? task?.due?.slice(0, 10) ?? '');
  const [at, setAt] = React.useState(draft?.at ?? (task?.starts_at ? localInput(task.starts_at) : ''));
  const [atValid, setAtValid] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const request = React.useRef(draft?.request ?? { value: '', key: crypto.randomUUID() });
  React.useEffect(() => { drafts.set(draftId, { title, parent, collection, description, priority, labels, labelQuery, recurrence, duration, due, at, request: request.current }); }, [drafts, draftId, title, parent, collection, description, priority, labels, labelQuery, recurrence, duration, due, at]);
  const descendants = new Set<string>();
  const pending = task ? [task.id] : [];
  const childrenByParent = new Map<string, string[]>();
  for (const row of tasks) if (row.parent_id) {
    if (!childrenByParent.has(row.parent_id)) childrenByParent.set(row.parent_id, []);
    childrenByParent.get(row.parent_id)!.push(row.id);
  }
  while (pending.length) {
    const id = pending.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    for (const child of childrenByParent.get(id) ?? []) pending.push(child);
  }
  const parents = tasks.filter(row => !descendants.has(row.id)).map(row => ({ value: row.id, label: row.title }));
  if (parent && !parents.some(row => row.value === parent)) parents.push({ value: parent, label: words.task_parent_unloaded });
  const children = task ? tasks.filter(row => row.parent_id === task.id) : [];
  const repeatValid = !recurrence || recurrence.ends.kind !== 'date' || Boolean(recurrence.ends.value);
  const valid = Boolean(title.trim() && Number.isInteger(Number(duration)) && Number(duration) >= 5 && Number(duration) <= 1440 && atValid && repeatValid);
  const save = async (action: string) => {
    // An incomplete optional time must not become an instruction to unschedule.
    if (busy || ((action === 'create' || action === 'update') && !valid)) return;
    const minutes = Number(duration);
    const details = { parent_id: parent, collection_id: collection, description, priority, labels, recurrence, ...(!task && initialSmartList && !collection ? { smart_list: initialSmartList } : {}) };
    const input = task ? { action, task_id: task.id, ...(action === 'update' ? { title: title.trim(), ...details, duration_minutes: minutes, due: due || null } : {}) }
      : { action: 'create', title: title.trim(), ...details, duration_minutes: minutes, ...(due ? { due } : {}) };
    const value = JSON.stringify(input);
    if (request.current.value !== value) request.current = { value, key: crypto.randomUUID() };
    drafts.set(draftId, { title, parent, collection, description, priority, labels, labelQuery, recurrence, duration, due, at, request: request.current });
    setBusy(true);
    try {
      const answer = await postJson<{ task: Task }>('/work/api/calendar/tasks', { ...input, request_key: request.current.key });
      if ((action === 'create' || action === 'update') && answer.task?.status !== 'Done') {
        if (at && answer.task) await postJson('/work/api/calendar/tasks', { action: 'schedule', task_id: answer.task.id, start: new Date(at).toISOString(), end: new Date(Date.parse(at) + minutes * 60_000).toISOString() });
        else if (task?.starts_at) await postJson('/work/api/calendar/tasks', { action: 'unschedule', task_id: task.id });
      }
      notify(action === 'complete' ? words.task_done : action === 'delete' ? words.task_deleted : action === 'reopen' ? words.task_reopened : words.task_kept, { kind: 'done' });
      drafts.delete(draftId);
      onKept();
    } catch (error) { notify(errorWords(error), { kind: 'error' }); } finally { setBusy(false); }
  };
  const cardVerbs = menuVerbs.filter(verb => trayData.card_menu.includes(verb.id));
  const propertyPieces = [
    { id: 'duration', label: words.task_duration, content: <Popover><PopoverTrigger render={<Button size="sm" variant="outline" disabled={busy} aria-label={words.task_duration} />}><NamedIcon name="Clock3" size="xs" /><Text variant="caption">{Number.isInteger(Number(duration)) && Number(duration) > 0 ? durationWords(Number(duration)) : fill(words.task_minutes, { minutes: duration })}</Text></PopoverTrigger>
      <PopoverPopup preserveContent align="start" className="calendar-task-duration-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
        <Container layout="vertical" gap="sm" padding="sm" data-task-duration-presets>
          <Container layout="horizontal" gap="xs" wrap>
            {trayData.durations.map(minutes => <Button key={minutes} size="xs" variant={Number(duration) === minutes ? 'primary' : 'outline'} aria-pressed={Number(duration) === minutes} disabled={busy} onClick={() => setDuration(String(minutes))}>{durationWords(minutes)}</Button>)}
          </Container>
          <Input disabled={busy} label={words.task_duration} type="number" min={5} max={1440} step={5} value={duration} onChange={event => setDuration(event.target.value)} />
        </Container>
      </PopoverPopup></Popover> },
    { id: 'recurrence', label: words.task_repeat, content: <Popover><PopoverTrigger render={<Button size="sm" variant="outline" disabled={busy} aria-label={words.task_repeat} />}><NamedIcon name="Repeat2" size="xs" /><Text variant="caption">{recurrence ? `${words.task_repeat_every} ${recurrence.interval > 1 ? `${recurrence.interval} ` : ''}${(words.task_repeat_frequencies as { value: string; label: string }[]).find(row => row.value === recurrence.frequency)?.label.toLowerCase() ?? recurrence.frequency}` : words.task_repeat}</Text></PopoverTrigger>
      <PopoverPopup preserveContent className="calendar-task-repeat-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
        <TaskRecurrence value={recurrence} frequencies={words.task_repeat_frequencies} nextTodoChoices={words.task_repeat_next_choices}
          words={{ repeat: words.task_repeat, every: words.task_repeat_every, interval: words.task_repeat_interval, on: words.task_repeat_on,
            ends: words.task_repeat_ends, never: words.task_repeat_never, onDate: words.task_repeat_on_date, after: words.task_repeat_after,
            occurrences: words.task_repeat_occurrences, createNextTodo: words.task_create_next, weekdays: words.task_repeat_weekdays }}
          disabled={busy} onChange={value => setRecurrence(value ? { ...value, timeZone: value.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : null)} />
      </PopoverPopup></Popover> },
    { id: 'list', label: words.task_list, content: <Container layout="vertical" gap="sm" data-calendar-task-list-assignment={task?.id ?? 'new'}>
      <Text variant="caption">{words.task_list}</Text>
      <Select modal={false} value={collection ?? ''} onValueChange={value => { if (typeof value === 'string') setCollection(value || null); }} disabled={busy}>
        <SelectTrigger aria-label={words.task_list}><SelectValue placeholder={words.task_list_unassigned} /></SelectTrigger>
        <SelectPopup portalProps={{ className: 'coss-ui', keepMounted: true }}>
          <SelectItem value="">{words.task_list_unassigned}</SelectItem>
          {collection && !collections.some(row => row.id === collection) ? <SelectItem value={collection}>{words.task_list_unavailable}</SelectItem> : null}
          {collections.map(row => <SelectItem key={row.id} value={row.id}>{row.title}</SelectItem>)}
        </SelectPopup>
      </Select>
      {collectionsPartial ? <Button size="sm" variant="outline" disabled={loadingCollections} onClick={onMoreCollections}>{words.load_more_task_lists}</Button> : null}
    </Container> },
    { id: 'due', label: words.task_due, content: <Popover><PopoverTrigger render={<Button size="sm" variant="outline" disabled={busy} aria-label={words.task_due} data-deadline-tone={due ? deadlineTone(due, nowDay(Date.now())) ?? undefined : undefined} />}>
      <NamedIcon name="CalendarCheck" size="xs" /><Text variant="caption">{due ? fill(trayData.words.deadline_chip, { date: new Date(`${due.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }) : trayData.words.deadline_none}</Text>
    </PopoverTrigger><PopoverPopup preserveContent align="start" className="calendar-task-deadline-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
      <Container layout="vertical" gap="sm" padding="sm" data-task-deadline-picker>
        <DatePicker aria-label={words.task_due} placeholder={words.task_due_short} disabled={busy} value={due} onChange={value => setDue(value ?? '')} />
        <Button size="sm" variant="ghost" disabled={busy || !due} onClick={() => setDue('')}>{trayData.words.menu_deadline_none}</Button>
      </Container>
    </PopoverPopup></Popover> },
    { id: 'timer', label: trayData.words.timer_start, content: task ? <TaskTimer task={task} disabled={busy} onLog={onLogTime} /> : null },
    { id: 'more', label: trayData.words.card_more, content: task && cardVerbs.length ? <Popover open={moreOpen} onOpenChange={setMoreOpen}><PopoverTrigger render={<Button size="sm" variant="outline" disabled={busy} aria-label={trayData.words.card_more} title={trayData.words.card_more} />}><NamedIcon name="Ellipsis" size="xs" aria-hidden /></PopoverTrigger>
      <PopoverPopup align="end" className="calendar-task-more-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}><VerbList verbs={cardVerbs} onClose={() => setMoreOpen(false)} /></PopoverPopup></Popover> : null },
    { id: 'schedule', label: words.task_time, content: <Popover><PopoverTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
      {at ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : words.task_schedule}
    </PopoverTrigger><PopoverPopup preserveContent className="calendar-task-time-popup" portalProps={{ className: 'coss-ui', keepMounted: true }}>
      <DateTimePicker aria-label={words.task_time} label={words.task_time} disabled={busy} value={at} onChange={value => setAt(value ?? '')} onValidityChange={setAtValid} />
    </PopoverPopup></Popover> },
    { id: 'open-pane', label: words.task_open_pane, content: task && onOpenInPane ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onOpenInPane(task)}><NamedIcon name="PanelsTopLeft" size="xs" />{words.task_open_pane}</Button> : null },
    { id: 'duplicate', label: words.task_duplicate, content: task ? <Button size="sm" variant="outline" disabled={busy || changingTasks.has(task.id)} onClick={() => onDuplicate(task)}>{words.task_duplicate}</Button> : null },
    { id: 'delete', label: words.task_delete, content: task ? <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(true)}>{words.task_delete}</Button> : null },
  ];
  const pieces = [
    { id: 'heading', label: words.new_task, content: (task ? null : <Text variant="heading-xs">{words.new_task}</Text>) },
    { id: 'title', label: words.task_title, content: (<Container layout="horizontal" gap="sm" alignItems="center" className="calendar-task-title-row">
      {task ? <Checkbox className="schedule-checklist-check" aria-label={fill(task.status === 'Done' ? words.task_reopen_named : words.task_complete_named, { title: task.title })}
        checked={task.status === 'Done'} disabled={busy || changingTasks.has(task.id)} onCheckedChange={checked => onChildCompletion(task, checked === true)} /> : null}
      <Input borderless className="calendar-task-title" disabled={busy} aria-label={words.task_title} placeholder={words.task_title} value={title} onChange={event => setTitle(event.target.value)} />
    </Container>) },
    { id: 'properties', label: words.task_more, content: (<TaskProperties compact description={description} priority={priority} priorityOptions={screenData.task_properties.priorities}
      selectedLabels={labels} labelOptions={taskLabelOptions(labels, labelOptions, labelQuery)}
      labelQuery={labelQuery} words={screenData.task_properties.words} disabled={busy}
      parent={{ value: parent, options: parents, label: words.task_parent, noneLabel: words.task_no_parent, onChange: setParent }}
      subtasks={task ? { label: words.task_subtasks, items: children.map(child => ({ id: child.id, title: child.title, checked: child.status === 'Done', disabled: changingTasks.has(child.id), checkLabel: fill(child.status === 'Done' ? words.task_reopen_named : words.task_complete_named, { title: child.title }) })),
        onOpen, onCheckedChange: (id, checked) => { const child = children.find(row => row.id === id); if (child) onChildCompletion(child, checked); }, addLabel: words.task_add_subtask, addShortLabel: words.task_subtask_action, onAdd: () => onAddSubtask(task.id),
        ...(partial ? { notice: words.task_relationships_partial, moreLabel: words.load_more_tasks, loadingMore, onMore } : {}) } : undefined}
      descriptionFormats={{ label: trayData.words.format_label, commands: trayData.formats as SelectionFormatCommand[] }}
      additionalPieces={propertyPieces}
      renderPieces={propertyPieces => <ArrangedContents pieces={propertyPieces} arrangement={screenData.task_properties.composition.property_arrangement}
        keptAt={screenData.task_properties.composition.properties_kept_at} words={screenData.task_properties.composition.property_words} />}
      onDescriptionChange={setDescription} onPriorityChange={setPriority} onLabelsChange={setLabels} onLabelQueryChange={setLabelQuery} />) },
    { id: 'origin', label: words.task_origin, content: (task?.source_url ? <Button size="sm" variant="ghost" onClick={() => runRoad({ href: task.source_url! }, {})}>{words.task_origin}</Button> : null) },
    { id: 'actions', label: words.task_save, content: (<Container layout="horizontal" gap="sm" wrap>
      <Button size="sm" disabled={!valid || busy} onClick={() => save(task ? 'update' : 'create')}>{task ? words.task_save : words.task_add}</Button>
      <Button size="sm" variant="ghost" onClick={onClose}>{words.close}</Button>
    </Container>) },
    { id: 'confirmation', label: words.task_delete, content: (deleting ? <Container layout="horizontal" gap="sm" alignItems="center" wrap>
      <Text variant="body-sm">{words.task_delete_question}</Text>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => save('delete')}>{words.task_delete}</Button>
      <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>{words.close}</Button>
    </Container> : null) },
  ];
  return <Container layout="vertical" gap="sm" padding="md" className="calendar-task-editor" data-calendar-task-editor>
    <ArrangedContents pieces={pieces} arrangement={screenData.task_properties.composition.arrangement}
      keptAt={screenData.task_properties.composition.kept_at} words={screenData.task_properties.composition.words} />
  </Container>;
}

/** The calendar with the people looking at it: cursors over it and who is here, while the focus is one space. */
function SharedCalendar({ room, selected, children, roster }: { room: string | null; selected: readonly string[]; children: React.ReactNode; roster: (people: React.ReactNode) => React.ReactNode }) {
  const surface = React.useRef<HTMLDivElement | null>(null);
  const { people } = useSurfacePresence(room, screenData.presence, surface, selected);
  return (
    <>
      {roster(people.length ? <LiveSurfacePeopleRoster people={people} label={fill(words.here, { count: people.length })} /> : null)}
      <Container ref={surface} layout="vertical" flex={1} minHeight="0" padding="sm" position="relative" data-calendar-surface>
        {children}
        <LiveSurfacePeopleOverlay people={people} />
      </Container>
    </>
  );
}

export function mountSharedCalendarScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> } = {}): () => void {
  const taskOnly = props.surfaceInput?.task_only === true;
  const gridOnly = props.surfaceInput?.calendar_piece === 'grid';
  const tasksOnly = props.surfaceInput?.calendar_piece === 'tasks';
  const requestedTaskId = typeof props.surfaceInput?.task_id === 'string' ? props.surfaceInput.task_id : null;
  const requestedEventValue = props.surfaceInput?.calendar_event;
  const requestedEvent = requestedEventValue && typeof requestedEventValue === 'object' && !Array.isArray(requestedEventValue)
    ? requestedEventValue as { id?: unknown; source?: unknown; source_id?: unknown; starts_at?: unknown; source_generation?: unknown } : null;
  let views: ReturnType<typeof mountRecordViews> | null = null;
  // The bar's view (the calendar or the list) and the calendar header's own choice of week, month or day.
  let viewId = screenData.calendar.id;
  let choice = VIEWS[0].id;
  let anchor = dayKey(new Date());
  if (requestedEvent && typeof requestedEvent.starts_at === 'string' && Number.isFinite(Date.parse(requestedEvent.starts_at))) anchor = dayKey(new Date(requestedEvent.starts_at));
  let loaded: Calendar = { from: '', to: '', items: [], sources: [] };
  let openId: string | null = null;
  let pendingItemAction: Action | null = null;
  let writing = false;
  let newAt: string | null = null;
  // The start of a video meeting begun from the header's Meet button, so its form opens with the video call switched on.
  let meetAt: string | null = null;
  // A range dragged on the hour grid: where it ends and the rectangle the new-event popover opens at.
  let newUntil: string | null = null;
  let newAnchor: { x: number; y: number; width: number; height: number } | null = null;
  let eventDraft: Item | null = null;
  let selectingEvents = false;
  let selectedEventIds: string[] = [];
  let duplicateQueue: string[] = [];
  let duplicateCompleted = 0;
  const batchDuplicateItems = new Map<string, Item>();
  let batchRemovalBusy = false;
  let confirmingBatchRemoval = false;
  const batchRemovalRequestKeys = new Map<string, string>();
  let taskEditor: string | 'new' | null = requestedTaskId ?? (props.surfaceInput?.new_task === true ? 'new' : null);
  let newTaskParent: string | null = null;
  const taskDrafts = new Map<string, TaskDraft>();
  let eventEditor: string | null = null;
  let loadingMore = false;
  let manualView = false;
  let hidden: string[] = [];
  let hiddenSourcesRevision = 0;
  let calendarPreferencesRevision = 0;
  // The events the person marked done (their ids, oldest first, bounded), kept as one preference of their own.
  let eventsDone = new Set<string>();
  const setEventDone = (id: string, done: boolean) => {
    const previous = eventsDone;
    const next = new Set(previous);
    if (done) next.add(id); else next.delete(id);
    eventsDone = new Set([...next].slice(-screenData.events_done.most));
    redraw();
    void writeConfirmedWorkspacePreference(screenData.events_done.preference_key, [...eventsDone]).catch(error => {
      eventsDone = previous; redraw(); notify(errorWords(error), { kind: 'error' });
    });
  };
  // Colleagues whose busy times are drawn beside the person's own (their person refs, as kept in one preference), and the
  // free-times answer per space and range, read once and kept until the range or space changes.
  let colleaguesShown: string[] = [];
  const colleagueReads = new Map<string, ColleaguesAnswer | 'reading'>();
  const noColleagues: ColleaguesAnswer = { rows: [], connectYours: null };
  const colleaguesOf = (space: string | null | undefined, range: { from: string; to: string }): ColleaguesAnswer => {
    if (!space) return noColleagues;
    const to = new Date(Math.min(new Date(range.to).getTime(), new Date(range.from).getTime() + screenData.colleagues.most_days * 86_400_000)).toISOString();
    const key = `${space}|${range.from}|${to}`;
    const kept = colleagueReads.get(key);
    if (kept && kept !== 'reading') return kept;
    if (kept === 'reading') return noColleagues;
    colleagueReads.set(key, 'reading');
    void postJson<{ members: (MemberCalendar & { person_ref?: string; busy?: { start: string; end: string }[]; read?: boolean })[] }>(fill(screenData.colleagues.post, { space: encodeURIComponent(space) }), { from: range.from, to, duration_minutes: 30, include_busy: true })
      .then((answer): ColleaguesAnswer => ({ connectYours: (answer.members ?? []).find(member => member.you && !member.connected && member.shares && member.connect?.service)?.connect?.service ?? null, rows: (answer.members ?? []).filter(member => !member.you && member.person_ref).map((member, index): Colleague => ({
        ref: member.person_ref!, name: member.name, tone: screenData.colleagues.tones[index % screenData.colleagues.tones.length],
        busy: member.busy ?? [],
        note: !member.shares ? words.colleague_not_shared : !member.connected ? words.colleague_not_connected : member.busy ? undefined : words.colleague_unread,
      })) }), () => { colleagueReads.delete(key); return noColleagues; })
      .then(found => { if (colleagueReads.has(key)) { colleagueReads.set(key, found); redraw(); } });
    return noColleagues;
  };
  const setColleagueShown = (ref: string, shown: boolean) => {
    const previous = colleaguesShown;
    const next = shown ? [...new Set([...previous, ref])] : previous.filter(id => id !== ref);
    colleaguesShown = next; redraw();
    void writeConfirmedWorkspacePreference(screenData.colleagues.preference_key, next).catch(error => {
      colleaguesShown = previous; redraw(); notify(errorWords(error), { kind: 'error' });
    });
  };
  let zoomSave: ReturnType<typeof setTimeout> | undefined;
  const saveZoom = () => {
    zoomSave = undefined;
    void writeConfirmedWorkspacePreference('calendar-settings', preferences).catch(error => notify(errorWords(error), { kind: 'error' }));
  };
  const settingsValue = props.surfaceInput?.[screenData.settings_only.parameter];
  const settingsOnly = String(settingsValue) === screenData.settings_only.value;
  let settingsOpen = settingsOnly;
  // Slot-creation mode: the spans dragged out on the calendar for a new availability link.
  let slotMode = false;
  let slotRanges: ScheduleRange[] = [];
  let calendarAccounts: CalendarAccount[] = [];
  let calendarSelections: CalendarSelection[] | null = null;
  let connectionsBusy = false;
  let connectionsError: string | null = null;
  let collectionSelection = '';
  let collectionName = '';
  let collectionMutationBusy = false;
  let collectionCreateRequest = { value: '', key: crypto.randomUUID() };
  let collectionsLoadingMore = false;
  // The task tray: which list its tabs have open, how it is displayed, and what the keys and marks are acting on.
  let activeList = 'all';
  let trayDisplay: TaskDisplay = displayFrom(undefined);
  let focusedTaskId: string | null = null;
  let markedTaskIds: string[] = [];
  let markAnchorId: string | null = null;
  let quickFocusRequest = 0;
  let listSwitcherOpen = false;
  let verbAsked: { verb: string; ids: string[] } | null = null;
  let newTaskPlace: { collection_id: string | null; smart_list: string | null } | null = null;
  let listCreateRequest = { value: '', key: '' };
  let mailCount = { count: 0, more: false };
  function mailItemsChanged(value: { count: number; more: boolean }) { if (value.count !== mailCount.count || value.more !== mailCount.more) { mailCount = value; redraw(); } }
  let mailDetailOpen = false;
  function mailDetailChanged(open: boolean) { if (open !== mailDetailOpen) { mailDetailOpen = open; redraw(); } }
  let mailComposeRequest = 0;
  let quickTaskRequest = { value: '', key: '' };
  const duplicateTaskRequests = new Map<string, string>();
  let planning = false;
  let applyingPlan = false;
  let plan: SchedulePlan | null = null;
  let planFailure: string | null = null;
  const preferenceDefaults = screenData.preference_defaults;
  let preferences: CalendarControlPreferences = {
    weekStart: preferenceDefaults.week_start,
    workStart: preferenceDefaults.work_start,
    workEnd: preferenceDefaults.work_end,
    weekends: preferenceDefaults.weekends,
    workdays: preferenceDefaults.workdays,
    hourHeightPx: screenData.hour_height_px,
    defaultEventDurationMinutes: preferenceDefaults.default_event_duration_minutes,
  };
  const changingTasks = new Set<string>();
  const minute = (time: string) => { const [hours, minutes] = time.split(':').map(Number); return hours * 60 + minutes; };
  let places: { id: string; title: string }[] = [];
  const host = document.createElement('div');
  host.className = 'trillion-decisions';
  // The Ask bar docked under the whole calendar (DockedComposer in global-composer.tsx); a single piece of it (grid, tasks, settings) has none.
  const askBar = document.createElement('div');
  askBar.className = 'sticky bottom-0 z-10';
  if (taskOnly || gridOnly || tasksOnly || settingsOnly) element.replaceChildren(host);
  else { element.replaceChildren(host, askBar); mountSharedContent(askBar, <DockedComposer />); }
  let disposed = false;
  // Opened from a space's Calendar place, the space is where a new meeting goes and whose people are here.
  const opened = typeof props.surfaceInput?.space_id === 'string' ? props.surfaceInput.space_id : null;
  const focusedPlace = () => { const ids = focusNow()[screenData.place.param] ?? []; return ids.length === 1 ? ids[0] : opened; };

  // A week that starts today (rather than on the week's first day) is the person's saved choice; only whole weeks read it.
  const shownView = (): ScheduleView => {
    const view = VIEWS.find(row => row.id === choice)?.view ?? VIEWS[0].view;
    return view.grid === 'hours' && preferences.startWeekToday ? { ...view, rolling: true } : view;
  };
  const redraw = () => views?.update(options());
  const itemOf = (id: string) => loaded.items.find(item => item.id === id) ?? null;
  const taskConfigurations = makeConfigurationController({
    source: recordConfigurationSource({accessCode: typeof props.surfaceInput?.access_code === 'string' ? props.surfaceInput.access_code : undefined}), target: 'list:calendar-tasks', openPath: '/lists/calendar-tasks',
    fieldIds: () => taskListFieldIds,
    initialId: typeof props.surfaceInput?.task_configuration === 'string' ? props.surfaceInput.task_configuration : undefined,
    sharedCode: typeof props.surfaceInput?.shared_configuration === 'string' ? props.surfaceInput.shared_configuration : undefined,
    sharedOffer: typeof props.surfaceInput?.shared_offer === 'string' ? props.surfaceInput.shared_offer : undefined,
    changed: () => { if (!disposed) redraw(); },
    applied: () => { if (!disposed) redraw(); },
  });
  let taskConfigurationsStarted = false;

  // Moves a thing to a new time: drawn there at once, then kept through its source's road, then read again.
  async function move(id: string, at: string, minutes?: number) {
    const item = itemOf(id);
    const road = item ? sourceFor(item.source, loaded.sources)?.move : undefined;
    if (!item || !road || !item.may_move) return;
    const length = minutes ? minutes * 60_000 : item.ends_at ? Date.parse(item.ends_at) - Date.parse(item.starts_at) : screenData.meeting_minutes * 60_000;
    const end = new Date(Date.parse(at) + length).toISOString();
    loaded = { ...loaded, items: loaded.items.map(row => (row.id === id ? { ...row, starts_at: at, ends_at: row.ends_at ? new Date(Date.parse(at) + length).toISOString() : null } : row)) };
    redraw();
    try {
      if (item.all_day && sourceFor(item.source, loaded.sources)?.calendar_actions?.edit) {
        const date = dayKey(new Date(at));
        const days = Math.max(1, Math.round((Date.parse(item.ends_at ?? item.starts_at) - Date.parse(item.starts_at)) / 86_400_000));
        await calendarWrite(item.source, 'edit', { event_id: item.source_id, start: { date }, end: { date: addDays(date, days) } });
      } else await runRoad(road, { ...item, at, ends_at: end });
      notify(fill(words.moved, { title: item.title, when: whenWords({ ...item, starts_at: at, ends_at: item.ends_at ? new Date(Date.parse(at) + length).toISOString() : null }) }), { kind: 'done' });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
    await screen.reload();
  }

  async function road(item: Item, chosen: Road) {
    try { if (await runRoad(chosen, { ...item })) await screen.reload(); } catch (error) { notify(errorWords(error), { kind: 'error' }); }
  }

  async function moreTasks() {
    if (loadingMore || !loaded.tasksPage?.next_cursor) return;
    loadingMore = true; redraw();
    try {
      const answer = await readJson<{ tasks: Task[]; page: TaskPage; ordering?: TaskOrdering }>(`/work/api/calendar/tasks?sort=manual&cursor=${encodeURIComponent(loaded.tasksPage.next_cursor)}`);
      const definition = sourceData.sources.find(source => source.id === screenData.tasks.source);
      const more = definition ? itemsOf(definition, answer) as Item[] : [];
      loaded = { ...loaded, tasks: [...new Map([...(loaded.tasks ?? []), ...answer.tasks].map(task => [task.id, task])).values()], items: [...new Map([...loaded.items, ...more].map(item => [item.id, item])).values()], tasksPage: answer.page, taskOrdering: answer.ordering };
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { loadingMore = false; redraw(); }
  }

  async function moreTaskCollections() {
    if (collectionsLoadingMore || !loaded.collectionsPage?.next_cursor) return;
    collectionsLoadingMore = true; redraw();
    try {
      const answer = await readJson<{ collections: TaskCollection[]; collections_page: TaskPage }>(`/work/api/calendar/tasks?collection_cursor=${encodeURIComponent(loaded.collectionsPage.next_cursor)}`);
      loaded = { ...loaded, collections: [...new Map([...(loaded.collections ?? []), ...answer.collections].map(row => [row.id, row])).values()], collectionsPage: answer.collections_page };
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { collectionsLoadingMore = false; redraw(); }
  }

  /** The lists a todo can be put in by name or by moving it: the built-in ones that take tasks, then the person's own. */
  const placeLists = () => [...trayData.lists.filter(row => moveTarget(row.id)).map(row => ({ id: row.id, label: row.label })), ...(loaded.collections ?? []).filter(row => !row.archived).map(row => ({ id: row.id, label: row.title }))];
  async function changeTaskCollection(action: 'create_collection' | 'update_collection' | 'delete_collection') {
    if (collectionMutationBusy) return;
    const title = collectionName.trim();
    const selected = (loaded.collections ?? []).find(row => row.id === collectionSelection);
    if (action === 'create_collection' && !title) return;
    if (action === 'update_collection' && (!selected || !title)) return;
    if (action === 'delete_collection' && !selected) return;
    if (action === 'create_collection' && collectionCreateRequest.value !== title) collectionCreateRequest = { value: title, key: crypto.randomUUID() };
    collectionMutationBusy = true; redraw();
    try {
      await postJson('/work/api/calendar/tasks', action === 'create_collection'
        ? { action, title, request_key: collectionCreateRequest.key }
        : action === 'update_collection' ? { action, collection_id: selected!.id, title }
          : { action, collection_id: selected!.id });
      if (action === 'delete_collection') collectionSelection = '';
      if (action !== 'delete_collection') collectionSelection = action === 'create_collection' ? `calendar-collection-${collectionCreateRequest.key}` : selected!.id;
      await screen.reload();
      collectionName = '';
      if (action === 'create_collection') collectionCreateRequest = { value: '', key: crypto.randomUUID() };
      notify(action === 'delete_collection' ? words.task_list_deleted : action === 'update_collection' ? words.task_list_renamed : words.task_list_created, { kind: 'done' });
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { collectionMutationBusy = false; redraw(); }
  }

  async function createTaskList(name: string): Promise<boolean> {
    if (listCreateRequest.value !== name) listCreateRequest = { value: name, key: crypto.randomUUID() };
    try {
      await postJson('/work/api/calendar/tasks', { action: 'create_collection', title: name, request_key: listCreateRequest.key });
      activeList = `calendar-collection-${listCreateRequest.key}`;
      listCreateRequest = { value: '', key: '' };
      await screen.reload();
      notify(trayData.words.add_list_created, { kind: 'done' });
      return true;
    } catch (error) { notify(errorWords(error), { kind: 'error' }); return false; }
  }

  function changeDisplay(next: TaskDisplay) {
    const previous = trayDisplay;
    trayDisplay = next; redraw();
    void writeConfirmedWorkspacePreference(trayData.display.preference_key, next).catch(error => { trayDisplay = previous; redraw(); notify(errorWords(error), { kind: 'error' }); });
  }

  async function quickAddTask(text: string): Promise<boolean> {
    const parsed = parseQuickTask(text, { lists: placeLists(), now: Date.now() });
    if (!parsed.title) return false;
    const raw = text.trim();
    if (quickTaskRequest.value !== raw) quickTaskRequest = { value: raw, key: crypto.randomUUID() };
    // A list named in the words wins; otherwise the todo goes in the list the tabs have open, when that list takes tasks.
    const place = moveTarget(parsed.list?.id ?? activeList);
    let created: { task?: Task } = {};
    try {
      created = await postJson('/work/api/calendar/tasks', { action: 'create', title: parsed.title, duration_minutes: screenData.task_minutes, request_key: quickTaskRequest.key,
        ...(place ? { collection_id: place.collection_id, ...(place.smart_list ? { smart_list: place.smart_list } : {}) } : {}) });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
      return false;
    }
    quickTaskRequest = { value: '', key: '' };
    if (parsed.day !== null && parsed.minute !== null && created.task) {
      const start = instantOf(parsed.day, parsed.minute);
      try { await postJson('/work/api/calendar/tasks', { action: 'schedule', task_id: created.task.id, start, end: new Date(Date.parse(start) + screenData.task_minutes * 60_000).toISOString() }); }
      catch (error) { notify(errorWords(error), { kind: 'error' }); }
    }
    try { await screen.reload(); }
    catch (error) { notify(errorWords(error), { kind: 'error' }); }
    notify(words.task_kept, { kind: 'done' });
    return true;
  }

  /** What the typed words will do, said under the new-todo field before they are sent. */
  function quickAddPreview(text: string): string | null {
    const parsed = parseQuickTask(text, { lists: placeLists(), now: Date.now() });
    if (!parsed.title || (!parsed.list && parsed.day === null)) return null;
    const when = parsed.day !== null && parsed.minute !== null ? new Date(instantOf(parsed.day, parsed.minute)).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    const copy = trayData.quick_add.preview;
    return parsed.list && when ? fill(copy.both, { list: parsed.list.label, when }) : parsed.list ? fill(copy.list, { list: parsed.list.label }) : fill(copy.time, { when });
  }

  // The calendar choice inside a new event groups calendars by account, so the accounts are read when one opens.
  const needAccounts = () => { if (!calendarAccounts.length) void readConnections(); };

  async function readConnections() {
    if (connectionsBusy) return;
    connectionsBusy = true; connectionsError = null; redraw();
    try {
      const answer = await readJson<{ accounts: CalendarAccount[]; selections: CalendarSelection[] | null }>(`/work/api/calendar/connections?check=${crypto.randomUUID()}`, { method: 'GET' });
      calendarAccounts = answer.accounts ?? []; calendarSelections = answer.selections ?? null;
    } catch (error) { connectionsError = errorWords(error); }
    finally { connectionsBusy = false; redraw(); }
  }

  const availabilityDraft: import('../../parts/calendar-booker/show/AvailabilityLinks').AvailabilityLinkDraftState = {};
  const availabilityLinks = {
    retainedDraft: availabilityDraft,
    subscribeChanges: onStoreChange,
    listLinks: (after?: string) => {
      const query = new URLSearchParams({ limit: '25' });
      if (after) query.set('after', after);
      return readJson<{ links: import('../../parts/calendar-booker/show/AvailabilityLinks').AvailabilityLink[]; next_cursor?: string | null }>(`/work/api/calendar/availability?${query}`);
    },
    readLink: (id: string) => postJson<import('../../parts/calendar-booker/show/AvailabilityLinks').AvailabilityLink>('/work/api/calendar/availability', { action: 'read', input: { link_id: id } }),
    readOffers: (id: string) => postJson<{link: {timezone: string}; slots: {startMs: number; endMs: number}[]}>('/work/api/calendar/availability', { action: 'offered-times', input: { link_id: id } }),
    mutate: (action: import('../../parts/calendar-booker/show/AvailabilityLinks').AvailabilityLinkAction, input: Record<string, unknown>, requestKey: string) =>
      postJsonByKey('/work/api/calendar/availability', { action, input: { ...input, request_key: requestKey }, request_key: requestKey }),
    onShare: async (id: string, title: string, anchor: Element | null) => {
      (await import('./sharing-sheet')).openSharing(`availability-link:${id}`, { title, anchor });
    },
    onCopy: (value: string) => copyTextToClipboard(value),
    onRefreshCalendars: () => { void readConnections(); },
  };

  function startSlotMode() {
    slotMode = true; slotRanges = []; settingsOpen = false; openId = null; writing = false; taskEditor = null; eventEditor = null;
    // Slots are dragged on hour lanes, so a month view moves to the first view that has them.
    if (shownView().grid !== 'hours') choice = VIEWS.find(item => item.view.grid === 'hours')?.id ?? choice;
    manualView = true;
    if (!calendarAccounts.length) void readConnections();
    notify(slotWords.toastTitle, { kind: 'warning', detail: slotWords.toastDetail });
    redraw(); void screen.reload();
  }
  function leaveSlotMode() { slotMode = false; slotRanges = []; redraw(); }

  function currentDefaultSourceId(): string | null {
    const preference = preferences.defaultCalendar;
    if (!preference?.source_id || !preference.connected_at) return null;
    const account = calendarAccounts.find(row => row.source_id === preference.source_id && row.connection_id === preference.connection_id);
    if (!account || account.connected_at !== preference.connected_at) return null;
    if (!account.calendars.some(calendar => calendar.id === preference.calendar_id && calendar.writable === true)) return null;
    return loaded.sources.find(source => source.connected !== false && source.writable === true && source.calendar_actions?.create
      && source.selection?.source_id === preference.source_id
      && source.selection.connection_id === preference.connection_id
      && source.selection.calendar_id === preference.calendar_id)?.id ?? null;
  }

  // How planned tasks are also put on the person's own calendar (calendar-tasks.json preferences.external_display), read with the tasks.
  let externalDisplay = 'off';
  let todoPrivacy = 'private';
  const taskById = new Map<string, Task>();
  async function freshPlan(): Promise<SchedulePlan> {
    const start = dayKey(new Date());
    const query = `from=${encodeURIComponent(dayStart(start).toISOString())}&to=${encodeURIComponent(dayStart(addDays(start, screenData.planning.days)).toISOString())}&check=${crypto.randomUUID()}`;
    const [calendar, tasks] = await Promise.all([
      readJson<Calendar>(`/work/api/calendar?${query}&fresh=1`),
      readJson<{ tasks: Task[]; page: TaskPage; collections: TaskCollection[]; collections_page: TaskPage; day_hours?: DayHours[]; preferences?: { external_display?: string; default_todo_visibility?: string; ai_scheduling?: boolean }; capacity?: { default_minutes: number | null; caution_band_minutes: number; weekdays: Record<string, number> } | null }>(`/work/api/calendar/tasks?${query}`),
    ]);
    const unread = calendar.sources.filter(source => source.connected !== false && (!source.read || source.complete === false));
    if (tasks.preferences?.ai_scheduling === false) throw new Error(trayData.words.plan_off);
    externalDisplay = tasks.preferences?.external_display ?? 'off';
    todoPrivacy = tasks.preferences?.default_todo_visibility ?? 'private';
    // A list can opt out of planning or keep its tasks to some hours of the day, so every list's settings are read, page by page.
    const collections = new Map((tasks.collections ?? []).map(row => [row.id, row]));
    let more = tasks.collections_page ?? { complete: true, next_cursor: null };
    for (let page = 0; !more.complete && more.next_cursor && page < screenData.planning.max_list_pages; page += 1) {
      const next = await readJson<{ collections: TaskCollection[]; collections_page: TaskPage }>(`/work/api/calendar/tasks?collection_cursor=${encodeURIComponent(more.next_cursor)}`);
      for (const row of next.collections) collections.set(row.id, row);
      more = next.collections_page;
    }
    if (!more.complete) throw new Error(trayData.words.plan_incomplete_lists);
    taskById.clear(); for (const task of tasks.tasks) taskById.set(task.id, task);
    if (unread.length) throw new Error(fill(words.plan_unread, { sources: unread.map(source => source.label).join(', ') }));
    if (!tasks.page.complete) throw new Error(words.plan_incomplete_tasks);
    // The planner places tasks with no time and takes back the ones it placed earlier unless a person pinned them there;
    // a task it takes back is no longer an obstacle to itself. Every other task is a blocker that is done or ends when it ends.
    // A task already placed in slices is planned through its slices, not again as a whole.
    const sliced = new Set(tasks.tasks.filter(task => task.status !== 'Done' && task.slice_of).map(task => task.slice_of));
    const listOf = (task: Task) => (task.collection_id ? collections.get(task.collection_id) : undefined);
    const unscheduled = tasks.tasks
      .filter(task => task.status !== 'Done' && !sliced.has(task.id) && (!task.starts_at || task.auto_placed) && listOf(task)?.ai_scheduling !== false)
      .map(task => (listOf(task)?.preferred_times ? { ...task, preferred_window: listOf(task)!.preferred_times } : task));
    if (unscheduled.length > screenData.planning.max_tasks) throw new Error(fill(words.plan_too_many, { count: screenData.planning.max_tasks }));
    const handedBack = new Set(unscheduled.filter(task => task.starts_at && !(task.pinned_until && Date.parse(task.pinned_until) > Date.now())).map(task => task.id));
    const planned = new Set(unscheduled.map(task => task.id));
    const blockers = Object.fromEntries(tasks.tasks.filter(task => !planned.has(task.id)).map(task => [task.id, task.status === 'Done' ? { done: true } : { ends_at: task.ends_at }]));
    return planSchedule(unscheduled, calendar.items.filter(item => !(item.source === screenData.tasks.source && handedBack.has(item.source_id ?? ''))), {
      blockers, day_overrides: tasks.day_hours ?? [], ...(tasks.capacity ? { capacity: tasks.capacity } : {}),
      start_day: start, horizon_days: screenData.planning.days, slot_minutes: screenData.snap_minutes,
      working_hours: preferences.workScheduleId && preferences.workSchedules?.some(schedule => schedule.id === preferences.workScheduleId)
        ? { days: preferences.workSchedules.find(schedule => schedule.id === preferences.workScheduleId)!.days }
        : { start_minute: minute(preferences.workStart), end_minute: minute(preferences.workEnd), weekdays: preferences.workdays },
      earliest_at: new Date().toISOString(),
    });
  }

  // The zone plans are kept in and the zone this device shows are two facts; a new difference is asked about once.
  async function askAboutZone() {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const drift = await postJson<{ ask: boolean; planning_zone: string | null; device_zone: string }>('/work/api/calendar/tasks', { action: 'zone_drift', device_zone: device });
    if (!drift.ask || !drift.planning_zone) return;
    const answer = (move: boolean) => () => { void postJson('/work/api/calendar/tasks', { action: 'answer_zone_drift', device_zone: device, move }).catch(error => notify(errorWords(error), { kind: 'error' })); };
    notify(fill(words.zone_drift, { planning: drift.planning_zone, device: drift.device_zone }), {
      kind: 'info', timeout: 2 * 60 * 1000, key: `zone-drift:${drift.device_zone}`,
      actions: [{ id: 'move', label: words.zone_move, onAction: answer(true) }, { id: 'keep', label: fill(words.zone_keep, { planning: drift.planning_zone }), onAction: answer(false) }],
    });
  }

  async function suggest() {
    if (planning || applyingPlan) return;
    void askAboutZone().catch(() => undefined);
    planning = true; planFailure = null; plan = null; redraw();
    try { plan = await freshPlan(); }
    catch (error) { planFailure = errorWords(error); }
    finally { planning = false; redraw(); }
  }

  // When the person chose it (external_display is not `off`), a placed task is also written to their calendar as an event at
  // exactly the previewed time; a failure is said and does not undo the placement.
  async function putOnCalendar(proposed: SchedulePlan['proposals'][number]) {
    const task = taskById.get(proposed.task_id);
    const event = task ? timeboxEvent(externalDisplay, task, proposed, todoPrivacy) : null;
    const source = currentDefaultSourceId();
    if (!event || !source) return;
    const input = { title: event.title, start: event.start, end: event.end, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, transparency: event.transparency, ...(event.visibility === 'private' ? { visibility: 'private' } : {}) };
    try { await calendarWrite(source, 'create', input, `timebox:${proposed.task_id}:${proposed.starts_at}`); }
    catch (error) { notify(errorWords(error), { kind: 'error' }); }
  }

  async function applySuggestions() {
    if (!plan?.proposals.length || applyingPlan) return;
    applyingPlan = true; planFailure = null; redraw();
    try {
      // Re-read all sources immediately before writes; a changed schedule gets a new preview.
      const current = await freshPlan();
      if (JSON.stringify(current.proposals) !== JSON.stringify(plan.proposals)) {
        plan = current; planFailure = words.plan_changed; return;
      }
      // Each write answers with the restore that undoes it; together they undo the whole plan.
      const undoRows: unknown[] = [];
      for (const proposed of current.proposals) {
        // The slices of one task are written together, on the first of them.
        if (proposed.chunk_index && proposed.chunk_index > 1) continue;
        const slices = proposed.chunk_index ? current.proposals.filter(row => row.task_id === proposed.task_id).map(row => ({ start: row.starts_at, end: row.ends_at })) : null;
        const written = await postJson<{ undo?: { rows: unknown[] } }>('/work/api/calendar/tasks', slices
          ? { action: 'schedule_slices', task_id: proposed.task_id, slices }
          : { action: 'schedule', task_id: proposed.task_id, start: proposed.starts_at, end: proposed.ends_at, expected_start: proposed.was_at ?? null, placed_by: 'planner' });
        undoRows.push(...(written.undo?.rows ?? []));
        await putOnCalendar(proposed);
        // Retain only unapplied suggestions if a later write fails; completed writes are never presented as pending.
        plan = { ...plan!, proposals: plan!.proposals.filter(row => row.task_id !== proposed.task_id) };
      }
      notify(words.plan_applied, { kind: 'done', ...(undoRows.length ? { actions: [{ id: 'undo-plan', label: words.undo, onAction: () => {
        void postJson('/work/api/calendar/tasks', { action: 'restore', rows: undoRows }).then(() => screen.reload()).catch(error => notify(errorWords(error), { kind: 'error' }));
      } }] } : {}) });
      plan = null;
    } catch (error) { planFailure = errorWords(error); }
    finally { applyingPlan = false; redraw(); await screen.reload(); }
  }

  const duplicateTask = async (task: Task) => {
    if (changingTasks.has(task.id)) return;
    let requestKey = duplicateTaskRequests.get(task.id);
    if (!requestKey) { requestKey = crypto.randomUUID(); duplicateTaskRequests.set(task.id, requestKey); }
    changingTasks.add(task.id); redraw();
    try {
      const answer = await postJson<{ task: Task }>('/work/api/calendar/tasks', { action: 'duplicate', task_id: task.id, request_key: requestKey });
      duplicateTaskRequests.delete(task.id);
      await screen.reload();
      taskEditor = answer.task.id; openId = `${screenData.tasks.source}:${answer.task.id}`; redraw();
      notify(words.task_duplicated, { kind: 'done' });
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { changingTasks.delete(task.id); redraw(); }
  };

  // Every change to a task or to several marked together goes through the verbs (task-verbs.tsx): the card's menu, the
  // right-click menu, the keys and the marked bar are one list.
  const verbContext: VerbContext = {
    collections: () => loaded.collections ?? [],
    now: () => Date.now(),
    post: body => postJson('/work/api/calendar/tasks', body),
    reload: () => screen.reload(),
    notify, changing: changingTasks, redraw,
    open: task => { taskEditor = task.id; openId = `${screenData.tasks.source}:${task.id}`; eventEditor = null; redraw(); },
    duplicate: duplicateTask,
    changed: (verb, ids) => {
      if ((verb === 'complete' || verb === 'delete') && taskEditor && ids.includes(taskEditor)) { taskEditor = null; openId = null; }
      // Keys carry on from the todo next to the one that left the list.
      if (focusedTaskId && ids.includes(focusedTaskId) && ['complete', 'delete', 'move', 'snooze'].includes(verb)) {
        const at = drawnTaskIds.indexOf(focusedTaskId);
        focusedTaskId = drawnTaskIds.slice(at + 1).find(id => !ids.includes(id)) ?? drawnTaskIds.slice(0, Math.max(at, 0)).reverse().find(id => !ids.includes(id)) ?? null;
      }
      if (['complete', 'delete', 'move', 'snooze'].includes(verb)) markedTaskIds = markedTaskIds.filter(id => !ids.includes(id));
    },
  };
  // Mail becomes todos: the inbox the mail pane last read, and whether the person chose to have it land in the Email list.
  let inboxMail: { messages: MailMessageFacts[]; connection: string } | null = null;
  const importedMail = new Set<string>();
  /** Adds the loaded inbox's messages as todos (the server routes each by Split contents) and answers how many were new. */
  async function importInbox(asked: boolean): Promise<number> {
    const chosen = loaded.taskPreferences ?? {};
    if (!inboxMail || (!asked && chosen.email_todos !== true)) return 0;
    const account = typeof chosen.email_todo_account === 'string' ? chosen.email_todo_account : '';
    if (account && account !== inboxMail.connection) return 0;
    const fresh = inboxMail.messages.filter(message => asked || !importedMail.has(message.id)).slice(0, taskListData.email_split.most_messages);
    if (!fresh.length) return 0;
    const answer = await postJson<{ imported: number; disabled?: boolean }>('/work/api/calendar/tasks', { action: 'import_messages', messages: fresh });
    if (answer.disabled) throw new Error(trayData.words.mail_import_off);
    for (const message of fresh) importedMail.add(message.id);
    if (answer.imported) await screen.reload();
    return answer.imported;
  }
  const mailArrived = (messages: MailMessageFacts[], account: { connection_id: string }) => {
    inboxMail = { messages, connection: account.connection_id };
    void importInbox(false).then(count => { if (count) notify(fill(trayData.words.mail_imported, { count }), { kind: 'done' }); }, () => undefined);
  };

  const logTime = async (task: Task, minutes: number) => {
    try {
      await postJson('/work/api/calendar/tasks', { action: 'log_time', task_id: task.id, minutes });
      await screen.reload();
      notify(fill(trayData.words.timer_logged, { minutes }), { kind: 'done' });
    } catch (error) { notify(errorWords(error), { kind: 'error' }); }
  };
  // The task ids in the order the tray draws them (kept by the tray's last draw), which the keys walk.
  let drawnTaskIds: string[] = [];
  // What the keymap's tray rows run: set at each draw, so it reads this draw's tasks, marks and lists.
  let trayKey: ((row: { with?: Record<string, unknown> }, event?: KeyboardEvent) => void) | null = null;
  function startTaskIn(listId: string) {
    taskEditor = 'new'; newTaskParent = null; newTaskPlace = moveTarget(listId); eventEditor = null; writing = false; openId = null; settingsOpen = false; redraw();
  }
  const setTaskCompletion = (task: Task, complete: boolean): Promise<void> => {
    if ((task.status === 'Done') === complete) return Promise.resolve();
    return taskVerbs(verbContext, [task]).find(verb => verb.id === 'complete')?.run?.() ?? Promise.resolve();
  };

  function CalendarBody({ records, toolbar, searchText }: { records: Row[]; toolbar: RecordViewContext['toolbar']; searchText: string }) {
    const surface = React.useRef<HTMLDivElement | null>(null);
    const [taskProjection, setTaskProjection] = React.useState<TaskTrayProjection>({records: [], groups: [], groupById: new Map(), detailsById: new Map(), hasNonManualSort: false});
    const projectionKey = React.useRef('');
    const keepTaskProjection = React.useCallback((next: TaskTrayProjection) => {
      const key = JSON.stringify([next.records.map(task => [task.id, ...taskListFieldIds.map(field => (task as unknown as Record<string, unknown>)[field])]), next.groups, [...next.groupById], [...next.detailsById], next.hasNonManualSort]);
      if (key === projectionKey.current) return;
      projectionKey.current = key;
      setTaskProjection(next);
    }, []);
    // What the tray offers: the open list's tasks, minus done and snoozed ones unless asked for, in the Display order.
    const nowMs = Date.now();
    const today = nowDay(nowMs);
    const listTabs = tabsFor({ tasks: loaded.tasks ?? [], collections: loaded.collections ?? [], display: trayDisplay, now: nowMs });
    if (!listTabs.some(tab => tab.id === activeList)) activeList = 'all';
    const oneList = !['all', 'today'].includes(activeList);
    const trayInput = sortTasks(visibleTasks((loaded.tasks ?? []).filter(task => inList(task, activeList, { today })), trayDisplay, { now: nowMs }), trayDisplay.sort_by);
    // Inside one list every task is in that list, so there is nothing to group by.
    // Grouping by list is drawn here from each task's list (lists are not a field of the task list), so the shared record view is
    // given no levels for it; any other grouping is the record view's own.
    const listGrouping = trayDisplay.group_by === 'list' && !trayDisplay.group_levels;
    const trayGroupLevels = listGrouping ? [] : levelsOf(trayDisplay);
    React.useLayoutEffect(() => {
      const node = surface.current;
      if (!node || settingsOnly || taskOnly || tasksOnly) return;
      return bindContainerSize(node, {
        classes: screenData.responsive_views,
        onChange: size => {
          if (manualView) return;
          const preferred = VIEWS.find(item => item.id === size && item.view.grid === 'hours');
          if (preferred && choice !== preferred.id) { choice = preferred.id; redraw(); void screen.reload(); }
        },
      });
    }, []);
    const shown = new Set(records.map(row => row.id));
    const showDeclined = useShowDeclined();
    const items = loaded.items.filter(item => shown.has(item.id) && !hidden.includes(item.source) && (showDeclined || item.going !== false)).map(item => ({
      // A whole-day thing (a date with no time) sits on its own day in every time zone, in the calendar's whole-day strip.
      id: item.id, title: item.title, at: item.starts_at, day: item.all_day ? item.starts_at.slice(0, 10) : undefined, dayEnd: item.all_day ? item.day_end : undefined, minutes: minutesOf(item),
      cancelled: screenData.cancelled_statuses.includes(String(item.status).toLowerCase()),
      declined: item.going === false, past: Date.parse(item.ends_at ?? item.starts_at) < Date.now(),
      subtitle: screenData.event_subtitle_fields.map(field => item[field as keyof Item]).find((value): value is string => typeof value === 'string' && Boolean(value.trim())),
      tone: preferences.sourceColors?.[item.source] ?? sourceFor(item.source, loaded.sources)?.look?.tone ?? 'grey', movable: item.may_move && Boolean(sourceFor(item.source, loaded.sources)?.move), resizable: item.may_move && Boolean(sourceFor(item.source, loaded.sources)?.calendar_actions?.move || item.source === screenData.tasks.source),
      color: sourceFor(item.source, loaded.sources)?.event_colors?.find(choice => choice.value === item.color_id)?.color,
      quiet: preferences.calendarTypes?.[item.source] === 'background',
      // Offered only when the person turned the boxes on; a task is done through its own record, not this one.
      checked: preferences.eventCheckboxes === true && item.source !== screenData.tasks.source ? eventsDone.has(item.id) : undefined,
    }));
    const colleagueRead = colleaguesOf(focusedPlace(), visibleRange(shownView(), anchor, preferences.weekStart));
    const colleagues = colleagueRead.rows.slice(0, screenData.colleagues.most_shown);
    const connectYours = colleagueRead.connectYours ? () => void runRoad({ href: fill(screenData.members.connect, { service: encodeURIComponent(colleagueRead.connectYours!) }) }, {}) : undefined;
    // The keys this screen answers itself (the calendar names the rest): a key whose thing is not there now has no verb, so it goes on to the page.
    const [, keysChanged] = React.useState(0);
    React.useEffect(() => subscribeKeymap(() => keysChanged(count => count + 1)), []);
    const calendarRows = currentRows().filter(row => CALENDAR_SCOPES.includes(row.scope));
    React.useEffect(() => {
      const stops = [
        bindCalendarVerb('calendar-time-zones', () => openTimeZones()),
        bindCalendarVerb('calendar-share-link', () => startSlotMode()),
      ];
      if (colleagues.length) {
        stops.push(bindCalendarVerb('calendar-people', () => { settingsOpen = true; openId = null; redraw(); void readConnections(); }));
        stops.push(bindCalendarVerb('calendar-person', args => {
          const person = colleagues[Number(args?.nth) - 1];
          if (person && !person.note) setColleagueShown(person.ref, !colleaguesShown.includes(person.ref));
        }));
      }
      if (colleaguesShown.length) stops.push(bindCalendarVerb('calendar-hide-people', () => { for (const ref of colleaguesShown) setColleagueShown(ref, false); }));
      return () => { for (const stop of stops) stop(); };
    });
    const colleagueItems = colleagues.filter(person => colleaguesShown.includes(person.ref)).flatMap(person => person.busy.map(stretch => ({
      id: `colleague:${person.ref}:${stretch.start}`, title: fill(words.colleague_busy, { name: person.name }), at: stretch.start,
      minutes: Math.max(1, Math.round((new Date(stretch.end).getTime() - new Date(stretch.start).getTime()) / 60_000)),
      tone: person.tone, quiet: true, movable: false,
    })));
    const peopleChoices = colleagues.map((person, index) => ({ id: person.ref, label: person.name, tone: person.tone, shown: colleaguesShown.includes(person.ref), available: !person.note, note: person.note, shortcut: `⇧${index + 1}` }));
    const trayRecords = hidden.includes(screenData.tasks.source) ? [] : taskProjection.records;
    const grouping = listGrouping && !oneList ? groupedByList(trayRecords, placeLists()) : { groups: taskProjection.groups, groupById: taskProjection.groupById };
    const unscheduled = trayRecords.filter(task => !task.starts_at).map(task => ({ id: `${screenData.tasks.source}:${task.id}`, title: task.title, at: null, minutes: task.duration_minutes, subtitle: task.status === 'Done' ? words.task_done : task.due ? fill(words.task_deadline, { date: new Date(`${task.due.slice(0, 10)}T12:00:00`).toLocaleDateString() }) : words.task_no_deadline, tone: 'accent', movable: task.status !== 'Done' && !changingTasks.has(task.id), checked: task.status === 'Done', checkDisabled: changingTasks.has(task.id) }));
    const taskCards = trayRecords.map(task => ({
      groupId: grouping.groupById.get(task.id),
      id: `${screenData.tasks.source}:${task.id}`, title: task.title, at: task.starts_at, minutes: task.duration_minutes,
      parentId: task.parent_id ? `${screenData.tasks.source}:${task.parent_id}` : null,
      subtitle: taskProjection.detailsById.get(task.id) || undefined,
      tone: 'accent', movable: task.status !== 'Done' && !changingTasks.has(task.id), checked: task.status === 'Done', checkDisabled: changingTasks.has(task.id),
    }));
    const expandedTask = taskEditor && taskEditor !== 'new' ? (loaded.tasks ?? []).find(task => task.id === taskEditor) : null;
    const trayTasks = taskCards.filter(item => {
      const task = trayRecords.find(row => `${screenData.tasks.source}:${row.id}` === item.id);
      return !(expandedTask && task?.parent_id === expandedTask.id);
    });
    let sourceAt = 0;
    const followsStoredOrder = taskProjection.records.every(task => {
      const found = (loaded.tasks ?? []).findIndex((candidate, index) => index >= sourceAt && candidate.id === task.id);
      if (found < 0) return false;
      sourceAt = found + 1;
      return true;
    });
    const trayCanReorder = Boolean(loaded.taskOrdering?.ready && followsStoredOrder && (grouping.groups.length === 0 || trayDisplay.group_by === 'list') && !taskProjection.hasNonManualSort && trayDisplay.sort_by === 'manual');
    // Group headings: how many each holds, a press that folds it, and (on a list) a press that adds a todo there. With
    // "Show empty lists" the lists that hold nothing keep their heading, in the order of the tabs.
    const headingOf = (group: TaskTrayGroup) => ({
      id: group.id, label: group.label, count: group.count, toggleLabel: fill(trayData.words.group_toggle, { list: group.label }),
      ...(group.listId !== null && moveTarget(group.listId) ? { addLabel: fill(trayData.words.group_add, { list: group.label }), onAdd: () => startTaskIn(group.listId!) } : {}),
    });
    const trayGroups = (() => {
      const shown = grouping.groups.map(headingOf);
      if (!(trayDisplay.group_by === 'list' && trayDisplay.show_empty_lists === true && !oneList)) return shown;
      const byList = new Map<string | null, TaskTrayGroup>(grouping.groups.map(group => [group.listId, group]));
      const ordered = placeLists().map(list => {
        const group = byList.get(list.id);
        return group ? headingOf(group) : { ...headingOf({ id: `empty:${list.id}`, label: list.label, count: 0, listId: list.id }), empty: true };
      });
      return [...ordered, ...shown.filter(row => !placeLists().some(list => grouping.groups.find(group => group.id === row.id)?.listId === list.id))];
    })();
    const cardIdOf = (taskId: string) => `${screenData.tasks.source}:${taskId}`;
    const taskIdOfCard = (id: string) => (id.startsWith(`${screenData.tasks.source}:`) ? id.slice(screenData.tasks.source.length + 1) : null);
    const groupOrder = new Map(trayGroups.map((group, index) => [group.id, index]));
    drawnTaskIds = taskCards.map((card, index) => ({ id: taskIdOfCard(card.id)!, group: groupOrder.get(card.groupId ?? '') ?? groupOrder.size, index }))
      .sort((a, b) => a.group - b.group || a.index - b.index).map(row => row.id);
    const tasksById = new Map((loaded.tasks ?? []).map(task => [task.id, task]));
    const markedTasks = markedTaskIds.flatMap(id => tasksById.get(id) ?? []);
    // Tasks marked together are what an action acts on when the focused one is among them; otherwise the focused one.
    const keyTargets = (focus: string | null): Task[] => {
      if (markedTasks.length > 1 || (markedTasks.length === 1 && markedTasks[0].id === focus)) return markedTasks;
      const one = focus ? tasksById.get(focus) : undefined;
      return one ? [one] : [];
    };
    // The tray's keys are rows of the one keymap; its listener hands each press here (registered once, at mount).
    trayKey = (row, event) => {
      const target = event?.target as HTMLElement | null;
      if (!target) return;
      const entry = target.closest<HTMLElement>('[data-schedule-tray-entry]')?.dataset.scheduleTrayEntry;
      // Keys act on a todo's row or a group heading only, never inside an open card (the keymap already leaves typing and menus alone).
      if (target.closest('[data-calendar-task-editor], [role="dialog"], [data-task-display-menu]')) return;
      if (!entry && !target.closest('[data-schedule-tray-group-row]')) return;
      const keyed = (row.with ?? {}) as { action: string; value?: string };
      const focus = (entry ? taskIdOfCard(entry) : null) ?? focusedTaskId;
      const step = (forward: boolean) => stepId(drawnTaskIds, focus, forward ? 1 : -1) as string | null;
      switch (keyed.action) {
        case 'next': case 'previous':
          focusedTaskId = step(keyed.action === 'next'); markedTaskIds = []; markAnchorId = null; redraw(); return;
        case 'extend_next': case 'extend_previous': {
          const next = step(keyed.action === 'extend_next'), anchor = markAnchorId ?? focus ?? drawnTaskIds[0];
          if (!next || !anchor) return;
          markAnchorId = anchor; focusedTaskId = next; markedTaskIds = rangeIds(drawnTaskIds, anchor, next); redraw(); return;
        }
        case 'next_list': case 'previous_list': {
          const ids = listTabs.map(tab => tab.id), forward = keyed.action === 'next_list';
          activeList = cycleId(ids, activeList, forward ? 1 : -1) as string; markedTaskIds = []; markAnchorId = null; focusedTaskId = null; redraw(); return;
        }
        case 'switch_list': listSwitcherOpen = true; redraw(); return;
        case 'new_todo': quickFocusRequest += 1; redraw(); return;
        default: {
          const targets = entry ? keyTargets(focus) : [];
          const found = targets.length ? verbForKey(taskVerbs(verbContext, targets), keyed) : null;
          if (!found || found.verb.disabled) return;
          if (found.choice) void found.choice.run();
          else if (found.verb.run) void found.verb.run();
          else { verbAsked = { verb: found.verb.id, ids: targets.map(task => task.id) }; redraw(); }
        }
      }
    };
    const markTaskFromPress = (id: string, modifiers?: { additive: boolean; range: boolean }) => {
      const taskId = taskIdOfCard(id);
      if (taskId && modifiers && (modifiers.additive || modifiers.range)) {
        const anchor = markAnchorId ?? focusedTaskId;
        if (modifiers.range && anchor) markedTaskIds = rangeIds(drawnTaskIds, anchor, taskId);
        else { markedTaskIds = markedTaskIds.includes(taskId) ? markedTaskIds.filter(marked => marked !== taskId) : [...markedTaskIds, taskId]; markAnchorId = taskId; }
        focusedTaskId = taskId; redraw();
        return true;
      }
      if (taskId) { focusedTaskId = taskId; markedTaskIds = []; markAnchorId = null; }
      return false;
    };
    const showMail = !tasksOnly && !gridOnly;
    const visibleItems = [...items, ...unscheduled, ...taskCards];
    const scheduleItemById = new Map(visibleItems.map(item => [item.id, item]));
    const taskForScheduleItem = (id: string) => {
      const calendarItem = itemOf(id);
      return (loaded.tasks ?? []).find(task => id === `${screenData.tasks.source}:${task.id}` || (calendarItem?.source === screenData.tasks.source && calendarItem.source_id === task.id));
    };
    const selectableEventIds = items.filter(item => itemOf(item.id)?.source !== screenData.tasks.source).map(item => item.id);
    // Selection follows the records the person can currently see. Hiding a
    // source or filtering the view must not leave unseen events actionable.
    const selectableEventIdSet = new Set(selectableEventIds);
    const visibleSelectedIds = selectedEventIds.filter(id => selectableEventIdSet.has(id));
    if (visibleSelectedIds.length !== selectedEventIds.length) {
      selectedEventIds = visibleSelectedIds;
      confirmingBatchRemoval = false;
    }
    const selectedEvents = selectedEventIds.map(itemOf).filter((item): item is Item => Boolean(item));
    const canDuplicateEvent = (item: Item) => {
      const source = sourceFor(item.source, loaded.sources);
      const create = source?.calendar_actions?.create;
      return Boolean(item.may_move && source?.connected !== false && create && (!item.all_day || create.supports_all_day));
    };
    const removalActionFor = (item: Item) => itemActions(item, loaded.sources).find(action => {
      const declaration = action.calendar_action && sourceFor(item.source, loaded.sources)?.calendar_actions?.[action.calendar_action];
      return Boolean(action.tone === 'danger' && action.confirm && (
        (action.calendar_action && declaration) || (action.post && !action.opens && !action.href)
      ));
    }) ?? null;
    const selectedRemovalActions = selectedEvents.map(item => ({ item, action: removalActionFor(item) }));
    const canRemoveSelection = selectedEvents.length > 0
      && selectedEvents.length === selectedEventIds.length
      && selectedRemovalActions.every(row => row.action);
    const changeEventSelection = (id: string, selected: boolean) => {
      if (!selectingEvents || batchRemovalBusy || duplicateQueue.length || !selectableEventIds.includes(id)) return;
      selectedEventIds = selected
        ? [...new Set([...selectedEventIds, id])]
        : selectedEventIds.filter(value => value !== id);
      confirmingBatchRemoval = false;
      redraw();
    };
    const openNextBatchDuplicate = () => {
      while (duplicateQueue.length && !batchDuplicateItems.has(duplicateQueue[0])) duplicateQueue.shift();
      const item = batchDuplicateItems.get(duplicateQueue[0] ?? '');
      if (!item) {
        writing = false; eventDraft = null; duplicateQueue = [];
        redraw();
        return;
      }
      eventDraft = item; newAt = item.starts_at; newUntil = null; newAnchor = null; writing = true; openId = null;
      pendingItemAction = null; eventEditor = null; taskEditor = null; settingsOpen = false;
      redraw();
    };
    const startBatchDuplicate = () => {
      if (!selectedEvents.length || !selectedEvents.every(canDuplicateEvent)) return;
      duplicateQueue = selectedEvents.map(item => item.id);
      batchDuplicateItems.clear();
      for (const item of selectedEvents) batchDuplicateItems.set(item.id, item);
      duplicateCompleted = 0;
      openNextBatchDuplicate();
    };
    const finishBatchDuplicate = () => {
      const completedId = duplicateQueue.shift();
      if (completedId) {
        duplicateCompleted += 1;
        selectedEventIds = selectedEventIds.filter(id => id !== completedId);
        batchDuplicateItems.delete(completedId);
      }
      if (duplicateQueue.length) { openNextBatchDuplicate(); return; }
      const count = duplicateCompleted;
      duplicateCompleted = 0; batchDuplicateItems.clear(); eventDraft = null; writing = false;
      void screen.reload();
      notify(fill(words.calendar_batch_duplicate_done, { count }), { kind: 'done' });
      redraw();
    };
    const removeSelectedEvents = async () => {
      if (batchRemovalBusy || !canRemoveSelection) return;
      batchRemovalBusy = true; confirmingBatchRemoval = false; redraw();
      const result = await runCalendarBatchRemoval(selectedRemovalActions, async row => {
        const { item, action } = row;
        if (!action) throw new Error(words.calendar_batch_remove_unavailable);
        if (!action.calendar_action) {
          const completed = await runRoad(action, {
            source: item.source, source_id: item.source_id, space_id: item.space_id,
            title: item.title, at: item.starts_at, ends_at: item.ends_at,
          });
          if (!completed) throw new Error(words.calendar_batch_remove_unavailable);
          return;
        }
        let key = batchRemovalRequestKeys.get(item.id);
        if (!key) { key = crypto.randomUUID(); batchRemovalRequestKeys.set(item.id, key); }
        await calendarWrite(item.source, action.calendar_action, { event_id: item.source_id }, key);
        batchRemovalRequestKeys.delete(item.id);
      });
      const removed = result.removed.map(row => row.item.id);
      const failed = result.failed;
      selectedEventIds = selectedEventIds.filter(id => !removed.includes(id));
      let reloadError: unknown = null;
      try { await screen.reload(); } catch (error) { reloadError = error; }
      batchRemovalBusy = false;
      if (failed.length) {
        const detail = errorWords(failed[0].error);
        notify(fill(words.calendar_batch_remove_partial, { removed: removed.length, failed: failed.length, error: detail }), { kind: 'error' });
      } else {
        const message = fill(words.calendar_batch_remove_done, { count: removed.length });
        notify(reloadError ? `${message} ${errorWords(reloadError)}` : message, { kind: reloadError ? 'error' : 'done' });
      }
      redraw();
    };
    const contextRows = screenData.context_actions as { id: string; label: string; icon: string; source_action_tone?: string }[];
    const menuActions: NodeActionCapability[] = contextRows.map(row => {
      const acceptsItem = (node: NodeRef) => node.family === 'schedule-calendar-item' && typeof node.parts?.id === 'string' && scheduleItemById.has(node.parts.id);
      const acceptsAction = (node: NodeRef) => {
        if (!acceptsItem(node)) return false;
        const id = node.parts!.id!;
        const item = itemOf(id);
        const task = taskForScheduleItem(id);
        if (row.source_action_tone) return Boolean(!task && item && itemActions(item, loaded.sources).some(action => action.tone === row.source_action_tone && action.confirm));
        if (row.id === 'calendar.event_duplicate') {
          const create = item && sourceFor(item.source, loaded.sources)?.calendar_actions?.create;
          return Boolean(!task && item?.may_move && create && (!item.all_day || create.supports_all_day));
        }
        if (row.id === 'calendar.edit') return Boolean(task || (item?.may_move && sourceFor(item.source, loaded.sources)?.calendar_actions?.edit));
        if (row.id === 'calendar.copy') return !task;
        return true;
      };
      const run = async (node: NodeRef) => {
        const id = node.parts!.id!;
        const item = itemOf(id);
        const task = taskForScheduleItem(id);
        if (row.source_action_tone && item) {
          const action = itemActions(item, loaded.sources).find(action => action.tone === row.source_action_tone && action.confirm);
          if (action) { open(id); pendingItemAction = { ...action }; redraw(); }
        } else if (row.id === 'calendar.event_duplicate' && item) {
          eventDraft = item; newAt = item.starts_at; newUntil = null; newAnchor = null; writing = true; openId = null; pendingItemAction = null; eventEditor = null; taskEditor = null; settingsOpen = false; redraw();
        } else if (row.id === 'calendar.open') open(id);
        else if (row.id === 'calendar.edit') {
          if (task) { taskEditor = task.id; eventEditor = null; openId = id; redraw(); }
          else if (item?.may_move && sourceFor(item.source, loaded.sources)?.calendar_actions?.edit) { eventEditor = id; openId = null; taskEditor = null; redraw(); }
        } else if (row.id === 'calendar.copy') {
          const copied = await copyTextToClipboard([item?.title ?? '', item ? whenWords(item) : ''].filter(Boolean).join(' · '));
          notify(copied ? words.calendar_copied : words.calendar_copy_failed, { kind: copied ? 'done' : 'error' });
        }
      };
      return { id: row.id, label: row.label, icon: row.icon, shortcut: shortcutOfAction(calendarRows, row.id), accepts: acceptsAction, run };
    });
    const keyActions = calendarKeyActions({
      eventOf: id => (taskForScheduleItem(id) ? null : itemOf(id)),
      sourceOf: event => sourceFor(event.source, loaded.sources),
      actionsOf: event => itemActions(event as Item, loaded.sources),
      runAction: (event, action) => road(event as Item, action as Action),
      askAction: (event, action) => { open(event.id); pendingItemAction = { ...(action as Action) }; redraw(); },
      writeEdit: async (event, input) => { await calendarWrite(event.source, 'edit', input); await screen.reload(); },
      propertyFields: (source, draft) => eventPropertyFields(source as Source | undefined, { ...newEventPropertyDraft(), ...draft }),
      join: event => joinCall(event as Item, loaded.sources, () => ({ item: itemOf(event.id) ?? (event as Item), sources: loaded.sources })),
      say: (words, kind) => notify(words, { kind }),
      doneOffered: () => preferences.eventCheckboxes === true,
      isDone: id => eventsDone.has(id),
      setDone: setEventDone,
    }, id => shortcutOfAction(calendarRows, id), Intl.DateTimeFormat().resolvedOptions().timeZone);
    const contextActions = [...menuActions, ...keyActions];
    // Dropped with Option held: the same duplicate the menu offers, starting where it was dropped.
    const duplicateEventAt = (id: string, at: string) => {
      const item = itemOf(id);
      const create = item && !taskForScheduleItem(id) ? sourceFor(item.source, loaded.sources)?.calendar_actions?.create : null;
      if (!item || !item.may_move || !create || (item.all_day && !create.supports_all_day)) return;
      const length = item.ends_at ? Date.parse(item.ends_at) - Date.parse(item.starts_at) : 0;
      eventDraft = { ...item, starts_at: at, ends_at: item.ends_at ? new Date(Date.parse(at) + length).toISOString() : null };
      newAt = at; writing = true; openId = null; pendingItemAction = null; eventEditor = null; taskEditor = null; settingsOpen = false; redraw();
    };
    // The zones command (Z) opens the settings where the person's time zones are kept.
    const openTimeZones = () => {
      settingsOpen = true; redraw(); void readConnections();
      setTimeout(() => host.querySelector('[data-calendar-time-zones]')?.scrollIntoView({ block: 'center' }), 0);
    };
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Meet: a video meeting starting now, on the grid, for any calendar that can make one.
    const canMeet = loaded.sources.some(source => sourceFor(source.id, loaded.sources)?.calendar_actions?.['create-video-call']);
    const meetNow = () => {
      const now = new Date();
      newUntil = null; newAnchor = null; meetAt = newAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, Math.floor((now.getHours() * 60 + now.getMinutes()) / screenData.snap_minutes) * screenData.snap_minutes).toISOString();
      eventDraft = null; pendingItemAction = null; writing = true; openId = null; taskEditor = null; eventEditor = null; settingsOpen = false; redraw();
    };
    // The verbs of a task act on the tasks marked together when it is one of them, else on it alone.
    const taskVerbsFor = (cardId: string) => {
      const task = taskForScheduleItem(cardId);
      if (!task) return [];
      const marked = markedTaskIds.includes(task.id) && markedTaskIds.length > 1 ? markedTaskIds.flatMap(id => (loaded.tasks ?? []).filter(row => row.id === id)) : [task];
      return taskVerbs(verbContext, marked);
    };
    const taskActions = verbsAsNodeActions(taskVerbsFor, cardId => scheduleItemById.has(cardId) && Boolean(taskForScheduleItem(cardId)));
    const batchRemovePrompt = [...new Set(selectedRemovalActions.map(row => row.action?.confirm?.asks).filter((value): value is string => Boolean(value)))].join(' ');
    const selectionActions = [
      { label: words.calendar_batch_copy, onClick: async () => {
        const copied = await copyTextToClipboard(selectedEvents.map(item => `${item.title} · ${whenWords(item)}`).join('\n'));
        notify(copied ? words.calendar_copied : words.calendar_copy_failed, { kind: copied ? 'done' : 'error' });
      } },
      { label: words.calendar_batch_duplicate, onClick: startBatchDuplicate, disabled: batchRemovalBusy || duplicateQueue.length > 0 || !selectedEvents.length || selectedEvents.length !== selectedEventIds.length || !selectedEvents.every(canDuplicateEvent) },
      { label: confirmingBatchRemoval ? words.calendar_batch_remove_confirm : words.calendar_batch_remove, onClick: () => {
        if (batchRemovalBusy || !canRemoveSelection) return;
        if (confirmingBatchRemoval) void removeSelectedEvents();
        else { confirmingBatchRemoval = true; redraw(); }
      }, variant: 'danger' as const, disabled: batchRemovalBusy || !canRemoveSelection },
      ...(confirmingBatchRemoval ? [{ label: words.calendar_batch_remove_cancel, onClick: () => { confirmingBatchRemoval = false; redraw(); } }] : []),
    ];
    const selectionBar = selectedEvents.length ? <BulkSelectBar
      selectedCount={selectedEvents.length}
      clearDisabled={batchRemovalBusy || duplicateQueue.length > 0}
      onClearAll={() => { if (batchRemovalBusy || duplicateQueue.length) return; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); }}
      actions={selectionActions}
      words={{
        selected: count => fill(words.calendar_selection_count, { count }),
        clear: words.calendar_selection_clear,
        more: words.calendar_selection_more,
        actions: words.calendar_selection_actions,
      }}
      className="min-w-0 flex-wrap"
    >
      {confirmingBatchRemoval ? <Text variant="caption">{batchRemovePrompt}</Text> : null}
    </BulkSelectBar> : null;
    const opened = openId ? itemOf(openId) : null;
    const editingEvent = eventEditor ? itemOf(eventEditor) : null;
    const open = (id: string | null) => { if (id?.startsWith('colleague:')) return; openId = id; pendingItemAction = null; eventDraft = null; writing = false; eventEditor = null; taskEditor = id && taskForScheduleItem(id) ? taskForScheduleItem(id)!.id : null; if (id) { settingsOpen = false; } redraw(); };
    const selectedTaskItemId = taskEditor && taskEditor !== 'new' ? `${screenData.tasks.source}:${taskEditor}` : null;
    const inlineTaskItemId = !gridOnly && selectedTaskItemId && trayTasks.some(item => item.id === selectedTaskItemId) ? selectedTaskItemId : null;
    const taskEditorTask = taskEditor && taskEditor !== 'new' ? (loaded.tasks ?? []).find(task => task.id === taskEditor) ?? null : null;
    const taskEditorContent = taskEditor && (taskEditor === 'new' || taskEditorTask) ? <TaskEditor key={taskEditor === 'new' ? `new:${newTaskParent ?? ''}:${newTaskPlace?.collection_id ?? ''}:${newTaskPlace?.smart_list ?? ''}` : taskEditor} task={taskEditorTask}
            tasks={loaded.tasks ?? []} collections={loaded.collections ?? []} initialParent={taskEditor === 'new' ? newTaskParent : null} initialCollection={taskEditor === 'new' ? newTaskPlace?.collection_id ?? null : null} initialSmartList={taskEditor === 'new' ? newTaskPlace?.smart_list ?? null : null} drafts={taskDrafts}
            labelOptions={[...new Set((loaded.tasks ?? []).flatMap(task => task.labels ?? []))]} partial={loaded.tasksPage?.complete === false} loadingMore={loadingMore} collectionsPartial={loaded.collectionsPage?.complete === false} loadingCollections={collectionsLoadingMore} changingTasks={changingTasks} onMore={() => void moreTasks()} onMoreCollections={() => void moreTaskCollections()}
            onOpen={id => { taskEditor = id; openId = null; redraw(); void screen.reload(); }} onAddSubtask={id => { newTaskParent = id; newTaskPlace = null; taskEditor = 'new'; openId = null; redraw(); }} onChildCompletion={(task, checked) => void setTaskCompletion(task, checked)} onDuplicate={task => void duplicateTask(task)}
            menuVerbs={taskEditorTask ? taskVerbs(verbContext, [taskEditorTask]) : []} onLogTime={logTime}
            onOpenInPane={taskOnly ? undefined : task => openScreenOn(screenData.task_surface.screen, { task_id: task.id, task_only: true }, task.title)}
            onClose={() => { taskEditor = null; newTaskPlace = null; openId = null; redraw(); }} onKept={() => { taskEditor = null; newTaskPlace = null; openId = null; void screen.reload(); }} /> : null;
    const unread = loaded.sources.filter(source => !source.read || source.complete === false);
    const changeHiddenSources = (values: string[]) => {
      const previous = hidden, revision = ++hiddenSourcesRevision; hidden = values; redraw();
      void writeConfirmedWorkspacePreference('calendar-hidden-sources', values).catch(error => {
        if (revision === hiddenSourcesRevision) { hidden = previous; redraw(); }
        notify(errorWords(error), { kind: 'error' });
      });
    };
    const changeCalendarPreferences = (values: CalendarControlPreferences) => {
      if (!values.workScheduleId) {
        if (!values.workdays.length) { notify(words.work_days_invalid, { kind: 'info' }); return; }
        if (minute(values.workEnd) <= minute(values.workStart)) { notify(words.work_hours_invalid, { kind: 'info' }); return; }
      }
      try {
        const ids = new Set<string>();
        for (const schedule of values.workSchedules ?? []) {
          if (!schedule.id || ids.has(schedule.id) || !schedule.label.trim()) throw new Error('Invalid schedule');
          ids.add(schedule.id);
          // Use the planner's shared admission instead of allowing settings and
          // scheduling to disagree about valid intervals.
          planSchedule([], [], { working_hours: { days: schedule.days } });
        }
        if (values.workScheduleId && !ids.has(values.workScheduleId)) throw new Error('Missing schedule');
      } catch { notify(words.work_schedule_invalid, { kind: 'info' }); return; }
      const previous = preferences, revision = ++calendarPreferencesRevision; preferences = values; redraw();
      void writeConfirmedWorkspacePreference('calendar-settings', values).then(() => screen.reload(), error => {
        if (revision === calendarPreferencesRevision) { preferences = previous; redraw(); }
        notify(errorWords(error), { kind: 'error' });
      });
    };
    // Zoom keys and the Command-drag over the hour labels change the height many times a second: the calendar redraws at
    // once and the choice is saved once the person stops, without reading the calendar again.
    const changeHourHeight = (px: number) => {
      if (px === preferences.hourHeightPx) return;
      preferences = { ...preferences, hourHeightPx: px }; redraw();
      clearTimeout(zoomSave);
      zoomSave = setTimeout(saveZoom, 400);
    };
    const taskDisplayOptions = <TaskDisplayMenu display={trayDisplay} onChange={changeDisplay}>
      <Button size="sm" variant="ghost" disabled={planning || applyingPlan} onClick={() => suggest()}>{planning ? words.plan_loading : words.plan}</Button>
      {toolbar.displayActions ? <Container layout="vertical" gap="xs">
        <Text variant="caption">{words.calendar_display}</Text>
        {toolbar.displayActions}
      </Container> : null}
      <Container layout="vertical" gap="sm">
        <Text variant="caption">{words.task_list_to_manage}</Text>
        <Select modal={false} value={collectionSelection} onValueChange={value => {
          if (typeof value !== 'string') return;
          collectionSelection = value; collectionName = (loaded.collections ?? []).find(row => row.id === value)?.title ?? ''; redraw();
        }}>
          <SelectTrigger aria-label={words.task_list_to_manage}><SelectValue placeholder={words.task_list_new_choice} /></SelectTrigger>
          <SelectPopup align="end" portalProps={{ className: 'coss-ui', keepMounted: true }}>
            <SelectItem value="">{words.task_list_new_choice}</SelectItem>
            {collectionSelection && !(loaded.collections ?? []).some(row => row.id === collectionSelection) ? <SelectItem value={collectionSelection}>{words.task_list_unavailable}</SelectItem> : null}
            {(loaded.collections ?? []).map(row => <SelectItem key={row.id} value={row.id}>{row.title}</SelectItem>)}
          </SelectPopup>
        </Select>
        <Input aria-label={words.task_list_name} placeholder={words.task_list_name} value={collectionName} disabled={collectionMutationBusy} onChange={event => { collectionName = event.target.value; redraw(); }} />
        <Container layout="horizontal" gap="xs" wrap>
          <Button size="sm" variant="outline" disabled={collectionMutationBusy || !collectionName.trim()} onClick={() => changeTaskCollection('create_collection')}>{words.task_list_create}</Button>
          {collectionSelection && (loaded.collections ?? []).some(row => row.id === collectionSelection) ? <>
            <Button size="sm" variant="outline" disabled={collectionMutationBusy || !collectionName.trim()} onClick={() => changeTaskCollection('update_collection')}>{words.task_list_rename}</Button>
            <Button size="sm" variant="ghost" disabled={collectionMutationBusy} onClick={() => changeTaskCollection('delete_collection')}>{words.task_list_delete}</Button>
          </> : null}
        </Container>
        {loaded.collectionsPage?.complete === false ? <Button size="sm" variant="outline" disabled={collectionsLoadingMore} onClick={() => moreTaskCollections()}>{words.load_more_task_lists}</Button> : null}
      </Container>
    </TaskDisplayMenu>;
    const sourceMenu = <CalendarControls presentation="sources-menu" sources={loaded.sources.map(source => ({ ...source, connected: source.connected !== false }))}
      hidden={hidden} onHiddenChange={changeHiddenSources} preferences={preferences} onPreferencesChange={changeCalendarPreferences} people={peopleChoices} onPersonShownChange={setColleagueShown} onConnectYours={connectYours} />;
    const settingsPanel = settingsOpen ? <CalendarControls className={settingsOnly ? 'max-h-full min-h-0 flex-1 overflow-y-auto' : 'max-h-[60vh] shrink-0 overflow-y-auto'} sources={loaded.sources.map(source => ({ ...source, connected: source.connected !== false }))} hidden={hidden} onHiddenChange={changeHiddenSources} accounts={calendarAccounts} selections={calendarSelections} connectionsBusy={connectionsBusy} connectionsError={connectionsError} availabilityLinks={availabilityLinks} onSelectionsChange={values => {
      if (values.length > 12) { notify(words.calendar_selection_limit, { kind: 'info' }); return; }
      const previous = calendarSelections; calendarSelections = values; connectionsBusy = true; redraw();
      void writeWorkspacePreference('calendar-selections', values).then(() => screen.reload(), error => { calendarSelections = previous; notify(errorWords(error), { kind: 'error' }); }).finally(() => { connectionsBusy = false; redraw(); });
    }} preferences={preferences} onPreferencesChange={changeCalendarPreferences} people={peopleChoices} onPersonShownChange={setColleagueShown} onConnectYours={connectYours} onNewTask={settingsOnly ? undefined : () => { taskEditor = 'new'; newTaskParent = null; newTaskPlace = null; eventEditor = null; writing = false; openId = null; settingsOpen = false; redraw(); }} onTaskInbox={() => openAddress(screenData.tasks.href)} /> : null;
    const mailAccounts = [...new Map(calendarAccounts.map(account => [account.connection_id, { id: account.connection_id, label: account.account_label }])).values()];
    const todoSettings = settingsOpen ? <Container layout="vertical" gap="md" padding="md" className={settingsOnly ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-[40vh] shrink-0 overflow-y-auto'} data-calendar-todo-settings>
      <TodoListsSettings accounts={calendarAccounts} notify={notify} onChanged={() => void screen.reload()} />
      <PlanningSettings notify={notify} />
      <EmailTodoSettings accounts={mailAccounts} notify={notify} onImport={() => importInbox(true)} />
    </Container> : null;
    const eventSettings = settingsOpen ? <Container layout="vertical" gap="md" padding="md" className={settingsOnly ? 'shrink-0' : 'max-h-[40vh] shrink-0 overflow-y-auto'} data-calendar-event-settings>
      <ShowDeclinedSetting />
      <MeetingProviderSettings />
    </Container> : null;
    const slotBar = slotMode ? <SlotBar accounts={calendarAccounts} preferences={preferences} mutate={availabilityLinks.mutate} ranges={slotRanges}
      onRangesChange={next => { slotRanges = next; redraw(); }} dayKeys={visibleDays(shownView(), anchor, preferences.weekStart)} weekdayOf={key => dayStart(key).getDay()} at={timeAt}
      onCreated={link => { leaveSlotMode(); notify(slotWords.created, { kind: 'done' }); void availabilityLinks.onShare(link.id, link.title, null); }} onDiscard={leaveSlotMode} /> : null;
    if (settingsOnly) return <Container ref={surface} layout="vertical" height="full" minHeight="0" data-calendar-screen data-calendar-settings-only>{settingsPanel}{eventSettings}{todoSettings}</Container>;
    if (taskOnly) return <Container ref={surface} layout="vertical" height="full" minHeight="0" className="overflow-y-auto" data-calendar-screen data-calendar-task-only>
      {taskEditorContent ?? <Container layout="vertical" gap="sm" padding="md"><Text>{words.task_pane_closed}</Text><Button size="sm" variant="outline" onClick={() => openScreen(screenData.calendar_surface.screen)}>{words.task_open_calendar}</Button></Container>}
    </Container>;

    return (
      <Container ref={surface} layout="vertical" gap="sm" height="full" minHeight="0" data-calendar-screen>
        {settingsPanel}
        {eventSettings}
        {todoSettings}
        {slotBar}
        <SharedCalendar
          room={focusedPlace()}
          selected={openId ? [openId] : []}
          roster={people => (people || unread.length ? (
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="sm" wrap>
              <Container layout="horizontal" gap="sm" alignItems="center" wrap>
                {unread.filter(source => !(focusedPlace() && source.connected === false)).map(source => (
                  <Container key={source.id} layout="horizontal" gap="xs" alignItems="center" wrap className="min-w-0 max-w-full">
                    <Text variant="caption">{source.said ?? fill(words.unread, { source: source.label })}</Text>
                    {source.connected === false && sourceFor(source.id, loaded.sources)?.connect ? (
                      <Button size="xs" variant="outline" onClick={() => runRoad({ href: sourceFor(source.id, loaded.sources)!.connect!.href }, {})}>{sourceFor(source.id, loaded.sources)!.connect!.label}</Button>
                    ) : null}
                  </Container>
                ))}
              </Container>
              {people}
            </Container>
          ) : null)}
        >
          <ScheduleCalendar
            items={[...items, ...colleagueItems, ...unscheduled]}
            trayItems={trayTasks}
            onTrayReorder={trayCanReorder ? async move => {
              const task = taskForScheduleItem(move.id);
              const anchorId = move.before ?? move.after;
              const anchorTask = anchorId ? taskForScheduleItem(anchorId) : null;
              if (!task || !anchorTask) throw new Error(words.task_order_failed);
              changingTasks.add(task.id); redraw();
              try {
                const answer = await postJson<{ task: Task }>('/work/api/calendar/tasks', {
                  action: 'reorder', task_id: task.id, anchor_id: anchorTask.id,
                  placement: move.before ? 'before' : 'after',
                });
                loaded = { ...loaded, tasks: (loaded.tasks ?? []).map(row => row.id === task.id ? answer.task : row) };
                // Default ordering is the Lists owner's ordering, not another
                // comparator in this presentation. Read its accepted order.
                await screen.reload();
              } catch (error) {
                notify(errorWords(error), { kind: 'error' }); throw error;
              } finally { changingTasks.delete(task.id); redraw(); }
            } : undefined}
            trayReorderDisabled={changingTasks.size > 0}
            trayGroups={trayGroups}
            trayMarkedIds={markedTaskIds.map(cardIdOf)}
            trayFocusedId={focusedTaskId ? cardIdOf(focusedTaskId) : null}
            contextActions={[...contextActions, ...taskActions]}
            selectableIds={selectingEvents ? selectableEventIds : []}
            selectedIds={selectedEventIds}
            selectionDisabled={batchRemovalBusy || duplicateQueue.length > 0}
            selectionPresentation={screenData.selection_presentation as 'highlight' | 'checkbox'}
            onSelectionChange={changeEventSelection}
            selectionBar={selectionBar}
            selectedId={selectedTaskItemId ?? openId}
            view={shownView()}
            showGrid={!tasksOnly}
            showHeader={!tasksOnly}
            choices={VIEWS.map(({ id, label }) => ({ id, label }))}
            choice={choice}
            choicePresentation={screenData.choice_presentation as 'segmented' | 'menu'}
            onChoiceChange={next => { manualView = true; choice = next; openId = null; selectingEvents = false; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); void screen.reload(); }}
            anchor={anchor}
            tray={!gridOnly}
            traySide={screenData.tray_side}
            headerPosition="grid"
            headerContent={<Container layout="horizontal" gap="xs" alignItems="center" wrap>{sourceMenu}
              {canMeet ? <Button size="xs" variant="outline" title={words.meet_tip} onClick={meetNow}>{words.meet}</Button> : null}
              <ShareLinksMenu listLinks={availabilityLinks.listLinks} mutate={availabilityLinks.mutate} subscribeChanges={onStoreChange}
                onShare={(id, title, anchor) => void availabilityLinks.onShare(id, title, anchor)} onCreate={startSlotMode} />
              {selectableEventIds.length ? <Button size="xs" variant={selectingEvents ? 'outline' : 'ghost'} aria-pressed={selectingEvents}
                aria-label={selectingEvents ? words.calendar_selection_finish : words.calendar_selection_start}
                title={selectingEvents ? words.calendar_selection_finish : words.calendar_selection_start}
                disabled={batchRemovalBusy || duplicateQueue.length > 0}
                onClick={() => { selectingEvents = !selectingEvents; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); }}>
                <NamedIcon name={screenData.selection_icon} size={14} />
              </Button> : null}
              {toolbar.primaryActions ?? toolbar.actions}</Container>}
            trayHeader={
        <Container layout="vertical" gap="sm" className="schedule-tray-controls">
          <TaskListTabs tabs={listTabs} more={loaded.tasksPage?.complete === false} active={activeList} switcherOpen={listSwitcherOpen}
            onChange={id => { activeList = id; markedTaskIds = []; markAnchorId = null; focusedTaskId = null; redraw(); }}
            onSwitcherOpenChange={open => { listSwitcherOpen = open; redraw(); }} onCreate={createTaskList} />
          {markedTasks.length > 1 ? <TaskMarkedBar count={markedTasks.length} disabled={changingTasks.size > 0}
            onClear={() => { markedTaskIds = []; markAnchorId = null; redraw(); }}
            onDone={() => void taskVerbs(verbContext, markedTasks).find(verb => verb.id === 'complete')?.run?.()}
            onMove={() => { verbAsked = { verb: 'move', ids: markedTasks.map(task => task.id) }; redraw(); }}
            onDelete={() => void taskVerbs(verbContext, markedTasks).find(verb => verb.id === 'delete')?.run?.()} /> : null}
          {(() => {
            const asked = verbAsked ? taskVerbs(verbContext, verbAsked.ids.flatMap(id => tasksById.get(id) ?? [])) : [];
            const verb = asked.find(row => row.id === verbAsked?.verb);
            return verb && verbAsked ? <VerbPanel verb={verb} label={verbAsked.ids.length === 1 ? tasksById.get(verbAsked.ids[0])?.title ?? verb.label : fill(trayData.words.marked, { count: verbAsked.ids.length })}
              onClose={() => { verbAsked = null; redraw(); }} /> : null;
          })()}
          <TaskTrayRecordView tasks={hidden.includes(screenData.tasks.source) ? [] : trayInput} collections={loaded.collections ?? []}
            groupLevels={trayGroupLevels} onGroupLevelsChange={levels => {
              if (JSON.stringify(levels) === JSON.stringify(trayGroupLevels)) return;
              const matched = trayData.display.group_by.find(row => row.id !== 'list' && JSON.stringify(row.levels) === JSON.stringify(levels));
              changeDisplay(matched ? { ...trayDisplay, group_by: matched.id, group_levels: undefined } : { ...trayDisplay, group_by: 'none', group_levels: levels });
            }}
            configuration={taskConfigurations.options()} onProjection={keepTaskProjection} onLoadMore={() => void moreTasks()}
            hasMore={loaded.tasksPage?.complete === false} loadingMore={loadingMore} toolbarEnd={taskDisplayOptions} />
          <QuickCreate compact expandLabel={words.new_task} focusRequest={quickFocusRequest} preview={quickAddPreview}
            onExpand={() => { taskEditor = 'new'; newTaskParent = null; newTaskPlace = moveTarget(activeList); eventEditor = null; writing = false; openId = null; settingsOpen = false; redraw(); }}
            label={words.quick_task_label} placeholder={trayData.quick_add.placeholder} submitLabel={words.quick_task_add} busyLabel={words.quick_task_adding} errorLabel={words.quick_task_failed} secondaryLabel={words.compose_mail}
            onSubmit={quickAddTask} onSecondaryAction={() => {
              if (tasksOnly) openScreenOn(screenData.mail_surface.screen, { presentation: 'calendar', compose: true }, words.compose_mail);
              else { mailComposeRequest += 1; redraw(); }
            }} />
        </Container>
            }
            trayItemDetail={inlineTaskItemId ? { id: inlineTaskItemId, content: taskEditorContent, replacesItem: true } : null}
            trayDetailOpen={mailDetailOpen || Boolean(writing || taskEditor || editingEvent || opened || plan || planFailure || planning)}
            trayContent={writing || (!inlineTaskItemId && taskEditor) || editingEvent || opened || plan || planFailure || planning ? <Tabs value="tasks">
              <TabsContent value="tasks" keepMounted>
        {writing || taskEditor || editingEvent || opened ? <Container layout="vertical" gap="sm" className="schedule-calendar-detail" data-calendar-action-panel>
          {writing ? <NewMeeting key={eventDraft?.id ?? newAt ?? 'new'} places={places} place={focusedPlace()} at={newAt} until={newUntil} anchor={newAnchor} draft={eventDraft} defaultPrivate={preferences.privateByDefault === true} defaultVideo={meetAt !== null && meetAt === newAt} sources={loaded.sources} accounts={calendarAccounts} toneOf={id => preferences.sourceColors?.[id] ?? sourceFor(id, loaded.sources)?.look?.tone} onNeedAccounts={needAccounts} defaultTime={preferences.workStart} defaultDuration={preferences.defaultEventDurationMinutes ?? preferenceDefaults.default_event_duration_minutes} defaultSourceId={currentDefaultSourceId()} quietSuccess={duplicateQueue.length > 0} onClose={() => {
            if (duplicateQueue.length) {
              const count = duplicateCompleted;
              duplicateQueue = []; duplicateCompleted = 0; batchDuplicateItems.clear();
              if (count) { void screen.reload(); notify(fill(words.calendar_batch_duplicate_done, { count }), { kind: 'done' }); }
            }
            writing = false; eventDraft = null; redraw();
          }} onKept={() => { if (duplicateQueue.length) finishBatchDuplicate(); else { writing = false; eventDraft = null; void screen.reload(); } }} /> : null}
          {!inlineTaskItemId ? taskEditorContent : null}
          {editingEvent ? <EventEditor key={editingEvent.id} item={editingEvent} sources={loaded.sources} onClose={() => { eventEditor = null; redraw(); }} onKept={() => { eventEditor = null; void screen.reload(); }} /> : null}
          {opened && !writing && !taskEditor && !editingEvent ? <OpenItem item={opened} sources={loaded.sources} askAction={pendingItemAction} onEdit={opened.source === screenData.tasks.source ? () => { taskEditor = opened.source_id; redraw(); } : undefined} onEditEvent={opened.may_move && sourceFor(opened.source, loaded.sources)?.calendar_actions?.edit ? () => { eventEditor = opened.id; redraw(); } : undefined} onMove={at => move(opened.id, at)} onRoad={chosen => road(opened, chosen)} onClose={() => open(null)} /> : null}
        </Container> : null}
        {plan || planFailure || planning ? <Container layout="vertical" gap="sm" padding="md" className="schedule-calendar-detail" data-calendar-plan>
          <Text variant="heading-xs">{words.plan_title}</Text>
          <Text variant="body-sm">{fill(words.plan_about, { days: screenData.planning.days })}</Text>
          {planFailure ? <Text variant="body-sm" color="error">{planFailure}</Text> : null}
          {plan?.proposals.map(row => <Container key={row.task_id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
            <Text variant="body-sm">{row.title}</Text>
            <Text variant="caption">{new Date(row.starts_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {row.duration_minutes} min{screenData.planning.statuses[row.status] ? ` · ${screenData.planning.statuses[row.status]}` : ''}</Text>
          </Container>)}
          {plan?.unscheduled.map((row, index) => <Text key={row.task_id ?? index} variant="caption">{row.title}: {screenData.planning.reasons[row.reason]}</Text>)}
          {plan && !plan.proposals.length && !plan.unscheduled.length ? <Text variant="body-sm">{words.plan_empty}</Text> : null}
          <Container layout="horizontal" gap="sm">
            {plan?.proposals.length ? <Button size="sm" variant="primary" disabled={applyingPlan} onClick={() => applySuggestions()}>{words.plan_apply}</Button> : null}
            <Button size="sm" variant="ghost" disabled={planning || applyingPlan} onClick={() => { plan = null; planFailure = null; redraw(); }}>{words.close}</Button>
          </Container>
        </Container> : null}
              </TabsContent>
            </Tabs> : null}
            trayAfterItems={!tasksOnly && !gridOnly ? <Tabs value={showMail ? "mail" : "hidden"}>
              <TabsContent value="mail" keepMounted className="calendar-mail-panel">
                <EmailSurface presentation="calendar" enabled={showMail} composeRequest={mailComposeRequest} onDetailChange={mailDetailChanged} onCountChange={mailItemsChanged} onInboxMessages={mailArrived} />
              </TabsContent>
            </Tabs> : null}
            weekStartsOn={preferences.weekStart}
            showWeekends={preferences.weekends}
            workingHours={{ startMinute: minute(preferences.workStart), endMinute: minute(preferences.workEnd) }}
            workingIntervalsForDay={day => {
              const weekday = dayStart(day).getDay();
              const selected = preferences.workSchedules?.find(schedule => schedule.id === preferences.workScheduleId);
              if (selected) return (selected.days.find(row => row.weekday === weekday)?.intervals ?? [])
                .map(interval => ({ startMinute: interval.start_minute, endMinute: interval.end_minute }));
              return preferences.workdays.includes(weekday)
                ? [{ startMinute: minute(preferences.workStart), endMinute: minute(preferences.workEnd) }] : [];
            }}
            onAnchorChange={next => { anchor = next; openId = null; selectingEvents = false; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); void screen.reload(); }}
            onMove={(id, at) => {
              const task = (loaded.tasks ?? []).find(task => `${screenData.tasks.source}:${task.id}` === id);
              const taskId = task?.id ?? (id.startsWith(`${screenData.tasks.source}:`) ? id.slice(screenData.tasks.source.length + 1) : null);
              if (taskId) { void postJson('/work/api/calendar/tasks', at ? { action: 'schedule', task_id: taskId, start: at } : { action: 'unschedule', task_id: taskId }).then(() => screen.reload(), error => notify(errorWords(error), { kind: 'error' })); }
              else if (at) void move(id, at);
            }}
            onResize={(id, minutes) => { const at = itemOf(id)?.starts_at; if (at) void move(id, at, minutes); }}
            ranges={slotMode ? slotRanges : undefined}
            onSelectRange={(startAt, endAt, anchor) => {
              if (slotMode) { slotRanges = addRange(slotRanges, { startAt, endAt }); redraw(); return; }
              eventDraft = null; pendingItemAction = null; newAt = startAt; newUntil = endAt; newAnchor = anchor; writing = true; openId = null; taskEditor = null; eventEditor = null; settingsOpen = false; redraw();
            }}
            onRemoveRange={slotMode ? id => { slotRanges = slotRanges.filter(range => range.id !== id); redraw(); } : undefined}
            onOpen={(id, modifiers) => { if (!markTaskFromPress(id, modifiers)) open(id); }}
            onCheckedChange={(id, checked) => {
              const task = taskForScheduleItem(id);
              if (task) void setTaskCompletion(task, checked);
              else if (itemOf(id)) setEventDone(id, checked);
            }}
            onSelectDay={key => { anchor = key; choice = VIEWS.find(item => item.view.grid === 'hours' && item.view.days === 1)?.id ?? choice; selectingEvents = false; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); void screen.reload(); }}
            ariaLabel={words.screen}
            registerVerb={bindCalendarVerb}
            shortcutGroups={calendarShortcutGroups(calendarRows)}
            shortcutKeys={Object.fromEntries(['previous', 'next', 'today'].flatMap(name => {
              const chord = calendarRows.find(row => row.id === `calendar-${name}`)?.chord;
              return chord ? [[name, shownChord(chord, KEYMAP, onMac()).join('')]] : [];
            }))}
            format={calendarFormatChoice(preferences)}
            zoneGutters={calendarZoneGutters(preferences.timeZones, deviceZone)}
            gutterHeading={preferences.timeZones?.find(row => row.zone === deviceZone)?.nickname}
            onHourHeightChange={changeHourHeight}
            minHourHeightPx={screenData.zoom.min_px}
            maxHourHeightPx={screenData.zoom.max_px}
            zoomStepPx={screenData.zoom.step_px}
            onRollingChange={rolling => changeCalendarPreferences({ ...preferences, startWeekToday: rolling })}
            onDuplicate={duplicateEventAt}
            sections={screenData.sections}
            section={screenData.sections[0].id}
            onSectionChange={id => { const opens = screenData.sections.find(row => row.id === id)?.opens; if (opens) openScreen(opens); }}
            words={{
              previous: words.previous, next: words.next, today: words.today,
              periods: { day: words.period_day, week: words.period_week, month: words.period_month, days: words.period_days },
              previousPeriod: words.previous_period, nextPeriod: words.next_period, goToToday: words.go_to_today, weekLabel: words.week_label,
              breadcrumb: words.breadcrumb, chooseMonth: words.choose_month, chooseSection: words.choose_section,
              allDayMore: count => fill(words.all_day_more, { count }), shortcuts: words.shortcuts_title, zoomDrag: words.zoom_drag, tray: words.tasks_heading, trayEmpty: showMail || taskProjection.filtering ? '' : words.task_empty,
              more: count => fill(words.more, { count }),
              placing: (title, when) => fill(words.placing, { title, when }),
              unplacing: title => fill(words.task_unplace, { title }), show: words.show, allDay: words.all_day,
              selectTimeHint: words.select_time_hint, resizeHandle: (title, minutes) => fill(words.resize_handle, { title, minutes }),
              checkItem: (title, checked) => fill(checked ? words.task_reopen_named : words.task_complete_named, { title }),
              reorderItem: title => fill(words.task_reorder_named, { title }),
              selectItem: (title, selected) => fill(selected ? words.calendar_deselect_event : words.calendar_select_event, { title }),
              chooseDate: words.choose_date, removeRange: when => fill(slotWords.removeSlot, { when }),
            }}
            windowStartMinute={screenData.hour_window.start}
            windowEndMinute={screenData.hour_window.end}
            initialScrollMinute={minute(preferences.workStart)}
            hourHeightPx={preferences.hourHeightPx}
            snapMinutes={screenData.snap_minutes}
            durationMinutes={screenData.meeting_minutes}
          />
        </SharedCalendar>

      </Container>
    );
  }

  // One calendar view in the bar (its id is the Calendar every list is offered, so this screen's own takes its place).
  const calendarView: RecordView = { ...screenData.calendar, render: ({ records, toolbar, searchText }: RecordViewContext) => <CalendarBody records={records} toolbar={toolbar} searchText={searchText} /> };
  const onCalendar = () => viewId === calendarView.id;
  const options = () => ({
    label: words.screen, fields: FIELDS, records: loaded.items.filter(item => !hidden.includes(item.source)).map(rowOf), identify: (row: Row) => row.id, preferenceKey: 'trillion-shared-calendar', showToolbar: !settingsOnly && !taskOnly && viewId !== screenData.calendar.id,
    toolbarEnd: settingsOnly || viewId !== screenData.calendar.id ? null : <>
      <Button size="icon-sm" variant="ghost" aria-label={words.settings} title={words.settings} aria-expanded={settingsOpen} onClick={() => { settingsOpen = !settingsOpen; redraw(); if (settingsOpen) void readConnections(); }}><NamedIcon name="Settings2" size={14} /></Button>
    </>,
    // The calendar shows its whole window and its own week, month and day, so no count beside the name and no zoom.
    views: [calendarView, screenData.table], view: viewId, count: false, detailLevels: null,
    onViewChange: (next: string) => { if (next === viewId) return; viewId = next; if (onCalendar()) void screen.reload(); },
    onOpen: (id: string) => { openId = id; writing = false; if (!onCalendar()) { viewId = calendarView.id; const at = itemOf(id)?.starts_at; if (at) anchor = dayKey(new Date(at)); void screen.reload(); } redraw(); },
    ...recordFilter,
    primaryAction: { label: words.new, icon: 'CalendarPlus', onSelect: () => { eventDraft = null; pendingItemAction = null; newAt = null; newUntil = null; newAnchor = null; writing = true; taskEditor = null; eventEditor = null; openId = null; settingsOpen = false; viewId = calendarView.id; redraw(); } },
    emptyMessage: words.nothing,
  });

  // Keep the existing React owners when a fresh answer replaces a kept one.
  // Open controls and local drafts survive the same updates as saved layouts.
  const acceptCalendar = (answer: Calendar) => {
      loaded = answer;
      if (requestedEvent) {
        const sourceId = typeof requestedEvent.source === 'string' ? requestedEvent.source : '';
        const source = loaded.sources.find(row => row.id === sourceId);
        const event = loaded.items.find(row => row.id === requestedEvent.id && row.source === sourceId
          && row.source_id === requestedEvent.source_id && row.starts_at === requestedEvent.starts_at);
        if (event && source?.read && source.complete !== false && source.selection?.connected_at === requestedEvent.source_generation) openId = event.id;
        else if (source?.read && source.complete !== false) notify('This meeting is no longer available in the calendar.', { kind: 'error' });
        else notify('This meeting could not be verified because its calendar source is unavailable.', { kind: 'error' });
      }
      // Source state belongs to this mount. sourceFor combines this answer with
      // immutable source DATA, so another configured Calendar piece cannot erase it.
      if (views) redraw(); else views = mountRecordViews(host, options());
      if (!taskConfigurationsStarted) { taskConfigurationsStarted = true; void taskConfigurations.load(); }
  };

  const screen = loadScreen(host, {
    loading: { label: words.loading, layout: 'rows' },
    read: async () => {
      await readSavedLabels([`workspace-preference:${screenData.colleagues.preference_key}`, 'workspace-preference:calendar-settings', 'workspace-preference:calendar-hidden-sources', `workspace-preference:${trayData.display.preference_key}`, `workspace-preference:${screenData.events_done.preference_key}`]);
      eventsDone = new Set(readWorkspacePreference<string[]>(screenData.events_done.preference_key) ?? []);
      colleaguesShown = readWorkspacePreference<string[]>(screenData.colleagues.preference_key) ?? [];
      preferences = { ...preferences, ...readWorkspacePreference<typeof preferences>('calendar-settings') };
      hidden = readWorkspacePreference<string[]>('calendar-hidden-sources') ?? hidden;
      trayDisplay = displayFrom(readWorkspacePreference<unknown>(trayData.display.preference_key));
      const range = visibleRange(shownView(), anchor, preferences.weekStart);
      const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${requestedEvent ? '&fresh=1' : ''}`;
      const activeTaskId = taskEditor && taskEditor !== 'new' ? taskEditor : null;
      const [calendar, tasks] = await Promise.all([taskOnly ? Promise.resolve({ from: '', to: '', items: [], sources: [] } as Calendar) : readJson<Calendar>(`/work/api/calendar?${query}`), readJson<{ tasks: Task[]; page: TaskPage; ordering?: TaskOrdering; collections: TaskCollection[]; collections_page: TaskPage; preferences?: Record<string, unknown> }>(`/work/api/calendar/tasks?sort=manual${activeTaskId ? `&task_id=${encodeURIComponent(activeTaskId)}` : ''}`)]);
      return { ...calendar, tasks: tasks.tasks, tasksPage: tasks.page, taskOrdering: tasks.ordering, collections: tasks.collections, collectionsPage: tasks.collections_page, taskPreferences: tasks.preferences };
    },
    failed: refusal(words.failed),
    clear: () => { views?.destroy(); views = null; },
    draw: acceptCalendar,
    update: acceptCalendar,
  });
  if (settingsOnly) void readConnections();
  // The spaces a meeting can be for, read once; a focus that changes moves the room and what is shown.
  focusChoices().then(dimensions => {
    const place = dimensions.find((dimension: Dimension) => dimension.param === screenData.place.param);
    places = (place?.values ?? []).map(value => ({ id: value.id, title: value.title }));
    redraw();
  }, () => undefined);
  const stopFocus = onFocusChange(() => { selectingEvents = false; selectedEventIds = []; confirmingBatchRemoval = false; redraw(); });
  const stopListening = onStoreChange(() => screen.reload());
  const stopKeys = registerVerb(TASK_KEY, (row, event) => trayKey?.(row, event));
  return () => { if (zoomSave !== undefined) { clearTimeout(zoomSave); saveZoom(); } stopFocus(); stopListening(); stopKeys(); disposed = true; taskConfigurations.dispose(); screen.dispose(); releaseNode(askBar); element.replaceChildren(); };
}
