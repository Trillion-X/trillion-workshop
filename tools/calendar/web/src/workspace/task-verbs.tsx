// src/workspace/task-verbs.tsx
//
// PURPOSE
//   What a person can do to one task or to several marked together, written once: mark done, move to a list, set priority,
//   schedule, set duration, repeat, set deadline, snooze, copy the title, duplicate, delete. The right-click menu, the card's
//   "..." menu, the keys on the tray and the marked-tasks bar all read this one list (`taskVerbs`), so a verb added here
//   appears in each. Which verbs exist, their words and icons are rows of calendar-task-tray.json `menu` and their keys are rows of the
//   one keymap (keymap.json, scope `tasks`); every change goes through the one task road (/work/api/calendar/tasks) and answers with the undo it was given.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A change is made task by task through the task road; one that is refused is counted and said, the others still change.
//   2. Every change that can be undone is offered with its undo, in the same note that says what happened.
//   3. Nothing here keeps state: the screen owns what is marked, what is busy and when to read again.

import React from 'react';
import { Button, Container, Text } from '../../parts/ui';
import { DatePicker } from '../../parts/ui/show/date-picker/DatePicker';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { TaskRecurrence, type TaskRecurrenceValue } from '../../parts/ui/show/task-recurrence/TaskRecurrence';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { NamedIcon } from '../../parts/ui/show/icon';
import type { NodeActionCapability } from '../../parts/ui/show/node-actions';
import taskData from '../calendar-tasks.json';
import tray from './calendar-task-tray.json';
import screenData from './shared-calendar.json';
import { durationWords, instantOf, inList, localDay, moveTarget, nowDay, snoozeDay } from '../calendar-task-views.mjs';
import { fill, localInput, type Task, type TaskCollection } from './calendar-screen-core';
import { KEYMAP, currentRows } from './keymap-runtime';
import { parseChord } from './keymap.mjs';

/** The verb every tray row of keymap.json (scope `tasks`) names; the row's `with.action` says which todo verb or movement it is. */
export const TASK_KEY = 'task-key';

const words = tray.words;
const menuRow = (id: string) => tray.menu.find(row => row.id === id)!;
const labelOf = (id: string) => menuRow(id).label;
const iconOf = (id: string) => menuRow(id).icon;
const priorityLabels = taskData.priority_labels as Record<string, string>;
const MOST = taskData.bulk.most_tasks;

type Said = { kind: 'done' | 'info' | 'error'; actions?: { id: string; label: string; onAction: () => void }[]; timeout?: number; key?: string };

export type VerbContext = {
  collections: () => TaskCollection[];
  now: () => number;
  /** One call to the task road; answers what it answered. */
  post: (body: Record<string, unknown>) => Promise<{ undo?: { rows?: unknown[] } } & Record<string, unknown>>;
  /** Reads the tasks again after a change. */
  reload: () => Promise<void>;
  notify: (message: string, options?: Said) => void;
  /** Tasks being changed now (the screen draws them busy and refuses a second change to them). */
  changing: Set<string>;
  redraw: () => void;
  /** Opens one task for editing. */
  open: (task: Task) => void;
  /** Makes a copy of one task (the screen keeps that request's key so a retry does not make two). */
  duplicate: (task: Task) => Promise<void>;
  /** Told after a change has been kept, with the verb and the tasks it changed. */
  changed?: (verb: string, ids: string[]) => void;
};

export type VerbChoice = { id: string; label: string; checked?: boolean; shortcut?: string[]; run: () => Promise<void> };
export type Verb = {
  id: string; label: string; icon: string; shortcut?: string[]; tone?: 'destructive'; disabled?: boolean;
  /** Runs at once. */
  run?: () => Promise<void>;
  /** Or: a short list of choices. */
  choices?: VerbChoice[];
  /** Or: its own small form, drawn where the verb was asked for. */
  panel?: (close: () => void) => React.ReactNode;
};

/** The key a todo verb has now (the person's own key when they re-recorded it), in the glyph order a menu shows it. */
const shortcutOf = (action: string, value?: string) => {
  const row = currentRows().find(entry => entry.verb === TASK_KEY && (entry.with as { action?: string; value?: string } | undefined)?.action === action
    && (value === undefined || (entry.with as { value?: string }).value === value));
  const chord = row?.chord ? parseChord(row.chord, KEYMAP) : null;
  return chord ? [...chord.modifiers.map(name => (name === 'mod' ? 'meta' : name)), chord.key] : undefined;
};

/** Changes tasks one by one through the task road and says what happened, with one undo for the lot. */
async function change(ctx: VerbContext, verb: string, targets: Task[], input: (task: Task) => Record<string, unknown>, said: (changed: number) => string | null) {
  const open = targets.filter(task => !ctx.changing.has(task.id)).slice(0, MOST);
  if (!open.length) return;
  for (const task of open) ctx.changing.add(task.id);
  ctx.redraw();
  const rows: unknown[] = [];
  const kept: string[] = [];
  let refused = 0;
  let firstRefusal = '';
  for (const task of open) {
    try {
      const answer = await ctx.post(input(task));
      rows.push(...(answer.undo?.rows ?? []));
      kept.push(task.id);
    } catch (error) { refused += 1; firstRefusal ||= errorWords(error); }
  }
  for (const task of open) ctx.changing.delete(task.id);
  try { await ctx.reload(); } catch (error) { ctx.notify(errorWords(error), { kind: 'error' }); }
  ctx.redraw();
  if (kept.length) ctx.changed?.(verb, kept);
  const undo = rows.length ? [{ id: 'undo', label: words.undo, onAction: () => { void ctx.post({ action: 'restore', rows }).then(() => ctx.reload()).catch(error => ctx.notify(errorWords(error), { kind: 'error' })); } }] : undefined;
  if (refused) ctx.notify(kept.length ? fill(words.marked_partial, { changed: kept.length, refused }) : firstRefusal, { kind: 'error' });
  else {
    const message = said(kept.length);
    if (message) ctx.notify(message, { kind: 'done', ...(undo ? { actions: undo, timeout: 30_000 } : {}) });
  }
}

function SchedulePanel({ ctx, task, close }: { ctx: VerbContext; task: Task; close: () => void }) {
  const [at, setAt] = React.useState(task.starts_at ? localInput(task.starts_at) : localInput(instantOf(nowDay(ctx.now()), (new Date(ctx.now()).getHours() + 1) * 60)));
  const [valid, setValid] = React.useState(true);
  return <Container layout="vertical" gap="sm" padding="sm" data-task-verb-panel="schedule">
    <DateTimePicker aria-label={labelOf('schedule')} label={labelOf('schedule')} value={at} onChange={next => setAt(next ?? '')} onValidityChange={setValid} />
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="primary" disabled={!at || !valid} onClick={() => {
        const start = new Date(at).toISOString();
        close();
        void change(ctx, 'schedule', [task], row => ({ action: 'schedule', task_id: row.id, start, end: new Date(Date.parse(start) + row.duration_minutes * 60_000).toISOString() }),
          () => fill(words.scheduled, { when: new Date(start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }));
      }}>{labelOf('schedule')}</Button>
    </Container>
  </Container>;
}

function DeadlinePanel({ ctx, targets, close }: { ctx: VerbContext; targets: Task[]; close: () => void }) {
  const first = targets[0]?.due?.slice(0, 10) ?? '';
  const [day, setDay] = React.useState(targets.every(task => (task.due?.slice(0, 10) ?? '') === first) ? first : '');
  const set = (due: string | null) => { close(); void change(ctx, 'deadline', targets, row => ({ action: 'update', task_id: row.id, due }), () => (due ? words.deadline_set : words.deadline_cleared)); };
  return <Container layout="vertical" gap="sm" padding="sm" data-task-verb-panel="deadline">
    <DatePicker aria-label={labelOf('deadline')} placeholder={labelOf('deadline')} value={day} onChange={next => setDay(next ?? '')} />
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="primary" disabled={!day} onClick={() => set(day)}>{labelOf('deadline')}</Button>
      <Button size="sm" variant="ghost" onClick={() => set(null)}>{words.menu_deadline_none}</Button>
    </Container>
  </Container>;
}

function RepeatPanel({ ctx, task, close }: { ctx: VerbContext; task: Task; close: () => void }) {
  const [value, setValue] = React.useState<TaskRecurrenceValue | null>(task.recurrence ?? null);
  const set = (next: TaskRecurrenceValue | null) => {
    close();
    void change(ctx, 'repeat', [task], row => ({ action: 'update', task_id: row.id, recurrence: next }), () => (next ? words.repeat_set : words.repeat_cleared));
  };
  const copy = screenData.words;
  return <Container layout="vertical" gap="sm" padding="sm" data-task-verb-panel="repeat">
    <TaskRecurrence value={value} frequencies={copy.task_repeat_frequencies} nextTodoChoices={copy.task_repeat_next_choices}
      words={{ repeat: copy.task_repeat, every: copy.task_repeat_every, interval: copy.task_repeat_interval, on: copy.task_repeat_on, ends: copy.task_repeat_ends, never: copy.task_repeat_never,
        onDate: copy.task_repeat_on_date, after: copy.task_repeat_after, occurrences: copy.task_repeat_occurrences, createNextTodo: copy.task_create_next, weekdays: copy.task_repeat_weekdays }}
      onChange={next => setValue(next ? { ...next, timeZone: next.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : null)} />
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="primary" disabled={value !== null && value.ends.kind === 'date' && !value.ends.value} onClick={() => set(value)}>{labelOf('repeat')}</Button>
    </Container>
  </Container>;
}

/** Every verb that applies to these tasks, in the order of calendar-task-tray.json `menu`. */
export function taskVerbs(ctx: VerbContext, targets: Task[]): Verb[] {
  if (!targets.length) return [];
  const single = targets.length === 1 ? targets[0] : null;
  const allDone = targets.every(task => task.status === 'Done');
  const today = nowDay(ctx.now());
  const same = <T,>(read: (task: Task) => T, value: T) => targets.every(task => read(task) === value);
  const lists = [...tray.lists.filter(row => moveTarget(row.id)), ...ctx.collections().filter(row => !row.archived).map(row => ({ id: row.id, label: row.title }))];
  const verbs: Verb[] = [
    { id: 'complete', label: allDone ? words.menu_reopen : labelOf('complete'), icon: allDone ? 'RotateCcw' : iconOf('complete'), shortcut: shortcutOf('complete'),
      run: () => change(ctx, 'complete', targets, task => ({ action: allDone ? 'reopen' : 'complete', task_id: task.id }), count => (count === 1 ? (allDone ? screenData.words.task_reopened : screenData.words.task_done) : count ? fill(words.marked_done_result, { count }) : null)) },
    { id: 'move', label: labelOf('move'), icon: iconOf('move'), shortcut: shortcutOf('move'),
      choices: lists.map(row => ({
        id: row.id, label: row.label,
        checked: targets.every(task => inList(task, row.id, { today })) && (moveTarget(row.id) !== null),
        run: () => change(ctx, 'move', targets, task => ({ action: 'update', task_id: task.id, ...moveTarget(row.id) }), count => fill(words.marked_move_result, { count, list: row.label })),
      })) },
    { id: 'priority', label: labelOf('priority'), icon: iconOf('priority'),
      choices: tray.priorities.map(row => {
        const value = row.value;
        return {
          id: String(value), label: value === null ? words.menu_priority_none : priorityLabels[value] ?? value, shortcut: value === null ? undefined : shortcutOf('priority', value),
          checked: same(task => task.priority ?? null, value),
          run: () => change(ctx, 'priority', targets, task => ({ action: 'update', task_id: task.id, priority: value }), () => words.priority_set),
        };
      }) },
    { id: 'schedule', label: labelOf('schedule'), icon: iconOf('schedule'), shortcut: shortcutOf('schedule'), disabled: !single || single.status === 'Done',
      panel: single ? close => <SchedulePanel ctx={ctx} task={single} close={close} /> : undefined },
    ...(targets.some(task => task.starts_at) ? [{ id: 'unschedule', label: labelOf('unschedule'), icon: iconOf('unschedule'),
      run: () => change(ctx, 'unschedule', targets.filter(task => task.starts_at), task => ({ action: 'unschedule', task_id: task.id }), () => screenData.words.task_moved_inbox) }] : []),
    { id: 'duration', label: labelOf('duration'), icon: iconOf('duration'),
      choices: tray.durations.map(minutes => ({
        id: String(minutes), label: durationWords(minutes), checked: same(task => task.duration_minutes, minutes),
        run: () => change(ctx, 'duration', targets, task => ({ action: 'update', task_id: task.id, duration_minutes: minutes }), () => words.duration_set),
      })) },
    { id: 'repeat', label: labelOf('repeat'), icon: iconOf('repeat'), disabled: !single, panel: single ? close => <RepeatPanel ctx={ctx} task={single} close={close} /> : undefined },
    { id: 'deadline', label: labelOf('deadline'), icon: iconOf('deadline'), shortcut: shortcutOf('deadline'), panel: close => <DeadlinePanel ctx={ctx} targets={targets} close={close} /> },
    { id: 'snooze', label: labelOf('snooze'), icon: iconOf('snooze'),
      choices: [
        ...tray.snooze.choices.map(choice => ({
          id: choice.id, label: choice.label,
          run: () => { const day = snoozeDay(choice, today); return change(ctx, 'snooze', targets, task => ({ action: 'update', task_id: task.id, snoozed_until: day }), () => fill(words.snoozed, { when: new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) })); },
        })),
        ...(targets.some(task => task.snoozed_until && (localDay(task.snoozed_until) ?? '') > today)
          ? [{ id: 'now', label: words.menu_unsnooze, run: () => change(ctx, 'snooze', targets, task => ({ action: 'update', task_id: task.id, snoozed_until: null }), () => words.unsnoozed) }] : []),
      ] },
    { id: 'copy', label: labelOf('copy'), icon: iconOf('copy'), shortcut: shortcutOf('copy'),
      run: async () => { const copied = await copyTextToClipboard(targets.map(task => task.title).join('\n')); ctx.notify(copied ? words.title_copied : words.title_copy_failed, { kind: copied ? 'done' : 'error' }); } },
    { id: 'duplicate', label: labelOf('duplicate'), icon: iconOf('duplicate'), shortcut: shortcutOf('duplicate'), disabled: !single, run: single ? () => ctx.duplicate(single) : undefined },
    { id: 'delete', label: labelOf('delete'), icon: iconOf('delete'), tone: 'destructive', shortcut: shortcutOf('delete'),
      run: () => change(ctx, 'delete', targets, task => ({ action: 'delete', task_id: task.id }), count => (count === 1 ? words.deleted : fill(words.marked_delete_result, { count }))) },
  ];
  const order = tray.menu.map(row => row.id);
  return verbs.filter(verb => order.includes(verb.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** What a key row asks for among these verbs: the verb, and the choice inside it when the key names one. */
export function verbForKey(verbs: Verb[], row: { action: string; value?: string }): { verb: Verb; choice?: VerbChoice } | null {
  const id = row.action === 'open' || row.action === 'switch_list' ? null : row.action;
  const verb = verbs.find(entry => entry.id === id);
  if (!verb) return null;
  if (verb.id === 'priority' && row.value) {
    const choice = verb.choices?.find(entry => entry.id === row.value);
    // The key toggles: pressing it again on a task that already has the priority clears it.
    return { verb, choice: choice?.checked ? verb.choices?.find(entry => entry.id === 'null') : choice };
  }
  return { verb };
}

/** The verbs as the right-click menu's rows (submenus for choices, an editor for a form). */
export function verbsAsNodeActions(verbsOf: (id: string) => Verb[], accepts: (id: string) => boolean): NodeActionCapability[] {
  return tray.menu.map((row, index): NodeActionCapability => {
    const find = (nodeId: string) => verbsOf(nodeId).find(verb => verb.id === row.id);
    const meta = (nodeId: string) => find(nodeId);
    return {
      id: `calendar.task.${row.id}`, label: row.label, icon: row.icon, priority: 100 + index,
      accepts: node => accepts(node.parts?.id ?? '') && Boolean(find(node.parts?.id ?? '')) && !find(node.parts?.id ?? '')!.disabled,
      ...(row.id === 'delete' ? { tone: 'destructive' as const } : {}),
      run(node) { const verb = meta(node.parts!.id!); return verb?.run?.(); },
      ...(row.kind === 'choices' ? {
        run: undefined,
        submenu: node => (meta(node.parts!.id!)?.choices ?? []).map(choice => ({
          id: `calendar.task.${row.id}.${choice.id}`, label: choice.label, icon: choice.checked ? 'Check' : 'Circle',
          accepts: () => true, run: () => choice.run(),
        })),
      } : {}),
      ...(row.kind === 'panel' ? {
        run: undefined,
        editor: (node, close) => meta(node.parts!.id!)?.panel?.(close) ?? null,
      } : {}),
    };
  });
}

/** Draws the choices or the form of one verb that was asked for by key or from a menu, where the tray shows it. */
export function VerbPanel({ verb, label, onClose }: { verb: Verb; label: string; onClose: () => void }) {
  return <Container layout="vertical" gap="xs" padding="sm" className="calendar-task-verb-panel" data-task-verb={verb.id}>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
      <Text variant="body-sm" truncate>{label}</Text>
      <Button size="xs" variant="ghost" onClick={onClose}>{screenData.words.close}</Button>
    </Container>
    {verb.choices ? <Container layout="vertical" gap="xs" role="menu" aria-label={verb.label}>
      {verb.choices.map(choice => <Button key={choice.id} size="sm" variant={choice.checked ? 'outline' : 'ghost'} role="menuitem" aria-checked={choice.checked}
        onClick={() => { onClose(); void choice.run(); }}>{choice.label}</Button>)}
    </Container> : verb.panel?.(onClose)}
  </Container>;
}

/** Every verb as a short list in a popover (the card's "..." menu): a verb with choices or a form opens it just below. */
export function VerbList({ verbs, onClose }: { verbs: Verb[]; onClose: () => void }) {
  const [asked, setAsked] = React.useState<string | null>(null);
  const open = verbs.find(verb => verb.id === asked) ?? null;
  return <Container layout="vertical" gap="xs" padding="xs" className="calendar-task-verb-list" role="menu" aria-label={words.menu_more}>
    {verbs.filter(verb => !verb.disabled).map(verb => <React.Fragment key={verb.id}>
      <Button size="sm" variant={verb.tone === 'destructive' ? 'danger' : 'ghost'} role="menuitem" aria-expanded={verb.choices || verb.panel ? asked === verb.id : undefined}
        className="calendar-task-verb-row" data-task-verb={verb.id}
        onClick={() => { if (verb.run) { onClose(); void verb.run(); } else setAsked(asked === verb.id ? null : verb.id); }}>
        <NamedIcon name={verb.icon} size="xs" aria-hidden />{verb.label}
      </Button>
      {open?.id === verb.id ? <VerbPanel verb={verb} label={verb.label} onClose={onClose} /> : null}
    </React.Fragment>)}
  </Container>;
}
