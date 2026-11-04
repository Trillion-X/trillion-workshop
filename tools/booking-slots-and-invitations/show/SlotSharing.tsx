import * as React from 'react';
import { ActionMenu, Button, Container, errorWords, Input, NamedIcon, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text,
  type CalendarAccount, type CalendarControlPreferences, type ScheduleRange, type WeeklyAvailabilitySchedule } from '../../ui';
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/show/coss/ui/popover';
import words from '../read-data/slot-sharing.json';
import linkWords from '../read-data/availability-link-screen.json';
import { defaultCalendar, emptyDraft, reuseRequestKey, type AvailabilityLink, type AvailabilityLinkAction, type CalendarIdentity } from './AvailabilityLinks';
import { oneOffsToWindows, rangesToOneOffs, rangesToWindows, scheduleToRanges } from './slot-ranges.mjs';

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const mutationFor = (mutate: Mutate, action: AvailabilityLinkAction, input: Record<string, unknown>, keys: Map<string, { payload: string; key: string }>, signature: string) =>
  mutate(action, input, reuseRequestKey(keys, signature, [action, input]));

type Mutate = (action: AvailabilityLinkAction, input: Record<string, unknown>, requestKey: string) => Promise<AvailabilityLink | unknown>;

export interface ShareLinksMenuProps {
  listLinks: (after?: string) => Promise<{ links: AvailabilityLink[]; next_cursor?: string | null }>;
  mutate: Mutate;
  onShare: (id: string, title: string, anchor: Element | null) => void;
  /** The person chose Create link: the caller enters slot-creation mode. */
  onCreate: () => void;
  subscribeChanges?: (listener: () => void) => () => void;
}

/** The calendar header's Share button and its list of shared slots. */
export function ShareLinksMenu({ listLinks, mutate, onShare, onCreate, subscribeChanges }: ShareLinksMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [links, setLinks] = React.useState<AvailabilityLink[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState('');
  const trigger = React.useRef<HTMLButtonElement>(null);
  const generation = React.useRef(0);
  const keys = React.useRef(new Map<string, { payload: string; key: string }>());

  const reload = React.useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const answer = await listLinks();
      if (mine !== generation.current) return;
      if (!Array.isArray(answer?.links)) throw new Error(words.loadError);
      setLinks(answer.links.filter(link => link.state === 'active'));
      setError('');
    } catch (cause) {
      if (mine === generation.current) setError(errorWords(cause, words.loadError));
    } finally {
      if (mine === generation.current) { setLoading(false); setLoaded(true); }
    }
  }, [listLinks]);
  React.useEffect(() => { if (open) void reload(); }, [open, reload]);
  React.useEffect(() => subscribeChanges?.(() => { if (open) void reload(); }), [subscribeChanges, open, reload]);

  const act = async (link: AvailabilityLink, id: string) => {
    if (id === 'share') { onShare(link.id, link.title, trigger.current); return; }
    setError('');
    try {
      if (id === 'makeRecurring') {
        await mutationFor(mutate, 'edit', { link_id: link.id, expected_revision: link.revision,
          changes: { repeat: true, windows: oneOffsToWindows(link.one_off_slots ?? [], link.timezone), one_off_slots: [] } }, keys.current, `recurring:${link.id}:${link.revision}`);
      } else if (id === 'discard') {
        await mutationFor(mutate, 'delete', { link_id: link.id, expected_revision: link.revision }, keys.current, `discard:${link.id}:${link.revision}`);
      }
      await reload();
    } catch (cause) { setError(errorWords(cause, words.actionError)); }
  };

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button ref={trigger} size="xs" variant="ghost" aria-label={words.shareButton} title={words.shareButton} data-share-links-trigger />}>
      <NamedIcon name={words.shareIcon} size={14} />
    </PopoverTrigger>
    <PopoverPopup align="end" className="w-72" portalProps={{ className: 'coss-ui', keepMounted: false }}>
      <Container layout="vertical" gap="sm" data-share-links>
        <Text variant="body" weight="semibold">{words.popoverTitle}</Text>
        {error ? <Container layout="horizontal" gap="xs" alignItems="center" wrap>
          <Text variant="caption" color="error">{error}</Text>
          <Button size="xs" variant="ghost" onClick={() => void reload()}>{linkWords.retry}</Button>
        </Container> : null}
        {!loaded && loading ? <Text variant="caption" color="muted">{words.loading}</Text> : null}
        {loaded && !error && !links.length ? <Text variant="caption" color="muted" data-share-links-empty>{words.empty}</Text> : null}
        {links.map(link => <Container key={link.id} data-share-link={link.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Container layout="vertical" gap="none" className="min-w-0 flex-1">
            <Text variant="body-sm" weight="medium">{link.title}</Text>
            <Text variant="caption" color="muted">{link.repeat ? linkWords.repeatLabel : linkWords.oneOffLabel}</Text>
          </Container>
          <ActionMenu label={fill(words.rowMenu, { title: link.title })}
            items={[
              { id: 'share', ...words.rowActions.share },
              ...(link.repeat ? [] : [{ id: 'makeRecurring', ...words.rowActions.makeRecurring }]),
              { id: 'discard', ...words.rowActions.discard, tone: 'destructive', group: 'danger' },
            ]}
            onAction={id => void act(link, id)} />
        </Container>)}
        <Button size="sm" variant="primary" onClick={() => { setOpen(false); onCreate(); }}>{words.createLink}</Button>
      </Container>
    </PopoverPopup>
  </Popover>;
}

export interface SlotBarProps {
  accounts: CalendarAccount[];
  preferences: CalendarControlPreferences;
  mutate: Mutate;
  /** The spans dragged on the calendar so far. */
  ranges: ScheduleRange[];
  onRangesChange: (ranges: ScheduleRange[]) => void;
  /** The days the calendar shows, used to copy a preferred-times schedule onto them. */
  dayKeys: string[];
  weekdayOf: (key: string) => number;
  at: (key: string, minute: number) => string;
  /** The link was created. */
  onCreated: (link: AvailabilityLink) => void;
  /** The person left slot creation without creating. */
  onDiscard: () => void;
}

function firstWritableCalendar(accounts: CalendarAccount[]): CalendarIdentity | null {
  for (const account of accounts) {
    const calendar = account.calendars.find(row => row.writable === true || ['owner', 'writer'].includes(row.access_role ?? ''));
    if (calendar && account.source_id) return { source_id: account.source_id, connection_id: account.connection_id, connected_at: account.connected_at,
      calendar_id: calendar.id, ...(calendar.access_role ? { access_role: calendar.access_role } : {}) };
  }
  return null;
}

/** The bar shown while slots are dragged out on the calendar: what to call the link, how long each slot is, and Create. */
export function SlotBar({ accounts, preferences, mutate, ranges, onRangesChange, dayKeys, weekdayOf, at, onCreated, onDiscard }: SlotBarProps): React.ReactElement {
  const timezone = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [location, setLocation] = React.useState('');
  const [alias, setAlias] = React.useState('');
  const [repeat, setRepeat] = React.useState(false);
  const [duration, setDuration] = React.useState(30);
  const [scheduleId, setScheduleId] = React.useState(preferences.workScheduleId ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const keys = React.useRef(new Map<string, { payload: string; key: string }>());
  const schedules: WeeklyAvailabilitySchedule[] = preferences.workSchedules ?? [];
  const calendar = defaultCalendar(accounts, preferences) ?? firstWritableCalendar(accounts);
  const slotCount = repeat ? rangesToWindows(ranges, timezone).length : rangesToOneOffs(ranges, duration).length;
  const canCreate = Boolean(title.trim() && calendar && slotCount > 0 && !busy);

  const copyPreferred = () => {
    const schedule = schedules.find(row => row.id === scheduleId);
    if (schedule) onRangesChange(scheduleToRanges(schedule, dayKeys, weekdayOf, at));
  };
  const create = async () => {
    if (!canCreate || !calendar) return;
    const base = emptyDraft(calendar, timezone);
    const input = { ...base, title: title.trim(), description, location, alias, duration_min: duration, step_min: duration, repeat,
      windows: repeat ? rangesToWindows(ranges, timezone) : [], one_off_slots: repeat ? [] : rangesToOneOffs(ranges, duration),
      ...(repeat && scheduleId ? { preferred_times_snapshot: schedules.find(row => row.id === scheduleId) } : {}) };
    setBusy(true); setError('');
    try {
      const created = await mutationFor(mutate, 'create', input, keys.current, 'slot-create') as AvailabilityLink | undefined;
      if (!created || typeof created.id !== 'string') throw new Error(words.createError);
      onCreated(created);
    } catch (cause) { setError(errorWords(cause, words.createError)); }
    finally { setBusy(false); }
  };

  return <Container data-slot-bar role="group" aria-label={words.barLabel} layout="vertical" gap="sm" padding="sm" className="slot-bar">
    <Container layout="horizontal" gap="sm" alignItems="end" wrap>
      <Input label={linkWords.titleLabel} placeholder={linkWords.titlePlaceholder} maxLength={160} required value={title} onChange={event => setTitle(event.target.value)} />
      <Input label={linkWords.descriptionLabel} placeholder={linkWords.descriptionPlaceholder} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} />
      <Input label={linkWords.location} placeholder={linkWords.locationPlaceholder} maxLength={300} value={location} onChange={event => setLocation(event.target.value)} />
      <Input label={linkWords.alias} placeholder={linkWords.aliasPlaceholder} maxLength={300} value={alias} onChange={event => setAlias(event.target.value)} />
    </Container>
    <Container layout="horizontal" gap="sm" alignItems="center" wrap>
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Switch size="sm" label={words.repeat} checked={repeat} onCheckedChange={setRepeat} />
        <Container layout="vertical" gap="none">
          <Text variant="body-sm">{words.repeat}</Text>
          <Text variant="caption" color="muted">{words.repeatHelp}</Text>
        </Container>
      </Container>
      <Container layout="vertical" gap="xs">
        <Text variant="caption" color="muted">{words.duration}</Text>
        <Select value={String(duration)} onValueChange={value => { if (typeof value === 'string') setDuration(Number(value)); }}>
          <SelectTrigger aria-label={words.duration}><SelectValue>{`${duration} ${linkWords.minutes}`}</SelectValue></SelectTrigger>
          <SelectPopup>{linkWords.durationMinutes.map(minutes => <SelectItem key={minutes} value={String(minutes)}>{minutes} {linkWords.minutes}</SelectItem>)}</SelectPopup>
        </Select>
      </Container>
      {schedules.length ? <Container layout="horizontal" gap="sm" alignItems="end">
        <Select value={scheduleId} onValueChange={value => { if (typeof value === 'string') setScheduleId(value); }}>
          <SelectTrigger className="min-w-40" aria-label={words.choosePreferred}><SelectValue placeholder={words.choosePreferred}>{schedules.find(row => row.id === scheduleId)?.label}</SelectValue></SelectTrigger>
          <SelectPopup>{schedules.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
        </Select>
        <Button size="sm" variant="outline" disabled={!scheduleId} onClick={copyPreferred}>{words.copyPreferred}</Button>
      </Container> : <Text variant="caption" color="muted">{words.noPreferred}</Text>}
    </Container>
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="caption" color={error || !calendar ? 'error' : 'muted'}>
        {error || (!calendar ? linkWords.noCalendar : slotCount ? (slotCount === 1 ? words.slotCountOne : fill(words.slotCount, { count: String(slotCount) })) : words.dragHint)}
      </Text>
      <Container layout="horizontal" gap="xs">
        <Button size="sm" variant="ghost" onClick={onDiscard}>{words.discard}</Button>
        <Button size="sm" variant="primary" disabled={!canCreate} onClick={() => void create()}>{words.create}</Button>
      </Container>
    </Container>
  </Container>;
}

