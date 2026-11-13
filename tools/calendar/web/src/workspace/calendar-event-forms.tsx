// src/workspace/calendar-event-forms.tsx
//
// PURPOSE
//   The Calendar's event forms: the opened event (OpenItem, with its private note and its call), editing one (EventEditor)
//   and putting one on (NewMeeting, the quick-create with guests, a call, repeat, reminders, colour, privacy and busy or free),
//   plus the two settings these forms read (the default meeting provider and whether declined events show). Words, choices
//   and limits are DATA (calendar-event-forms.json); what a source can write is its row of src/calendar.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every element is a shared component; this file writes no markup of its own.
//   2. A value a person did not choose is never written: an edit that did not load a repeat, reminders, colour, privacy or
//      availability keeps what the provider holds (`keep`).
//   3. A private note is only this person's: it is kept as their own saved preference and is never part of any provider write.
//   4. Nothing here names a source: a call, a colour or a write exists only when the source's row offers it.

import React from 'react';
import { Badge, Button, Container, ColorDot, EventOptions, EventProperties, Input, Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, Switch, Text, Textarea, TaskRecurrence, addDays, type EventPropertySetting, type EventRepeatSetting, type EventReminderSetting, type TaskRecurrenceValue } from '../../parts/ui';
import { DateTimePicker } from '../../parts/ui/show/date-picker/DateTimePicker';
import { DatePicker } from '../../parts/ui/show/date-picker/DatePicker';
import { Popover, PopoverPopup, PopoverTrigger } from '../../parts/ui/show/coss/ui/popover';
import { SelectGroup, SelectGroupLabel } from '../../parts/ui/show/coss/ui/select';
import { SegmentedControl } from '../../parts/ui/show/segmented-control';
import { NamedIcon } from '../../parts/ui/show/icon';
import { notify } from '../../parts/ui/show/coss/notifications';
import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { copyTextToClipboard } from '../../../../ui/show/clipboard/copy-text.ts';
import { addGuests, groupSourcesByAccount, guestFields, presetsFor, recurrenceToRRule, reminderOverrides, removeGuest, rruleToLabel, rruleToRecurrence, type RepeatData } from '../../parts/ui/show/schedule-calendar';
import { createMeetingJoinRecordingInvocation, isFreshMeetingJoinRecordingInvocation, meetingContextOfCalendarItem } from '../../../../record-voice-and-meetings/do-work/meeting-join-recording.ts';
import meetingRecordingSettings from '../../../../record-voice-and-meetings/read-data/meeting-start-settings.json';
import { decodeMeetingCaptureStartPolicy, decideMeetingCaptureStart } from '../../parts/record-audio/read-data/capture-policy';
import type { CalendarAccount, CalendarControlSource } from '../../parts/ui';
import formsData from './calendar-event-forms.json';
import screenData from './shared-calendar.json';
import { postJson } from './api';
import { openScreenOn } from './open-screen';
import { COLOUR_NAMES, readColourNames, withColourNames } from './colour-names.mjs';
import { readSavedRecordFromOwner, readWorkspacePreference, subscribeRecordLabel, writeConfirmedWorkspacePreference } from './records';
import { calendarWrite, fill, itemActions, localInput, runRoad, sourceFor, sourceLabel, whenWords, type Action, type EventPropertyDraft, type EventPropertyName, type Item, type Road, type Source, type SourceState } from './calendar-screen-core';

const words = formsData.words;
const shared = screenData.words;
const repeatData = formsData.repeat as RepeatData;
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------------------------------------------------------------------------
// What the forms write
// ---------------------------------------------------------------------------

const noRepeat = 'none';
/** The provider fields for a repeat and reminders a person set (nothing for one they left as `keep`). */
export const eventOptionFields = (repeat: EventRepeatSetting, reminder: EventReminderSetting) => ({
  ...(repeat.kind === 'set' ? { recurrence: repeat.value === noRepeat ? [] : [repeat.value] } : {}),
  ...(reminder.kind === 'set' ? { reminders: reminderOverrides(reminder.minutes) } : {}),
});

export const newEventPropertyDraft = (privateByDefault = false): EventPropertyDraft => ({ color: { kind: 'keep' }, privacy: privateByDefault ? { kind: 'set', value: 'private' } : { kind: 'keep' }, availability: { kind: 'keep' } });
const eventPropertyDraftFor = (item: Item, source: Source | undefined): EventPropertyDraft => {
  const draft = newEventPropertyDraft();
  for (const [key, declaration] of Object.entries(source?.event_properties ?? {})) {
    const choice = declaration?.choices.find(row => (Object.hasOwn(row, 'input_value') ? row.input_value : row.value) === item[declaration.input_field as keyof Item]);
    if (choice) draft[key as EventPropertyName] = { kind: 'set', value: choice.value };
  }
  return draft;
};
export const eventPropertyFields = (source: Source | undefined, draft: EventPropertyDraft) => Object.fromEntries(
  Object.entries(source?.event_properties ?? {}).flatMap(([key, declaration]) => {
    const setting = draft[key as EventPropertyName];
    if (!declaration || setting.kind !== 'set') return [];
    const choice = declaration.choices.find(row => row.value === setting.value);
    return choice ? [[declaration.input_field, Object.hasOwn(choice, 'input_value') ? choice.input_value : choice.value]] : [];
  }),
);

/** The repeat choices for a start, with the rule an event already has listed (named by its words) when it is not a preset. */
function repeatChoicesFor(startIso: string, zone: string, repeat: EventRepeatSetting) {
  const choices = presetsFor(startIso, zone, repeatData).map(row => ({ value: row.value, label: row.label }));
  if (repeat.kind === 'set' && !choices.some(choice => choice.value === repeat.value)) choices.push({ value: repeat.value, label: rruleToLabel(repeat.value, startIso, zone, repeatData) });
  return choices;
}

// ---------------------------------------------------------------------------
// Saved choices these forms read (the person's own preferences)
// ---------------------------------------------------------------------------

function useSavedPreference<T>(key: string | null): T | null {
  const label = key ? `workspace-preference:${key}` : '';
  const subscribe = React.useCallback((listener: () => void) => (label ? subscribeRecordLabel(label, listener) : () => undefined), [label]);
  const read = React.useCallback(() => (key ? readWorkspacePreference<T>(key) : null), [key]);
  return React.useSyncExternalStore(subscribe, read, read);
}

type MeetingProvider = { provider: string; zoom_link?: string; custom_link?: string };
const providerData = formsData.meeting_provider;
const meetingProviderOf = (saved: MeetingProvider | null): Required<MeetingProvider> => ({
  provider: providerData.choices.some(choice => choice.id === saved?.provider) ? saved!.provider : providerData.default,
  zoom_link: typeof saved?.zoom_link === 'string' ? saved.zoom_link : '',
  custom_link: typeof saved?.custom_link === 'string' ? saved.custom_link : '',
});
/** The default meeting provider the person chose in settings, read the way every preference is. */
export const useMeetingProvider = () => meetingProviderOf(useSavedPreference<MeetingProvider>(providerData.preference_key));
const providerLink = (provider: Required<MeetingProvider>) => (provider.provider === 'zoom' ? provider.zoom_link : provider.provider === 'custom' ? provider.custom_link : '');

/** Settings: the call link new events get (None, Google Meet, Zoom or a link of the person's own). */
export function MeetingProviderSettings() {
  const current = useMeetingProvider();
  const copy = providerData.words;
  const [draft, setDraft] = React.useState<{ zoom_link: string; custom_link: string } | null>(null);
  const links = draft ?? { zoom_link: current.zoom_link, custom_link: current.custom_link };
  const save = (next: MeetingProvider) => {
    void writeConfirmedWorkspacePreference(providerData.preference_key, next).then(() => setDraft(null), error => notify(errorWords(error) || copy.failed, { kind: 'error' }));
  };
  const choice = providerData.choices.find(row => row.id === current.provider);
  return (
    <Container layout="vertical" gap="xs" data-meeting-provider-settings>
      <Text variant="body">{copy.heading}</Text>
      <Text variant="caption" color="muted">{copy.about}</Text>
      <SegmentedControl items={providerData.choices.map(row => ({ id: row.id, label: copy[row.key as keyof typeof copy] }))} value={current.provider} ariaLabel={copy.heading}
        onValueChange={next => save({ provider: next, zoom_link: links.zoom_link, custom_link: links.custom_link })} />
      {choice && 'link' in choice && choice.link ? <Input aria-label={current.provider === 'zoom' ? copy.zoom_link : copy.custom_link} placeholder={current.provider === 'zoom' ? copy.zoom_link : copy.custom_link}
        maxLength={providerData.max_link_chars} value={current.provider === 'zoom' ? links.zoom_link : links.custom_link}
        onChange={event => setDraft({ ...links, [current.provider === 'zoom' ? 'zoom_link' : 'custom_link']: event.target.value })}
        onBlur={() => { if (draft) save({ provider: current.provider, ...links }); }} /> : null}
    </Container>
  );
}

/** Settings: whether events the person declined stay on the calendar. */
export const useShowDeclined = () => {
  const saved = useSavedPreference<boolean>(formsData.declined.preference_key);
  return typeof saved === 'boolean' ? saved : formsData.declined.default;
};
export function ShowDeclinedSetting() {
  const shown = useShowDeclined();
  return (
    <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap data-show-declined-setting>
      <Container layout="vertical" gap="xs">
        <Text variant="body">{formsData.declined.words.label}</Text>
        <Text variant="caption" color="muted">{formsData.declined.words.about}</Text>
      </Container>
      <Switch size="sm" label={formsData.declined.words.label} checked={shown}
        onCheckedChange={checked => { void writeConfirmedWorkspacePreference(formsData.declined.preference_key, checked).catch(error => notify(errorWords(error) || formsData.declined.words.failed, { kind: 'error' })); }} />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Private note (only this person's, never sent to guests or the provider)
// ---------------------------------------------------------------------------

const noteData = formsData.private_note;
const noteKeyFor = (item: Item): string | null => {
  const key = `${noteData.key_prefix}${item.source}:${item.source_id}`;
  return key.length <= noteData.max_key_chars ? key : null;
};

function PrivateNote({ item }: { item: Item }) {
  const key = noteKeyFor(item);
  const saved = useSavedPreference<string>(key);
  const note = typeof saved === 'string' ? saved : '';
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setEditing(false); }, [item.id]);
  if (!key) return <Text variant="caption" color="muted">{words.note_unavailable}</Text>;
  const keep = async (value: string | null, done: string) => {
    setBusy(true);
    try { await writeConfirmedWorkspacePreference(key, value); setEditing(false); notify(done, { kind: 'done' }); }
    catch (error) { notify(errorWords(error) || words.note_failed, { kind: 'error' }); }
    finally { setBusy(false); }
  };
  if (editing) {
    return (
      <Container layout="vertical" gap="xs" data-calendar-private-note-editor>
        <Textarea aria-label={words.note_heading} placeholder={words.note_placeholder} maxLength={noteData.max_chars} rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
        <Text variant="caption" color="muted">{words.note_note}</Text>
        <Container layout="horizontal" gap="xs" wrap>
          <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => keep(draft.trim(), words.note_kept)}>{words.note_save}</Button>
          {note ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => keep(null, words.note_removed)}>{words.note_remove}</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{words.note_cancel}</Button>
        </Container>
      </Container>
    );
  }
  return note ? (
    <Container layout="vertical" gap="xs" data-calendar-private-note>
      <Text variant="caption" color="muted">{words.note_heading}</Text>
      <Text variant="body-sm">{note}</Text>
      <Container layout="horizontal" gap="xs"><Button size="xs" variant="ghost" onClick={() => { setDraft(note); setEditing(true); }}>{words.note_edit}</Button></Container>
    </Container>
  ) : <Button size="sm" variant="ghost" data-calendar-private-note-add onClick={() => { setDraft(''); setEditing(true); }}>{words.note_add}</Button>;
}

// ---------------------------------------------------------------------------
// Controls shared by the forms
// ---------------------------------------------------------------------------

function EventPropertyControls({ source, item, value, onChange, disabled }: { source?: Source; item?: Item; value: EventPropertyDraft; onChange: (draft: EventPropertyDraft) => void; disabled: boolean }) {
  const copy = formsData.event_properties.words;
  const colourNames = readColourNames(readWorkspacePreference(COLOUR_NAMES.record_key));
  const fields = Object.fromEntries(Object.entries(source?.event_properties ?? {}).map(([key, declaration]) => {
    const current = declaration?.choices.find(choice => (Object.hasOwn(choice, 'input_value') ? choice.input_value : choice.value) === item?.[declaration.input_field as keyof Item]);
    // A colour's choices take the keys 1-9, A, B in order; the one that clears the colour takes 0.
    const keys = [...formsData.colors.keys];
    const choices = key === 'color' && declaration ? withColourNames(declaration.choices, colourNames).map(choice => ({ ...choice, shortcut: Object.hasOwn(choice, 'input_value') && choice.input_value === null ? formsData.colors.default_key : keys.shift() })) : declaration?.choices;
    const extra = key === 'availability' ? { toggle: { ...formsData.availability, defaultValue: current?.value ?? formsData.availability.default } } : {};
    return [key, declaration ? { ...formsData.event_properties.presentation[key as EventPropertyName], ...extra, label: copy[key as EventPropertyName], choices: choices ?? declaration.choices, setting: value[key as EventPropertyName],
      keepExisting: item ? current ? fill(copy.current, { label: current.label }) : copy.keep : copy.default,
      onChange: (setting: EventPropertySetting) => onChange({ ...value, [key]: setting }) } : undefined];
  }));
  return <Container layout="vertical" gap="xs" className="event-property-controls"><EventProperties {...fields} variant="compact" disabled={disabled} />{source?.event_colors_unavailable ? <Text variant="caption">{copy.colors_unavailable}</Text> : null}</Container>;
}

/** The custom repeat, opened in place beside the toolbar: Every N unit, weekday chips, ends never, on a date or after N. */
function CustomRepeatPanel({ allDay, rule, onSave, onCancel }: { allDay: boolean; rule: string | null; onSave: (rule: string) => void; onCancel: () => void }) {
  const zone = allDay ? 'UTC' : deviceZone();
  const [value, setValue] = React.useState<TaskRecurrenceValue | null>(() => {
    const read = rule && rule !== noRepeat ? rruleToRecurrence(rule, { zone }, repeatData) : null;
    return { ...(read ?? { frequency: repeatData.frequencies[0].value, interval: 1, weekdays: [], ends: { kind: 'never' as const } }), nextTodo: '' };
  });
  const made = value ? recurrenceToRRule(value, { allDay, zone }, repeatData) : noRepeat;
  return (
    <Container layout="vertical" gap="sm" data-calendar-custom-repeat>
      <Text variant="heading-xs">{words.repeat_custom_heading}</Text>
      <TaskRecurrence value={value} frequencies={repeatData.frequencies} nextTodoChoices={[]}
        words={{ ...repeatData.recurrence_words, createNextTodo: '', weekdays: repeatData.weekdays }} onChange={setValue} />
      <Container layout="horizontal" gap="sm">
        <Button size="sm" variant="primary" disabled={!made} onClick={() => { if (made) onSave(made); }}>{words.repeat_custom_save}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{words.repeat_custom_cancel}</Button>
      </Container>
    </Container>
  );
}

type CallKind = 'none' | 'meet' | 'link';

/** The video call popover: Google Meet (when the source offers it), the person's Zoom or own link (placed in the location),
 *  copying the link to share, and removing it. What the source cannot do on an existing event is said, not hidden. */
function VideoCallControl({ kind, offersMeet, existing, link, provider, onMeet, onLink, onRemove, disabled }: {
  kind: CallKind; offersMeet: boolean; existing: boolean; link: string; provider: Required<MeetingProvider>;
  onMeet: () => void; onLink: (link: string) => void; onRemove: () => void; disabled: boolean;
}) {
  const zoomLink = provider.zoom_link;
  const customLink = provider.custom_link;
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" aria-label={words.video_heading} title={words.video_heading} disabled={disabled} data-calendar-video-trigger={kind} />}>
        <NamedIcon name="Video" size="sm" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup className="w-72" portalProps={{ className: 'coss-ui', keepMounted: true }}>
        <Container layout="vertical" gap="xs" padding="sm" data-calendar-video-popup>
          <Text variant="label">{words.video_heading}</Text>
          {kind === 'none' ? <Text variant="caption" color="muted">{words.video_provider_none}</Text> : null}
          <Button size="sm" variant={kind === 'meet' ? 'primary' : 'outline'} disabled={!offersMeet || existing} title={!offersMeet || existing ? words.video_unavailable : undefined} onClick={onMeet}>{words.video_change_meet}</Button>
          {zoomLink ? <Button size="sm" variant="outline" onClick={() => onLink(zoomLink)}>{words.video_zoom}</Button> : null}
          {customLink && customLink !== zoomLink ? <Button size="sm" variant="outline" onClick={() => onLink(customLink)}>{words.video_custom}</Button> : null}
          <Button size="sm" variant="outline" disabled={!link} onClick={() => { return copyTextToClipboard(link).then(copied => { notify(copied ? shared.calendar_copied : shared.calendar_copy_failed, { kind: copied ? 'done' : 'error' }); if (!copied) throw new Error(shared.calendar_copy_failed); }); }}>{words.video_connect_others}</Button>
          <Button size="sm" variant="ghost" disabled={kind === 'none' || existing} title={existing && kind !== 'none' ? words.video_remove_unavailable : undefined} onClick={onRemove}>{words.video_remove}</Button>
          {existing && kind !== 'none' ? <Text variant="caption" color="muted">{words.video_remove_unavailable}</Text> : null}
        </Container>
      </PopoverPopup>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// The opened event
// ---------------------------------------------------------------------------

/** Joins the call of an event in the person's click gesture, then offers or starts recording by their saved choice. `current` reads the
    item and sources as they are when the recording is about to start, so a changed event never records under an old name. */
export function joinCall(item: Item, sources: SourceState[], current: () => { item: Item; sources: SourceState[] } = () => ({ item, sources })) {
  if (!item.conference_url) return;
  // Keep opening the meeting in the person's click gesture. Recording receives
  // a separate, expiring request after its account preference has loaded.
  const connectedAt = sources.find(row => row.id === item.source)?.selection?.connected_at;
  const context = meetingContextOfCalendarItem(item, connectedAt);
  if (!context) return;
  const invocation = createMeetingJoinRecordingInvocation(context, Date.now(), () => {
    const now = current();
    return now.item.id === item.id && now.item.source === item.source
      && now.item.starts_at === item.starts_at && now.item.conference_url === item.conference_url
      && now.sources.find(row => row.id === item.source)?.selection?.connected_at === connectedAt;
  });
  window.open(item.conference_url, '_blank', 'noopener');
  const preference = `workspace-preference:${meetingRecordingSettings.preference_key}`;
  void readSavedRecordFromOwner(preference).then(saved => {
    if (!saved.found || !isFreshMeetingJoinRecordingInvocation(invocation)) return;
    const decision = decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy(saved.value), invocation);
    const openRecording = async (requested: boolean) => {
      if (!isFreshMeetingJoinRecordingInvocation(invocation)) return;
      const currentPreference = await readSavedRecordFromOwner(preference);
      if (!currentPreference.found || !isFreshMeetingJoinRecordingInvocation(invocation)) return;
      const currentDecision = decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy(currentPreference.value), invocation);
      if (currentDecision !== 'start' && !(requested && currentDecision === 'remind')) return;
      openScreenOn(screenData.record.screen, {
      calendar_event: { id: item.id, source_id: item.source_id, title: item.title, starts_at: item.starts_at, ends_at: item.ends_at, source: item.source, source_generation: sources.find(row => row.id === item.source)?.selection?.connected_at, conference_url: item.conference_url ?? item.link, space_id: item.space_id, about: item.about },
      meetingJoinRecording: invocation,
      recordingRequested: requested,
    }, fill(shared.record_title, { title: item.title }));
    };
    if (decision === 'start') void openRecording(false).catch(() => notify(shared.record_start_unavailable, { kind: 'error' }));
    if (decision === 'remind') notify(meetingRecordingSettings.join_reminder, {
      kind: 'info', timeout: 2 * 60 * 1000, key: `recording-reminder:${invocation.invocationId}`,
      actions: [{ id: 'record', label: meetingRecordingSettings.reminder_action,
        onAction: () => { void openRecording(true).catch(() => notify(shared.record_start_unavailable, { kind: 'error' })); } }],
    });
  }).catch(() => notify(shared.record_start_unavailable, { kind: 'error' }));
}

/** One opened thing beside the calendar: what it is, a new time when it may move, its private note, and what its source offers. */
export function OpenItem({ item, sources, askAction, onMove, onRoad, onClose, onEdit, onEditEvent }: { item: Item; sources: SourceState[]; askAction?: Action | null; onMove: (at: string) => Promise<void>; onRoad: (road: Road) => Promise<void>; onClose: () => void; onEdit?: () => void; onEditEvent?: () => void }) {
  const currentJoinSource = React.useRef({ item, sources });
  currentJoinSource.current = { item, sources };
  const [value, setValue] = React.useState(() => localInput(item.starts_at));
  React.useEffect(() => setValue(localInput(item.starts_at)), [item.starts_at]);
  const source = sourceFor(item.source, sources);
  const actions = itemActions(item, sources);
  // An action that takes something away asks first, in place: its question and its two answers are its row's own.
  const [asking, setAsking] = React.useState<Action | null>(askAction ?? null);
  React.useEffect(() => setAsking(askAction ?? null), [item.id, askAction]);
  const join = () => joinCall(item, sources, () => currentJoinSource.current);
  const repeatWords = item.recurring_event_id ? words.repeat_series_instance : null;
  return (
    <Container layout="vertical" gap="sm" padding="md" data-calendar-open-item={item.id}>
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="heading-xs" truncate>{item.title}</Text>
        <Button size="xs" variant="ghost" onClick={onClose}>{shared.close}</Button>
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <Badge size="sm" variant="muted-outline" data-tone={source?.look?.tone ?? 'grey'}>{sourceLabel(item.source, sources)}</Badge>
        <Text variant="caption">{whenWords(item)}</Text>
        {item.space_title ? <Text variant="caption" truncate>{item.space_title}</Text> : null}
      </Container>
      {item.about ? <Text variant="body-sm">{item.about}</Text> : null}
      {item.location ? <Text variant="body-sm">{item.location}</Text> : null}
      {item.conference_url ? <Button size="sm" variant="primary" onClick={join}>{words.join_call}</Button> : null}
      {repeatWords ? <Text variant="caption" color="muted">{repeatWords}</Text> : null}
      <PrivateNote item={item} />
      {onEditEvent ? <Button size="sm" variant="outline" onClick={onEditEvent}>{words.event_edit}</Button> : null}
      {onEdit ? <Button size="sm" variant="outline" onClick={onEdit}>{shared.task_edit}</Button> : <Button size="sm" variant="outline" onClick={() => openScreenOn(screenData.record.screen, { calendar_event: { id: item.id, source_id: item.source_id, title: item.title, starts_at: item.starts_at, ends_at: item.ends_at, source: item.source, source_generation: sources.find(row => row.id === item.source)?.selection?.connected_at, conference_url: item.conference_url ?? item.link, space_id: item.space_id, about: item.about } }, fill(shared.record_title, { title: item.title }))}>{shared.record}</Button>}
      {item.may_move && source?.move ? (
        <Container layout="horizontal" gap="sm" alignItems="center">
          <DateTimePicker aria-label={words.move_to} value={value} onChange={next => setValue(next ?? '')} />
          <Button size="sm" variant="outline" disabled={!value} onClick={() => onMove(new Date(value).toISOString())}>{words.move}</Button>
        </Container>
      ) : null}
      {asking?.confirm ? (
        <Container layout="horizontal" gap="sm" alignItems="center" wrap data-calendar-confirm={asking.id}>
          <Text variant="body-sm">{asking.confirm.asks}</Text>
          <Button size="sm" variant={asking.tone === 'danger' ? 'danger' : 'primary'} onClick={() => { setAsking(null); void onRoad(asking); }}>{asking.confirm.yes}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>{asking.confirm.no}</Button>
        </Container>
      ) : actions.length ? (
        <Container layout="horizontal" gap="sm" alignItems="center" wrap>
          {actions.map(action => <Button key={action.id} size="sm" variant='outline' onClick={() => (action.confirm ? setAsking(action) : void onRoad(action))}>{action.label}</Button>)}
        </Container>
      ) : null}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Editing an event
// ---------------------------------------------------------------------------

/** Edit only supplied fields so existing guests, recurrence and reminders remain owned by the provider. */
export function EventEditor({ item, sources, onClose, onKept }: { item: Item; sources: SourceState[]; onClose: () => void; onKept: () => void }) {
  const [title, setTitle] = React.useState(item.title);
  const [about, setAbout] = React.useState(item.about ?? '');
  const [location, setLocation] = React.useState(item.location ?? '');
  const [start, setStart] = React.useState(item.all_day ? item.starts_at.slice(0, 10) : localInput(item.starts_at));
  const [end, setEnd] = React.useState(item.all_day ? item.ends_at ? addDays(item.ends_at.slice(0, 10), -1) : item.starts_at.slice(0, 10) : localInput(item.ends_at ?? new Date(Date.parse(item.starts_at) + 3_600_000).toISOString()));
  const [busy, setBusy] = React.useState(false);
  const [repeat, setRepeat] = React.useState<EventRepeatSetting>({ kind: 'keep' });
  const [customRepeat, setCustomRepeat] = React.useState(false);
  const [reminder, setReminder] = React.useState<EventReminderSetting>({ kind: 'keep' });
  const [properties, setProperties] = React.useState<EventPropertyDraft>(() => newEventPropertyDraft());
  const provider = useMeetingProvider();
  const source = sourceFor(item.source, sources);
  const keys = React.useRef(new Map<string, string>());
  const zone = item.all_day ? 'UTC' : deviceZone();
  const startIso = item.all_day ? `${start}T00:00:00Z` : new Date(start).toISOString();
  // A series' instance repeats by its series: the instance is edited as itself and its series is edited at the provider.
  const inSeries = Boolean(item.recurring_event_id);
  const valid = Boolean(title.trim() && start && end && (item.all_day ? end >= start : Date.parse(end) > Date.parse(start)));
  const save = async () => {
    if (busy || !valid) return;
    const input = { event_id: item.source_id, title: title.trim(), description: about, location,
      start: item.all_day ? { date: start } : { dateTime: new Date(start).toISOString(), timeZone: deviceZone() },
      end: item.all_day ? { date: addDays(end, 1) } : { dateTime: new Date(end).toISOString(), timeZone: deviceZone() },
      ...eventOptionFields(inSeries ? { kind: 'keep' } : repeat, reminder), ...eventPropertyFields(source, properties) };
    const value = JSON.stringify(input);
    if (!keys.current.has(value)) keys.current.set(value, crypto.randomUUID());
    setBusy(true);
    try { await calendarWrite(item.source, 'edit', input, keys.current.get(value)!); notify(words.event_kept, { kind: 'done' }); onKept(); }
    catch (error) { notify(errorWords(error), { kind: 'error' }); }
    finally { setBusy(false); }
  };
  const callKind: CallKind = item.conference_url ? 'meet' : location && location === providerLink(provider) ? 'link' : 'none';
  return <Container layout="vertical" gap="sm" padding="md" data-calendar-event-editor>
    <Text variant="heading-xs">{words.event_edit}</Text>
    <Input aria-label={words.new_title} value={title} onChange={event => setTitle(event.target.value)} />
    <Container layout="horizontal" gap="sm" wrap>
      {item.all_day ? <DatePicker label={words.new_starts} aria-label={words.new_starts} value={start} onChange={next => setStart(next ?? '')} />
        : <DateTimePicker aria-label={words.new_starts} value={start} onChange={next => setStart(next ?? '')} />}
      {item.all_day ? <DatePicker label={words.new_ends_all_day} aria-label={words.new_ends_all_day} min={start} value={end} onChange={next => setEnd(next ?? '')} />
        : <DateTimePicker aria-label={words.new_ends} value={end} onChange={next => setEnd(next ?? '')} />}
    </Container>
    <Container layout="horizontal" gap="xs" alignItems="center">
      <Input aria-label={words.new_location} placeholder={words.new_location_placeholder} value={location} onChange={event => setLocation(event.target.value)} />
      <VideoCallControl kind={callKind} offersMeet={false} existing link={item.conference_url ?? location} provider={provider} disabled={busy}
        onMeet={() => undefined} onLink={setLocation} onRemove={() => setLocation('')} />
    </Container>
    <Textarea aria-label={words.new_about} placeholder={words.new_about} value={about} onChange={event => setAbout(event.target.value)} rows={2} />
    {customRepeat ? <CustomRepeatPanel allDay={item.all_day} rule={repeat.kind === 'set' ? repeat.value : null}
      onSave={rule => { setRepeat({ kind: 'set', value: rule }); setCustomRepeat(false); }} onCancel={() => setCustomRepeat(false)} /> : null}
    <Container layout="horizontal" alignItems="center" wrap gap="xs" className="event-editor-toolbar">
      <EventOptions variant="compact" {...formsData.event_options.presentation} repeat={repeat} reminder={reminder} repeatChoices={inSeries ? [] : repeatChoicesFor(startIso, zone, repeat)}
        customRepeat={inSeries ? undefined : { label: words.repeat_custom, onSelect: () => setCustomRepeat(true) }} words={formsData.event_options.words} reminderData={formsData.reminders}
        onRepeatChange={setRepeat} onReminderChange={setReminder} disabled={busy} />
      <EventPropertyControls source={source} item={item} value={properties} onChange={setProperties} disabled={busy} />
    </Container>
    {inSeries ? <Button size="sm" variant="ghost" onClick={() => runRoad({ href: item.link ?? '' }, {})}>{words.event_series}</Button> : null}
    <Text variant="caption">{words.event_guests_notice}</Text>
    <Container layout="horizontal" gap="sm" wrap>
      <Button size="sm" variant="primary" disabled={busy || !valid} onClick={() => save()}>{words.event_save}</Button>
      <Button size="sm" variant="ghost" onClick={onClose}>{shared.close}</Button>
    </Container>
  </Container>;
}

// ---------------------------------------------------------------------------
// Putting an event on
// ---------------------------------------------------------------------------

type GridAnchor = { x: number; y: number; width: number; height: number };

/** Putting an event on: what it is, when, who is invited, where (a place or a call), how it repeats and what it shows as; the
 *  focused space first. With a grid anchor it opens as a popover at the selection, otherwise where it is placed. */
export function NewMeeting({ places, place, at, until, anchor, sources, accounts, toneOf, draft, defaultTime, defaultDuration, defaultSourceId, defaultPrivate = false, defaultVideo = false, quietSuccess = false, onNeedAccounts, onClose, onKept }: {
  places: { id: string; title: string }[]; place: string | null; at: string | null; until?: string | null; anchor?: GridAnchor | null; sources: SourceState[];
  accounts?: CalendarAccount[]; toneOf?: (sourceId: string) => string | undefined; draft?: Item | null; defaultTime: string; defaultDuration: number;
  defaultSourceId?: string | null; defaultPrivate?: boolean; defaultVideo?: boolean; quietSuccess?: boolean; onNeedAccounts?: () => void; onClose: () => void; onKept: () => void;
}) {
  const start = draft?.starts_at ?? at ?? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const duration = draft ? screenData.meeting_minutes : defaultDuration;
  const end = draft?.ends_at ?? (until && !draft ? until : new Date(Date.parse(start) + duration * 60_000).toISOString());
  const [title, setTitle] = React.useState(draft?.title ?? '');
  const timedStart = draft?.all_day ? `${start.slice(0, 10)}T${defaultTime}` : localInput(start);
  const timedEnd = draft?.all_day ? localInput(new Date(Date.parse(timedStart) + duration * 60_000).toISOString()) : localInput(end);
  const [starts, setStarts] = React.useState(timedStart);
  const [ends, setEnds] = React.useState(timedEnd);
  const [startDate, setStartDate] = React.useState(() => draft?.all_day ? start.slice(0, 10) : localInput(start).slice(0, 10));
  const [inclusiveEndDate, setInclusiveEndDate] = React.useState(() => draft?.all_day ? draft.ends_at ? addDays(end.slice(0, 10), -1) : start.slice(0, 10) : localInput(end).slice(0, 10));
  const [allDay, setAllDay] = React.useState(Boolean(draft?.all_day));
  const [endValid, setEndValid] = React.useState(true);
  const writable = sources.filter(source => source.calendar_actions?.create);
  const destinations = [...writable.map(source => ({ id: `source:${source.id}`, title: sourceLabel(source.id, sources) })), ...places.map(row => ({ id: `space:${row.id}`, title: row.title }))];
  const savedDefault = defaultSourceId && destinations.some(row => row.id === `source:${defaultSourceId}`) ? `source:${defaultSourceId}` : null;
  // A meeting begun with Meet goes to a calendar that can make the call: the saved default when it can, else the first that can.
  const callable = (id: string | null | undefined) => Boolean(id && sources.find(source => source.id === id)?.calendar_actions?.['create-video-call']);
  const callCalendar = defaultVideo && !draft ? (callable(defaultSourceId) ? savedDefault : writable.find(source => callable(source.id)) ? `source:${writable.find(source => callable(source.id))!.id}` : null) : null;
  const [where, setWhere] = React.useState(draft ? `source:${draft.source}` : callCalendar ?? (place ? `space:${place}` : savedDefault ?? destinations[0]?.id ?? ''));
  const [about, setAbout] = React.useState(draft?.about ?? '');
  const [location, setLocation] = React.useState(draft?.location ?? '');
  const [guests, setGuests] = React.useState<string[]>([]);
  const [guestText, setGuestText] = React.useState('');
  const [guestError, setGuestError] = React.useState<string | null>(null);
  const [video, setVideo] = React.useState(defaultVideo);
  const [repeat, setRepeat] = React.useState<EventRepeatSetting>({ kind: 'set', value: noRepeat });
  const [customRepeat, setCustomRepeat] = React.useState(false);
  const [reminder, setReminder] = React.useState<EventReminderSetting>({ kind: 'keep' });
  const [properties, setProperties] = React.useState<EventPropertyDraft>(() => draft ? eventPropertyDraftFor(draft, sourceFor(draft.source, sources)) : newEventPropertyDraft(defaultPrivate));
  const [busy, setBusy] = React.useState(false);
  const requests = React.useRef(new Map<string, string>());
  const provider = useMeetingProvider();
  const touched = React.useRef(false);
  const sourceId = where.startsWith('source:') ? where.slice(7) : null;
  const selectedSource = sourceId ? sourceFor(sourceId, sources) : undefined;
  const supportsAllDay = selectedSource?.calendar_actions?.create?.supports_all_day === true;
  const offersMeet = Boolean(selectedSource?.calendar_actions?.['create-video-call']);
  React.useEffect(() => { onNeedAccounts?.(); }, [onNeedAccounts]);
  // The person's default call goes on a new event once, unless they have already touched the call or the place.
  React.useEffect(() => {
    if (draft || touched.current || defaultVideo) return;
    if (provider.provider === 'meet' && offersMeet) setVideo(true);
    else if (providerLink(provider)) setLocation(current => current || providerLink(provider));
  }, [draft, provider, offersMeet, defaultVideo]);
  const changeAllDay = (value: boolean) => {
    if (value && !allDay) { setStartDate(starts.slice(0, 10)); setInclusiveEndDate(ends.slice(0, 10)); }
    if (!value && allDay) { setStarts(`${startDate}T${starts.slice(11)}`); setEnds(`${inclusiveEndDate}T${ends.slice(11)}`); }
    setAllDay(value);
  };
  const disconnected = sourceId && sources.find(row => row.id === sourceId)?.connected === false;
  const datesValid = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(inclusiveEndDate) && inclusiveEndDate >= startDate;
  const ready = Boolean(title.trim() && (allDay ? supportsAllDay && datesValid : starts && ends && Date.parse(ends) > Date.parse(starts) && endValid) && where && !disconnected);
  // Calendars are listed by account, each as its account names it; the closed select says the same words.
  const groups = groupSourcesByAccount(writable.map(source => ({ ...source, label: sourceLabel(source.id, sources), colorTone: toneOf?.(source.id) ?? source.look?.tone }) as unknown as CalendarControlSource), accounts);
  const titleBySource = new Map([...groups.values()].flatMap(group => group.choices.map(choice => [choice.source.id, choice.label] as const)));
  const placeTitle = (sourceId ? titleBySource.get(sourceId) : null) ?? destinations.find(row => row.id === where)?.title ?? '';
  const zone = allDay ? 'UTC' : deviceZone();
  const startIso = allDay ? `${startDate || start.slice(0, 10)}T00:00:00Z` : starts ? new Date(starts).toISOString() : start;
  const addGuestText = (text: string) => {
    const result = addGuests(guests, text, formsData.guests.max);
    setGuests(result.guests);
    const problem = result.invalid.length ? fill(words.new_guest_invalid, { email: result.invalid[0] }) : result.over.length ? fill(words.new_guests_limit, { count: formsData.guests.max }) : null;
    setGuestError(problem);
    setGuestText(result.invalid.join(' '));
  };
  const putOn = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (sourceId) {
        const action = video && offersMeet ? 'create-video-call' : 'create';
        const input = { title: title.trim(), ...(allDay ? { start_date: startDate, end_date: addDays(inclusiveEndDate, 1) } : { start: new Date(starts).toISOString(), end: new Date(ends).toISOString(), time_zone: deviceZone() }), ...(about.trim() ? { description: about.trim() } : {}), ...(location.trim() ? { location: location.trim() } : {}), ...guestFields(guestText.trim() ? addGuests(guests, guestText, formsData.guests.max).guests : guests), ...eventOptionFields(repeat, reminder), ...eventPropertyFields(selectedSource, properties) };
        const value = JSON.stringify([sourceId, action, input]);
        if (!requests.current.has(value)) requests.current.set(value, crypto.randomUUID());
        await calendarWrite(sourceId, action, input, requests.current.get(value)!);
      }
      else await postJson(fill(formsData.new_event.post, { place: encodeURIComponent(where.slice(6)) }), { title: title.trim(), starts_at: new Date(starts).toISOString(), ends_at: new Date(ends).toISOString(), ...(about.trim() ? { about: about.trim() } : {}) });
      if (!quietSuccess) notify(fill(words.new_done, { title: title.trim(), place: placeTitle }), { kind: 'done' });
      onKept();
    } catch (error) {
      notify(errorWords(error), { kind: 'error' });
    } finally { setBusy(false); }
  };
  const callKind: CallKind = video ? 'meet' : location && location === providerLink(provider) ? 'link' : 'none';
  const form = (
    <Container layout="vertical" gap="sm" padding="md" data-calendar-new-meeting className="calendar-quick-create">
      <Text variant="heading-xs">{draft ? words.event_duplicate : shared.new}</Text>
      {draft ? <Text variant="caption">{words.event_duplicate_review}</Text> : null}
      <Input aria-label={words.new_title} placeholder={words.new_title_placeholder} value={title} onChange={event => setTitle(event.target.value)} />
      <Textarea aria-label={words.new_about} placeholder={words.new_description} value={about} onChange={event => setAbout(event.target.value)} rows={2} />
      {sourceId ? <Container layout="vertical" gap="xs" data-calendar-guests>
        {guests.length ? <Container layout="horizontal" gap="xs" wrap>
          {guests.map(email => <Badge key={email} size="sm" variant="muted-outline">{email}<Button size="icon-sm" variant="ghost" aria-label={fill(words.new_guest_remove, { email })} onClick={() => setGuests(removeGuest(guests, email))}><NamedIcon name="X" size="xs" aria-hidden /></Button></Badge>)}
        </Container> : null}
        <Input inputMode="email" aria-label={words.new_guests} placeholder={words.new_guests_placeholder} value={guestText}
          onChange={event => { const text = event.target.value; if (/[,;\s]$/.test(text)) addGuestText(text); else setGuestText(text); }}
          onKeyDown={event => { if (event.key === 'Enter' && guestText.trim()) { event.preventDefault(); addGuestText(guestText); } }}
          onBlur={() => { if (guestText.trim()) addGuestText(guestText); }}
          onPaste={event => { const text = event.clipboardData.getData('text'); if (/[,;\s]/.test(text.trim())) { event.preventDefault(); addGuestText(`${guestText} ${text}`); } }} />
        {guestError ? <Text variant="caption" color="error">{guestError}</Text> : null}
        {guests.length ? <Text variant="caption">{words.attendee_invitation}</Text> : null}
      </Container> : null}
      <Container layout="horizontal" gap="xs" alignItems="center">
        <Input aria-label={words.new_location} placeholder={words.new_location_placeholder} value={location} onChange={event => { touched.current = true; setLocation(event.target.value); }} />
        {sourceId ? <VideoCallControl kind={callKind} offersMeet={offersMeet} existing={false} link={location} provider={provider} disabled={busy}
          onMeet={() => { touched.current = true; setVideo(true); }} onLink={link => { touched.current = true; setVideo(false); setLocation(link); }}
          onRemove={() => { touched.current = true; setVideo(false); if (location === providerLink(provider)) setLocation(''); }} /> : null}
      </Container>
      {allDay ? <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <DatePicker label={words.new_starts} aria-label={words.new_starts} value={startDate} onChange={next => setStartDate(next ?? '')} />
        <DatePicker label={words.new_ends_all_day} aria-label={words.new_ends_all_day} min={startDate} value={inclusiveEndDate} onChange={next => setInclusiveEndDate(next ?? '')} />
      </Container> : <Container layout="horizontal" gap="sm" alignItems="center" wrap>
        <DateTimePicker aria-label={words.new_starts} value={starts} onChange={next => setStarts(next ?? '')} />
        <DateTimePicker aria-label={words.new_ends} value={ends} onChange={next => setEnds(next ?? '')} onValidityChange={setEndValid} />
      </Container>}
      {sourceId && supportsAllDay ? <Container layout="horizontal" gap="xs" alignItems="center"><Text variant="caption">{words.new_all_day}</Text><Switch label={words.new_all_day} checked={allDay} onCheckedChange={changeAllDay} size="sm" /></Container> : null}
      {disconnected && selectedSource?.connect ? <Button size="sm" onClick={() => runRoad({ href: selectedSource.connect!.href }, {})}>{selectedSource.connect.label}</Button> : null}
      {(allDay && Boolean(inclusiveEndDate && startDate && inclusiveEndDate < startDate)) || (!allDay && Boolean(starts && ends && Date.parse(ends) <= Date.parse(starts))) ? <Text variant="caption" color="error">{allDay ? words.end_on_or_after_start : words.end_after_start}</Text> : null}
      {customRepeat ? <CustomRepeatPanel allDay={allDay} rule={repeat.kind === 'set' ? repeat.value : null}
        onSave={rule => { setRepeat({ kind: 'set', value: rule }); setCustomRepeat(false); }} onCancel={() => setCustomRepeat(false)} /> : null}
      <Select value={where} onValueChange={value => { setWhere(typeof value === 'string' ? value : ''); setProperties(newEventPropertyDraft(defaultPrivate)); changeAllDay(false); setVideo(false); }}>
        <SelectTrigger aria-label={words.new_place}>
          <SelectValue>{placeTitle || words.new_place}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {[...groups].map(([key, group]) => <SelectGroup key={key}>
            {group.label ? <SelectGroupLabel>{group.label}</SelectGroupLabel> : null}
            {group.choices.map(({ source, label }) => <SelectItem key={source.id} value={`source:${source.id}`} aria-label={label}>
              <Container layout="horizontal" gap="xs" alignItems="center">
                {toneOf?.(source.id) ?? source.look?.tone ? <ColorDot tone={(toneOf?.(source.id) ?? source.look?.tone)!} /> : null}
                <Text variant="body" truncate>{label}</Text>
              </Container>
            </SelectItem>)}
          </SelectGroup>)}
          {places.length ? <SelectGroup>
            <SelectGroupLabel>{words.new_calendar_spaces}</SelectGroupLabel>
            {places.map(row => <SelectItem key={row.id} value={`space:${row.id}`}>{row.title}</SelectItem>)}
          </SelectGroup> : null}
        </SelectPopup>
      </Select>
      <Container layout="horizontal" alignItems="center" wrap gap="xs" className="event-editor-toolbar" data-calendar-new-meeting-toolbar>
        {sourceId ? <>
          <EventOptions variant="compact" {...formsData.event_options.presentation} repeat={repeat} reminder={reminder} repeatChoices={repeatChoicesFor(startIso, zone, repeat)}
            customRepeat={{ label: words.repeat_custom, onSelect: () => setCustomRepeat(true) }} words={formsData.event_options.words} reminderData={formsData.reminders}
            onRepeatChange={setRepeat} onReminderChange={setReminder} disabled={busy} />
          <EventPropertyControls source={selectedSource} value={properties} onChange={setProperties} disabled={busy} />
        </> : null}
      </Container>
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button size="sm" variant="primary" disabled={!ready || busy} onClick={putOn}>{words.new_put_on}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{words.new_cancel}</Button>
      </Container>
    </Container>
  );
  const virtual = React.useMemo(() => (anchor ? { getBoundingClientRect: () => DOMRect.fromRect(anchor) } : null), [anchor]);
  if (!virtual) return form;
  return (
    <Popover open onOpenChange={open => { if (!open) onClose(); }}>
      <PopoverPopup anchor={virtual} side="right" align="start" className="w-96 max-w-[90vw]" portalProps={{ className: 'coss-ui', keepMounted: true }}>
        {form}
      </PopoverPopup>
    </Popover>
  );
}
