// src/workspace/calendar-screen.tsx
//
// PURPOSE
//   The posting calendar: this person's posts on a month board or on hour lanes (the shared ScheduleCalendar, its
//   header choosing month, week or day), in the shared record views' bar with its search, status filter and a plain
//   list. It is drawn by this screen rather than the Calendar every list is offered (record-views designs), because it
//   reads only the span on screen, each post says whether it can still move, and a moved post that was approved asks to
//   be approved again: its view keeps that view's id, so the bar offers one Calendar. Each post sits at the time it goes out
//   (or, sent without one, when it was sent); drafts with no time wait in the tray beside it. Dragging a post that can
//   still change to a day or an hour gives it that time; dragging it to the tray takes its time away. A post that was
//   approved or set to go out becomes a draft again when it moves, and the screen says so and offers Approve again.
//   Opening a post shows it beside the calendar with a time field, so a keyboard can move it too. Write a post opens
//   the shared new-post panel (new-post.tsx) beside it; with no post yet the screen says so and offers Write a post
//   and Ask my AI, and while no place to post is connected it says drafts are kept and offers Connect a place.
//   Reads and changes go through /work/api/posts, the same /posts routes a person's AI uses (list_post_calendar,
//   draft_post, approve_post, publish_post), and the job is the Workshop tool tool:read-post-calendar.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every element is a shared component; this file writes no markup.
//   2. Words, views, status names and tones are DATA (calendar.json); nothing here names a status.
//   3. Only the span on screen is read (visibleRange of the shown view), again when the person moves, and again when
//      their store changes.
//   4. Approve again restores what the person had: an approved post is approved; a post that was set to go out is
//      approved and set again, only while its time is still ahead.

import React from 'react';
import { mountRecordViews, type FieldDescriptor, type RecordView } from '../../parts/ui/show/record-views/record-views';
import { loadScreen } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { Badge, Button, Container, ScheduleCalendar, Text, dayKey, visibleRange, type ScheduleItem, type ScheduleView } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import calendar from './calendar.json';
import { postJson, readJson } from './api';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import { onStoreChange } from './store-changes';
import { applyPending, optimistic } from './pending-changes';
import { ConnectNotice, NewPost, readPostPlaces, type PostPlaces } from './new-post';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
type Destination = { account_id: string; label?: string; platform?: string; status?: string };
type Post = {
  post_id: string; status: string; caption: string; media: { name?: string } | null; scheduled_for: string | null;
  at: string | null; can_move: boolean; destinations: Destination[];
};
// The calendar read that pending moves are laid over (pending-changes.ts).
const CALENDAR_READ = 'posts-calendar';
type Calendar = { from: string; to: string; posts: Post[]; unscheduled: Post[] };
type Row = { id: string; title: string; at: string | null; when: string; status: string; places: string; can_move: boolean };

const words = calendar.words;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const statusRows = calendar.status as Record<string, { label: string; tone: string }>;
const VIEWS = calendar.views as { id: string; label: string; icon: string; view: ScheduleView }[];
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const whenWords = (at: string) => new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// A post is named by its first line of words, else its video or picture's name.
const titleOf = (post: Post) => post.caption.split('\n').find(line => line.trim())?.trim().slice(0, 80) || post.media?.name?.split('/').pop() || words.untitled;
const rowOf = (post: Post): Row => ({
  id: post.post_id, title: titleOf(post), at: post.at, when: post.at ? whenWords(post.at) : '', status: post.status,
  places: post.destinations.map(item => item.label ?? item.platform ?? item.account_id).join(', '), can_move: post.can_move,
});

const FIELDS: FieldDescriptor[] = [
  { id: 'title', label: words.field_post, icon: 'LayoutList', ruleKind: 'text', filterable: true, sortable: true, width: 320 },
  { id: 'when', label: words.field_when, icon: 'CalendarClock', ruleKind: 'date', filterable: true, sortable: true, width: 200,
    sortValue: (row: Row) => (row.at ? Date.parse(row.at) : Number.MAX_SAFE_INTEGER), factValue: (row: Row) => (row.at ? Date.parse(row.at) : null) },
  { id: 'status', label: words.field_status, icon: 'CircleDot', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, width: 140, values: statusRows },
  { id: 'places', label: words.field_places, icon: 'Send', ruleKind: 'text', filterable: true, width: 220 },
];

/** One opened post beside the calendar: what it is, and a time field and buttons for what it can still do. */
function OpenPost({ row, onMove, onApprove, onClose }: { row: Row; onMove: (at: string | null) => void; onApprove: () => void; onClose: () => void }) {
  const [value, setValue] = React.useState('');
  React.useEffect(() => {
    const at = row.at ? new Date(row.at) : null;
    setValue(at ? new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
  }, [row.at]);
  const status = statusRows[row.status];
  return (
    <Container layout="vertical" gap="sm" padding="md" data-calendar-open-post={row.id}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="heading-xs" truncate>{row.title}</Text>
        <Button size="xs" variant="ghost" onClick={onClose}>{words.close}</Button>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Badge size="sm" variant="muted-outline" data-tone={status?.tone ?? 'grey'}>{status?.label ?? row.status}</Badge>
        {row.when ? <Text variant="caption">{row.when}</Text> : null}
        {row.places ? <Text variant="caption" truncate>{row.places}</Text> : null}
      </Container>
      {row.can_move ? (
        <Container layout="horizontal" gap="sm" alignItems="center">
          <DateTimePicker aria-label={words.move_to} value={value} onChange={next => setValue(next ?? '')} />
          <Button size="sm" variant="outline" disabled={!value} onClick={() => onMove(new Date(value).toISOString())}>{words.move}</Button>
          {row.at ? <Button size="sm" variant="ghost" onClick={() => onMove(null)}>{words.take_time_away}</Button> : null}
          {row.status === 'draft' ? <Button size="sm" onClick={onApprove}>{words.approve}</Button> : null}
        </Container>
      ) : <Text variant="caption">{words.cannot_move}</Text>}
    </Container>
  );
}

export function mountCalendarScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  // The bar's view (the calendar or the list) and the calendar's own choice of month, week or day.
  let viewId = calendar.calendar.id;
  let choice = VIEWS[0].id;
  let anchor = dayKey(new Date());
  let loaded: Calendar = { from: '', to: '', posts: [], unscheduled: [] };
  let places: PostPlaces | null = null;
  let writing = false;
  let openId: string | null = null;
  const host = document.createElement('div');
  host.className = 'trillion-decisions';
  element.replaceChildren(host);

  const shownView = () => VIEWS.find(view => view.id === choice)?.view ?? VIEWS[0].view;
  const rows = () => [...loaded.posts, ...loaded.unscheduled].map(rowOf);
  // The calendar views draw inside the record views' own tree, so updating it redraws them with the current anchor.
  const redraw = () => views?.update(options());

  // Moves a post: drawn at its new place at once, then kept, then read again. A post that was approved or set to go
  // out is a draft again, said with Approve again.
  async function move(id: string, at: string | null) {
    const post = [...loaded.posts, ...loaded.unscheduled].find(item => item.post_id === id);
    if (!post) return;
    const before = post.status;
    // The move is laid over every read of the calendar until the store has it, so a read that lands first never snaps the post back.
    const moved = (value: Calendar): Calendar => {
      const current = [...value.posts, ...value.unscheduled].find(item => item.post_id === id) ?? post;
      return {
        ...value,
        posts: [...value.posts.filter(item => item.post_id !== id), ...(at ? [{ ...current, at, scheduled_for: at }] : [])],
        unscheduled: [...value.unscheduled.filter(item => item.post_id !== id), ...(at ? [] : [{ ...current, at: null, scheduled_for: null }])],
      };
    };
    try {
      await optimistic<Calendar, unknown>(CALENDAR_READ, id, moved, async () => {
        loaded = applyPending(CALENDAR_READ, loaded);
        redraw();
        await postJson('/work/api/posts/draft', { post_id: id, scheduled_for: at, time_zone: at ? zone() : null });
      });
      const title = titleOf(post);
      if (before === 'approved' || before === 'scheduled') {
        notify(fill(words.now_a_draft, { title }), { kind: 'info', actions: [{ label: words.approve_again, onAction: () => void approve(id, before, at) }] });
      } else notify(at ? fill(words.moved, { title, when: whenWords(at) }) : fill(words.unplaced, { title }), { kind: 'done' });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
    await screen.reload();
  }

  // Approves a draft; one that was set to go out before it moved is set again, while its time is still ahead.
  async function approve(id: string, before: string, at: string | null) {
    try {
      await postJson('/work/api/posts/approve', { post_id: id });
      if (before === 'scheduled' && at && Date.parse(at) > Date.now()) {
        const published = await postJson<{ said: string }>('/work/api/posts/publish', { post_id: id });
        notify(fill(words.approved, { said: published.said }), { kind: 'done' });
      } else notify(before === 'scheduled' ? words.approved_past : fill(words.approved, { said: '' }).trim(), { kind: 'done' });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
    await screen.reload();
  }

  function CalendarBody({ records }: { records: Row[] }) {
    const items: ScheduleItem[] = records.map(row => ({ id: row.id, title: row.title, at: row.at, tone: statusRows[row.status]?.tone ?? 'grey', movable: row.can_move }));
    const opened = openId ? rows().find(row => row.id === openId) ?? null : null;
    const open = (id: string | null) => { openId = id; writing = false; redraw(); };
    const none = !loaded.posts.length && !loaded.unscheduled.length;
    return (
      <Container layout="vertical" gap="sm" height="full" minHeight="0" data-calendar-screen>
        <ConnectNotice places={places} />
        {none && !writing ? (
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="sm" data-calendar-no-posts="">
            <Text variant="caption">{words.no_posts}</Text>
            <Container layout="horizontal" gap="xs" alignItems="center">
              <Button size="sm" variant="primary" onClick={startWriting}>{words.write}</Button>
              <Button size="sm" variant="ghost" onClick={() => askForPost()}>{words.ask_ai}</Button>
            </Container>
          </Container>
        ) : null}
        <Container layout="vertical" flex={1} minHeight="0" padding="sm">
          <ScheduleCalendar
            items={items}
            view={shownView()}
            anchor={anchor}
            choices={VIEWS.map(({ id, label }) => ({ id, label }))}
            choice={choice}
            onChoiceChange={next => { choice = next; openId = null; redraw(); void screen.reload(); }}
            onAnchorChange={next => { anchor = next; openId = null; redraw(); void screen.reload(); }}
            onMove={(id, at) => void move(id, at)}
            onOpen={id => open(id)}
            onSelectDay={key => { anchor = key; choice = VIEWS.find(item => item.view.grid === 'hours' && item.view.days === 1)?.id ?? choice; redraw(); void screen.reload(); }}
            ariaLabel={words.screen}
            words={{
              previous: words.previous, next: words.next, today: words.today, tray: words.tray, trayEmpty: words.tray_empty, show: words.show,
              more: count => fill(words.more, { count: String(count) }),
              placing: (title, when) => fill(words.placing, { title, when }),
              unplacing: title => fill(words.unplacing, { title }),
            }}
            windowStartMinute={calendar.hour_window.start}
            windowEndMinute={calendar.hour_window.end}
            initialScrollMinute={calendar.start_scroll_minute}
            snapMinutes={calendar.snap_minutes}
            durationMinutes={calendar.post_minutes}
          />
        </Container>
        {writing ? <NewPost places={places} onClose={() => { writing = false; redraw(); }} onKept={id => { writing = false; openId = id; void screen.reload(); }} /> : null}
        {opened && !writing ? <OpenPost row={opened} onMove={at => void move(opened.id, at)} onApprove={() => void approve(opened.id, opened.status, opened.at)} onClose={() => open(null)} /> : null}
      </Container>
    );
  }

  // The calendar view draws the shared calendar over the rows the bar's search and filters keep.
  const calendarView: RecordView = {
    ...calendar.calendar,
    render: ({ records }: { records: Row[] }) => <CalendarBody records={records} />,
  };
  const options = () => ({
    label: words.screen, fields: FIELDS, records: rows(), identify: (row: Row) => row.id, preferenceKey: 'trillion-calendar',
    views: [calendarView, calendar.table], view: viewId,
    onViewChange: (next: string) => { if (next === viewId) return; viewId = next; if (next === calendarView.id) void screen.reload(); },
    onOpen: (id: string) => { openId = id; if (viewId !== calendarView.id) { viewId = calendarView.id; const at = rows().find(row => row.id === id)?.at; if (at) anchor = dayKey(new Date(at)); void screen.reload(); } redraw(); },
    ...recordFilter,
    primaryAction: { label: words.write, icon: 'SquarePen', onSelect: startWriting },
    emptyMessage: words.no_posts,
  });

  // The new-post panel opens beside the calendar view (a calendar view, since the list has no side).
  function startWriting() {
    writing = true;
    openId = null;
    if (viewId !== calendarView.id) { viewId = calendarView.id; void screen.reload(); }
    redraw();
  }

  // Hands the draft-post job (src/queued-work.json) to the person's own AIs.
  async function askForPost() {
    try {
      const answer = await postJson<{ said?: string }>('/work/api/queue', { job_id: 'draft-post', label: words.ask_ai, context: {}, press_key: `calendar-${Date.now()}` });
      notify(answer.said ?? words.asked, { kind: 'done' });
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    }
  }

  const screen = loadScreen(host, {
    loading: { label: words.loading, layout: 'rows' },
    // Only the span on screen: the shown calendar view's days, around the anchor.
    read: async () => {
      const range = visibleRange(shownView(), anchor);
      return applyPending(CALENDAR_READ, await readJson<Calendar>(`/work/api/posts/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`));
    },
    failed: refusal(words.failed),
    clear: () => { views?.destroy(); views = null; },
    draw: answer => {
      loaded = answer;
      if (views) redraw(); else views = mountRecordViews(host, options());
    },
  });
  // Where a post can go, read once by name (no connect link is made); the notice and the new-post panel read it.
  readPostPlaces().then(read => { places = read; redraw(); }, () => undefined);
  const stopListening = onStoreChange(() => screen.reload());
  return () => { stopListening(); screen.dispose(); element.replaceChildren(); };
}
