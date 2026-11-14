// package-set://bitfield-studio/packages/workout-log/show/WorkoutLogPanel.tsx

import React, { startTransition, useState } from 'react';
import { Activity, CheckCircle2, ClipboardList, Mic2, TrendingUp } from 'lucide-react';
import { Button, Card, Container, Icon, Input, Text, Textarea } from '@/packages/ui';
import { InteractiveTimeseriesChart } from '@/packages/ui/show/timeseries-chart/InteractiveTimeseriesChart';
import {
  buildWorkoutEvidenceAtom,
  buildWorkoutProgressChart,
  buildWorkoutRawArtifact,
  describeAtom,
  describeEvidenceValue,
  ensureWorkoutLogProjection,
  type WorkoutCaptureDescriptor,
  type WorkoutCaptureDimension,
  type WorkoutEvidenceAtom,
  type WorkoutEvidenceValue,
  type WorkoutLogLike,
  type WorkoutLog,
} from '@/packages/workout-log/read-data/workout-log';
import {
  writeWorkoutEvidence,
  writeWorkoutEvidenceConfirmation,
  writeWorkoutEvidenceCorrection,
  writeWorkoutEvidenceDiscard,
} from '@/packages/workout-log/do-work/workout-log-requests';

function lensOutput(log: WorkoutLog, kind: string) {
  return log.lensOutputs.find((output) => output.kind === kind);
}

function dimensionLabel(dimension: WorkoutEvidenceValue): string {
  return dimension.label ?? dimension.role ?? 'Value';
}

function FieldControl({
  dimension,
  value,
  onChange,
}: {
  dimension: WorkoutCaptureDimension;
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <Container layout="vertical" gap="xs">
      <Input
        label={dimension.label}
        inputMode={dimension.inputKind === 'number' ? 'decimal' : 'text'}
        placeholder={dimension.unitOptions?.[0] ?? ''}
        value={value}
        onChange={(event) => onChange(dimension.key, event.currentTarget.value)}
      />
      {dimension.quickValues && dimension.quickValues.length > 0 && (
        <Container layout="horizontal" gap="xs" wrap>
          {dimension.quickValues.map((quickValue) => (
            <Button
              key={`${dimension.key}:${String(quickValue)}`}
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => onChange(dimension.key, String(quickValue))}
            >
              {String(quickValue)}
            </Button>
          ))}
        </Container>
      )}
    </Container>
  );
}

function formDimensions(
  descriptor: WorkoutCaptureDescriptor,
  values: Record<string, string>,
): Record<string, WorkoutEvidenceValue> {
  return Object.fromEntries(
    descriptor.acceptedDimensions
      .map((dimension) => {
        const raw = values[dimension.key]?.trim() ?? '';
        if (!raw) return null;
        const numeric = Number(raw);
        const value = dimension.inputKind === 'number' && Number.isFinite(numeric) ? numeric : raw;
        return [
          dimension.key,
          {
            value,
            role: descriptor.intent,
            label: dimension.label,
            ...(dimension.unitOptions?.[0] ? { unit: dimension.unitOptions[0] } : {}),
          },
        ] as const;
      })
      .filter((entry): entry is readonly [string, WorkoutEvidenceValue] => Boolean(entry)),
  );
}

function subjectLabel(descriptor: WorkoutCaptureDescriptor, dimensions: Record<string, WorkoutEvidenceValue>): string {
  return Object.values(dimensions).map((dimension) => String(dimension.value)).find(Boolean) ?? descriptor.label;
}

function missingRequiredDimension(descriptor: WorkoutCaptureDescriptor, values: Record<string, string>): WorkoutCaptureDimension | undefined {
  return descriptor.acceptedDimensions.find((dimension) => dimension.required && !values[dimension.key]?.trim());
}

function CaptureSurface({ log }: { log: WorkoutLog }) {
  const entryDescriptors = log.captureDescriptors.filter((entry) => entry.intent !== 'workout_review_decision');
  const activeEntryDescriptor = entryDescriptors.find((entry) => entry.id === log.activeDescriptor?.id);
  const initialDescriptorId = activeEntryDescriptor?.id ?? entryDescriptors[0]?.id ?? '';
  const [descriptorId, setDescriptorId] = useState(initialDescriptorId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rawText, setRawText] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const descriptor = entryDescriptors.find((entry) => entry.id === descriptorId) ?? entryDescriptors[0];
  const previousValue = lensOutput(log, 'previous-value');

  if (!descriptor) {
    return (
      <Card variant="nested" padding="lg" layout="stack" aria-label="Workout entry">
        <Text variant="heading-xl">Ways to log are missing</Text>
        <Text variant="body" color="muted">This screen cannot save yet.</Text>
      </Card>
    );
  }

  function setDimensionValue(key: string, nextValue: string) {
    setValues((current) => ({ ...current, [key]: nextValue }));
  }

  async function submitEvidence(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const observedAt = new Date().toISOString();
    const dimensions = formDimensions(descriptor, values);
    const cleanedRawText = rawText.trim();
    const missingDimension = missingRequiredDimension(descriptor, values);
    if (missingDimension) {
      setMessage(`Add ${missingDimension.label}.`);
      return;
    }
    if (!cleanedRawText && Object.keys(dimensions).length === 0) {
      setMessage('Type something first.');
      return;
    }
    const rawArtifact = cleanedRawText
      ? buildWorkoutRawArtifact({ kind: 'raw_text', capturedAt: observedAt, text: cleanedRawText, source: descriptor.id })
      : undefined;
    const atom = buildWorkoutEvidenceAtom({
      descriptorId: descriptor.id,
      observedAt,
      source: descriptor.defaultSource ?? { kind: 'manual_capture', label: descriptor.label },
      subject: { kind: descriptor.intent, label: subjectLabel(descriptor, dimensions) },
      dimensions: rawArtifact
        ? { ...dimensions, raw_text: { value: cleanedRawText, role: 'raw', label: 'Notes' } }
        : dimensions,
      confidence: rawArtifact
        ? { state: 'needs_review', reviewReason: 'Check this before it counts.' }
        : { state: 'confirmed' },
      rawArtifactRefs: rawArtifact ? [rawArtifact.id] : [],
    });
    setPending(true);
    setMessage('');
    try {
      await writeWorkoutEvidence({ log, atom, rawArtifact });
      startTransition(() => {
        setValues({});
        setRawText('');
        setMessage('Saved.');
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error("[workout-log] failed:", raw); setMessage('Save failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card variant="solid" padding="lg" layout="stack" aria-label="Workout entry" className="relative overflow-hidden">
      <Container layout="horizontal" alignItems="start" gap="lg" wrap>
        <Container layout="vertical" gap="sm" className="min-w-0">
          <Container layout="horizontal" alignItems="center" gap="sm" wrap>
            <Icon icon={Activity} size="lg" color="success" />
            <Text variant="heading-lg">{descriptor.prompt.headline}</Text>
          </Container>
          {descriptor.prompt.subhead && (
            <Text variant="body" color="muted" leading="relaxed">{descriptor.prompt.subhead}</Text>
          )}
        </Container>
      </Container>

      {entryDescriptors.length > 1 && (
        <Container layout="horizontal" gap="sm" wrap aria-label="Ways to log">
          {entryDescriptors.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              size="sm"
              variant={entry.id === descriptor.id ? 'primary' : 'secondary'}
              active={entry.id === descriptor.id}
              onClick={() => startTransition(() => setDescriptorId(entry.id))}
            >
              {entry.label}
            </Button>
          ))}
        </Container>
      )}

      <form onSubmit={submitEvidence}>
        <Container layout="vertical" gap="md">
          {previousValue?.primaryText && (
            <Card variant="nested" padding="md" layout="row" aria-label="Last similar entry">
              <Icon icon={ClipboardList} size="md" color="info" />
              <Container layout="vertical" gap="xs">
                <Text variant="body-xs" color="muted">Last time</Text>
                <Text variant="heading">{previousValue.primaryText}</Text>
              </Container>
            </Card>
          )}

          {descriptor.prompt.inputMode.includes('text') && (
            <Textarea
              label="Say what happened"
              rows={5}
              placeholder="Type or paste what happened."
              value={rawText}
              onChange={(event) => setRawText(event.currentTarget.value)}
            />
          )}

          {descriptor.acceptedDimensions.length > 0 && (
            <Container layout="grid" gridCols="auto-fill-sm" gap="md">
              {descriptor.acceptedDimensions.map((dimension) => (
                <FieldControl
                  key={dimension.key}
                  dimension={dimension}
                  value={values[dimension.key] ?? ''}
                  onChange={setDimensionValue}
                />
              ))}
            </Container>
          )}

          <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md" wrap>
            <Button type="submit" variant="primary" size="lg" loading={pending}>
              {descriptor.prompt.primaryActionLabel}
            </Button>
            {message && <Text variant="body-xs" color={message.includes('failed') ? 'error' : message === 'Saved.' ? 'muted' : 'warning'}>{message}</Text>}
          </Container>
        </Container>
      </form>
    </Card>
  );
}

function ProgressSurface({ log }: { log: WorkoutLog }) {
  const progress = lensOutput(log, 'progress-summary');
  const metric = progress?.metric ?? { label: 'saved entries', value: log.evidenceAtoms.filter((atom) => atom.confidence?.state !== 'needs_review').length };
  const chart = buildWorkoutProgressChart(log);
  const [activeBucket, setActiveBucket] = useState('1d');

  if (chart) {
    return (
      <InteractiveTimeseriesChart
        config={{
          title: chart.title,
          metric: chart.metric,
          chartMode: 'line',
          showModeControls: false,
          showBucketControls: false,
          showAverage: true,
          showAccumulated: false,
          showAccumulatedTooltip: false,
          valueSuffix: chart.unit ? ` ${chart.unit}` : undefined,
          valueDecimals: chart.valueDecimals,
          tooltipDescription: 'Real saved entries only',
          eventLabel: 'entries',
          openLabel: 'Previous',
          highLabel: 'High',
          lowLabel: 'Low',
          closeLabel: 'Value',
          totalLabel: 'Latest',
          averageLabel: 'Average',
          minLabel: 'Low',
          maxLabel: 'High',
          countLabel: 'Entries',
          emptyTitle: 'No numbers yet',
          emptyDescription: 'Save a number to chart it.',
        }}
        buckets={chart.buckets}
        summary={chart.summary}
        activeBucket={activeBucket}
        onActiveBucketChange={setActiveBucket}
      />
    );
  }

  return (
    <Card variant="nested" padding="lg" layout="stack" aria-label="Workout progress">
      <Container layout="horizontal" alignItems="center" gap="sm">
        <Icon icon={TrendingUp} size="md" color="success" />
        <Text variant="heading">Progress</Text>
      </Container>
      <Text variant="display" tabular>{metric.value}</Text>
      <Text variant="body" color="muted">{metric.label}</Text>
      <Text variant="body" color="muted">{metric.detail ?? progress?.primaryText ?? 'Save a number to chart it.'}</Text>
    </Card>
  );
}

function ReviewSurface({ log }: { log: WorkoutLog }) {
  const reviewLens = lensOutput(log, 'review-queue');
  const reviewItems = reviewLens?.items ?? log.reviewQueue;
  const nextReview = reviewItems[0];
  const reviewCount = reviewLens?.metric?.value ?? reviewItems.length;
  const [correctionText, setCorrectionText] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const [message, setMessage] = useState('');

  async function writeReviewAction(action: 'confirm' | 'discard' | 'correct') {
    if (!nextReview) return;
    const observedAt = new Date().toISOString();
    const cleanedCorrection = correctionText.trim();
    if (action === 'correct' && !cleanedCorrection) {
      setMessage('Add the fix.');
      return;
    }
    setPendingAction(action);
    setMessage('');
    try {
      if (action === 'confirm') {
        await writeWorkoutEvidenceConfirmation({ log, targetAtom: nextReview, observedAt });
        setMessage('Saved.');
      } else if (action === 'discard') {
        await writeWorkoutEvidenceDiscard({ log, targetAtom: nextReview, observedAt });
        setMessage('Removed.');
      } else {
        await writeWorkoutEvidenceCorrection({
          log,
          targetAtom: nextReview,
          observedAt,
          dimensions: {
            correction: { value: cleanedCorrection, role: 'correction', label: 'Fix' },
          },
          note: cleanedCorrection,
        });
        startTransition(() => setCorrectionText(''));
        setMessage('Fix saved.');
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error); console.error("[workout-log] failed:", raw); setMessage('Update failed.');
    } finally {
      setPendingAction('');
    }
  }

  if (!nextReview) return null;

  return (
    <Card variant="nested" padding="lg" layout="stack" aria-label="Workout review">
      <Container layout="horizontal" alignItems="center" gap="sm">
        <Icon icon={Mic2} size="md" color="warning" />
        <Text variant="heading">Check entries</Text>
        {reviewCount > 1 && <Text variant="body-xs" color="muted">{reviewCount} to check</Text>}
      </Container>
      <Container layout="vertical" gap="sm">
        <Text variant="heading-xl">{nextReview.subject.label ?? nextReview.subject.kind}</Text>
        <Text variant="body" color="muted">{nextReview.confidence?.reviewReason ?? 'Check this before it counts.'}</Text>
        <Text variant="caption" color="faint" wrap="preserve">{describeAtom(nextReview)}</Text>
        <Textarea
          label="Fix"
          rows={3}
          placeholder="Only type here if something is wrong."
          value={correctionText}
          onChange={(event) => setCorrectionText(event.currentTarget.value)}
        />
        <Container layout="horizontal" gap="sm" wrap>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={pendingAction === 'confirm'}
            onClick={() => void writeReviewAction('confirm')}
          >
            Looks right
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={pendingAction === 'correct'}
            onClick={() => void writeReviewAction('correct')}
          >
            Save fix
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={pendingAction === 'discard'}
            onClick={() => void writeReviewAction('discard')}
          >
            Remove
          </Button>
        </Container>
        {message && <Text variant="body-xs" color={message.includes('failed') ? 'error' : message.startsWith('Add') ? 'warning' : 'muted'}>{message}</Text>}
      </Container>
    </Card>
  );
}

function EvidenceLine({ atom }: { atom: WorkoutEvidenceAtom }) {
  const dimensions = Object.entries(atom.dimensions)
    .filter(([, value]) => value.role !== 'link')
    .slice(0, 3);
  return (
    <Card variant="ghost" padding="sm" className="border border-[var(--border-primary)]">
      <Container layout="horizontal" alignItems="start" gap="sm">
        <Icon icon={ClipboardList} size="sm" color="muted" />
        <Container layout="vertical" gap="xs" className="min-w-0">
          <Text variant="body-xs" weight="semibold">{atom.subject.label ?? atom.subject.id ?? atom.subject.kind}</Text>
          {dimensions.length > 0 && (
            <Text variant="caption" color="muted" wrap="preserve">
              {dimensions.map(([, value]) => `${dimensionLabel(value)} ${describeEvidenceValue(value)}`).join(' · ')}
            </Text>
          )}
          {atom.links.map((link) => (
            <Text key={`${atom.id}:${link.role}:${link.targetId}`} variant="caption" color="faint">{link.targetId}</Text>
          ))}
        </Container>
      </Container>
    </Card>
  );
}

function HistorySurface({ log }: { log: WorkoutLog }) {
  const shelfLens = lensOutput(log, 'history-shelf') ?? lensOutput(log, 'export-rows') ?? lensOutput(log, 'progress-summary');
  const recent = (shelfLens?.items ?? log.evidenceAtoms).slice(0, 6);
  return (
    <Card variant="nested" padding="lg" layout="stack" aria-label="Workout history">
      <Container layout="horizontal" alignItems="center" gap="sm">
        <Icon icon={CheckCircle2} size="md" color="info" />
        <Text variant="heading">History</Text>
      </Container>
      <Container layout="vertical" gap="sm">
        {recent.length > 0 ? recent.map((atom) => <EvidenceLine key={atom.id} atom={atom} />) : (
          <Text variant="body" color="muted">Saved workouts will appear here.</Text>
        )}
      </Container>
    </Card>
  );
}

export function WorkoutLogPanel({ log }: { log: WorkoutLogLike }) {
  const projection = ensureWorkoutLogProjection(log);
  return (
    <Card variant="surface" padding="lg" layout="stack" aria-label="Workout log">
      <Container layout="horizontal" alignItems="start" gap="lg" wrap>
        <Container layout="vertical" gap="xs" className="min-w-0">
          <Container layout="horizontal" alignItems="center" gap="sm" wrap>
            <Icon icon={Activity} size="lg" color="success" />
            <Text variant="heading-xl">Workout Log</Text>
          </Container>
          <Text variant="body" color="muted" leading="relaxed">
            Log anything. Chart real numbers.
          </Text>
        </Container>
      </Container>

      <CaptureSurface log={projection} />

      <ProgressSurface log={projection} />

      <Container layout="grid" gridCols={2} gap="md" className="grid-cols-1 xl:grid-cols-2">
        <ReviewSurface log={projection} />
        <HistorySurface log={projection} />
      </Container>
    </Card>
  );
}
