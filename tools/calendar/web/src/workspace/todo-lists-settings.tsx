// src/workspace/todo-lists-settings.tsx
//
// PURPOSE
//   The Todos page of the Calendar's settings: the default lists, then the person's own lists with a filter, a new-list
//   form, drag to reorder, and a menu per list (rename, colour, default calendar, AI scheduling, preferred times, archive,
//   delete). Every change is one action on /work/api/calendar/tasks (src/calendar-tasks.mjs); the page shows what that
//   road holds, not what was typed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word is DATA (todo-lists-settings.json); every control is a shared ui part. No id or key is ever shown.
//   2. A failed change says so and changes nothing on screen; the lists are read again after every change.
//   3. A change whose old value is known offers an undo that puts it back; delete asks first, in place.
//   4. Lists load a bounded page at a time; the rest comes with Load more.
import React from 'react';
import { ActionMenu, Badge, Button, ColorDot, Container, DragReorderList, errorWords, Input, Text } from '../../parts/ui';
import { NamedIcon } from '../../parts/ui/show/icon';
import type { CalendarAccount } from './calendar-controls';
import taskData from '../calendar-tasks.json' with { type: 'json' };
import tray from './calendar-task-tray.json' with { type: 'json' };
import words from './todo-lists-settings.json' with { type: 'json' };
import { postJson, readJson } from './api';
import {
  aiChoiceOf, aiValueOf, calendarGroups, clockOf, createListRequest, deleteListRequest, filterLists, preferredTimes, reorderRequest, splitArchived, updateListRequest,
} from './todo-lists-settings.mjs';

export type TodoList = {
  id: string; title: string; color: string | null; archived: boolean;
  default_calendar: { source_id: string; calendar_id: string } | null;
  ai_scheduling: boolean | null;
  preferred_times: { start_minute: number; end_minute: number; weekdays?: number[] } | null;
};
type Page = { complete: boolean; next_cursor: string | null };
type Notify = (message: string, options?: { kind?: 'info' | 'error'; actions?: { id: string; label: string; onAction: () => void }[] }) => void;

const ROAD = '/work/api/calendar/tasks';
const colors = (taskData as unknown as { list_colors: { id: string; label: string; color: string }[] }).list_colors;
const colorOf = (id: string | null) => colors.find(row => row.id === id)?.color;
const fillTitle = (text: string, title: string) => text.replace('{title}', title);

function RenamePanel({ list, close, onRename }: { list: TodoList; close: () => void; onRename: (title: string) => void }) {
  const [title, setTitle] = React.useState(list.title);
  const submit = () => { if (title.trim() && title.trim() !== list.title) onRename(title.trim()); close(); };
  return <Container layout="vertical" gap="xs" padding="sm">
    <Input label={words.rename_label} value={title} onChange={event => setTitle(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
    <Button size="sm" variant="outline" disabled={!title.trim()} onClick={submit}>{words.rename_save}</Button>
  </Container>;
}

function ColorPanel({ value, close, onPick }: { value: string | null; close: () => void; onPick: (id: string | null) => void }) {
  return <Container layout="horizontal" gap="xs" padding="sm" wrap>
    {colors.map(row => <Button key={row.id} size="icon-sm" variant={row.id === value ? 'outline' : 'ghost'} aria-label={row.label} aria-pressed={row.id === value}
      onClick={() => { onPick(row.id); close(); }}><ColorDot color={row.color} size="md" /></Button>)}
    <Button size="sm" variant="ghost" disabled={value === null} onClick={() => { onPick(null); close(); }}>{words.no_color}</Button>
  </Container>;
}

function TimesPanel({ value, close, onSave }: { value: TodoList['preferred_times']; close: () => void; onSave: (times: TodoList['preferred_times']) => void }) {
  const [start, setStart] = React.useState(clockOf(value?.start_minute ?? 9 * 60));
  const [end, setEnd] = React.useState(clockOf(value?.end_minute ?? 17 * 60));
  const [days, setDays] = React.useState<number[]>(value?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const times = preferredTimes(start, end, days);
  return <Container layout="vertical" gap="xs" padding="sm">
    <Container layout="horizontal" gap="sm" wrap>
      <Input label={words.preferred_start} type="time" value={start} onChange={event => setStart(event.target.value)} />
      <Input label={words.preferred_end} type="time" value={end} onChange={event => setEnd(event.target.value)} />
    </Container>
    <Text variant="caption" color="muted">{words.preferred_days}</Text>
    <Container layout="horizontal" gap="xs" wrap>
      {words.weekdays.map((label, weekday) => <Button key={label} size="xs" variant={days.includes(weekday) ? 'primary' : 'outline'} aria-pressed={days.includes(weekday)}
        onClick={() => setDays(days.includes(weekday) ? days.filter(day => day !== weekday) : [...days, weekday])}>{label}</Button>)}
    </Container>
    <Container layout="horizontal" gap="xs" wrap>
      <Button size="sm" variant="outline" disabled={!times} onClick={() => { onSave(times); close(); }}>{words.preferred_save}</Button>
      <Button size="sm" variant="ghost" disabled={!value} onClick={() => { onSave(null); close(); }}>{words.preferred_clear}</Button>
    </Container>
  </Container>;
}

export function TodoListsSettings({ accounts, notify, onChanged }: { accounts: CalendarAccount[]; notify: Notify; onChanged?: () => void }): React.ReactElement {
  const [lists, setLists] = React.useState<TodoList[] | null>(null);
  const [page, setPage] = React.useState<Page>({ complete: true, next_cursor: null });
  const [problem, setProblem] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // One key per create attempt: made when first needed (never at module load), kept while the same words are retried.
  const attempt = React.useRef<{ value: string; key: string } | null>(null);
  const groups = React.useMemo(() => calendarGroups(accounts), [accounts]);

  const load = React.useCallback(async () => {
    try {
      const read = await readJson<{ collections: TodoList[]; collections_page: Page }>(`${ROAD}?check=${crypto.randomUUID()}`);
      setLists(read.collections); setPage(read.collections_page); setProblem(false);
    } catch { setProblem(true); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !page.next_cursor) return;
    setLoadingMore(true);
    try {
      const read = await readJson<{ collections: TodoList[]; collections_page: Page }>(`${ROAD}?collection_cursor=${encodeURIComponent(page.next_cursor)}`);
      setLists(current => [...new Map([...(current ?? []), ...read.collections].map(row => [row.id, row])).values()]); setPage(read.collections_page);
    } catch (error) { notify(errorWords(error) || words.load_failed, { kind: 'error' }); }
    finally { setLoadingMore(false); }
  };

  // One change: sent, said, offered back when its old values are known, and the lists read again.
  const change = async (body: Record<string, unknown>, said: string, undo?: Record<string, unknown>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const answer = await postJson<{ undo?: Record<string, unknown> }>(ROAD, body);
      const back = undo ?? answer.undo;
      notify(said, { kind: 'info', actions: back ? [{ id: 'undo', label: words.undo, onAction: () => { void postJson(ROAD, back).then(() => load()).then(() => onChanged?.()).catch(error => notify(errorWords(error) || words.failed, { kind: 'error' })); } }] : [] });
      await load(); onChanged?.();
      return true;
    } catch (error) { notify(errorWords(error) || words.failed, { kind: 'error' }); return false; }
    finally { setBusy(false); }
  };
  const update = (list: TodoList, patch: Record<string, unknown>, said: string) =>
    change(updateListRequest(list.id, patch), said, updateListRequest(list.id, Object.fromEntries(Object.keys(patch).map(key => [key, (list as unknown as Record<string, unknown>)[key] ?? null]))));

  const create = async () => {
    const title = name.trim();
    if (!title) return;
    if (attempt.current?.value !== title) attempt.current = { value: title, key: crypto.randomUUID() };
    if (await change(createListRequest({ title, color, key: attempt.current.key }), words.created)) { setName(''); setColor(null); attempt.current = null; }
  };

  const { active, archived } = splitArchived(lists ?? []);
  const shown = filterLists(active, query);
  const shownArchived = filterLists(archived, query);

  const reorder = async (ids: string[]) => {
    const order = active.map(list => list.id);
    const request = reorderRequest(order, ids);
    if (request) await change(request, words.reordered, reorderRequest(ids, order) ?? undefined);
  };

  const menuFor = (list: TodoList) => {
    const calendarItems = groups.flatMap(group => group.calendars.map(calendar => ({
      id: `calendar:${calendar.default_calendar.source_id}:${calendar.id}`, label: calendar.label, icon: 'Calendar', group: group.label, groupLabel: group.label,
      checked: list.default_calendar?.source_id === calendar.default_calendar.source_id && list.default_calendar?.calendar_id === calendar.id,
    })));
    return [
      { id: 'rename', label: words.rename, icon: 'Pencil', panel: (close: () => void) => <RenamePanel list={list} close={close} onRename={title => void update(list, { title }, words.renamed)} /> },
      { id: 'color', label: words.color, icon: 'Palette', panel: (close: () => void) => <ColorPanel value={list.color} close={close} onPick={id => void update(list, { color: id }, words.colored)} /> },
      { id: 'calendar', label: words.default_calendar, icon: 'CalendarDays', items: [
        { id: 'calendar:none', label: words.default_calendar_none, icon: 'CalendarX', checked: !list.default_calendar },
        ...calendarItems,
      ] },
      { id: 'ai', label: words.ai_scheduling, icon: 'Sparkles', items: [
        { id: 'ai:inherit', label: words.ai_inherit, icon: 'Settings2', checked: aiChoiceOf(list) === 'inherit' },
        { id: 'ai:on', label: words.ai_on, icon: 'Sparkles', checked: aiChoiceOf(list) === 'on' },
        { id: 'ai:off', label: words.ai_off, icon: 'Ban', checked: aiChoiceOf(list) === 'off' },
      ] },
      { id: 'times', label: words.preferred_times, icon: 'Clock3', panel: (close: () => void) => <TimesPanel value={list.preferred_times} close={close} onSave={times => void update(list, { preferred_times: times }, words.times_set)} /> },
      { id: 'archive', label: list.archived ? words.unarchive : words.archive, icon: list.archived ? 'ArchiveRestore' : 'Archive', group: 'end' },
      { id: 'delete', label: words.delete, icon: 'Trash2', tone: 'destructive', confirm: words.delete_confirm, group: 'end' },
    ];
  };
  const act = (list: TodoList) => (id: string) => {
    if (id === 'archive') void update(list, { archived: !list.archived }, list.archived ? words.unarchived : words.archived);
    else if (id === 'delete') void change(deleteListRequest(list.id), words.deleted);
    else if (id === 'calendar:none') void update(list, { default_calendar: null }, words.calendar_set);
    else if (id.startsWith('calendar:')) {
      const [, source, ...calendar] = id.split(':');
      void update(list, { default_calendar: { source_id: source, calendar_id: calendar.join(':') } }, words.calendar_set);
    } else if (id.startsWith('ai:')) void update(list, { ai_scheduling: aiValueOf(id.slice(3)) }, words.ai_set);
  };

  const row = (list: TodoList) => <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" data-todo-list-row>
    <Container layout="horizontal" gap="sm" alignItems="center">
      {colorOf(list.color) ? <ColorDot color={colorOf(list.color)!} size="md" /> : <NamedIcon name="ListTodo" size="xs" aria-hidden />}
      <Text variant="body-sm" truncate>{list.title}</Text>
      {list.ai_scheduling === false ? <Badge size="sm" variant="muted-outline">{words.ai_off}</Badge> : null}
    </Container>
    <ActionMenu label={`${words.options}: ${list.title}`} items={menuFor(list)} onAction={act(list)} align="end" />
  </Container>;

  if (problem && !lists) return <Text variant="body-sm" color="error">{words.load_failed}</Text>;
  if (!lists) return <Text variant="caption" color="muted">{words.loading}</Text>;
  return <Container layout="vertical" gap="sm" data-todo-lists-settings>
    <Text variant="body-sm" weight="semibold">{words.heading}</Text>
    <Input aria-label={words.filter} placeholder={words.filter} value={query} onChange={event => setQuery(event.target.value)} />
    <Text variant="caption" color="muted">{words.default_lists}</Text>
    {filterLists(tray.lists, query).map(list => <Container key={list.id} layout="horizontal" gap="sm" alignItems="center" data-todo-default-list>
      <NamedIcon name={list.icon} size="xs" aria-hidden /><Text variant="body-sm">{list.label}</Text>
    </Container>)}
    <Text variant="caption" color="muted">{words.your_lists}</Text>
    {shown.length ? <DragReorderList surface="grouped" items={shown.map(list => ({ id: list.id, label: fillTitle(words.reorder, list.title), content: row(list) }))}
      onReorder={query.trim() || busy ? () => undefined : ids => void reorder(ids)} />
      : <Text variant="caption" color="muted">{query.trim() ? words.none_match : words.none_yet}</Text>}
    {page.complete ? null : <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => loadMore()}>{words.load_more}</Button>}
    {archived.length ? <>
      <Button size="sm" variant="ghost" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>{archivedOpen ? words.hide_archived : `${words.show_archived} (${archived.length})`}</Button>
      {archivedOpen ? <Container layout="vertical" gap="xs" data-todo-archived-lists>
        <Text variant="caption" color="muted">{words.archived_heading}</Text>
        {shownArchived.map(list => <React.Fragment key={list.id}>{row(list)}</React.Fragment>)}
      </Container> : null}
    </> : null}
    <Text variant="body-sm" weight="semibold">{words.new_list}</Text>
    <Input label={words.new_list_name} value={name} disabled={busy} onChange={event => setName(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} />
    <Container layout="horizontal" gap="xs" wrap>
      {colors.map(row => <Button key={row.id} size="icon-sm" variant={row.id === color ? 'outline' : 'ghost'} aria-label={row.label} aria-pressed={row.id === color}
        onClick={() => setColor(row.id === color ? null : row.id)}><ColorDot color={row.color} size="md" /></Button>)}
    </Container>
    <Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={() => create()}>{words.create}</Button>
  </Container>;
}
