// packages/calendar-booker/show/BookingsInbox.tsx
//
// Audience-framed calendar surface. The default mode remains the owner's booking
// inbox; member audiences can render the same calendar substrate as practice
// windows plus scheduled practice sessions through surfaceInput DATA.

import * as React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Button } from '@/packages/ui/show/button/Button';
import { Badge } from '@/packages/ui/show/badge/Badge';
import { Input } from '@/packages/ui/show/input';

const BOOKING_KIND = 'calendar-booker.booking';
const PRACTICE_SESSION_KIND = 'calendar-booker.practice-session';
const AVAILABILITY_KIND = 'availability-template';

const DAYS = [
  { id: 'sun', label: 'Sun', dow: 0 },
  { id: 'mon', label: 'Mon', dow: 1 },
  { id: 'tue', label: 'Tue', dow: 2 },
  { id: 'wed', label: 'Wed', dow: 3 },
  { id: 'thu', label: 'Thu', dow: 4 },
  { id: 'fri', label: 'Fri', dow: 5 },
  { id: 'sat', label: 'Sat', dow: 6 },
];

interface Booking {
  id: string;
  attendee: string;
  when: string;
  status: string;
}

interface PracticeSession {
  id: string;
  title: string;
  when: string;
  status: string;
}

interface SavedAvailability {
  dayIds: string[];
  start: string;
  end: string;
  duration: string;
}

interface PracticeCalendarCopy {
  title: string;
  subtitle: string;
  windowsLabel: string;
  sessionsLabel: string;
  noWindows: string;
  noSessions: string;
}

export interface BookingsInboxProps {
  audience?: string;
  surfaceInput?: Record<string, unknown> | null;
}

const DEFAULT_PRACTICE_COPY: PracticeCalendarCopy = {
  title: 'Practice calendar',
  subtitle: 'Your saved practice windows and scheduled practice sessions.',
  windowsLabel: 'Practice windows',
  sessionsLabel: 'Scheduled practices',
  noWindows: 'No practice windows saved yet. Open Availability and choose when you can usually get on court.',
  noSessions: 'No scheduled practices yet. Your AI coach can use saved windows to plan them.',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readSurfaceInput(props: BookingsInboxProps): Record<string, unknown> {
  return props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput
    : {};
}

function memberPracticeMode(props: BookingsInboxProps): boolean {
  const input = readSurfaceInput(props);
  const audience = text(props.audience) ?? text(input.audience);
  const mode = text(input.calendar_mode) ?? text(input.calendarMode);
  return audience === 'member' || mode === 'member-practice';
}

function readPracticeCopy(input: Record<string, unknown>): PracticeCalendarCopy {
  const raw = input.practice_calendar_copy && typeof input.practice_calendar_copy === 'object' && !Array.isArray(input.practice_calendar_copy)
    ? input.practice_calendar_copy as Record<string, unknown>
    : input.practiceCalendarCopy && typeof input.practiceCalendarCopy === 'object' && !Array.isArray(input.practiceCalendarCopy)
      ? input.practiceCalendarCopy as Record<string, unknown>
      : {};
  return {
    title: text(raw.title) ?? DEFAULT_PRACTICE_COPY.title,
    subtitle: text(raw.subtitle) ?? DEFAULT_PRACTICE_COPY.subtitle,
    windowsLabel: text(raw.windows_label) ?? text(raw.windowsLabel) ?? DEFAULT_PRACTICE_COPY.windowsLabel,
    sessionsLabel: text(raw.sessions_label) ?? text(raw.sessionsLabel) ?? DEFAULT_PRACTICE_COPY.sessionsLabel,
    noWindows: text(raw.no_windows) ?? text(raw.noWindows) ?? DEFAULT_PRACTICE_COPY.noWindows,
    noSessions: text(raw.no_sessions) ?? text(raw.noSessions) ?? DEFAULT_PRACTICE_COPY.noSessions,
  };
}

function dayLabel(dow: number): string {
  return DAYS.find((day) => day.dow === dow)?.label ?? `Day ${dow}`;
}

function feedPayloads(feed: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(feed) ? feed : (feed as { records?: unknown[] } | null)?.records ?? [];
  return (rows as unknown[])
    .map((row) => {
      const record = row as { payload?: unknown } | null;
      const payload = record && typeof record === 'object' && 'payload' in record ? record.payload : row;
      return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    })
    .filter((payload): payload is Record<string, unknown> => payload !== null);
}

function readSavedAvailability(feed: unknown): SavedAvailability | null {
  const template = feedPayloads(feed).find((payload) => payload.kind === AVAILABILITY_KIND);
  if (!template) return null;
  const recurrence = template.recurrence_rule as { days?: unknown; start_time?: unknown; end_time?: unknown } | undefined;
  const dows = Array.isArray(recurrence?.days) ? (recurrence.days as unknown[]).map(Number) : [];
  return {
    dayIds: DAYS.filter((day) => dows.includes(day.dow)).map((day) => day.id),
    start: typeof recurrence?.start_time === 'string' ? recurrence.start_time : '09:00',
    end: typeof recurrence?.end_time === 'string' ? recurrence.end_time : '17:00',
    duration: typeof template.duration_minutes === 'number' ? String(template.duration_minutes) : '30',
  };
}

function readBookings(feed: unknown): Booking[] {
  return feedPayloads(feed)
    .filter((payload) => payload.kind === BOOKING_KIND)
    .map((payload) => ({
      id: String(payload.id ?? ''),
      attendee: typeof payload.attendee_name === 'string' ? payload.attendee_name : 'Someone',
      when: typeof payload.scheduled_start === 'string' ? payload.scheduled_start : '',
      status: typeof payload.status === 'string' ? payload.status : 'pending',
    }))
    .filter((booking) => booking.id !== '');
}

function readPracticeSessions(feed: unknown): PracticeSession[] {
  return feedPayloads(feed)
    .filter((payload) => payload.kind === PRACTICE_SESSION_KIND)
    .map((payload) => ({
      id: String(payload.id ?? ''),
      title: typeof payload.title === 'string' ? payload.title : 'Practice session',
      when: typeof payload.scheduled_start === 'string' ? payload.scheduled_start : '',
      status: typeof payload.status === 'string' ? payload.status : 'planned',
    }))
    .filter((session) => session.id !== '')
    .sort((left, right) => left.when.localeCompare(right.when));
}

function whenLabel(iso: string): string {
  if (!iso) return 'Time not set';
  const [date, time] = iso.split('T');
  return time ? `${date} · ${time}` : date;
}

function clockLabel(time: string): string {
  const [hourText, minuteText = '00'] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return time;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const twelveHour = hour % 12 || 12;
  return `${twelveHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function durationLabel(minutesText: string): string {
  const minutes = Number(minutesText);
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutesText}-min`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hr${hours === 1 ? '' : 's'}`;
  }
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return `${hours} hr ${remaining} min`;
  }
  return `${minutes} min`;
}

function windowLabel(availability: SavedAvailability): string {
  return `${clockLabel(availability.start)}-${clockLabel(availability.end)} · ${durationLabel(availability.duration)} sessions`;
}

function upcomingPracticeDays(availability: SavedAvailability | null): { key: string; day: string; date: string; window: string }[] {
  if (!availability) return [];
  const selectedDows = DAYS.filter((day) => availability.dayIds.includes(day.id)).map((day) => day.dow);
  if (!selectedDows.length) return [];
  const today = new Date();
  const rows: { key: string; day: string; date: string; window: string }[] = [];
  for (let offset = 0; offset < 14 && rows.length < 6; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    if (!selectedDows.includes(date.getDay())) continue;
    rows.push({
      key: date.toISOString().slice(0, 10),
      day: date.toLocaleDateString(undefined, { weekday: 'short' }),
      date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      window: windowLabel(availability),
    });
  }
  return rows;
}

const STATUS_TONE: Record<string, 'warning' | 'success' | 'muted'> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'muted',
};

async function writeBooking(booking: Booking): Promise<void> {
  await sendRequestToBitfieldTarget({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes: [
        {
          address_label: `package::calendar-booker::booking::${booking.id}`,
          address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          payload: {
            kind: BOOKING_KIND,
            id: booking.id,
            attendee_name: booking.attendee,
            scheduled_start: booking.when,
            status: booking.status,
          },
        },
      ],
    },
  });
}

function PracticeCalendar({
  availability,
  sessions,
  copy,
}: {
  availability: SavedAvailability | null;
  sessions: PracticeSession[];
  copy: PracticeCalendarCopy;
}): React.ReactElement {
  const practiceDays = React.useMemo(() => upcomingPracticeDays(availability), [availability]);
  return (
    <Container height="full" overflow="auto" width="full" padding="xl">
      <Container layout="vertical" gap="lg" maxWidth="5xl" width="full" centered>
        <Container layout="horizontal" gap="lg" alignItems="end" justifyContent="between" wrap>
          <Container layout="vertical" gap="xs">
            <Text variant="heading-lg">{copy.title}</Text>
            <Text variant="body" color="muted" leading="relaxed">{copy.subtitle}</Text>
          </Container>
          {availability ? (
            <Badge variant="success">{DAYS.filter((day) => availability.dayIds.includes(day.id)).map((day) => day.label).join(', ')}</Badge>
          ) : null}
        </Container>

        <Container layout="grid" gap="lg" gridCols={2}>
          <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
            <Container layout="vertical" gap="lg">
              <Container layout="vertical" gap="xs">
                <Text variant="overline">{copy.windowsLabel}</Text>
                <Text variant="heading">This week on court</Text>
              </Container>
              {practiceDays.length > 0 ? (
                <Container layout="vertical" gap="sm">
                  {practiceDays.map((day) => (
                    <Container
                      key={day.key}
                      layout="horizontal"
                      gap="md"
                      alignItems="center"
                      justifyContent="between"
                      wrap
                      padding="md"
                      rounded="md"
                      background="tertiary"
                    >
                      <Container layout="vertical" gap="xs">
                        <Text variant="body" weight="semibold">{day.day}</Text>
                        <Text variant="body-xs" color="muted">{day.date}</Text>
                      </Container>
                      <Text variant="body-sm" color="strong">{day.window}</Text>
                    </Container>
                  ))}
                </Container>
              ) : (
                <Container padding="lg" rounded="md" background="tertiary">
                  <Text variant="body-sm" color="muted">{copy.noWindows}</Text>
                </Container>
              )}
            </Container>
          </Card>

          <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
            <Container layout="vertical" gap="lg">
              <Container layout="vertical" gap="xs">
                <Text variant="overline">{copy.sessionsLabel}</Text>
                <Text variant="heading">Next practices</Text>
              </Container>
              {sessions.length > 0 ? (
                <Container layout="vertical" gap="sm">
                  {sessions.map((session) => (
                    <Container key={session.id} layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap padding="md" rounded="md" background="tertiary">
                      <Container layout="vertical" gap="xs">
                        <Text variant="body" weight="semibold">{session.title}</Text>
                        <Text variant="body-xs" color="muted">{whenLabel(session.when)}</Text>
                      </Container>
                      <Badge variant={STATUS_TONE[session.status] ?? 'muted'}>{session.status}</Badge>
                    </Container>
                  ))}
                </Container>
              ) : (
                <Container padding="lg" rounded="md" background="tertiary">
                  <Text variant="body-sm" color="muted">{copy.noSessions}</Text>
                </Container>
              )}
            </Container>
          </Card>
        </Container>
      </Container>
    </Container>
  );
}

function OwnerBookingsInbox({ published }: { published: unknown }): React.ReactElement {
  const bookings = React.useMemo(() => readBookings(published), [published]);
  const pending = bookings.filter((booking) => booking.status === 'pending');
  const settled = bookings.filter((booking) => booking.status !== 'pending');

  const [attendee, setAttendee] = React.useState('');
  const [date, setDate] = React.useState('');
  const [time, setTime] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const canAdd = attendee.trim().length > 0 && date !== '' && time !== '' && !busy;

  async function addBooking(): Promise<void> {
    if (!canAdd) return;
    setBusy(true);
    try {
      await writeBooking({ id: `b-${Date.now()}`, attendee: attendee.trim(), when: `${date}T${time}`, status: 'pending' });
      setAttendee('');
      setDate('');
      setTime('');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(booking: Booking, status: string): Promise<void> {
    setBusy(true);
    try {
      await writeBooking({ ...booking, status });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Container layout="vertical" gap="lg">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-md">Bookings</Text>
          <Text variant="body-sm" color="muted">Confirm the people who want time with you.</Text>
        </Container>

        <Container layout="vertical" gap="sm">
          <Text variant="label">Add a booking</Text>
          <Input placeholder="Who is booking?" value={attendee} onChange={(event) => setAttendee(event.currentTarget.value)} />
          <Container layout="horizontal" gap="sm">
            <Input type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} />
            <Input type="time" value={time} onChange={(event) => setTime(event.currentTarget.value)} />
            <Button variant="secondary" size="md" onClick={addBooking} disabled={!canAdd}>Add</Button>
          </Container>
        </Container>

        {pending.length ? (
          <Container layout="vertical" gap="sm">
            <Text variant="label">{pending.length} waiting on you</Text>
            {pending.map((booking) => (
              <Container key={booking.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="body">{booking.attendee}</Text>
                  <Text variant="body-xs" color="muted">{whenLabel(booking.when)}</Text>
                </Container>
                <Container layout="horizontal" gap="sm">
                  <Button variant="primary" size="sm" onClick={() => setStatus(booking, 'confirmed')} disabled={busy}>Confirm</Button>
                  <Button variant="ghost" size="sm" onClick={() => setStatus(booking, 'cancelled')} disabled={busy}>Cancel</Button>
                </Container>
              </Container>
            ))}
          </Container>
        ) : (
          <Text variant="body-sm" color="muted">Nothing waiting on you right now.</Text>
        )}

        {settled.length ? (
          <Container layout="vertical" gap="sm">
            <Text variant="label">Recent</Text>
            {settled.map((booking) => (
              <Container key={booking.id} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap>
                <Container layout="vertical" gap="xs">
                  <Text variant="body">{booking.attendee}</Text>
                  <Text variant="body-xs" color="muted">{whenLabel(booking.when)}</Text>
                </Container>
                <Badge variant={STATUS_TONE[booking.status] ?? 'muted'}>{booking.status}</Badge>
              </Container>
            ))}
          </Container>
        ) : null}
      </Container>
    </Card>
  );
}

export function BookingsInbox(props: BookingsInboxProps = {}): React.ReactElement {
  const published = useBitfieldData('published-records');
  const surfaceInput = readSurfaceInput(props);
  const practiceMode = memberPracticeMode(props);
  const availability = React.useMemo(() => readSavedAvailability(published), [published]);
  const practiceSessions = React.useMemo(() => readPracticeSessions(published), [published]);
  const practiceCopy = React.useMemo(() => readPracticeCopy(surfaceInput), [surfaceInput]);
  if (practiceMode) {
    return <PracticeCalendar availability={availability} sessions={practiceSessions} copy={practiceCopy} />;
  }
  return <OwnerBookingsInbox published={published} />;
}

export default BookingsInbox;
