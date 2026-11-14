// packages/ui/show/notifications/NotificationPanel.tsx
//
// PURPOSE
// The body of the notification center, shown as an ordinary screen: it opens
// wherever its surface DATA places it (a picture-in-picture window, or a tab in
// any container), and a compact version is what a navigation hover preview
// shows. It holds
//   - "In progress": every running item with its live progress and actions;
//   - the full history grouped by day (Today, Yesterday, then dates);
//   - filters (All, Unread, Problems), Mark all as read, Clear, and per-row
//     mark read/unread and remove.
// It replaces the separate "Live activity" page: running work is the center's
// live section, so there is one place to look.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Reads the same NotificationCenter the toasts read; never a copy.
// 2. Read state changes only through the person's action (row, Mark as read,
//    Mark all as read). Showing the panel does not clear the count.
// 3. Rows reuse NotificationParts, so a row and its toast look alike.
// 4. Filters are DATA below; "Problems" is decided by tone (from kind DATA),
//    never by a kind name.
// 5. The panel owns no placement: no popover, no fixed position. Where it
//    appears is the arrangement's and the surface DATA's decision.
// 6. Within a day, finished notifications that say the same thing (the same kind
//    and title, such as five "A new video is in your files") read as one row with
//    their count, the newest leading; Show all lists each under it. Running work
//    is never grouped: each piece of work shows its own progress.
//
// References (anatomy; original code): 21st.dev #27135 "Notification Panel"
// by uvain (tabs with unread count, Mark all as read, grouped rows, per-row
// read/archive), #8245 "Notification Inbox Popover" by ruixen.ui (All / Unread
// toggle), #29394 "Activity Feed" (icon, title, relative time rows). Mobbin:
// Linear inbox (unread dots, quiet rows), GitHub notifications (All / Unread,
// mark done), a dashboard activity feed (date grouping).

import React from 'react';
import {BellIcon} from 'lucide-react';
import {ExpandableTabs, type ExpandableTabItem} from '../expandable-tabs/ExpandableTabs';
import {RecordViews, type FieldDescriptor, type RecordView, type RecordViewsOptions, type SavedRecordView} from '../record-views/record-views';
import type {RuleGroup} from '../rule-filter/rule-tree';
import {NotificationRow, notificationKindAppearance} from './NotificationParts';
import {NOTICE_SUBJECT, noticeThing, type NotificationCenter as Center, type NotificationRecord} from './notification-center';
import {showOf, useShowChange} from '../show-rules/show-of';
import kindsData from './notification-kinds.json';

const words = kindsData.words;

const PROBLEM_TONES = new Set(['red', 'yellow']);
const FILTERS: Array<{tab: ExpandableTabItem & {icon: string}; keep: (record: NotificationRecord) => boolean}> = [
  {tab: {id: 'all', label: 'All', icon: 'Inbox', tip: 'See running work and earlier updates together.'}, keep: () => true},
  {tab: {id: 'unread', label: 'Unread', icon: 'CircleDot', tip: 'Find updates you have not opened yet.'}, keep: (record) => !record.read},
  {tab: {id: 'problems', label: 'Problems', icon: 'TriangleAlert', tip: 'Find work that failed or needs your attention.'}, keep: (record) => PROBLEM_TONES.has(notificationKindAppearance(record.kind).tone)},
];
type NotificationViewRecord = NotificationRecord & {state: string; reading: string; attention: string};
const ruleFor = (field: string, value: string): RuleGroup => ({
  kind: 'group', combinator: 'and', negate: false,
  rules: [{kind: 'rule', field, operator: 'is_any_of', params: {values: [value]}}],
});
const RUNNING_RULE = ruleFor('state', 'Running');
const SAVED_FILTERS: SavedRecordView[] = [
  {id: 'running', label: 'In progress', search: '', rules: RUNNING_RULE},
  {id: 'all', label: 'All', search: '', rules: {kind: 'group', combinator: 'and', negate: false, rules: []}},
  {id: 'unread', label: 'Unread', search: '', rules: ruleFor('reading', 'Unread')},
  {id: 'problems', label: 'Problems', search: '', rules: ruleFor('attention', 'Problem')},
];
const FIELDS: FieldDescriptor[] = [
  {id: 'title', label: 'Update', ruleKind: 'text', filterable: true, sortable: true, preview: 'heading', width: 320},
  {id: 'detail', label: 'Details', ruleKind: 'text', filterable: true, width: 320, preview: true},
  {id: 'state', label: 'State', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true, sortable: true,
    values: {Running: {label: 'In progress', tone: 'blue', working: true}, Done: {label: 'Finished', tone: 'green', settled: true}}},
  {id: 'reading', label: 'Read', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true,
    values: {Unread: {label: 'Unread'}, Read: {label: 'Read'}}},
  {id: 'attention', label: 'Attention', kind: 'tag', ruleKind: 'choice', filterable: true, groupable: true,
    values: {Problem: {label: 'Problem', tone: 'red'}, Other: {label: 'Other'}}},
  {id: 'updatedAt', label: 'When', kind: 'date', ruleKind: 'date', filterable: true, sortable: true,
    read: (record: NotificationViewRecord) => new Date(record.updatedAt).toLocaleString(),
    factValue: (record: NotificationViewRecord) => record.updatedAt,
    sortValue: (record: NotificationViewRecord) => record.updatedAt},
];
/** How many finished items the compact preview lists under the running ones. */
const COMPACT_SETTLED_LIMIT = 5;

const snapshotOf = (center: Center) => ({history: center.history(), unread: center.unreadCount()});

function useCenterSnapshot(center: Center) {
  const [snapshot, setSnapshot] = React.useState(() => snapshotOf(center));
  React.useEffect(() => {
    let frame = 0;
    const flush = () => { frame = 0; setSnapshot(snapshotOf(center)); };
    // Progress ticks arrive many times a second; paint at most once a frame.
    const unsubscribe = center.subscribe(() => { if (!frame) frame = requestAnimationFrame(flush); });
    flush();
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [center]);
  return snapshot;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
function dayLabel(time: number, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= start) return 'Today';
  if (time >= start - 86_400_000) return 'Yesterday';
  return dayFormat.format(time);
}

function groupByDay(records: NotificationRecord[]) {
  const groups: Array<{label: string; records: NotificationRecord[]}> = [];
  for (const record of records) {
    const label = dayLabel(record.updatedAt);
    const last = groups.at(-1);
    if (last?.label === label) last.records.push(record);
    else groups.push({label, records: [record]});
  }
  return groups;
}

/** The day's records with the ones that say the same thing (kind and title) together, in the order the first of each
 *  arrived (newest first, as history is). */
function sameTogether(records: NotificationRecord[]): NotificationRecord[][] {
  const together = new Map<string, NotificationRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.kind, record.title]);
    const same = together.get(key);
    if (same) same.push(record);
    else together.set(key, [record]);
  }
  return [...together.values()];
}

/** Several notifications that say the same thing as one row with their count; Show all lists each under it. */
function SameRows({records, center, compact}: {records: NotificationRecord[]; center: Center; compact: boolean}) {
  const [open, setOpen] = React.useState(false);
  if (records.length < 2) return <Row record={records[0]} center={center} compact={compact} />;
  const [newest] = records;
  const unread = records.filter((record) => !record.read);
  const count = String(records.length);
  return (
    <>
      <li className="notification-center-row" data-slot="notification-same-rows" data-unread={unread.length ? true : undefined}
        data-tone={notificationKindAppearance(newest.kind).tone}>
        <span className="notification-center-unread" aria-hidden="true" />
        <NotificationRow record={{...newest, actions: newest.actions.filter((action) => action.press || action.input)}} count={records.length}
          onDismiss={() => { for (const record of records) center.setRead(record.id, true); }}
          controls={
            <span className="notification-center-row-actions" data-slot="notification-row-actions" onClick={(event) => event.stopPropagation()}>
              <ExpandableTabs mode="action" size="sm" ariaLabel={words.together.replace('{count}', count)}
                items={[
                  {id: 'open', label: open ? words.show_fewer : words.show_all.replace('{count}', count), icon: open ? 'ChevronUp' : 'ChevronDown'},
                  ...(unread.length ? [{id: 'read', label: words.read_all, icon: 'CheckCheck'}] : []),
                ]}
                onSelect={(id) => { if (id === 'open') setOpen(!open); else if (id === 'read') for (const record of unread) center.setRead(record.id, true); }} />
            </span>
          } />
      </li>
      {open ? records.map((record) => <Row key={record.id} record={record} center={center} compact={compact} within />) : null}
    </>
  );
}

function Row({record, center, compact, within}: {record: NotificationRecord; center: Center; compact: boolean; within?: boolean}) {
  return (
    <li className="notification-center-row" data-slot="notification-history-row" data-within={within || undefined} data-running={record.running || undefined}
      data-unread={!record.read || undefined} data-tone={notificationKindAppearance(record.kind).tone}
      onClick={() => center.setRead(record.id, true)}>
      <span className="notification-center-unread" aria-hidden="true" />
      <NotificationRow record={compact ? {...record, actions: record.actions.filter((action) => action.press)} : record} onDismiss={() => center.setRead(record.id, true)}
        controls={compact ? undefined : (
          <span className="notification-center-row-actions" data-slot="notification-row-actions" onClick={(event) => event.stopPropagation()}>
            <ExpandableTabs mode="action" size="sm" ariaLabel="Actions for this notification"
              items={[
                {id: 'read', label: record.read ? 'Mark as unread' : 'Mark as read', icon: record.read ? 'CircleDot' : 'Circle'},
                ...(record.running || record.kept ? [] : [{id: 'remove', label: 'Remove', icon: 'X'}]),
              ]}
              onSelect={(id) => { if (id === 'read') center.setRead(record.id, !record.read); else if (id === 'remove') center.remove(record.id); }} />
          </span>
        )} />
    </li>
  );
}

export interface NotificationPanelProps {
  center: Center;
  /** The short live feed a hover preview shows: running work and the latest few, no filters or row actions. */
  compact?: boolean;
  /** The host's formula engine, loaded only when a person filters the full record list. */
  recordFilter?: Pick<RecordViewsOptions, 'ruleOperators' | 'loadFilterRecords'>;
}

export function NotificationPanel({center, compact = false, recordFilter}: NotificationPanelProps) {
  const {history: everything, unread} = useCenterSnapshot(center);
  const [activeRules, setActiveRules] = React.useState<RuleGroup>(RUNNING_RULE);
  // A notice a show rule hides leaves the list too (a silenced one stays listed, only its card stays away).
  useShowChange();
  const history = everything.filter((record) => !showOf(NOTICE_SUBJECT, noticeThing(record, 'list')).hidden);
  const live = history.filter((record) => record.running);
  const settled = history.filter((record) => !record.running).slice(0, COMPACT_SETTLED_LIMIT);
  const records: NotificationViewRecord[] = history.map((record) => ({
    ...record,
    state: record.running ? 'Running' : 'Done',
    reading: record.read ? 'Read' : 'Unread',
    attention: PROBLEM_TONES.has(notificationKindAppearance(record.kind).tone) ? 'Problem' : 'Other',
  }));
  const views: RecordView[] = [
    {id: 'feed', label: 'Feed', icon: 'List', render: ({records: shown}) => <NotificationFeed records={shown as NotificationRecord[]} center={center} />},
    {id: 'table', label: 'Table', icon: 'Table'},
    {id: 'board', label: 'Board', icon: 'Kanban'},
  ];
  // Existing hosts without a formula engine keep their original screen while
  // Trillion's screen uses the shared record views and every list filter.
  if (!compact && !recordFilter) return <LegacyNotificationPanel center={center} history={history} unread={unread} />;
  return (
    <section className="coss-ui notification-center" data-slot="notification-center" data-compact={compact || undefined} aria-label="Notifications">
      {compact ? (
        // The preview card already names the screen; the feed adds only its count.
        unread ? <p className="notification-center-count" data-slot="notification-unread-count">{unread} unread</p> : null
      ) : null}
      {compact ? <div className="notification-center-scroll">
        {live.length ? (
          <section className="notification-center-group" data-slot="notification-live" aria-label="In progress">
            <h3 className="notification-center-group-label">In progress</h3>
            <ul className="notification-center-list">{live.map((record) => <Row key={record.id} record={record} center={center} compact={compact} />)}</ul>
          </section>
        ) : null}
        {groupByDay(settled).map((group) => (
          <section key={group.label} className="notification-center-group" aria-label={group.label}>
            <h3 className="notification-center-group-label">{group.label}</h3>
            <ul className="notification-center-list">{sameTogether(group.records).map((same) => <SameRows key={same[0].id} records={same} center={center} compact={compact} />)}</ul>
          </section>
        ))}
        {!live.length && !settled.length ? (
          <div className="notification-center-empty">
            <span className="notification-center-empty-mark" aria-hidden="true"><BellIcon /></span>
            <p className="notification-center-empty-title">You’re all caught up</p>
            <p className="notification-center-empty-detail">Updates about your work show up here as they happen.</p>
          </div>
        ) : null}
      </div> : (
        <RecordViews
          label="Notifications"
          fields={FIELDS}
          records={records}
          identify={(record: NotificationViewRecord) => record.id}
          views={views}
          defaultView="feed"
          rules={activeRules}
          onQueryChange={({rules}) => setActiveRules(rules)}
          savedViews={SAVED_FILTERS}
          statusField="state"
          preferenceKey="trillion-notifications"
          moreActions={{label: 'Notification actions', icon: 'MoreHorizontal', items: [
            {id: 'read-all', label: 'Mark all as read', icon: 'CheckCheck', disabled: !unread},
            {id: 'clear', label: 'Clear finished', icon: 'ListX', disabled: !history.some((record) => !record.running && !record.kept)},
          ], onAction: (id) => { if (id === 'read-all') center.markAllRead(); else if (id === 'clear') center.clearHistory(); }}}
          rowActions={[
            {id: 'read', label: 'Mark as read', icon: 'Check', appliesTo: (record: NotificationViewRecord) => !record.read,
              run: (ids) => ids.forEach((id) => center.setRead(id, true))},
            {id: 'unread', label: 'Mark as unread', icon: 'CircleDot', appliesTo: (record: NotificationViewRecord) => record.read,
              run: (ids) => ids.forEach((id) => center.setRead(id, false))},
            {id: 'remove', label: 'Remove', icon: 'X', appliesTo: (record: NotificationViewRecord) => !record.running && !record.kept,
              run: (ids) => ids.forEach((id) => center.remove(id))},
          ]}
          {...recordFilter}
          emptyMessage="Nothing here"
        />
      )}
    </section>
  );
}

function LegacyNotificationPanel({center, history, unread}: {center: Center; history: NotificationRecord[]; unread: number}) {
  const [filter, setFilter] = React.useState('all');
  const keep = FILTERS.find((entry) => entry.tab.id === filter)?.keep ?? FILTERS[0].keep;
  const live = history.filter((record) => record.running && keep(record));
  const settled = history.filter((record) => !record.running && keep(record));
  const tabs = FILTERS.map(({tab}) => tab.id === 'unread' && unread ? {...tab, label: `Unread ${unread}`} : tab);
  return <section className="coss-ui notification-center" data-slot="notification-center" aria-label="Notifications">
    <header className="notification-center-header">
      <h2 className="notification-center-title">Notifications</h2>
      <ExpandableTabs mode="action" size="sm" ariaLabel="Notification actions" className="notification-center-header-actions"
        items={[
          {id: 'read-all', label: 'Mark all as read', icon: 'CheckCheck', disabled: !unread},
          {id: 'clear', label: 'Clear finished', icon: 'ListX', disabled: !history.some((record) => !record.running && !record.kept)},
        ]}
        onSelect={(id) => { if (id === 'read-all') center.markAllRead(); else if (id === 'clear') center.clearHistory(); }} />
    </header>
    <div className="notification-center-filters">
      <ExpandableTabs items={tabs} ariaLabel="Show" mode="choice" value={filter} onChange={setFilter} size="sm" />
    </div>
    <NotificationFeed records={[...live, ...settled]} center={center} />
    {!live.length && !settled.length ? <div className="notification-center-empty">
      <span className="notification-center-empty-mark" aria-hidden="true"><BellIcon /></span>
      <p className="notification-center-empty-title">{filter === 'all' ? 'You’re all caught up' : 'Nothing here'}</p>
      <p className="notification-center-empty-detail">Updates about your work show up here as they happen.</p>
    </div> : null}
  </section>;
}

function NotificationFeed({records, center}: {records: NotificationRecord[]; center: Center}) {
  const live = records.filter((record) => record.running);
  const settled = records.filter((record) => !record.running);
  return <div className="notification-center-scroll">
    {live.length ? <section className="notification-center-group" data-slot="notification-live" aria-label="In progress">
      <h3 className="notification-center-group-label">In progress</h3>
      <ul className="notification-center-list">{live.map((record) => <Row key={record.id} record={record} center={center} compact={false} />)}</ul>
    </section> : null}
    {groupByDay(settled).map((group) => <section key={group.label} className="notification-center-group" aria-label={group.label}>
      <h3 className="notification-center-group-label">{group.label}</h3>
      <ul className="notification-center-list">{sameTogether(group.records).map((same) => <SameRows key={same[0].id} records={same} center={center} compact={false} />)}</ul>
    </section>)}
  </div>;
}
