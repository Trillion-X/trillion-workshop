// packages/calendar-booker/show/AvailabilitySetupForm.tsx
//
// Audience-framed availability setup: pick weekdays, a daily time window, and a
// session length, then write ONE availability-template record (the shape
// generate-availability-slots reads). The visible vocabulary comes from an
// audience presentation profile; the underlying engine stays calendar-generic.

import * as React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Card } from '@/packages/ui/show/card/Card';
import { Container } from '@/packages/ui/show/container/container';
import { Text } from '@/packages/ui/show/text/Text';
import { Button } from '@/packages/ui/show/button/Button';
import { Badge } from '@/packages/ui/show/badge/Badge';
import { Input } from '@/packages/ui/show/input';
import { SelectablePillBar } from '@/packages/ui/show/selectable-pill-bar/SelectablePillBar';
import { SegmentedControl } from '@/packages/ui/show/segmented-control/SegmentedControl';
import {
  resolveAvailabilitySetupPresentationProfile,
  type AvailabilitySetupPresentationProfile,
} from '@/packages/calendar-booker/do-work/scheduling-offer-feed';

interface DayOption {
  id: string;
  label: string;
  dow: number;
}

const DAYS: readonly DayOption[] = [
  { id: 'mon', label: 'Mon', dow: 1 },
  { id: 'tue', label: 'Tue', dow: 2 },
  { id: 'wed', label: 'Wed', dow: 3 },
  { id: 'thu', label: 'Thu', dow: 4 },
  { id: 'fri', label: 'Fri', dow: 5 },
  { id: 'sat', label: 'Sat', dow: 6 },
  { id: 'sun', label: 'Sun', dow: 0 },
];

const DURATION_PRESETS = [
  { id: '30', label: '30 min' },
  { id: '60', label: '1 hr' },
  { id: '90', label: '90 min' },
  { id: '120', label: '2 hr' },
  { id: 'custom', label: 'Custom' },
];

const AVAILABILITY_ADDRESS = 'package::calendar-booker::availability-template::default';
const AVAILABILITY_KIND = 'availability-template';

function labelForDayIds(dayIds: readonly string[]): string {
  const labels = DAYS.filter((day) => dayIds.includes(day.id)).map((day) => day.label);
  return labels.length ? labels.join(', ') : 'No days yet';
}

function isPresetDuration(value: string): boolean {
  return DURATION_PRESETS.some((preset) => preset.id === value && preset.id !== 'custom');
}

function durationModeFor(value: string): string {
  return isPresetDuration(value) ? value : 'custom';
}

function normalizeDurationMinutes(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function durationLabel(minutes: number | null): string {
  if (!minutes) return 'Set length';
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

interface SavedAvailability {
  dayIds: string[];
  start: string;
  end: string;
  duration: string;
}

type SurfaceInput = Record<string, unknown>;

export interface AvailabilitySetupFormProps {
  audience?: string;
  presentationProfile?: AvailabilitySetupPresentationProfile | null;
  surfaceInput?: SurfaceInput | null;
}

function asRecord(value: unknown): SurfaceInput | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SurfaceInput : null;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPresentationProfile(
  props: AvailabilitySetupFormProps,
): { profile: AvailabilitySetupPresentationProfile | null; audience?: string } {
  const input = asRecord(props.surfaceInput);
  const profile =
    props.presentationProfile
    ?? (asRecord(input?.availability_setup_presentation_profile) as AvailabilitySetupPresentationProfile | null)
    ?? (asRecord(input?.audience_presentation_profile) as AvailabilitySetupPresentationProfile | null)
    ?? (asRecord(input?.presentation_profile) as AvailabilitySetupPresentationProfile | null)
    ?? null;
  return {
    profile,
    audience: props.audience ?? asText(input?.audience),
  };
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
  const dows = Array.isArray(recurrence?.days) ? (recurrence?.days as unknown[]).map(Number) : [];
  return {
    dayIds: DAYS.filter((day) => dows.includes(day.dow)).map((day) => day.id),
    start: typeof recurrence?.start_time === 'string' ? recurrence.start_time : '09:00',
    end: typeof recurrence?.end_time === 'string' ? recurrence.end_time : '17:00',
    duration: typeof template.duration_minutes === 'number' ? String(template.duration_minutes) : '30',
  };
}

export function AvailabilitySetupForm(props: AvailabilitySetupFormProps = {}): React.ReactElement {
  const published = useBitfieldData('published-records');
  const saved = React.useMemo(() => readSavedAvailability(published), [published]);
  const presentationInput = React.useMemo(() => readPresentationProfile(props), [props]);
  const presentation = React.useMemo(
    () => resolveAvailabilitySetupPresentationProfile(presentationInput.profile, presentationInput.audience),
    [presentationInput],
  );

  const [dayIds, setDayIds] = React.useState<string[]>(saved?.dayIds ?? ['mon', 'tue', 'wed', 'thu', 'fri']);
  const [start, setStart] = React.useState(saved?.start ?? '09:00');
  const [end, setEnd] = React.useState(saved?.end ?? '17:00');
  const initialDuration = saved?.duration ?? '60';
  const [durationMode, setDurationMode] = React.useState(durationModeFor(initialDuration));
  const [customDuration, setCustomDuration] = React.useState(isPresetDuration(initialDuration) ? '480' : initialDuration);
  const [state, setState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const selectedDurationMinutes = React.useMemo(
    () => normalizeDurationMinutes(durationMode === 'custom' ? customDuration : durationMode),
    [customDuration, durationMode],
  );

  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current || !saved) return;
    seededRef.current = true;
    if (saved.dayIds.length) setDayIds(saved.dayIds);
    setStart(saved.start);
    setEnd(saved.end);
    setDurationMode(durationModeFor(saved.duration));
    setCustomDuration(isPresetDuration(saved.duration) ? '480' : saved.duration);
  }, [saved]);

  const toggleDay = React.useCallback((id: string) => {
    setState('idle');
    setDayIds((current) => (current.includes(id) ? current.filter((day) => day !== id) : [...current, id]));
  }, []);

  const selectAllDays = React.useCallback(() => {
    setState('idle');
    setDayIds(DAYS.map((day) => day.id));
  }, []);

  const canPublish = dayIds.length > 0 && start < end && selectedDurationMinutes !== null && state !== 'saving';

  async function publish(): Promise<void> {
    if (!canPublish) return;
    setState('saving');
    const dows = DAYS.filter((day) => dayIds.includes(day.id)).map((day) => day.dow);
    const request = {
      target: 'engine.operation.label-addressed',
      payload: {
        operation_label: 'engine.operation.write-batch',
        writes: [
          {
            address_label: AVAILABILITY_ADDRESS,
            address_mode: 'identity_text',
            path_labels: ['current-item', 'published-record'],
            payload: {
              kind: AVAILABILITY_KIND,
              id: 'default',
              user_id: 'me',
              name: presentation.template_name,
              timezone: 'America/Los_Angeles',
              recurrence_rule: { days: dows, start_time: start, end_time: end },
              duration_minutes: selectedDurationMinutes,
              buffer_minutes_before: 0,
              buffer_minutes_after: 15,
              booking_window_days: 30,
              min_notice_hours: 24,
              is_active: true,
            },
          },
        ],
      },
    };
    try {
      await sendRequestToBitfieldTarget(request);
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <Container height="full" overflow="auto" width="full" padding="xl">
      <Container layout="vertical" gap="lg" maxWidth="4xl" width="full" centered>
        <Container layout="horizontal" gap="lg" alignItems="start" justifyContent="between" wrap>
          <Container layout="vertical" gap="xs">
            <Text variant="heading-lg">{presentation.section_label}</Text>
            <Text variant="body" color="muted" leading="relaxed">{presentation.section_help}</Text>
          </Container>
          {saved || state === 'saved' ? <Badge variant="success">{presentation.saved_badge}</Badge> : null}
        </Container>

        <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
          <Container layout="vertical" gap="lg">
            <Container layout="horizontal" gap="md" alignItems="start" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="overline">Step 1</Text>
                <Text variant="heading">{presentation.day_label}</Text>
              </Container>
              <Text variant="body-sm" color="muted">{labelForDayIds(dayIds)}</Text>
            </Container>
            <SelectablePillBar
              items={DAYS.map((day) => ({ id: day.id, label: day.label }))}
              selectedIds={dayIds}
              allLabel={presentation.all_days_label}
              ariaLabel={presentation.days_aria_label}
              onSelectAll={selectAllDays}
              onToggle={toggleDay}
            />
          </Container>
        </Card>

        <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
          <Container layout="vertical" gap="lg">
            <Container layout="vertical" gap="xs">
              <Text variant="overline">Step 2</Text>
              <Text variant="heading">Court window</Text>
            </Container>
            <Container layout="grid" gap="md" gridCols={2}>
              <Container layout="vertical" gap="xs">
                <Text as="label" htmlFor="availability-start" variant="label">{presentation.from_label}</Text>
                <Input id="availability-start" type="time" value={start} onChange={(event) => { setState('idle'); setStart(event.currentTarget.value); }} />
              </Container>
              <Container layout="vertical" gap="xs">
                <Text as="label" htmlFor="availability-end" variant="label">{presentation.to_label}</Text>
                <Input id="availability-end" type="time" value={end} onChange={(event) => { setState('idle'); setEnd(event.currentTarget.value); }} />
              </Container>
            </Container>
          </Container>
        </Card>

        <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
          <Container layout="vertical" gap="lg">
            <Container layout="horizontal" gap="md" alignItems="start" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="overline">Step 3</Text>
                <Text variant="heading">{presentation.duration_label}</Text>
              </Container>
              <Text variant="body-sm" color={selectedDurationMinutes ? 'muted' : 'error'}>
                {durationLabel(selectedDurationMinutes)}
              </Text>
            </Container>
            <SegmentedControl
              items={DURATION_PRESETS}
              value={durationMode}
              ariaLabel={presentation.duration_label}
              onValueChange={(next) => { setState('idle'); setDurationMode(next); }}
            />
            {durationMode === 'custom' ? (
              <Container layout="vertical" gap="xs" maxWidth="sm">
                <Text as="label" htmlFor="availability-custom-duration" variant="label">Custom minutes</Text>
                <Input
                  id="availability-custom-duration"
                  type="number"
                  min="1"
                  step="5"
                  inputMode="numeric"
                  value={customDuration}
                  onChange={(event) => {
                    setState('idle');
                    setCustomDuration(event.currentTarget.value);
                  }}
                />
              </Container>
            ) : null}
          </Container>
        </Card>

        <Card padding="lg" className="border border-[var(--border-primary)] bg-[var(--surface-tertiary)]">
          <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
            <Container layout="vertical" gap="xs">
              <Text variant="heading">Ready to save</Text>
              <Text variant="body-sm" color="muted">
                {labelForDayIds(dayIds)} - {start} to {end} - {durationLabel(selectedDurationMinutes)} practices
              </Text>
              {state === 'error' ? <Text variant="body-sm" color="error">{presentation.save_error}</Text> : null}
            </Container>
            <Button variant="primary" size="lg" onClick={publish} disabled={!canPublish} loading={state === 'saving'}>
              {state === 'saved' ? presentation.saved_button_label : presentation.publish_action_label}
            </Button>
          </Container>
        </Card>
      </Container>
    </Container>
  );
}

export default AvailabilitySetupForm;
