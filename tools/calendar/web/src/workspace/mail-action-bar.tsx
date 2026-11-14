// src/workspace/mail-action-bar.tsx
//
// PURPOSE
//   The mail verbs drawn around an open message, from DATA: the card's own row (Reply, Forward and a "..." menu), and the
//   bar under it (the people in the conversation, the paperclip with its count, Done, Priority, Schedule, Deadline and a
//   "..." menu with every planning verb). Which verbs, in what order, with which icon is mail-actions.json; each verb's
//   title is the command table (mail-commands.json) and its key hint is the keymap's row for it (mail-keys.ts), so the
//   hint beside a verb is the key that runs it, whatever the person has set it to.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every control is a shared part (Button, ActionMenu, AnchoredOverlay, Kbd, DateTimePicker, DatePicker, TaskRecurrence);
//      this file writes no markup of its own and no appearance.
//   2. It decides nothing: a verb the person picks goes to `onRun` / `onPlan`, and the screen (email-screen.tsx) does it.
//   3. A panel (priority, time, deadline, the paperclip) is controlled by the screen, so a key press and a click open the same one; Escape or a press outside closes it.
//   4. Never a machine word: the person sees names, counts and the table's titles.

import * as React from 'react';
import { ActionMenu, AnchoredOverlay, AvatarGroup, Button, Container, Kbd, NamedIcon, Text, type ActionMenuItem } from '../../parts/ui';
import { PersonTag } from '../../parts/ui/show/person-tag';
import { DatePicker } from '../../parts/ui/show/date-picker/DatePicker';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { TaskRecurrence, type TaskRecurrenceValue } from '../../parts/ui/show/task-recurrence/TaskRecurrence';
import { rowById, type CommandTable } from '../../parts/ui/show/command-table/command-table';
import type { MailKey } from './mail-keys';
import type { MailAttachment, MailParticipant } from './mail-message';
import type { MailTask } from './mail-task';
import layout from './mail-actions.json';
import calendarScreen from './shared-calendar.json';

const words = layout.words;
const repeatWords = calendarScreen.words;
export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));

export type MailPanel = 'priority' | 'schedule' | 'deadline' | 'attachments' | null;
export type MailPlan =
  | { verb: 'priority'; value: string | null }
  | { verb: 'schedule'; value: string | null }
  | { verb: 'deadline'; value: string | null }
  | { verb: 'duration'; value: number }
  | { verb: 'repeat'; value: TaskRecurrenceValue | null }
  | { verb: 'move'; value: string | null };

export type MailBarProps = {
  table: CommandTable;
  /** Each verb's key as the person has it now (the keymap's row for it). */
  keyOf: (command: string) => MailKey;
  busy: boolean;
  task: MailTask | null;
  taskLists: readonly { id: string; title: string }[];
  /** Whether the message is read: Mark as unread is offered while it is, Mark as read while it is not. */
  messageRead: boolean;
  participants: readonly MailParticipant[];
  links: readonly string[];
  attachments: readonly MailAttachment[];
  /** The mail provider's name, for the words that send the person to its own page. */
  provider: string;
  panel: MailPanel;
  onPanel: (panel: MailPanel) => void;
  onRun: (id: string) => void;
  onPlan: (plan: MailPlan) => void;
};

/** A verb's icon colour: a named tone of the shared icon, from DATA (`icon_tones`), or the icon's own. */
const iconTone = (id: string) => (layout.icon_tones as Record<string, 'success' | 'accent' | 'error' | 'info' | 'muted'>)[id];
const titleOf = (table: CommandTable, id: string) => rowById(table, id)?.title ?? id;

/** A verb's menu row: its title and icon from the two DATA files and its key hint from the keymap. */
function menuRow(props: MailBarProps, id: string, extra: Partial<ActionMenuItem> = {}): ActionMenuItem {
  const menu = props.keyOf(id).menu;
  return {
    id, label: titleOf(props.table, id), icon: (layout.icons as Record<string, string>)[id] ?? 'Circle',
    ...(menu ? { shortcut: { key: menu.key, ...(menu.modifiers.length ? { modifiers: menu.modifiers } : {}) } } : {}),
    ...(id === 'delete' ? { tone: 'destructive' } : {}),
    ...extra,
  };
}

/** The panel rows shared by the bar's buttons and the "..." menu. */
function PlanPanel({ kind, task, onPlan, onClose }: { kind: 'schedule' | 'deadline' | 'repeat'; task: MailTask | null; onPlan: (plan: MailPlan) => void; onClose: () => void }) {
  const [at, setAt] = React.useState<string | null>(task?.starts_at ? localInput(task.starts_at) : null);
  const [valid, setValid] = React.useState(true);
  const [day, setDay] = React.useState<string | null>(task?.due ?? null);
  const [repeat, setRepeat] = React.useState<TaskRecurrenceValue | null>((task?.recurrence as TaskRecurrenceValue | null | undefined) ?? null);
  if (kind === 'schedule') {
    return <Container layout="vertical" gap="sm" padding="sm" data-mail-plan="schedule">
      <Text variant="label">{words.schedule_when}</Text>
      <DateTimePicker aria-label={words.schedule_when} value={at} onChange={setAt} onValidityChange={setValid} />
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button size="sm" variant="primary" disabled={!at || !valid} onClick={() => { if (at) { onPlan({ verb: 'schedule', value: new Date(at).toISOString() }); onClose(); } }}>{words.schedule_save}</Button>
        {task?.starts_at ? <Button size="sm" variant="ghost" onClick={() => { onPlan({ verb: 'schedule', value: null }); onClose(); }}>{words.schedule_clear}</Button> : null}
      </Container>
    </Container>;
  }
  if (kind === 'deadline') {
    return <Container layout="vertical" gap="sm" padding="sm" data-mail-plan="deadline">
      <Text variant="label">{words.deadline_when}</Text>
      <DatePicker label={words.deadline_when} value={day} onChange={setDay} allowClear />
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button size="sm" variant="primary" disabled={!day} onClick={() => { if (day) { onPlan({ verb: 'deadline', value: day }); onClose(); } }}>{words.deadline_save}</Button>
        {task?.due ? <Button size="sm" variant="ghost" onClick={() => { onPlan({ verb: 'deadline', value: null }); onClose(); }}>{words.deadline_clear}</Button> : null}
      </Container>
    </Container>;
  }
  const valueOk = !repeat || repeat.ends.kind !== 'date' || Boolean(repeat.ends.value);
  return <Container layout="vertical" gap="sm" padding="sm" data-mail-plan="repeat">
    <TaskRecurrence value={repeat} frequencies={repeatWords.task_repeat_frequencies} nextTodoChoices={repeatWords.task_repeat_next_choices}
      words={{ repeat: repeatWords.task_repeat, every: repeatWords.task_repeat_every, interval: repeatWords.task_repeat_interval, on: repeatWords.task_repeat_on,
        ends: repeatWords.task_repeat_ends, never: repeatWords.task_repeat_never, onDate: repeatWords.task_repeat_on_date, after: repeatWords.task_repeat_after,
        occurrences: repeatWords.task_repeat_occurrences, createNextTodo: repeatWords.task_create_next, weekdays: repeatWords.task_repeat_weekdays }}
      onChange={value => setRepeat(value ? { ...value, timeZone: value.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone } : null)} />
    <Button size="sm" variant="primary" disabled={!valueOk} onClick={() => { onPlan({ verb: 'repeat', value: repeat }); onClose(); }}>{words.repeat_save}</Button>
  </Container>;
}

/** An ISO instant as the local `YYYY-MM-DDTHH:mm` the date-time picker holds. */
function localInput(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function planningRows(props: MailBarProps, id: string): ActionMenuItem {
  const { table, task, onPlan } = props;
  if (id === 'priority') {
    return menuRow(props, id, { hint: words.priority_choices.find(choice => choice.value === task?.priority)?.label, items: [
      ...words.priority_choices.map(choice => ({ id: `priority:${choice.value}`, label: choice.label, icon: 'Gem', checked: task?.priority === choice.value, props: { 'data-choice': choice.value } })),
      { id: 'priority:none', label: words.no_priority, icon: 'CircleOff', checked: !task?.priority },
    ] });
  }
  if (id === 'duration') {
    return menuRow(props, id, { hint: task ? fill(words.minutes, { minutes: task.duration_minutes }) : undefined, items: layout.durations.map(minutes => ({ id: `duration:${minutes}`, label: fill(words.minutes, { minutes }), icon: 'Clock', checked: task?.duration_minutes === minutes })) });
  }
  if (id === 'move') {
    return menuRow(props, id, { items: [
      { id: 'move:none', label: words.no_task_list, icon: 'ListX', checked: !task?.collection_id },
      ...props.taskLists.map(list => ({ id: `move:${list.id}`, label: list.title, icon: 'ListTodo', checked: task?.collection_id === list.id })),
    ] });
  }
  if (id === 'schedule' || id === 'deadline' || id === 'repeat') {
    return menuRow(props, id, { panel: close => <PlanPanel kind={id} task={task} onPlan={onPlan} onClose={close} /> });
  }
  return menuRow(props, id);
}

function rowsFor(props: MailBarProps, ids: readonly (string | null)[]): ActionMenuItem[] {
  let group = 0;
  const rows: ActionMenuItem[] = [];
  for (const id of ids) {
    if (id === null) { group += 1; continue; }
    if ((id === 'unread' && !props.messageRead) || (id === 'read' && props.messageRead)) continue;
    rows.push({ ...planningRows(props, id), group: String(group) });
  }
  return rows;
}

/** One menu's pick, split into a verb that is a plan (a choice inside a submenu) or a verb the screen runs. */
function choose(props: MailBarProps, id: string) {
  const [verb, value] = id.split(/:(.*)/s);
  if (verb === 'priority' && value !== undefined) props.onPlan({ verb: 'priority', value: value === 'none' ? null : value });
  else if (verb === 'duration' && value !== undefined) props.onPlan({ verb: 'duration', value: Number(value) });
  else if (verb === 'move' && value !== undefined) props.onPlan({ verb: 'move', value: value === 'none' ? null : value });
  else props.onRun(id);
}

/** The card's row: Reply and Forward with their keys, and a "..." menu. */
export function MailCardActions(props: MailBarProps) {
  return <Container layout="horizontal" gap="xs" alignItems="center" wrap data-mail-card-actions="">
    <ActionMenu label={words.card_more} items={rowsFor(props, layout.card_more)} onAction={id => choose(props, id)} />
    {layout.card.map(id => <Button key={id} size="sm" variant="secondary" disabled={props.busy} data-mail-verb={id} onClick={() => props.onRun(id)}>
      <NamedIcon name={(layout.icons as Record<string, string>)[id]} size="xs" color={iconTone(id)} />{titleOf(props.table, id)}<Kbd>{props.keyOf(id).shown.join('')}</Kbd>
    </Button>)}
  </Container>;
}

/** The bar: the people, the paperclip, the verbs that plan the email and the "..." menu with all of them. */
export function MailActionBar(props: MailBarProps) {
  const anchors = { priority: React.useRef<HTMLButtonElement | null>(null), schedule: React.useRef<HTMLButtonElement | null>(null), deadline: React.useRef<HTMLButtonElement | null>(null), attachments: React.useRef<HTMLButtonElement | null>(null) };
  const { table, panel, onPanel, task } = props;
  const count = props.links.length + props.attachments.length;
  const close = () => onPanel(null);
  React.useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, onPanel]);
  const open = (id: Exclude<MailPanel, null>) => onPanel(panel === id ? null : id);
  return <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" wrap border="all" rounded="lg" role="toolbar" aria-label={words.bar_label} data-collapse-labels="" data-mail-bar="">
    {props.participants.length ? <Container layout="horizontal" gap="xs" alignItems="center" role="group" aria-label={words.participants} data-collapsible-extra="" data-mail-participants="">
      <AvatarGroup size="sm" items={props.participants.slice(0, 6).map(person => ({ key: person.address, node: <PersonTag name={person.name} size="sm" /> }))} />
    </Container> : null}
    <Container flex={1} />
    <Button ref={anchors.attachments} size="sm" variant="ghost" disabled={!count} aria-label={fill(words.attachments_button, { count })} aria-expanded={panel === 'attachments'} data-mail-verb="attachments" onClick={() => open('attachments')}>
      <NamedIcon name={(layout.icons as Record<string, string>).attachments} size="xs" />{count}
    </Button>
    {layout.bar.map(id => {
      const mark = <>
        <NamedIcon name={(layout.icons as Record<string, string>)[id]} size="xs" color={iconTone(id)} /><Text variant="body-sm" data-collapsible-label="">{titleOf(table, id)}</Text><Kbd>{props.keyOf(id).shown.join('')}</Kbd>
      </>;
      if (id === 'done') return <Button key={id} size="sm" variant="outline" disabled={props.busy} aria-label={titleOf(table, id)} data-mail-verb={id} onClick={() => props.onRun(id)}>{mark}</Button>;
      const anchor = anchors[id as 'priority' | 'schedule' | 'deadline'];
      return <Button key={id} ref={anchor} size="sm" variant="outline" disabled={props.busy} aria-label={titleOf(table, id)} aria-expanded={panel === id} data-mail-verb={id} onClick={() => open(id as 'priority' | 'schedule' | 'deadline')}>{mark}</Button>;
    })}
    <ActionMenu label={words.more} items={rowsFor(props, layout.bar_more)} onAction={id => choose(props, id)} bindShortcuts={false} />
    <AnchoredOverlay open={panel === 'priority'} anchorRef={anchors.priority} placement="above" gap={6} onDismiss={close}>
      <Container layout="vertical" gap="xs" padding="sm" role="menu" data-mail-plan="priority">
        {[...words.priority_choices, { value: '', label: words.no_priority }].map(choice => <Button key={choice.value || 'none'} size="sm" variant={(task?.priority ?? '') === choice.value ? 'secondary' : 'ghost'} role="menuitemradio" aria-checked={(task?.priority ?? '') === choice.value} onClick={() => { props.onPlan({ verb: 'priority', value: choice.value || null }); close(); }}>{choice.label}</Button>)}
      </Container>
    </AnchoredOverlay>
    <AnchoredOverlay open={panel === 'schedule'} anchorRef={anchors.schedule} placement="above" gap={6} onDismiss={close}><PlanPanel kind="schedule" task={task} onPlan={props.onPlan} onClose={close} /></AnchoredOverlay>
    <AnchoredOverlay open={panel === 'deadline'} anchorRef={anchors.deadline} placement="above" gap={6} onDismiss={close}><PlanPanel kind="deadline" task={task} onPlan={props.onPlan} onClose={close} /></AnchoredOverlay>
    <AnchoredOverlay open={panel === 'attachments'} anchorRef={anchors.attachments} placement="above" gap={6} onDismiss={close}>
      <Container layout="vertical" gap="sm" padding="sm" data-mail-attachments="">
        {!count ? <Text variant="body-sm">{words.popover_none}</Text> : null}
        {props.links.length ? <Container layout="vertical" gap="xs"><Text variant="label">{words.popover_links}</Text>
          {props.links.map(url => <Button key={url} size="sm" variant="ghost" title={url} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}><NamedIcon name="Link" size="xs" /><Text variant="body-sm" truncate>{linkLabel(url)}</Text></Button>)}
        </Container> : null}
        {props.attachments.length ? <Container layout="vertical" gap="xs"><Text variant="label">{words.popover_attachments}</Text>
          {props.attachments.map((file, index) => <Container key={`${file.name}-${index}`} layout="horizontal" gap="sm" alignItems="center"><NamedIcon name="Paperclip" size="xs" /><Text variant="body-sm" truncate>{file.name}</Text>{file.size !== null ? <Text variant="caption" color="muted" wrap="nowrap">{fill(words.attachment_size, { kb: Math.max(1, Math.round(file.size / 1024)) })}</Text> : null}</Container>)}
          <Text variant="caption" color="muted">{fill(words.popover_open_in_provider, { provider: props.provider })}</Text>
        </Container> : null}
      </Container>
    </AnchoredOverlay>
  </Container>;
}

/** A link as a person reads it: the site and the start of its path. */
function linkLabel(url: string): string {
  try { const parsed = new URL(url); return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 80); } catch { return url.slice(0, 80); }
}
