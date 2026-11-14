// package-set://bitfield-studio/packages/training-plan/show/TrainingPlanPanel.tsx

import React from 'react';
import { CalendarCheck, Dumbbell, Flag, Sparkles, Target } from 'lucide-react';
import { Badge, Card, Container, Icon, ProgressBar, Text } from '@/packages/ui';
import { sessionsForWeek, trainingPlanSummary, type TrainingPlan } from '@/packages/training-plan/read-data/training-plan';
import type { AdaptiveNextSession } from '@/packages/training-plan/read-data/select-adaptive-next-session';

function valueText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${String(entry)}`)
    .join(' / ');
}

export function TrainingPlanPanel({ plan, adapted }: { plan: TrainingPlan; adapted?: AdaptiveNextSession | null }) {
  const summary = trainingPlanSummary(plan);
  const plannedWeeks = Math.max(1, summary.weeks);
  const sessionDensity = Math.round((summary.sessions / plannedWeeks) * 10) / 10;
  const completionSignal = Math.min(100, Math.round((summary.sessions / Math.max(1, summary.goals * 12)) * 100));
  const adaptedNote = adapted ? (typeof adapted.next.intensity.note === 'string' ? adapted.next.intensity.note : '') : '';

  return (
    <Card variant="surface" padding="lg" layout="stack" aria-label="Training plan">
      <Container layout="horizontal" justifyContent="between" alignItems="start" gap="lg" wrap>
        <Container layout="vertical" gap="xs" className="min-w-0">
          <Container layout="horizontal" alignItems="center" gap="sm" wrap>
            <Icon icon={Dumbbell} size="lg" color="success" />
            <Text variant="heading-xl">Training Plan</Text>
            <Badge variant="success" size="sm">tasks + journal backed</Badge>
          </Container>
          <Text variant="body" color="muted" leading="relaxed">
            Goal, phase, week, and session prescriptions for a training loop that can be scheduled as tasks and reviewed through workout notes.
          </Text>
        </Container>
        <Badge variant="accent" size="lg">{summary.sessions} sessions</Badge>
      </Container>

      <Container layout="grid" gridCols={4} gap="sm" className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <Card variant="nested" padding="sm" layout="stack">
          <Icon icon={Target} size="md" color="accent" />
          <Text variant="caption" color="faint">goals</Text>
          <Text variant="heading-lg" tabular>{summary.goals}</Text>
        </Card>
        <Card variant="nested" padding="sm" layout="stack">
          <Icon icon={Flag} size="md" color="info" />
          <Text variant="caption" color="faint">phases</Text>
          <Text variant="heading-lg" tabular>{summary.phases}</Text>
        </Card>
        <Card variant="nested" padding="sm" layout="stack">
          <Icon icon={CalendarCheck} size="md" color="success" />
          <Text variant="caption" color="faint">weeks</Text>
          <Text variant="heading-lg" tabular>{summary.weeks}</Text>
        </Card>
        <Card variant="nested" padding="sm" layout="stack">
          <Icon icon={Dumbbell} size="md" color="warning" />
          <Text variant="caption" color="faint">sessions / week</Text>
          <Text variant="heading-lg" tabular>{sessionDensity}</Text>
        </Card>
      </Container>

      <Card variant="nested" padding="md" layout="stack">
        <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
          <Text variant="heading">Training coverage</Text>
          <Text variant="body-xs" color="muted">{completionSignal}% of baseline session coverage</Text>
        </Container>
        <ProgressBar percentage={completionSignal} color="var(--color-success)" />
      </Card>

      {adapted ? (
        <Card variant="nested" padding="md" layout="stack" aria-label="Adapted next session">
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
            <Container layout="horizontal" alignItems="center" gap="sm">
              <Icon icon={Sparkles} size="md" color="accent" />
              <Text variant="heading">Your next session, adapted</Text>
            </Container>
            <Badge variant={adapted.decision.matched ? 'success' : 'muted'} size="sm">
              {adapted.decision.matched ? 'adjusted from your last result' : 'on track — no change'}
            </Badge>
          </Container>
          <Text variant="body-xs" color="muted">Based on how "{adapted.from.title}" went</Text>
          <Text variant="body-xs" weight="semibold">{adapted.next.title}</Text>
          <Text variant="caption" color="faint" wrap="preserve">{valueText(adapted.next.dose)}</Text>
          <Text variant="caption" color="muted" wrap="preserve">{valueText(adapted.next.intensity)}</Text>
          {adaptedNote ? <Text variant="body-xs" color="accent">{adaptedNote}</Text> : null}
        </Card>
      ) : null}

      <Container layout="grid" gridCols={2} gap="md" className="grid-cols-1 xl:grid-cols-2">
        {plan.weeks.map((week) => {
          const sessions = sessionsForWeek(plan, week.id);
          const phase = plan.phases.find((entry) => entry.id === week.phaseId);
          const goal = plan.goals.find((entry) => entry.id === phase?.goalId);
          return (
            <Card key={week.id} variant="nested" padding="md" layout="stack">
              <Container layout="horizontal" justifyContent="between" alignItems="start" gap="md">
                <Container layout="vertical" gap="xs">
                  <Text variant="heading">Week {week.sequence}</Text>
                  <Text variant="body-xs" color="muted">{phase?.name ?? 'Unassigned phase'} / {goal?.name ?? 'No goal'}</Text>
                </Container>
                <Badge variant="muted">{week.loadIntent.label || week.loadIntent.id || 'Unspecified'}</Badge>
              </Container>
              <Container layout="vertical" gap="sm">
                {sessions.map((session) => (
                  <Card key={session.id} variant="ghost" padding="sm" layout="stack" className="border border-[var(--border-primary)]">
                    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md">
                      <Text variant="body-xs" weight="semibold">{session.title}</Text>
                      <Badge variant="muted" size="sm">{session.activity}</Badge>
                    </Container>
                    <Text variant="caption" color="faint" wrap="preserve">{valueText(session.dose)}</Text>
                    <Text variant="caption" color="muted" wrap="preserve">{valueText(session.intensity)}</Text>
                  </Card>
                ))}
              </Container>
            </Card>
          );
        })}
      </Container>
    </Card>
  );
}
