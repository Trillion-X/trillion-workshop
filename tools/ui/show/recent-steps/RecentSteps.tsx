// parts/ui/show/recent-steps/RecentSteps.tsx
//
// PURPOSE
//   Shows the steps a request carries (recent-steps.ts), newest last, one row per step: the kind's icon and word, the
//   control's name and how long ago, so the person sees exactly what their AI will see before they send it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Words and icons per kind come from recent-steps.json `kinds`; an unknown kind shows as `other_kind`.
//   2. At most `shown` rows; the rest are counted, never dropped silently.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { Container } from '../container';
import { Text } from '../text';
import { NamedIcon } from '../icon';
import type { RecentStep } from './recent-steps';
import settings from './recent-steps.json';

type Kind = { word: string; icon: string };
const kindOf = (kind: string): Kind => (settings.kinds as Record<string, Kind>)[kind] ?? settings.other_kind;
const fill = (template: string, count: number) => template.replace('{count}', String(count));

function ago(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 10) return settings.words.just_now;
  if (seconds < 60) return fill(settings.words.seconds_ago, seconds);
  return fill(settings.words.minutes_ago, Math.round(seconds / 60));
}

export function RecentSteps({ steps, now = Date.now() }: { steps: RecentStep[]; now?: number }) {
  const shown = steps.slice(-settings.shown);
  const earlier = steps.length - shown.length;
  return (
    <Container layout="vertical" gap="xs" data-recent-steps>
      <Text variant="label">{settings.words.title}</Text>
      {shown.length ? null : <Text variant="caption">{settings.words.none}</Text>}
      {earlier > 0 ? <Text variant="caption">{fill(settings.words.earlier, earlier)}</Text> : null}
      {shown.map(step => {
        const kind = kindOf(step.kind);
        return (
          <Container key={`${step.at}${step.kind}${step.label}`} layout="horizontal" gap="sm" alignItems="center" data-recent-step={step.kind}>
            <NamedIcon name={kind.icon} size="xs" />
            <Text variant="caption" truncate className="min-w-0 flex-1">{kind.word} <Text as="span" variant="caption" weight="medium">{step.label}</Text></Text>
            <Text variant="caption" className="shrink-0">{ago(step.at, now)}</Text>
          </Container>
        );
      })}
      {shown.length ? <Text variant="caption">{settings.words.sent_with_it}</Text> : null}
    </Container>
  );
}
