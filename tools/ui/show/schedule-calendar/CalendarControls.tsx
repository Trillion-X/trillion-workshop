import * as React from 'react';
import { Button, ColorDot, Container, Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text } from '../../index';
import { GripVertical, X } from 'lucide-react';
import { Popover, PopoverPopup, PopoverTrigger } from '../coss/ui/popover';
import { Checkbox } from '../coss/ui/checkbox';
import { Input } from '../coss/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../coss/ui/table';
import { ChoiceTiles } from '../choice-tiles/ChoiceTiles';
import { Kbd } from '../kbd/Kbd';
import { SortableRows } from '../drag-reorder-list/SortableRows';
import { knownZones, makeFormat, zoneCity } from './schedule-format.mjs';
import type { WeeklyAvailabilityDay, WeeklyAvailabilitySchedule, WeeklyAvailabilityWords } from './WeeklyAvailability';
import { later } from '../load-later/later';
import { groupSourcesByAccount } from './calendar-source-groups';

// The settings' work schedules and new-event duration box are drawn only in the settings, never in the sources menu:
// each is fetched the first time the settings are drawn.
const WeeklyAvailability = later(() => import('./WeeklyAvailability'), module => module.WeeklyAvailability);
const EventDurationField = later(() => import('./EventDurationField'), module => module.EventDurationField);

/** Provider role labels are open-ended; shared UI behavior uses writable/read_mode. */
export type CalendarAccessRole = string;
export type CalendarSelection = { source_id?: string; connection_id: string; connected_at?: string; calendar_id: string };
export interface CalendarAccountCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  access_role?: CalendarAccessRole;
  writable?: boolean;
  read_mode?: 'events' | 'busy';
  /** Exact source/account/calendar identity supplied by the workspace adapter. */
  color_key?: string;
  /** Existing screen-look tone used before this calendar has a saved choice. */
  color_tone?: string;
}
export type CalendarAccount = {
  source_id?: string;
  connection_id: string;
  connected_at: string;
  account_label: string;
  said?: string;
  calendars: CalendarAccountCalendar[];
};

export interface CalendarControlSource {
  id: string;
  label: string;
  read: boolean;
  connected: boolean;
  said?: string | null;
  connectLabel?: string;
  /** Caller-selected palette tone for this exact source. */
  colorTone?: string;
  writable?: boolean;
  canCreate?: boolean;
  selection?: CalendarSelection;
}

/** One time zone the person keeps beside their own, with the name they call it. */
export interface CalendarControlTimeZone { id: string; zone: string; nickname: string }

export interface CalendarControlPreferences {
  /** Sunday = 0 through Saturday = 6. */
  weekStart: number;
  /** Local wall-clock values in HH:mm form. */
  workStart: string;
  workEnd: string;
  weekends: boolean;
  workdays: number[];
  /** Optional named weekly availability templates. */
  workSchedules?: WeeklyAvailabilitySchedule[];
  /** Selected default template; null keeps the legacy shared work-hour controls active. */
  workScheduleId?: string | null;
  /** Caller-owned calendar zoom, measured as the height of one hour. */
  hourHeightPx?: number;
  /** Default duration in minutes for newly created timed events. */
  defaultEventDurationMinutes?: number;
  /** Screen-look tone keyed by the exact selected calendar source id. */
  sourceColors?: Record<string, string>;
  /** Exact connected account/calendar used for new events when it is still available. */
  defaultCalendar?: CalendarSelection | null;
  /** The id of the chosen time format and date format (the caller's choices); absent: the browser's own. */
  timeFormat?: string;
  dateFormat?: string;
  /** Weeks of the calendar begin on today instead of on the week's first day. */
  startWeekToday?: boolean;
  /** Time zones in the order the person keeps them. The one equal to the device's is the main hour gutter. */
  timeZones?: CalendarControlTimeZone[];
  /** What kind of calendar and how the menubar treats it, by exact source id (the caller's choice ids). */
  calendarTypes?: Record<string, string>;
  menubar?: Record<string, string>;
  /** Events show a checkbox that marks them done; off, events are shown done once they are over. */
  eventCheckboxes?: boolean;
  /** New events are private to others. */
  privateByDefault?: boolean;
}

export interface CalendarControlColor { id: string; label: string }
export interface CalendarControlChoice { id: string; label: string }
/** One person whose busy times can be drawn on the calendar beside the person's own. */
export interface CalendarControlPerson {
  id: string; label: string; tone: string; shown: boolean;
  /** False when their calendar cannot be drawn (not connected, not shared): the switch is off and `note` says why. */
  available: boolean;
  note?: string;
  /** The keys that show or hide them, drawn as one key cap. */
  shortcut?: string;
}
export interface CalendarControlTimeFormat extends CalendarControlChoice { hour12: boolean }
export interface CalendarControlDateFormat extends CalendarControlChoice { locale: string }
export interface CalendarControlZoomOption { value: number; label: string; description?: string }

export interface CalendarControlsWords {
  title: string;
  accounts: string;
  loadingAccounts: string;
  addAccount: string;
  sources: string;
  /** Optional count-sensitive names supplied by the caller’s language DATA. */
  sourceCountNames?: Partial<Record<Intl.LDMLPluralRule, string>>;
  preferences: string;
  defaultCalendar: string;
  defaultCalendarHelp: string;
  chooseDefaultCalendar: string;
  noWritableCalendar: string;
  calendarColor: string;
  workdays: string;
  weekStart: string;
  workHours: string;
  workStart: string;
  workEnd: string;
  weekends: string;
  timezone: string;
  calendarZoom?: string;
  defaultEventDuration?: string;
  defaultEventDurationUnit?: string;
  defaultEventDurationMin?: number;
  defaultEventDurationMax?: number;
  defaultEventDurationStep?: number;
  showSource: string;
  connected: string;
  notConnected: string;
  unavailable: string;
  busyTimesOnly: string;
  readOnly: string;
  unavailableSelection: string;
  remove: string;
  newTask: string;
  taskInbox: string;
  /** Optional copy and weekday names for the named weekly availability editor. */
  workSchedules?: WeeklyAvailabilityWords;
  calendarZoomHelp?: string;
  /** The people section of the calendars menu: its heading, what it shows and the switch's name ({person}). */
  people?: string;
  peopleHelp?: string;
  connectYours?: string;
  showPerson?: string;
  /** The switch that begins every week of the calendar on today. */
  startWeekToday?: string;
  /** The tip under the zoom choices that names the zoom keys. */
  zoomTip?: string;
  zoomCustom?: string;
  timeZones?: {
    title: string; help: string; zone: string; nickname: string; nicknamePlaceholder: string; add: string; chooseZone: string;
    remove: string; reorder: string; thisDevice: string; max: number;
  };
  timeFormat?: string;
  timeFormatHelp?: string;
  dateFormat?: string;
  dateFormatHelp?: string;
  display?: {
    title: string;
    eventCheckboxes: { title: string; help: string };
    privateByDefault: { title: string; help: string };
  };
  calendarTable?: { title: string; help: string; calendar: string; color: string; type: string; menubar: string };
  defaultEventDurationHelp?: string;
}

export interface CalendarControlNavigationItem { id: string; label: string }

export interface CalendarControlsPiece {
  id: string;
  label: string;
  content: React.ReactNode;
}

export interface CalendarControlsProps {
  /** The caller places these live controls through its shared arrangement owner. */
  renderPieces?: (pieces: readonly CalendarControlsPiece[]) => React.ReactNode;
  /** The source menu and full settings share the same visibility actions. */
  presentation?: 'settings' | 'sources-menu';
  sources: CalendarControlSource[];
  hidden: string[];
  onHiddenChange: (hidden: string[]) => void;
  preferences: CalendarControlPreferences;
  onPreferencesChange: (preferences: CalendarControlPreferences) => void;
  words: CalendarControlsWords;
  colorOptions?: CalendarControlColor[];
  /** Caller DATA defines the available zoom choices; no product presets live here. */
  hourHeightOptions?: CalendarControlZoomOption[];
  /** Caller DATA: the clock and date-order choices, and the kinds and menubar treatments a calendar can have. */
  timeFormats?: CalendarControlTimeFormat[];
  dateFormats?: CalendarControlDateFormat[];
  calendarTypes?: CalendarControlChoice[];
  menubarChoices?: CalendarControlChoice[];
  navigation?: CalendarControlNavigationItem[];
  /** People whose busy times can be shown on the calendar (the focused space's members), and the choice to show one. */
  people?: CalendarControlPerson[];
  onPersonShownChange?: (id: string, shown: boolean) => void;
  /** Connects the person's own calendar for the focused space; offered in the people section only while theirs is not. */
  onConnectYours?: () => void;
  onNewTask?: () => void;
  onTaskInbox?: () => void;
  onAddAccount?: () => void;
  onSourceConnect?: (sourceId: string) => void;
  onNavigate?: (id: string) => void;
  /** Starts a booking link from one preferred-times schedule. */
  onCreateBookingLink?: (schedule: WeeklyAvailabilitySchedule) => void;
  className?: string;
  accounts?: CalendarAccount[];
  selections?: CalendarSelection[] | null;
  onSelectionsChange?: (selections: CalendarSelection[]) => void;
  connectionsBusy?: boolean;
  connectionsError?: string | null;
}

const localTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
};

const timeOptions = Array.from({ length: 48 }, (_, index) => {
  const minutes = index * 30;
  const value = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { value, label: new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) };
});

const weekdays = Array.from({ length: 7 }, (_, value) => ({
  value,
  label: new Date(2024, 0, 7 + value).toLocaleDateString(undefined, { weekday: 'long' }),
}));

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const minutesOf = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
};

/** A nickname box that keeps what is typed until the person leaves it or presses Enter, so one save is not made per key. */
function NicknameField({ value, label, placeholder, onSave }: { value: string; label: string; placeholder: string; onSave: (nickname: string) => void }): React.ReactElement {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => { const next = draft.trim(); if (next !== value) onSave(next); else setDraft(value); };
  return <Input size="sm" className="w-32" aria-label={label} placeholder={placeholder} value={draft}
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); }} />;
}

/** Controlled calendar visibility and work-time controls. All words, records and actions come from the caller. */
export function CalendarControls({
  sources, hidden, onHiddenChange, preferences, onPreferencesChange, words, navigation = [],
  people = [], onPersonShownChange, onConnectYours, onNewTask, onTaskInbox, onAddAccount, onSourceConnect, onNavigate, onCreateBookingLink, className, accounts, colorOptions = [],
  selections, onSelectionsChange, connectionsBusy, connectionsError,
  hourHeightOptions = [], presentation = 'settings', renderPieces,
  timeFormats = [], dateFormats = [], calendarTypes = [], menubarChoices = [],
}: CalendarControlsProps): React.ReactElement {
  const zone = localTimeZone();
  const eventDurationMin = words.defaultEventDurationMin ?? 1;
  const eventDurationMax = words.defaultEventDurationMax ?? 1440;
  const eventDurationStep = words.defaultEventDurationStep ?? 1;
  const hiddenSet = new Set(hidden);
  const legacyDefault = (accounts ?? []).flatMap(account => account.calendars.filter(calendar => calendar.primary).map(calendar => ({
    ...(account.source_id ? { source_id: account.source_id } : {}),
    connection_id: account.connection_id, connected_at: account.connected_at, calendar_id: calendar.id,
  })))[0];
  const unavailableSelections = (selections ?? []).filter(selection => {
    const account = accounts?.find(row => row.connection_id === selection.connection_id && (!selection.source_id || row.source_id === selection.source_id));
    return !account || (selection.connected_at && selection.connected_at !== account.connected_at) || !account.calendars.some(calendar => calendar.id === selection.calendar_id);
  });
  const colors = new Map(colorOptions.map(option => [option.id, option]));
  // Every current calendar is offered in the default picker; one that cannot take a new event is shown, disabled.
  const listedChoices = sources.filter(source => {
    const selection = source.selection;
    if (!(source.connected === true && selection?.source_id && selection.connection_id && selection.connected_at && selection.calendar_id)) return false;
    if (!accounts) return true;
    const account = accounts.find(row => row.source_id === selection.source_id && row.connection_id === selection.connection_id);
    return account?.connected_at === selection.connected_at && account.calendars.some(calendar => calendar.id === selection.calendar_id);
  });
  const canTakeEvents = (source: CalendarControlSource) => {
    const selection = source.selection!;
    if (!(source.writable === true && source.canCreate === true)) return false;
    if (!accounts) return true;
    const account = accounts.find(row => row.source_id === selection.source_id && row.connection_id === selection.connection_id);
    return Boolean(account?.calendars.some(calendar => calendar.id === selection.calendar_id && calendar.writable === true));
  };
  const defaultChoices = listedChoices.filter(canTakeEvents);
  const configuredDefault = preferences.defaultCalendar && defaultChoices.find(source => {
    const selection = source.selection!;
    return selection.connection_id === preferences.defaultCalendar?.connection_id
      && selection.source_id === preferences.defaultCalendar?.source_id
      && selection.calendar_id === preferences.defaultCalendar?.calendar_id
      && selection.connected_at === preferences.defaultCalendar?.connected_at;
  });
  const defaultGroups = groupSourcesByAccount(listedChoices, accounts, source => !canTakeEvents(source));
  const defaultColor = (source: CalendarControlSource) => preferences.sourceColors?.[source.id] ?? source.colorTone;
  const selectedDefault = configuredDefault || defaultChoices[0];
  const workSchedules = preferences.workSchedules ?? [];
  const activeWorkSchedule = workSchedules.some(schedule => schedule.id === preferences.workScheduleId);
  const legacyStart = minutesOf(preferences.workStart);
  const legacyEnd = minutesOf(preferences.workEnd);
  const initialDays: WeeklyAvailabilityDay[] = weekdays.map(day => ({
    weekday: day.value,
    intervals: preferences.workdays.includes(day.value) && legacyStart !== null && legacyEnd !== null && legacyEnd > legacyStart
      ? [{ start_minute: legacyStart, end_minute: legacyEnd }]
      : [],
  }));

  const zoomChoice = hourHeightOptions.find(option => option.value === (preferences.hourHeightPx ?? hourHeightOptions[0]?.value));
  const example = new Date();
  const exampleDay = `${example.getFullYear()}-${String(example.getMonth() + 1).padStart(2, '0')}-${String(example.getDate()).padStart(2, '0')}`;
  const chosenTime = timeFormats.find(option => option.id === preferences.timeFormat);
  const chosenDate = dateFormats.find(option => option.id === preferences.dateFormat);
  const deviceZone = zone;
  const keptZones = preferences.timeZones ?? [];
  const setZones = (timeZones: CalendarControlTimeZone[]) => onPreferencesChange({ ...preferences, timeZones });
  const zoneChoices = React.useMemo(() => knownZones(), []);

  const setSourceVisible = (id: string, visible: boolean) => {
    const next = new Set(hiddenSet);
    if (visible) next.delete(id); else next.add(id);
    onHiddenChange([...next]);
  };

  const sourceControls = <Container layout="vertical" gap="sm">
      <Text variant="label">{words.sources}</Text>
      {sources.map(source => <Container key={source.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Container layout="vertical" gap="none" className="min-w-0 flex-1">
          <Container layout="horizontal" gap="xs" alignItems="center">
            {source.colorTone ? <ColorDot tone={source.colorTone} size="lg" /> : null}
            <Text variant="body" truncate>{source.label}</Text>
          </Container>
          <Text variant="caption" color={source.read ? 'muted' : 'error'}>
            {!source.connected ? words.notConnected : source.read ? words.connected : source.said || words.unavailable}
          </Text>
        </Container>
        <Container layout="horizontal" gap="sm" alignItems="center">
          {source.connectLabel && !source.connected ? <Button size="xs" variant="outline" onClick={() => onSourceConnect?.(source.id)}>{source.connectLabel}</Button> : null}
          <Switch checked={!hiddenSet.has(source.id)} disabled={!source.connected} label={fill(words.showSource, { source: source.label })}
            onCheckedChange={visible => setSourceVisible(source.id, visible)} size="sm" />
        </Container>
      </Container>)}
      {people.length || onConnectYours ? <Container layout="vertical" gap="sm" data-calendar-people="">
        <Text variant="label">{words.people}</Text>
        {words.peopleHelp ? <Text variant="caption" color="muted">{words.peopleHelp}</Text> : null}
        {onConnectYours ? <Button size="xs" variant="primary" onClick={onConnectYours}>{words.connectYours}</Button> : null}
        {people.map(person => <Container key={person.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
          <Container layout="vertical" gap="none" className="min-w-0 flex-1">
            <Container layout="horizontal" gap="xs" alignItems="center">
              <ColorDot tone={person.tone} size="lg" />
              <Text variant="body" truncate>{person.label}</Text>
              {person.shortcut ? <Kbd size="sm">{person.shortcut}</Kbd> : null}
            </Container>
            {person.note ? <Text variant="caption" color="muted">{person.note}</Text> : null}
          </Container>
          <Switch checked={person.shown} disabled={!person.available} size="sm" label={fill(words.showPerson ?? '{person}', { person: person.label })}
            onCheckedChange={shown => onPersonShownChange?.(person.id, shown)} />
        </Container>)}
      </Container> : null}
    </Container>;
  if (presentation === 'sources-menu') {
    const visibleSources = sources.filter(source => source.connected && source.read && !hiddenSet.has(source.id));
    const countName = words.sourceCountNames?.[new Intl.PluralRules().select(visibleSources.length)] ?? words.sources;
    return <Popover>
      <PopoverTrigger render={<Button size="xs" variant="outline" className="calendar-sources-trigger" aria-label={words.sources} data-calendar-sources-trigger="" />}>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Container layout="horizontal" gap="none" className="calendar-sources-colors" aria-hidden="true">
            {visibleSources.filter(source => source.colorTone).slice(0, 7).map(source => <ColorDot key={source.id} tone={source.colorTone!} size="lg" />)}
          </Container>
          <Text variant="caption">{visibleSources.length}</Text>
          <Text variant="caption" className="calendar-sources-name">{countName}</Text>
        </Container>
      </PopoverTrigger>
      <PopoverPopup align="end" className="calendar-sources-popup" portalProps={{ className: 'coss-ui' }}>
        <Container layout="vertical" gap="sm" padding="sm">{sourceControls}</Container>
      </PopoverPopup>
    </Popover>;
  }

  const pieces: CalendarControlsPiece[] = [
    { id: 'heading', label: words.title, content: (<Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="heading-xs">{words.title}</Text>
      <Container layout="horizontal" gap="xs" alignItems="center" wrap>
        {onNewTask ? <Button size="sm" variant="primary" onClick={onNewTask}>{words.newTask}</Button> : null}
        {onTaskInbox ? <Button size="sm" variant="outline" onClick={onTaskInbox}>{words.taskInbox}</Button> : null}
      </Container>
    </Container>) },
    { id: 'accounts', label: words.accounts, content: (<Container layout="vertical" gap="sm">
      <Text variant="label">{words.accounts}</Text>
      {words.calendarTable ? <Text variant="caption" color="muted">{words.calendarTable.help}</Text> : null}
      {connectionsBusy ? <Text variant="caption">{words.loadingAccounts}</Text> : null}
      {connectionsError ? <Text variant="body-sm" color="error">{connectionsError}</Text> : null}
      {accounts?.map(account => <Container key={`${account.source_id ?? ''}:${account.connection_id}`} layout="vertical" gap="xs">
        <Text variant="body" weight="semibold">{account.account_label}</Text>
        {account.said ? <Text variant="caption" color="error">{account.said}</Text> : null}
        <Table className="calendar-control-table" data-calendar-table="">
          {words.calendarTable ? <TableHeader><TableRow>
            <TableHead>{words.calendarTable.calendar}</TableHead>
            <TableHead>{words.calendarTable.color}</TableHead>
            {calendarTypes.length ? <TableHead>{words.calendarTable.type}</TableHead> : null}
            {menubarChoices.length ? <TableHead>{words.calendarTable.menubar}</TableHead> : null}
          </TableRow></TableHeader> : null}
          <TableBody>{account.calendars.map(calendar => {
            const accessLabel = calendar.read_mode === 'busy' ? words.busyTimesOnly : calendar.writable === false ? words.readOnly : '';
            const savedColor = calendar.color_key ? preferences.sourceColors?.[calendar.color_key] : undefined;
            const colorId = colors.has(savedColor ?? '') ? savedColor! : colors.has(calendar.color_tone ?? '') ? calendar.color_tone! : colorOptions[0]?.id;
            const kind = calendar.color_key ? preferences.calendarTypes?.[calendar.color_key] ?? calendarTypes[0]?.id : undefined;
            const menubar = calendar.color_key ? preferences.menubar?.[calendar.color_key] ?? menubarChoices[0]?.id : undefined;
            const choose = (field: 'calendarTypes' | 'menubar') => (value: unknown) => {
              if (typeof value !== 'string' || !calendar.color_key) return;
              onPreferencesChange({ ...preferences, [field]: { ...preferences[field], [calendar.color_key]: value } });
            };
            const label = accessLabel ? `${calendar.summary} · ${accessLabel}` : calendar.summary;
            return <TableRow key={calendar.id}>
              <TableCell>
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Checkbox aria-label={label} disabled={connectionsBusy}
                    checked={selections == null ? legacyDefault?.connection_id === account.connection_id && legacyDefault.source_id === account.source_id && legacyDefault.calendar_id === calendar.id : selections.some(row => row.connection_id === account.connection_id && row.calendar_id === calendar.id && (!row.source_id || row.source_id === account.source_id))}
                    onCheckedChange={checked => {
                      const current = selections ?? (legacyDefault ? [legacyDefault] : []);
                      const kept = current.filter(row => row.connection_id !== account.connection_id || row.calendar_id !== calendar.id || Boolean(row.source_id && row.source_id !== account.source_id));
                      onSelectionsChange?.(checked ? [...kept, { ...(account.source_id ? { source_id: account.source_id } : {}), connection_id: account.connection_id, connected_at: account.connected_at, calendar_id: calendar.id }] : kept);
                    }} />
                  <Container layout="vertical" gap="none" className="min-w-0 flex-1">
                    <Text variant="body-sm">{calendar.summary}</Text>
                    {accessLabel ? <Text variant="caption" color="muted">{accessLabel}</Text> : null}
                  </Container>
                </Container>
              </TableCell>
              <TableCell>{calendar.color_key && colorId ? <Select value={colorId} onValueChange={value => {
                if (typeof value !== 'string' || !colors.has(value)) return;
                onPreferencesChange({ ...preferences, sourceColors: { ...preferences.sourceColors, [calendar.color_key!]: value } });
              }}>
                <SelectTrigger className="w-28" aria-label={fill(words.calendarColor, { calendar: calendar.summary })}>
                  <ColorDot tone={colorId} size="md" />
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>{colorOptions.map(option => <SelectItem key={option.id} value={option.id}>
                  <Container layout="horizontal" gap="xs" alignItems="center"><ColorDot tone={option.id} size="md" /><Text variant="body-sm">{option.label}</Text></Container>
                </SelectItem>)}</SelectPopup>
              </Select> : null}</TableCell>
              {calendarTypes.length ? <TableCell>{kind ? <Select items={calendarTypes.map(row => ({ value: row.id, label: row.label }))} value={kind} onValueChange={choose('calendarTypes')}>
                <SelectTrigger className="w-32" aria-label={`${words.calendarTable?.type ?? ''} ${calendar.summary}`.trim()}><SelectValue /></SelectTrigger>
                <SelectPopup>{calendarTypes.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
              </Select> : null}</TableCell> : null}
              {menubarChoices.length ? <TableCell>{menubar ? <Select items={menubarChoices.map(row => ({ value: row.id, label: row.label }))} value={menubar} onValueChange={choose('menubar')}>
                <SelectTrigger className="w-32" aria-label={`${words.calendarTable?.menubar ?? ''} ${calendar.summary}`.trim()}><SelectValue /></SelectTrigger>
                <SelectPopup>{menubarChoices.map(row => <SelectItem key={row.id} value={row.id}>{row.label}</SelectItem>)}</SelectPopup>
              </Select> : null}</TableCell> : null}
            </TableRow>;
          })}</TableBody>
        </Table>
      </Container>)}
      {unavailableSelections.map(selection => {
        const account = accounts?.find(row => row.connection_id === selection.connection_id && (!selection.source_id || row.source_id === selection.source_id));
        const calendar = account?.calendars.find(row => row.id === selection.calendar_id);
        return <Container key={`${selection.source_id ?? ''}:${selection.connection_id}:${selection.calendar_id}`} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
          <Text variant="caption" color="muted">{fill(words.unavailableSelection, { calendar: calendar?.summary ?? selection.calendar_id, account: account?.account_label ?? selection.source_id ?? selection.connection_id })}</Text>
          <Button size="xs" variant="ghost" disabled={connectionsBusy} onClick={() => onSelectionsChange?.((selections ?? []).filter(row => row.connection_id !== selection.connection_id || row.calendar_id !== selection.calendar_id || row.source_id !== selection.source_id))}>{words.remove}</Button>
        </Container>;
      })}
      {onAddAccount ? <Button size="sm" variant="outline" onClick={onAddAccount}>{words.addAccount}</Button> : null}
    </Container>) },
    { id: 'sources', label: words.sources, content: (sourceControls) },
    { id: 'preferences-title', label: words.preferences, content: (<Text variant="label">{words.preferences}</Text>) },
    { id: 'default-calendar', label: words.defaultCalendar, content: (<Container layout="vertical" gap="xs">
        <Text variant="body">{words.defaultCalendar}</Text>
        <Text variant="caption" color="muted">{words.defaultCalendarHelp}</Text>
        <Select value={selectedDefault?.id ?? ''} disabled={connectionsBusy || !defaultChoices.length} onValueChange={value => {
          if (typeof value !== 'string') return;
          const chosen = defaultChoices.find(source => source.id === value);
          if (chosen) onPreferencesChange({ ...preferences, defaultCalendar: chosen.selection });
        }}>
          <SelectTrigger aria-label={words.defaultCalendar}>
            <SelectValue placeholder={defaultChoices.length ? words.chooseDefaultCalendar : words.noWritableCalendar}>
              {selectedDefault ? <Container layout="horizontal" gap="xs" alignItems="center">
                {defaultColor(selectedDefault) ? <ColorDot tone={defaultColor(selectedDefault)!} /> : null}
                <Text variant="body" truncate>{selectedDefault.label}</Text>
              </Container> : null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>{[...defaultGroups].map(([key, group]) => <SelectGroup key={key}>
            {group.label ? <SelectGroupLabel>{group.label}</SelectGroupLabel> : null}
            {group.choices.map(({ source, label, disabled }) => <SelectItem key={source.id} value={source.id} aria-label={source.label} disabled={disabled}>
              <Container layout="horizontal" gap="xs" alignItems="center">
                {defaultColor(source) ? <ColorDot tone={defaultColor(source)!} /> : null}
                <Text variant="body" truncate>{label}</Text>
                {disabled ? <Text variant="caption" color="muted">{words.readOnly}</Text> : null}
              </Container>
            </SelectItem>)}
          </SelectGroup>)}</SelectPopup>
        </Select>
      </Container>) },
    { id: 'workdays', label: words.workdays, content: (!activeWorkSchedule ? <Container layout="vertical" gap="xs">
        <Text variant="body">{words.workdays}</Text>
        <Container layout="horizontal" gap="sm" wrap>
          {weekdays.map(day => <Container key={day.value} layout="horizontal" gap="xs" alignItems="center">
            <Text variant="caption">{day.label}</Text>
            <Switch size="sm" label={day.label} checked={preferences.workdays.includes(day.value)} onCheckedChange={checked => {
            const selected = new Set(preferences.workdays);
            if (checked) selected.add(day.value); else selected.delete(day.value);
            onPreferencesChange({ ...preferences, workdays: [...selected].sort() });
          }} />
          </Container>)}
        </Container>
      </Container> : null) },
    { id: 'week-start', label: words.weekStart, content: (<Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="body">{words.weekStart}</Text>
        <Select items={weekdays.map(day => ({ value: day.value, label: day.label }))} value={preferences.weekStart} onValueChange={value => { if (typeof value === 'number') onPreferencesChange({ ...preferences, weekStart: value }); }}>
          <SelectTrigger aria-label={words.weekStart} className="w-44"><SelectValue /></SelectTrigger>
          <SelectPopup>{weekdays.map(day => <SelectItem key={day.value} value={day.value}>{day.label}</SelectItem>)}</SelectPopup>
        </Select>
        {words.startWeekToday ? <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" className="w-full">
          <Text variant="body">{words.startWeekToday}</Text>
          <Switch size="sm" label={words.startWeekToday} checked={preferences.startWeekToday === true}
            onCheckedChange={value => onPreferencesChange({ ...preferences, startWeekToday: value })} />
        </Container> : null}
      </Container>) },
    { id: 'zoom', label: words.calendarZoom ?? words.preferences, content: (words.calendarZoom && hourHeightOptions.length ? <Container layout="vertical" gap="xs" data-calendar-zoom="">
        <Text variant="body">{words.calendarZoom}</Text>
        {words.calendarZoomHelp ? <Text variant="caption" color="muted">{words.calendarZoomHelp}</Text> : null}
        <ChoiceTiles kind="radio" label={words.calendarZoom} chosen={zoomChoice ? String(zoomChoice.value) : null}
          tiles={hourHeightOptions.map(option => ({ id: String(option.value), label: option.label, description: option.description }))}
          onPick={tile => { const value = Number(tile.id); if (hourHeightOptions.some(option => option.value === value)) onPreferencesChange({ ...preferences, hourHeightPx: value }); }} />
        {!zoomChoice && words.zoomCustom ? <Text variant="caption" color="muted">{words.zoomCustom}</Text> : null}
        {words.zoomTip ? <Text variant="caption" color="muted">{words.zoomTip}</Text> : null}
      </Container> : null) },
    { id: 'event-duration', label: words.defaultEventDuration ?? words.preferences, content: (words.defaultEventDuration ? <EventDurationField
        label={words.defaultEventDuration}
        unit={words.defaultEventDurationUnit}
        min={eventDurationMin}
        max={eventDurationMax}
        step={eventDurationStep}
        help={words.defaultEventDurationHelp}
        saved={preferences.defaultEventDurationMinutes}
        onSave={minutes => onPreferencesChange({ ...preferences, defaultEventDurationMinutes: minutes })}
      /> : null) },
    { id: 'work-hours', label: words.workHours, content: (!activeWorkSchedule ? <Container layout="vertical" gap="xs">
        <Text variant="body">{words.workHours}</Text>
        <Container layout="horizontal" gap="sm" alignItems="center" wrap>
          <Container layout="vertical" gap="xs" className="min-w-32 flex-1">
            <Text variant="caption" color="muted">{words.workStart}</Text>
            <Select items={timeOptions} value={preferences.workStart} onValueChange={value => { if (typeof value === 'string') onPreferencesChange({ ...preferences, workStart: value }); }}>
              <SelectTrigger aria-label={words.workStart}><SelectValue /></SelectTrigger>
              <SelectPopup>{timeOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
            </Select>
          </Container>
          <Container layout="vertical" gap="xs" className="min-w-32 flex-1">
            <Text variant="caption" color="muted">{words.workEnd}</Text>
            <Select items={timeOptions} value={preferences.workEnd} onValueChange={value => { if (typeof value === 'string') onPreferencesChange({ ...preferences, workEnd: value }); }}>
              <SelectTrigger aria-label={words.workEnd}><SelectValue /></SelectTrigger>
              <SelectPopup>{timeOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
            </Select>
          </Container>
        </Container>
      </Container> : null) },
    { id: 'work-schedules', label: words.workSchedules?.title ?? words.workHours, content: (words.workSchedules ? <WeeklyAvailability
        schedules={workSchedules}
        workScheduleId={preferences.workScheduleId ?? null}
        initialDays={initialDays}
        words={words.workSchedules}
        weekStartsOn={preferences.weekStart}
        onCreateBookingLink={onCreateBookingLink}
        onSave={(nextSchedules, workScheduleId) => onPreferencesChange({ ...preferences, workSchedules: nextSchedules, workScheduleId })}
      /> : null) },
    { id: 'weekends', label: words.weekends, content: (<Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="body">{words.weekends}</Text>
        <Switch checked={preferences.weekends} label={words.weekends} onCheckedChange={weekends => onPreferencesChange({ ...preferences, weekends })} size="sm" />
      </Container>) },
    { id: 'timezone', label: words.timeZones?.title ?? words.timezone, content: (words.timeZones ? <Container layout="vertical" gap="xs" data-calendar-time-zones="">
        <Text variant="body">{words.timeZones.title}</Text>
        <Text variant="caption" color="muted">{words.timeZones.help}</Text>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Text variant="caption" color="muted">{words.timeZones.thisDevice}</Text>
          <Text variant="caption">{deviceZone}</Text>
        </Container>
        {keptZones.length ? <SortableRows items={keptZones} getId={row => row.id} className="calendar-time-zone-rows"
          onReorder={(order) => setZones(order.map(id => keptZones.find(row => row.id === id)!))}
          renderItem={row => <Container layout="horizontal" gap="xs" alignItems="center" className="calendar-time-zone-row">
            <Button data-reorder-handle="" size="icon-xs" variant="ghost" aria-label={fill(words.timeZones!.reorder, { zone: row.nickname || zoneCity(row.zone) })}><GripVertical aria-hidden="true" /></Button>
            <Select items={[...zoneChoices, ...(zoneChoices.includes(row.zone) ? [] : [row.zone])].map(value => ({ value, label: zoneCity(value) }))} value={row.zone}
              onValueChange={value => { if (typeof value === 'string') setZones(keptZones.map(kept => kept.id === row.id ? { ...kept, zone: value } : kept)); }}>
              <SelectTrigger className="w-44" aria-label={words.timeZones!.zone}><SelectValue /></SelectTrigger>
              <SelectPopup>{[...zoneChoices, ...(zoneChoices.includes(row.zone) ? [] : [row.zone])].map(value => <SelectItem key={value} value={value}>{zoneCity(value)}</SelectItem>)}</SelectPopup>
            </Select>
            <NicknameField value={row.nickname} label={words.timeZones!.nickname} placeholder={words.timeZones!.nicknamePlaceholder}
              onSave={nickname => setZones(keptZones.map(kept => kept.id === row.id ? { ...kept, nickname } : kept))} />
            <Button size="icon-xs" variant="ghost" aria-label={fill(words.timeZones!.remove, { zone: row.nickname || zoneCity(row.zone) })}
              onClick={() => setZones(keptZones.filter(kept => kept.id !== row.id))}><X aria-hidden="true" /></Button>
          </Container>} /> : null}
        {keptZones.length < words.timeZones.max ? <Select items={zoneChoices.map(value => ({ value, label: zoneCity(value) }))} value={null}
          onValueChange={value => { if (typeof value === 'string') setZones([...keptZones, { id: crypto.randomUUID(), zone: value, nickname: zoneCity(value) }]); }}>
          <SelectTrigger className="w-60" aria-label={words.timeZones.add}><SelectValue placeholder={words.timeZones.chooseZone} /></SelectTrigger>
          <SelectPopup>{zoneChoices.map(value => <SelectItem key={value} value={value}>{zoneCity(value)}</SelectItem>)}</SelectPopup>
        </Select> : null}
      </Container> : <Container layout="vertical" gap="none">
        <Text variant="caption" color="muted">{words.timezone}</Text>
        <Text variant="body">{zone}</Text>
      </Container>) },
    { id: 'time-format', label: words.timeFormat ?? words.preferences, content: (words.timeFormat && timeFormats.length ? <Container layout="vertical" gap="xs" data-calendar-time-format="">
        <Text variant="body">{words.timeFormat}</Text>
        {words.timeFormatHelp ? <Text variant="caption" color="muted">{words.timeFormatHelp}</Text> : null}
        <ChoiceTiles kind="radio" label={words.timeFormat} chosen={chosenTime?.id ?? null}
          tiles={timeFormats.map(option => ({ id: option.id, label: option.label, description: makeFormat({ hour12: option.hour12 }).minutes(example.getHours() * 60 + example.getMinutes()) }))}
          onPick={tile => onPreferencesChange({ ...preferences, timeFormat: tile.id })} />
      </Container> : null) },
    { id: 'date-format', label: words.dateFormat ?? words.preferences, content: (words.dateFormat && dateFormats.length ? <Container layout="vertical" gap="xs" data-calendar-date-format="">
        <Text variant="body">{words.dateFormat}</Text>
        {words.dateFormatHelp ? <Text variant="caption" color="muted">{words.dateFormatHelp}</Text> : null}
        <ChoiceTiles kind="radio" label={words.dateFormat} chosen={chosenDate?.id ?? null}
          tiles={dateFormats.map(option => ({ id: option.id, label: option.label, description: makeFormat({ dateLocale: option.locale }).numericDay(exampleDay) }))}
          onPick={tile => onPreferencesChange({ ...preferences, dateFormat: tile.id })} />
      </Container> : null) },
    { id: 'display', label: words.display?.title ?? words.preferences, content: (words.display ? <Container layout="vertical" gap="sm" data-calendar-display="">
        {([['eventCheckboxes', words.display.eventCheckboxes, preferences.eventCheckboxes === true], ['privateByDefault', words.display.privateByDefault, preferences.privateByDefault === true]] as const).map(([field, row, checked]) =>
          <Container key={field} layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Container layout="vertical" gap="none" className="min-w-0 flex-1">
              <Text variant="body">{row.title}</Text>
              <Text variant="caption" color="muted">{row.help}</Text>
            </Container>
            <Switch size="sm" label={row.title} checked={checked} onCheckedChange={value => onPreferencesChange({ ...preferences, [field]: value })} />
          </Container>)}
      </Container> : null) },
    { id: 'navigation', label: words.title, content: (<Container layout="horizontal" gap="xs" wrap>
      {navigation.map(item => <Button key={item.id} size="xs" variant="ghost" onClick={() => onNavigate?.(item.id)}>{item.label}</Button>)}
    </Container>) },
  ];
  const render = (id: string) => pieces.find(piece => piece.id === id)?.content;
  return <Container data-calendar-controls layout="vertical" gap="md" padding="md" minHeight={renderPieces ? '0' : undefined} className={className}>
    {renderPieces ? renderPieces(pieces) : <>
      {render('heading')}{render('accounts')}{render('sources')}
      <Container layout="vertical" gap="sm">
        {render('preferences-title')}{render('default-calendar')}{render('workdays')}{render('week-start')}{render('zoom')}{render('time-format')}{render('date-format')}{render('event-duration')}{render('display')}{render('work-hours')}{render('work-schedules')}{render('weekends')}{render('timezone')}
      </Container>
      {render('navigation')}
    </>}
  </Container>;
}
