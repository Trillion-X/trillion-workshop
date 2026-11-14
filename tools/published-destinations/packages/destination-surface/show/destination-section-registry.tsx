import React from 'react';
import {
  Badge,
  Bar,
  Button,
  Card,
  ColorDot,
  Container,
  Divider,
  IconTile,
  StatStrip,
  Text,
} from '@/packages/ui';
import {
  createBlindRegistry,
  registerAll,
  type BlindRegistry,
} from '@/packages/ui/show/blind-registry';
import type {
  DestinationItem,
  DestinationSection,
} from '@/packages/destination-surface/read-data/read-destination';

export interface DestinationSectionRendererProps {
  section: DestinationSection;
  onRetry?: () => void;
}

export type DestinationSectionRenderer = React.ComponentType<DestinationSectionRendererProps>;
export type DestinationSectionRegistry = BlindRegistry<DestinationSectionRenderer>;

const chipVariant: Record<string, React.ComponentProps<typeof Badge>['variant']> = {
  accent: 'accent',
  positive: 'success',
  warm: 'warning',
  neutral: 'muted-outline',
};

function QuestRow({ item }: { item: DestinationItem }) {
  const percent = Math.max(0, Math.min(100, item.percent ?? 0));
  const done = item.tone === 'positive' || percent >= 100;
  const tileColor = item.color ?? (done ? '#34D399' : '#818CF8');
  return (
    <Container layout="horizontal" alignItems="center" gap="md" padding="none" width="full">
      <IconTile color={tileColor} icon={item.icon ?? (done ? 'Check' : 'Zap')} />
      <Container gap="xs" padding="none" flex={1} minWidth="0">
        <Text variant="body" color="strong" weight="semibold" truncate>{item.title}</Text>
        <Bar
          height="md"
          rounded="full"
          labelOnBar={item.fraction}
          segments={[{
            percent,
            variant: done ? 'success' : 'accent',
            color: done ? undefined : item.color,
            title: item.fraction,
          }]}
        />
      </Container>
      {item.chip ? <Badge variant={done ? 'success' : 'muted-outline'} size="sm">{item.chip}</Badge> : null}
    </Container>
  );
}

function ItemRow({ item }: { item: DestinationItem }) {
  return (
    <Container layout="horizontal" alignItems="center" gap="sm" padding="none" width="full">
      {item.color ? <ColorDot color={item.color} size="md" /> : null}
      {item.actor ? <IconTile icon={item.icon ?? 'User'} color={item.color ?? '#818CF8'} /> : null}
      <Container gap="none" padding="none" minWidth="0" flex={1}>
        <Text variant="body-xs" color="strong" truncate>{item.title}</Text>
        {item.detail ? <Text variant="caption" color="dim" truncate>{item.detail}</Text> : null}
      </Container>
      {item.chip ? <Badge variant={chipVariant[item.tone ?? 'neutral']} size="sm">{item.chip}</Badge> : null}
    </Container>
  );
}

function SectionFrame({ section, children }: React.PropsWithChildren<{ section: DestinationSection }>) {
  return (
    <Card padding="lg" layout="stack">
      {section.label ? (
        <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm" padding="none">
          <Container gap="none" padding="none" minWidth="0">
            <Text variant="overline" color="subtle">{section.label}</Text>
            {section.detail ? <Text variant="body-xs" color="muted">{section.detail}</Text> : null}
          </Container>
          {section.meta ? <Text variant="caption" color="dim">{section.meta}</Text> : null}
        </Container>
      ) : null}
      {children}
    </Card>
  );
}

const renderers: Readonly<Record<string, DestinationSectionRenderer>> = {
  hero: ({ section }) => (
    <Card padding="lg" layout="stack">
      {section.label ? <Text variant="overline" color="subtle">{section.label}</Text> : null}
      {section.detail ? <Text variant="heading-sm" color="strong">{section.detail}</Text> : null}
      {section.body ? <Text variant="body" color="muted">{section.body}</Text> : null}
      {section.meta ? <Badge variant="muted-outline" size="sm">{section.meta}</Badge> : null}
    </Card>
  ),
  'card-row': ({ section }) => (
    <Container gap="sm" padding="none" width="full">
      {section.label ? <Text variant="overline" color="subtle">{section.label}</Text> : null}
      {(section.items ?? []).map((item) => <ItemRow key={item.ref} item={item} />)}
    </Container>
  ),
  'stat-strip': ({ section }) => <SectionFrame section={section}>{section.stats ? <StatStrip stats={section.stats} /> : null}</SectionFrame>,
  'quest-list': ({ section }) => (
    <SectionFrame section={section}>
      <Container gap="md" padding="none">
        {(section.items ?? []).map((item, index) => (
          <React.Fragment key={item.ref}>
            {index > 0 ? <Divider orientation="horizontal" /> : null}
            <QuestRow item={item} />
          </React.Fragment>
        ))}
      </Container>
    </SectionFrame>
  ),
  'rank-list': ({ section }) => (
    <SectionFrame section={section}>
      <Container gap="xs" padding="none">
        {(section.items ?? []).map((item) => <ItemRow key={item.ref} item={{
          ...item,
          title: item.rank === undefined ? item.title : `${item.rank}. ${item.title}`,
        }} />)}
      </Container>
    </SectionFrame>
  ),
  'item-list': ({ section }) => (
    <SectionFrame section={section}>
      <Container gap="sm" padding="none">
        {(section.items ?? []).map((item) => <ItemRow key={item.ref} item={item} />)}
      </Container>
    </SectionFrame>
  ),
  'progress-ring': ({ section }) => (
    <SectionFrame section={section}>
      {section.percent !== undefined ? (
        <Container gap="sm" padding="none">
          <Bar height="md" rounded="full" labelOnBar={section.ringLabel} segments={[{
            percent: Math.max(0, Math.min(100, section.percent)),
            variant: 'accent',
            color: section.color,
          }]} />
          {section.body ? <Text variant="body" color="muted">{section.body}</Text> : null}
        </Container>
      ) : null}
    </SectionFrame>
  ),
  pulse: ({ section }) => (
    <SectionFrame section={section}>
      <Container gap="xs" padding="none">
        {(section.bars ?? []).map((bar, index) => (
          <Bar key={index} height="sm" rounded="full" segments={[{
            percent: Math.max(0, Math.min(100, bar.value)),
            variant: bar.tone === 'positive' ? 'success' : bar.tone === 'warm' ? 'warning' : 'accent',
            color: bar.color,
            title: bar.title,
          }]} />
        ))}
      </Container>
    </SectionFrame>
  ),
  text: ({ section }) => <SectionFrame section={section}>{section.body ? <Text variant="body" color="muted">{section.body}</Text> : null}</SectionFrame>,
};

function UnavailableSection({ onRetry }: DestinationSectionRendererProps) {
  return (
    <Card padding="lg" layout="stack" role="status">
      <Text variant="body" color="strong">This view is unavailable.</Text>
      <Text variant="body-xs" color="muted">Reload to check for an updated view.</Text>
      {onRetry ? <Button variant="secondary" onClick={onRetry}>Reload</Button> : null}
    </Card>
  );
}

export function createDestinationSectionRegistry(): DestinationSectionRegistry {
  return registerAll(createBlindRegistry<DestinationSectionRenderer>({ fallback: UnavailableSection }), renderers);
}
