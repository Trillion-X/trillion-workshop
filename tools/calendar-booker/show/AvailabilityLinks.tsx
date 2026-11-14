import * as React from 'react';
import { Button, Container, errorWords, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text, WeeklyAvailability,
  type CalendarAccount, type CalendarControlPreferences, type WeeklyAvailabilityDay, type WeeklyAvailabilitySchedule, type WeeklyAvailabilityWords } from '../../ui';
import { zonedWallClockToUtcMs } from 'trillion-workshop/tools/booking-slots-and-invitations/do-work/derive-open-slots.ts';
import { ArrangedContents } from '../../screen-arrangement/show/ArrangedContents';
import words from '../read-data/availability-link-screen.json';

export type CalendarIdentity = { source_id: string; connection_id: string; connected_at: string; calendar_id: string; access_role?: string };
type Cohost = { calendar: CalendarIdentity; email: string; private_contact?: string; weight?: number };
type OneOffSlot = { start_ms: number; end_ms: number };
export type AvailabilityLink = {
  id: string; state: 'active' | 'revoked' | 'deleted'; revision: number; title: string; calendar: CalendarIdentity;
  description?: string | null; location?: string | null; alias?: string | null; cohosts?: Cohost[]; timezone: string;
  windows: { weekday: number; start: string; end: string }[]; duration_min: number; step_min: number;
  buffer_before_min?: number; buffer_after_min?: number; min_notice_min?: number; horizon_days?: number;
  seats_per_slot?: number | null; host_mode?: string; host_weight?: number; requires_confirmation?: boolean; pending_blocks_slot?: boolean;
  expires_at?: string | null; one_off_slots?: OneOffSlot[]; preferred_times_snapshot?: unknown; repeat: boolean; created_at?: string; updated_at?: string;
};
export type Draft = Omit<AvailabilityLink, 'id' | 'state' | 'revision' | 'created_at' | 'updated_at' | 'calendar'> & { calendar: CalendarIdentity | null };
export type AvailabilityLinkDraftState = { draft?: Draft | null; editor?: {id:string|null;revision:number|null}|null; preferredId?:string; oneOffDate?:string; oneOffTime?:string; requestKeys?:Map<string,{payload:string;key:string}> };
export type AvailabilityLinkAction = 'create' | 'edit' | 'revoke' | 'restore' | 'delete' | 'reservation:list' | 'reservation:confirm' | 'reservation:decline';
type Request = { id: string; start_ms: number; end_ms: number; recipient?: { name?: string; email?: string } };
type SourceDetail = { id: string; label?: string; connected?: boolean; writable?: boolean; selection?: Partial<CalendarIdentity> };
export interface AvailabilityLinksProps {
  retainedDraft?: AvailabilityLinkDraftState;
  subscribeChanges?: (listener:()=>void)=>()=>void;
  accounts: CalendarAccount[];
  preferences: CalendarControlPreferences;
  sources: SourceDetail[];
  connectionsBusy?: boolean;
  connectionsError?: string | null;
  onRefreshCalendars: () => void;
  listLinks: (after?: string) => Promise<{ links: AvailabilityLink[]; next_cursor?: string | null }>;
  readLink: (id: string) => Promise<AvailabilityLink>;
  readOffers: (id: string) => Promise<{link: {timezone: string}; slots: {startMs: number; endMs: number}[]}>;
  mutate: (action: AvailabilityLinkAction, input: Record<string, unknown>, requestKey: string) => Promise<AvailabilityLink | unknown>;
  onShare: (id: string, title: string, anchor: Element | null, preferredAddress?: string | null) => void;
  /** A preferred-times schedule to start a new link from. A new nonce starts another draft from the same schedule. */
  startFrom?: { schedule: WeeklyAvailabilitySchedule; nonce: number } | null;
  onCopy: (value: string) => Promise<boolean>;
}

/** The request key for one change: the same payload under the same signature keeps its key, so a retry is the same request. */
export function reuseRequestKey(keys: Map<string, { payload: string; key: string }>, signature: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  const previous = keys.get(signature);
  if (previous?.payload === serialized) return previous.key;
  const key = crypto.randomUUID();
  keys.set(signature, { payload: serialized, key });
  return key;
}

const identityKey = (selection: CalendarIdentity) => JSON.stringify([selection.source_id, selection.connection_id, selection.connected_at, selection.calendar_id]);
const sameIdentity = (left: Partial<CalendarIdentity> | null | undefined, right: Partial<CalendarIdentity> | null | undefined) => Boolean(left && right
  && left.source_id === right.source_id && left.connection_id === right.connection_id
  && left.connected_at === right.connected_at && left.calendar_id === right.calendar_id);
const asClock = (value: number) => value === 1440 ? '24:00' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const clockMinutes = (value: string) => value === '24:00' ? 1440 : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const scheduleFrom = (id: string, label: string, windows: Draft['windows']): WeeklyAvailabilitySchedule => {
  const byDay = new Map<number, WeeklyAvailabilityDay['intervals']>();
  for (const window of windows ?? []) {
    const intervals = byDay.get(window.weekday) ?? [];
    intervals.push({ start_minute: clockMinutes(window.start), end_minute: clockMinutes(window.end) });
    byDay.set(window.weekday, intervals);
  }
  return { id, label, days: [...byDay].map(([weekday, intervals]) => ({ weekday, intervals: intervals.sort((a, b) => a.start_minute - b.start_minute) })) };
};
const windowsFrom = (schedule: WeeklyAvailabilitySchedule) => schedule.days.flatMap(day => day.intervals.map(interval => ({
  weekday: day.weekday, start: asClock(interval.start_minute), end: asClock(interval.end_minute),
})));
export const emptyDraft = (calendar: CalendarIdentity | null, timezone: string): Draft => ({
  title: '', calendar, timezone, windows: [], duration_min: 30, step_min: 30,
  repeat: true, cohosts: [], one_off_slots: [], buffer_before_min: 0, buffer_after_min: 0, min_notice_min: 0, horizon_days: 60,
  seats_per_slot: null, host_mode: 'everyone', host_weight: 1, requires_confirmation: false, pending_blocks_slot: false,
});
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
// One-off selection uses the same DST-safe admission as Calendar planning.
const localTimeInZone = (date: string, time: string, timezone: string) =>
  zonedWallClockToUtcMs(date, clockMinutes(time), timezone);

export function defaultCalendar(accounts: CalendarAccount[], preferences: CalendarControlPreferences): CalendarIdentity | null {
  const preferred = preferences.defaultCalendar;
  if (!preferred?.source_id || !preferred.connected_at) return null;
  const account = accounts.find(row => row.source_id === preferred.source_id && row.connection_id === preferred.connection_id
    && row.connected_at === preferred.connected_at);
  const calendar = account?.calendars.find(row => row.id === preferred.calendar_id && row.writable === true);
  return account && calendar ? { source_id: account.source_id!, connection_id: account.connection_id, connected_at: account.connected_at,
    calendar_id: calendar.id, ...(calendar.access_role ? { access_role: calendar.access_role } : {}) } : null;
}

export function AvailabilityLinks({ accounts, preferences, sources, connectionsBusy = false, connectionsError, onRefreshCalendars,
  listLinks, readLink, readOffers, mutate, onShare, onCopy, retainedDraft, subscribeChanges, startFrom }: AvailabilityLinksProps): React.ReactElement {
  const localDraft=React.useRef<AvailabilityLinkDraftState>({});
  const retained=retainedDraft??localDraft.current;
  const loadGeneration=React.useRef(0),detailGeneration=React.useRef(0);
  const [links, setLinks] = React.useState<AvailabilityLink[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const [editor, setEditor] = React.useState<{ id: string | null; revision: number | null } | null>(()=>retained.editor??null);
  const [draft, setDraft] = React.useState<Draft | null>(()=>retained.draft??null);
  const [detail, setDetail] = React.useState<AvailabilityLink | null>(null);
  const [requests, setRequests] = React.useState<Request[] | null>(null);
  const [requestsError, setRequestsError] = React.useState('');
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [preferredId, setPreferredId] = React.useState(retained.preferredId??preferences.workScheduleId??'');
  const [oneOffDate, setOneOffDate] = React.useState(retained.oneOffDate??'');
  const [oneOffTime, setOneOffTime] = React.useState(retained.oneOffTime??'');
  const requestKeys = React.useRef(retained.requestKeys??new Map<string, { payload: string; key: string }>());
  const listLinksRef = React.useRef(listLinks);
  listLinksRef.current = listLinks;
  React.useLayoutEffect(()=>{Object.assign(retained,{draft,editor,preferredId,oneOffDate,oneOffTime,requestKeys:requestKeys.current});},[retained,draft,editor,preferredId,oneOffDate,oneOffTime]);
  const timezone = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const reload = React.useCallback(async () => {
    const generation=++loadGeneration.current;
    setLoading(true);
    try {
      const answer = await listLinksRef.current();
      if(generation!==loadGeneration.current)return;
      if (!Array.isArray(answer?.links)) throw new Error(words.loadError);
      setLinks(answer.links);
      setNextCursor(typeof answer.next_cursor === 'string' ? answer.next_cursor : null);
      setLoaded(true); setLoadError('');
    } catch (cause) {
      if(generation!==loadGeneration.current)return;
      setLoaded(true); setLoadError(errorWords(cause, words.loadError));
    } finally { if(generation===loadGeneration.current)setLoading(false); }
  }, []);
  React.useEffect(() => { void reload(); return ()=>{loadGeneration.current++;detailGeneration.current++;}; }, [reload]);
  React.useEffect(()=>subscribeChanges?.(()=>{void reload();}),[subscribeChanges,reload]);

  const choices = React.useMemo(() => accounts.flatMap(account => account.calendars.map(calendar => ({
    selection: { source_id: account.source_id ?? '', connection_id: account.connection_id, connected_at: account.connected_at,
      calendar_id: calendar.id, ...(calendar.access_role ? { access_role: calendar.access_role } : {}) } as CalendarIdentity,
    label: `${calendar.summary} · ${account.account_label}`,
    role: calendar.access_role ?? '', writable: calendar.writable === true,
    current: sources.find(source => source.connected !== false && source.selection && sameIdentity(source.selection,
      { source_id: account.source_id, connection_id: account.connection_id, connected_at: account.connected_at, calendar_id: calendar.id })),
  })).filter(choice => choice.selection.source_id && choice.current?.writable !== false)), [accounts, sources]);
  const writableChoices = choices.filter(choice => choice.writable || ['owner', 'writer'].includes(choice.role));
  const readableChoices = choices;
  const choiceMap = React.useMemo(() => new Map(choices.map(choice => [identityKey(choice.selection), choice])), [choices]);

  const keyFor = (signature: string, payload: unknown) => reuseRequestKey(requestKeys.current, signature, payload);
  const loadMore = async () => {
    if (!nextCursor || loading) return;
    const generation=++loadGeneration.current;
    setLoading(true); setLoadError('');
    try {
      const answer = await listLinksRef.current(nextCursor);
      if(generation!==loadGeneration.current)return;
      if (!Array.isArray(answer?.links)) throw new Error(words.loadError);
      setLinks(rows => [...rows, ...answer.links.filter(link => !rows.some(existing => existing.id === link.id))]);
      setNextCursor(typeof answer.next_cursor === 'string' ? answer.next_cursor : null);
    } catch (cause) { if(generation===loadGeneration.current)setLoadError(errorWords(cause, words.loadError)); }
    finally { if(generation===loadGeneration.current)setLoading(false); }
  };
  const runMutation = async (action: AvailabilityLinkAction, input: Record<string, unknown>, signature: string) => {
    const requestKey = keyFor(signature, [action, input]);
    setBusyKey(signature); setError(''); setNotice('');
    try {
      const result = await mutate(action, input, requestKey);
      const changed = result && typeof result === 'object' && typeof (result as AvailabilityLink).id === 'string' ? result as AvailabilityLink : null;
      if(!changed)throw new Error(words.saveError);
      requestKeys.current.delete(signature);
      if (changed) {
        setLinks(rows => action === 'create' ? [changed, ...rows.filter(row => row.id !== changed.id)] : rows.map(row => row.id === changed.id ? changed : row));
        setDetail(current => current?.id === changed.id ? changed : current);
      }
      await reload();
      setNotice(''); return true;
    } catch (cause) {
      setError(errorWords(cause, words.saveError));
      return false;
    } finally { setBusyKey(null); }
  };

  const startCreate = () => {
    setEditor({ id: null, revision: null }); setDetail(null); setError(''); setNotice('');
    setDraft(emptyDraft(defaultCalendar(accounts, preferences), timezone)); setPreferredId(preferences.workScheduleId ?? '');
  };
  const handledStart = React.useRef(0);
  React.useEffect(() => {
    if (!startFrom || startFrom.nonce === handledStart.current) return;
    handledStart.current = startFrom.nonce;
    setEditor({ id: null, revision: null }); setDetail(null); setError(''); setNotice('');
    setDraft({ ...emptyDraft(defaultCalendar(accounts, preferences), timezone), title: startFrom.schedule.label,
      windows: windowsFrom(startFrom.schedule), preferred_times_snapshot: structuredClone(startFrom.schedule) });
    setPreferredId(startFrom.schedule.id);
  }, [startFrom, accounts, preferences, timezone]);
  const startEdit = (link: AvailabilityLink) => {
    setEditor({ id: link.id, revision: link.revision }); setDetail(null); setError(''); setNotice('');
    setDraft({ title: link.title, calendar: structuredClone(link.calendar), description: link.description ?? '', location: link.location ?? '', alias: link.alias ?? '',
      cohosts: structuredClone(link.cohosts ?? []), timezone: link.timezone, windows: structuredClone(link.windows ?? []),
      duration_min: link.duration_min, step_min: link.step_min, repeat: link.repeat, one_off_slots: structuredClone(link.one_off_slots ?? []),
      preferred_times_snapshot: structuredClone(link.preferred_times_snapshot),
      buffer_before_min: link.buffer_before_min ?? 0, buffer_after_min: link.buffer_after_min ?? 0, min_notice_min: link.min_notice_min ?? 0, horizon_days: link.horizon_days ?? 60,
      seats_per_slot: link.seats_per_slot ?? null, host_mode: link.host_mode ?? 'everyone', host_weight: link.host_weight ?? 1,
      requires_confirmation: link.requires_confirmation ?? false, pending_blocks_slot: link.pending_blocks_slot ?? false });
    setPreferredId(preferences.workScheduleId ?? '');
  };
  const loadRequests = React.useCallback(async (link: AvailabilityLink | null) => {
    setRequests(null); setRequestsError('');
    if (!link?.requires_confirmation) return;
    try {
      const answer = await mutate('reservation:list', { link_id: link.id, state: 'requested' }, crypto.randomUUID()) as { reservations?: Request[] };
      setRequests(answer.reservations ?? []);
    } catch { setRequestsError(words.requestsError); }
  }, [mutate]);
  React.useEffect(() => { void loadRequests(detail); }, [detail, loadRequests]);
  const answerRequest = async (request: Request, action: 'reservation:confirm' | 'reservation:decline') => {
    setBusyKey(`${action}:${request.id}`); setError('');
    try { await mutate(action, { reservation_id: request.id }, `${action}:${request.id}`); setNotice(words.requestAnswered); await loadRequests(detail); }
    catch (failure) { setError(errorWords(failure)); }
    finally { setBusyKey(null); }
  };
  const readDetails = async (id: string) => {
    const generation=++detailGeneration.current;
    setBusyKey(`read:${id}`); setError('');
    try { const found = await readLink(id); if(generation===detailGeneration.current)setDetail(found); }
    catch { if(generation===detailGeneration.current)setError(words.readError); }
    finally { if(generation===detailGeneration.current)setBusyKey(null); }
  };

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => previous ? { ...previous, [key]: value } : previous);
  const updateDuration = (duration: number) => setDraft(previous => previous ? {
    ...previous,
    duration_min: duration,
    one_off_slots: (previous.one_off_slots ?? []).map(slot => slot.start_ms < Date.now() ? slot : ({ ...slot, end_ms: slot.start_ms + duration * 60_000 })),
  } : previous);
  const primaryKey = draft?.calendar ? identityKey(draft.calendar) : '';
  const selectedPrimary = primaryKey ? choiceMap.get(primaryKey) : undefined;
  const cohostEmailsValid = (draft?.cohosts ?? []).every(host => validEmail(host.email));
  const oneOffValid = (draft?.one_off_slots?.length ?? 0) > 0;
  const canSave = Boolean(draft && draft.title.trim() && draft.calendar && selectedPrimary?.writable && draft.timezone.trim()
    && cohostEmailsValid && (draft.repeat ? draft.windows.length > 0 : oneOffValid));
  const saveDraft = async () => {
    if (!draft || !editor || !canSave) return;
    const payload = structuredClone(draft) as Draft;
    const signature = editor.id ? `edit:${editor.id}:${editor.revision}` : `create:${JSON.stringify(payload)}`;
    const input = editor.id ? { link_id: editor.id, expected_revision: editor.revision, changes: payload }
      : { ...payload, calendar: payload.calendar };
    if (await runMutation(editor.id ? 'edit' : 'create', input, signature)) {
      retained.editor=null;retained.draft=null;
      setEditor(null); setDraft(null); setError('');
    }
  };

  const beginCalendarSelect = (value: string) => {
    const choice = choiceMap.get(value);
    if (choice) update('calendar', structuredClone(choice.selection));
    else update('calendar', null);
  };
  const updateCohost = (index: number, change: Partial<Cohost>) => update('cohosts', (draft?.cohosts ?? []).map((host, at) => at === index ? { ...host, ...change } : host));
  const addCohost = () => update('cohosts', [...(draft?.cohosts ?? []), { calendar: { source_id: '', connection_id: '', connected_at: '', calendar_id: '' }, email: '' }]);

  const weeklySchedule = draft ? scheduleFrom('availability-link-draft', words.weeklyTitle, draft.windows ?? []) : null;
  const preferredSchedules = preferences.workSchedules ?? [];
  const copyPreferred = () => {
    const schedule = preferredSchedules.find(row => row.id === preferredId);
    if (schedule) { update('windows', windowsFrom(schedule)); update('preferred_times_snapshot', structuredClone(schedule)); }
  };
  const addOneOff = () => {
    if (!draft || !oneOffDate || !oneOffTime) return;
    let start: number | null = null;
    try { start = localTimeInZone(oneOffDate, oneOffTime, draft.timezone); } catch { start = null; }
    if (start === null || !Number.isFinite(start)) { setError(words.timeDoesNotExist); return; }
    const end = start + draft.duration_min * 60_000;
    if ((draft.one_off_slots ?? []).some(slot => start! < slot.end_ms && end > slot.start_ms)) { setError(words.oneOffOverlap); return; }
    update('one_off_slots', [...(draft.one_off_slots ?? []), { start_ms: start, end_ms: end }].sort((a, b) => a.start_ms - b.start_ms));
    setOneOffDate(''); setOneOffTime(''); setError('');
  };
  const copyTimes = async (link: AvailabilityLink) => {
    setBusyKey(`copy:${link.id}`); setError(''); setNotice('');
    try {
      const offered = await readOffers(link.id);
      if (!Array.isArray(offered?.slots)) throw new Error(words.copyFailed);
      const format = new Intl.DateTimeFormat(undefined, { timeZone: offered.link.timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const value = offered.slots.map(slot => `${format.format(new Date(slot.startMs))}–${format.format(new Date(slot.endMs))} (${offered.link.timezone})`).join('\n');
      if (!value) { setNotice(words.noOpenTimes); return; }
      const copied = await onCopy(`${link.title}\n${value}`);
      setNotice(copied ? words.copySucceeded : words.copyFailed);
    } catch (cause) { setError(errorWords(cause, words.copyFailed)); }
    finally { setBusyKey(null); }
  };
  const doStatusAction = async (action: 'revoke' | 'restore' | 'delete', link: AvailabilityLink) => {
    const signature = `${action}:${link.id}:${link.revision}`;
    const ok = await runMutation(action, { link_id: link.id, expected_revision: link.revision }, signature);
    if (ok) setDeleteId(null);
  };

  const calendarSelect = (value: string, label: string, options: typeof choices, change: (next: string) => void) => <Container layout="vertical" gap="xs">
    <Text variant="caption" color="muted">{label}</Text>
    <Select items={options.map(choice => ({ value: identityKey(choice.selection), label: choice.label }))} value={value} onValueChange={next => { if (typeof next === 'string') change(next); }}>
      <SelectTrigger aria-label={label}><SelectValue placeholder={words.chooseCalendar} /></SelectTrigger>
      <SelectPopup>{options.map(choice => <SelectItem key={identityKey(choice.selection)} value={identityKey(choice.selection)}>{choice.label}{choice.role ? ` · ${choice.role}` : ''}</SelectItem>)}</SelectPopup>
    </Select>
  </Container>;

  const editorPieces = editor && draft ? [
    { id: 'editor-heading', label: words.editorHeading, content: <Text variant="heading-xs">{editor.id ? words.editTitle : words.createTitle}</Text> },
    { id: 'title-field', label: words.titleLabel, content: <Input label={words.titleLabel} placeholder={words.titlePlaceholder} maxLength={160} required value={draft.title} onChange={event => update('title', event.target.value)} /> },
    { id: 'description-field', label: words.descriptionLabel, content: <Input label={words.descriptionLabel} placeholder={words.descriptionPlaceholder} maxLength={4000} value={draft.description ?? ''} onChange={event => update('description', event.target.value)} /> },
    { id: 'location-field', label: words.location, content: <Input label={words.location} placeholder={words.locationPlaceholder} maxLength={300} value={draft.location ?? ''} onChange={event => update('location', event.target.value)} /> },
    { id: 'alias-field', label: words.alias, content: <Input label={words.alias} placeholder={words.aliasPlaceholder} maxLength={300} value={draft.alias ?? ''} onChange={event => update('alias', event.target.value)} /> },
    { id: 'calendar-field', label: words.calendar, content: calendarSelect(primaryKey, words.calendar, writableChoices, beginCalendarSelect) },
    { id: 'calendar-status', label: words.calendarStatusLabel, content: <Container layout="vertical" gap="xs">
      {draft.calendar && !selectedPrimary ? <Text variant="caption" color="error">{words.calendarUnavailable}</Text> : null}
      {!writableChoices.length ? <Container layout="vertical" gap="xs"><Text variant="caption" color="muted">{words.noCalendar}</Text><Button size="xs" variant="outline" disabled={connectionsBusy} onClick={onRefreshCalendars}>{words.refreshCalendars}</Button></Container> : null}
      {connectionsError ? <Container layout="horizontal" gap="xs" alignItems="center" wrap><Text variant="caption" color="error">{connectionsError}</Text><Button size="xs" variant="ghost" onClick={onRefreshCalendars}>{words.refreshCalendars}</Button></Container> : null}
    </Container> },
    { id: 'timezone-field', label: words.timezone, content: <Input label={words.timezone} value={draft.timezone} maxLength={100} required onChange={event => update('timezone', event.target.value)} /> },
    { id: 'duration-fields', label: words.duration, content: <Container layout="horizontal" gap="sm" wrap>
      {([['duration_min', words.duration], ['step_min', words.step]] as const).map(([field, label]) => <Container key={field} layout="vertical" gap="xs" className="min-w-40 flex-1">
        <Text variant="caption" color="muted">{label}</Text>
        <Select value={String(draft[field])} onValueChange={value => { if (typeof value === 'string') field === 'duration_min' ? updateDuration(Number(value)) : update(field, Number(value)); }}>
          <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectPopup>{words.durationMinutes.map(minutes => <SelectItem key={minutes} value={String(minutes)}>{minutes} {words.minutes}</SelectItem>)}</SelectPopup>
        </Select>
      </Container>)}
    </Container> },
    { id: 'repeat-control', label: words.repeat, content: <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="body-sm">{words.repeat}</Text><Switch checked={draft.repeat} label={words.repeat} onCheckedChange={repeat => update('repeat', repeat)} size="sm" />
    </Container> },
    { id: 'weekly-times', label: words.weeklyTitle, content: draft.repeat ? <Container layout="vertical" gap="sm">
      {preferredSchedules.length ? <Container layout="horizontal" gap="xs" alignItems="end" wrap>
        <Container layout="vertical" gap="xs" className="min-w-40 flex-1"><Text variant="caption" color="muted">{words.preferredTimes}</Text>
          <Select items={preferredSchedules.map(schedule => ({value: schedule.id, label: schedule.label}))} value={preferredId} onValueChange={value => { if (typeof value === 'string') setPreferredId(value); }}>
            <SelectTrigger size="sm" aria-label={words.preferredTimes}><SelectValue placeholder={words.choosePreferredTimes} /></SelectTrigger>
            <SelectPopup>{preferredSchedules.map(schedule => <SelectItem key={schedule.id} value={schedule.id}>{schedule.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Container><Button size="sm" variant="outline" disabled={!preferredId} onClick={copyPreferred}>{words.copyPreferredTimes}</Button>
      </Container> : null}
      {weeklySchedule ? <WeeklyAvailability schedules={[weeklySchedule]} workScheduleId={weeklySchedule.id}
        initialDays={Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: [] }))}
        words={words.weeklyWords as WeeklyAvailabilityWords} weekStartsOn={preferences.weekStart}
        onSave={schedules => update('windows', windowsFrom(schedules[0] ?? weeklySchedule))} /> : null}
    </Container> : null },
    { id: 'one-off-times', label: words.oneOffTitle, content: !draft.repeat ? <Container layout="vertical" gap="sm">
      <Text variant="body-sm" weight="semibold">{words.oneOffTitle}</Text>
      <Container layout="horizontal" gap="sm" alignItems="end" wrap>
        <Input label={words.date} type="date" value={oneOffDate} onChange={event => setOneOffDate(event.target.value)} />
        <Input label={words.startTime} type="time" value={oneOffTime} onChange={event => setOneOffTime(event.target.value)} />
        <Button variant="outline" disabled={!oneOffDate || !oneOffTime} onClick={addOneOff}>{words.addOneOff}</Button>
      </Container>
      {(draft.one_off_slots ?? []).length ? (draft.one_off_slots ?? []).map(slot => {
        const label = new Intl.DateTimeFormat(undefined, { timeZone: draft.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(slot.start_ms));
        return <Container key={slot.start_ms} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
          <Text variant="body-sm">{label} · {draft.duration_min} {words.minutes}</Text>
          <Button size="xs" variant="ghost" aria-label={words.removeOneOff.replace('{when}', label)} onClick={() => update('one_off_slots', (draft.one_off_slots ?? []).filter(row => row.start_ms !== slot.start_ms))}>×</Button>
        </Container>;
      }) : <Text variant="caption" color="muted">{words.noOneOff}</Text>}
    </Container> : null },
    { id: 'cohosts', label: words.cohosts, content: <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap><Text variant="body-sm" weight="semibold">{words.cohosts}</Text><Button size="xs" variant="outline" disabled={(draft.cohosts?.length ?? 0) >= 20} onClick={addCohost}>{words.addCohost}</Button></Container>
      {(draft.cohosts ?? []).map((host, index) => <Container key={index} layout="vertical" gap="xs" data-availability-cohost>
        {calendarSelect(identityKey(host.calendar), words.cohostCalendar, readableChoices, value => {
          const choice = choiceMap.get(value); if (choice) updateCohost(index, { calendar: structuredClone(choice.selection) });
        })}
        <Input label={words.cohostEmail} type="email" required value={host.email} aria-invalid={host.email.length > 0 && !validEmail(host.email)} onChange={event => updateCohost(index, { email: event.target.value })} />
        {draft.host_mode === 'take_turns' ? <Input label={words.hostWeight} type="number" min={1} max={100} value={host.weight ?? 1} onChange={event => updateCohost(index, { weight: Number(event.target.value) })} /> : null}
        <Button size="xs" variant="ghost" onClick={() => update('cohosts', (draft.cohosts ?? []).filter((_, at) => at !== index))}>{words.removeCohost}</Button>
      </Container>)}
    </Container> },
    { id: 'buffers', label: words.buffers, content: <Container layout="horizontal" gap="sm" wrap>
      <Input label={words.beforeBuffer} type="number" min={0} max={525600} value={draft.buffer_before_min ?? 0} onChange={event => update('buffer_before_min', Number(event.target.value))} />
      <Input label={words.afterBuffer} type="number" min={0} max={525600} value={draft.buffer_after_min ?? 0} onChange={event => update('buffer_after_min', Number(event.target.value))} />
      <Input label={words.notice} type="number" min={0} max={525600} value={draft.min_notice_min ?? 0} onChange={event => update('min_notice_min', Number(event.target.value))} />
      <Input label={words.horizon} type="number" min={1} max={366} value={draft.horizon_days ?? 60} onChange={event => update('horizon_days', Number(event.target.value))} />
    </Container> },
    { id: 'booking-rules', label: words.bookingRules, content: <Container layout="vertical" gap="sm">
      <Text variant="body-sm" weight="semibold">{words.bookingRules}</Text>
      <Input label={words.seats} type="number" min={1} max={1000} placeholder={words.seatsPlaceholder} value={draft.seats_per_slot ?? ''}
        onChange={event => update('seats_per_slot', event.target.value === '' ? null : Number(event.target.value))} />
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="body-sm">{words.requiresConfirmation}</Text><Switch checked={draft.requires_confirmation === true} label={words.requiresConfirmation} onCheckedChange={value => update('requires_confirmation', value)} size="sm" />
      </Container>
      {draft.requires_confirmation ? <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Text variant="body-sm">{words.pendingBlocks}</Text><Switch checked={draft.pending_blocks_slot === true} label={words.pendingBlocks} onCheckedChange={value => update('pending_blocks_slot', value)} size="sm" />
      </Container> : null}
      {(draft.cohosts?.length ?? 0) > 0 ? <Container layout="vertical" gap="xs">
        <Text variant="caption" color="muted">{words.hostMode}</Text>
        <Select items={words.hostModes} value={draft.host_mode ?? 'everyone'} onValueChange={value => { if (typeof value === 'string') update('host_mode', value); }}>
          <SelectTrigger aria-label={words.hostMode}><SelectValue /></SelectTrigger>
          <SelectPopup>{words.hostModes.map(mode => <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>)}</SelectPopup>
        </Select>
        {draft.host_mode === 'take_turns' ? <Input label={words.hostWeight} type="number" min={1} max={100} value={draft.host_weight ?? 1} onChange={event => update('host_weight', Number(event.target.value))} /> : null}
      </Container> : null}
    </Container> },
    { id: 'editor-error', label: words.errorLabel, content: error ? <Text variant="caption" color="error">{error}</Text> : null },
    { id: 'editor-actions', label: words.cancel, content: <Button size="sm" variant="ghost" onClick={() => { setEditor(null); setDraft(null); setError(''); }}>{words.cancel}</Button> },
    { id: 'editor-submit', label: words.save, content: <Button size="sm" variant="primary" disabled={!canSave || busyKey !== null} onClick={() => saveDraft()}>{busyKey && (busyKey.startsWith('create:') || busyKey.startsWith('edit:')) ? words.retryMutation : words.save}</Button> },
  ] : [];
  const editorView = editor && draft ? <ArrangedContents pieces={editorPieces} arrangement={words.composition.editor.arrangement}
    keptAt={words.composition.editor.keptAt} words={words.composition.editor.words} /> : null;

  const detailPieces = detail ? [
    { id: 'detail-heading', label: words.detailHeading, content: <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
      <Text variant="heading-xs">{detail.title}</Text><Button size="xs" variant="ghost" onClick={() => setDetail(null)}>{words.closed}</Button>
    </Container> },
    { id: 'detail-summary', label: words.descriptionLabel, content: <Text variant="body-sm">{detail.description || detail.location || ''}</Text> },
    { id: 'detail-facts', label: words.detailsLabel, content: <Container layout="vertical" gap="xs">
      <Text variant="caption" color="muted">{detail.repeat ? words.repeatLabel : words.oneOffLabel} · {detail.duration_min} {words.minutes} · {detail.timezone}</Text>
      <Text variant="caption" color="muted">{detail.state === 'active' ? words.active : detail.state === 'revoked' ? words.revoked : words.deleted} · {words.calendar}: {choiceMap.get(identityKey(detail.calendar))?.label ?? words.calendarUnavailable}</Text>
    </Container> },
    { id: 'detail-requests', label: words.requestsHeading, content: detail.requires_confirmation ? <Container layout="vertical" gap="xs">
      <Text variant="body-sm" weight="semibold">{words.requestsHeading}</Text>
      {requestsError ? <Text variant="caption" color="error">{requestsError}</Text> : requests === null ? null : requests.length === 0 ? <Text variant="caption" color="muted">{words.noRequests}</Text>
        : requests.map(request => <Container key={request.id} layout="horizontal" gap="xs" alignItems="center" justifyContent="between" wrap data-availability-request>
          <Text variant="body-sm">{new Date(request.start_ms).toLocaleString([], { timeZone: detail.timezone, dateStyle: 'medium', timeStyle: 'short' })} · {request.recipient?.name || request.recipient?.email || ''}</Text>
          <Container layout="horizontal" gap="xs">
            <Button size="xs" variant="primary" disabled={busyKey !== null} onClick={() => answerRequest(request, 'reservation:confirm')}>{words.confirmRequest}</Button>
            <Button size="xs" variant="outline" disabled={busyKey !== null} onClick={() => answerRequest(request, 'reservation:decline')}>{words.declineRequest}</Button>
          </Container>
        </Container>)}
    </Container> : null },
    { id: 'detail-actions', label: words.actionsLabel, content: <Container layout="horizontal" gap="xs" wrap>
      {detail.state !== 'deleted' ? <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => startEdit(detail)}>{words.edit}</Button> : null}
      {detail.state === 'active' ? <Button size="sm" variant="outline" onClick={() => onShare(detail.id, detail.title, document.activeElement, detail.alias)}>{words.share}</Button> : null}
      {detail.state === 'active' ? <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => copyTimes(detail)}>{words.copyTimes}</Button> : null}
      {detail.state === 'active' ? <Button size="sm" variant="ghost" disabled={busyKey !== null} onClick={() => doStatusAction('revoke', detail)}>{words.revoke}</Button> : null}
      {detail.state === 'revoked' ? <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => doStatusAction('restore', detail)}>{words.restore}</Button> : null}
      {detail.state !== 'deleted' ? <Button size="sm" variant="danger" disabled={busyKey !== null} onClick={() => setDeleteId(detail.id)}>{words.delete}</Button> : null}
      {error ? <Text variant="caption" color="error">{error}</Text> : null}
    </Container> },
    { id: 'delete-confirmation', label: words.deleteConfirm, content: deleteId === detail.id ? <Container layout="horizontal" gap="sm" alignItems="center" wrap>
      <Text variant="body-sm">{words.deleteConfirm}</Text><Button size="sm" variant="danger" disabled={busyKey !== null} onClick={() => doStatusAction('delete', detail)}>{words.confirmDelete}</Button>
      <Button size="sm" variant="ghost" onClick={() => setDeleteId(null)}>{words.cancel}</Button>
    </Container> : null },
  ] : [];
  const detailView = detail ? <ArrangedContents pieces={detailPieces} arrangement={words.composition.detail.arrangement}
    keptAt={words.composition.detail.keptAt} words={words.composition.detail.words} /> : null;

  const listPieces = [
    { id: 'loading', label: words.loading, content: loading && !loaded ? <Text variant="body-sm" role="status">{words.loading}</Text> : null },
    { id: 'load-error', label: words.loadError, content: loadError ? <Container layout="horizontal" gap="sm" alignItems="center" wrap><Text variant="caption" color="error">{words.loadError}</Text><Button size="xs" variant="outline" disabled={loading} onClick={() => reload()}>{words.retry}</Button></Container> : null },
    { id: 'notice', label: words.noticeLabel, content: notice ? <Text variant="caption" role="status">{notice}</Text> : null },
    { id: 'list-error', label: words.errorLabel, content: error ? <Text variant="caption" color="error">{error}</Text> : null },
    { id: 'empty-state', label: words.emptyTitle, content: loaded && !loading && !loadError && links.length === 0 ? <Container layout="vertical" gap="xs"><Text variant="body-sm" weight="semibold">{words.emptyTitle}</Text><Text variant="body-sm" color="muted">{words.empty}</Text></Container> : null },
    { id: 'link-rows', label: words.listLabel, content: links.length ? <Container layout="vertical" gap="xs">{links.map(link => <Container key={link.id} layout="vertical" gap="xs" data-availability-link={link.id}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
        <Container layout="vertical" gap="xs" minWidth="0"><Text variant="body-sm" weight="semibold">{link.title}</Text><Text variant="caption" color="muted">{link.repeat ? words.repeatLabel : words.oneOffLabel} · {link.duration_min} {words.minutes} · {link.timezone} · {words[link.state]}</Text></Container>
        <Container layout="horizontal" gap="xs" wrap>
          <Button size="xs" variant="ghost" disabled={busyKey === `read:${link.id}`} onClick={() => readDetails(link.id)}>{words.read}</Button>
          {link.state === 'active' ? <Button size="xs" variant="outline" onClick={() => onShare(link.id, link.title, document.activeElement, link.alias)}>{words.share}</Button> : null}
          {link.state === 'active' ? <Button size="xs" variant="ghost" disabled={busyKey !== null} onClick={() => copyTimes(link)}>{words.copyTimes}</Button> : null}
        </Container>
      </Container>
    </Container>)}</Container> : null },
    { id: 'pagination', label: words.paginationLabel, content: nextCursor ? <Button size="sm" variant="outline" disabled={loading} onClick={() => loadMore()}>{words.loadMore}</Button> : null },
  ];
  const listContent = <ArrangedContents pieces={listPieces} arrangement={words.composition.list.arrangement}
    keptAt={words.composition.list.keptAt} words={words.composition.list.words} />;
  const viewPieces = [
    { id: 'list-heading', label: words.title, content: <Container layout="vertical" gap="xs"><Text variant="body" weight="semibold">{words.title}</Text><Text variant="caption" color="muted">{words.description}</Text></Container> },
    { id: 'list-actions', label: words.actionsLabel, content: <Container layout="horizontal" gap="xs" wrap><Button size="sm" variant="ghost" disabled={loading} onClick={() => reload()}>{words.retry}</Button><Button size="sm" variant="primary" onClick={startCreate}>{words.create}</Button></Container> },
    { id: 'list-content', label: words.listLabel, content: listContent },
    { id: 'detail-view', label: words.detailsLabel, content: detailView },
    { id: 'editor-view', label: words.editorHeading, content: editorView },
  ];
  return <Container layout="vertical" gap="sm" data-availability-links-list>
    <ArrangedContents pieces={viewPieces} arrangement={words.composition.view.arrangement}
      keptAt={words.composition.view.keptAt} words={words.composition.view.words} />
  </Container>;
}

