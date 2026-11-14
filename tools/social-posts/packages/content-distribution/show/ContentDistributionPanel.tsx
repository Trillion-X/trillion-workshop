/**
 * file: packages/content-distribution/show/ContentDistributionPanel.tsx
 *
 * PURPOSE: The Distribution surface paints owner-produced target, intent, state,
 * action, and projection descriptors. Every visible word, column header, stat
 * label, and default comes from the read-model's descriptor resolution — this
 * panel chooses none of them. The queue is rendered column-by-column from
 * `view.queueColumns` + `view.queueRows`; selecting a row reveals its detail.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero imports from slot::workflow or slot::eeaf — reads only via useBitfieldData
 * 2. Components only from @/packages/ui; zero inline style objects, zero raw HTML
 *    (the one anchor wrapper is the platform's only native link affordance)
 * 3. Platforms are destination RECORDS and statuses are domain OPTIONS — this
 *    panel never names a platform or a status (L090); it renders resolved cells
 * 4. No copy/column/stat literal in code: all strings come from `view.copy`,
 *    `view.queueColumns`, and `view.statBand`
 * 5. Observability: logs `[ui:content-distribution] mounted input=<n> records` on mount
 */

import * as React from 'react';

import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ExternalLink } from 'lucide-react';

import {
  Badge,
  Card,
  Container,
  Icon,
  OutputFieldList,
  ResponsiveSwitch,
  SafeErrorCard,
  ScrollableSurface,
  StatStrip,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  sanitizeErrorText,
} from '@/packages/ui';

import {
  destinationDisplayLabel,
  readDistributionView,
  type DistributionDetail,
  type DistributionView,
  type PublishDestination,
  type QueueCell,
  type QueueColumn,
  type QueueRow,
} from '@/packages/content-distribution/read-data/read-content-distribution';

const badgeVariant = (tone: string) => (
  ['neutral', 'info', 'success', 'warning', 'error'].includes(tone) ? tone : 'neutral'
) as 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** Map a generic semantic tone to the StatusDot's status token (neutral -> idle). */
const toneDot = (tone: string) => (
  ['success', 'warning', 'error', 'info'].includes(tone) ? tone : 'idle'
) as 'success' | 'warning' | 'error' | 'info' | 'idle';

/** Paint one resolved cell by its generic render kind — never by status/platform name. */
function QueueCellView({ cell, column, liveLinkLabel }: { cell: QueueCell; column: QueueColumn; liveLinkLabel: string }) {
  if (cell.render === 'status') {
    return <Badge variant={badgeVariant(cell.tone ?? 'neutral')} size="sm">{cell.text}</Badge>;
  }
  if (cell.render === 'link') {
    if (!cell.href) return null;
    return (
      <a href={cell.href} target="_blank" rel="noreferrer" aria-label={cell.text || liveLinkLabel}>
        <Icon icon={ExternalLink} size="sm" color="muted" />
      </a>
    );
  }
  return (
    <Text variant={column.primary ? 'body' : 'body-xs'} color={column.primary ? undefined : 'secondary'} truncate>
      {cell.text}
    </Text>
  );
}

function DestinationCard({ destination, connectedLabel, disconnectedLabel }: {
  destination: PublishDestination;
  connectedLabel: string;
  disconnectedLabel: string;
}) {
  const connected = destination.connection_enabled === true;
  return (
    <Card variant="surface" padding="md" layout="stack">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" gap="xs" flex={1}>
          <Text variant="heading" truncate>{destinationDisplayLabel(destination)}</Text>
          {destination.account_label && destination.account_label !== destinationDisplayLabel(destination) ? (
            <Text variant="caption" color="faint" truncate>{destination.account_label}</Text>
          ) : null}
        </Container>
        <StatusDot status={connected ? 'success' : 'error'} />
        <Text variant="body-xs" color={connected ? 'success' : 'secondary'}>
          {connected ? connectedLabel : disconnectedLabel}
        </Text>
      </Container>
    </Card>
  );
}

/** The detail pane for the selected post: labeled fields + activity timeline. */
function PostDetail({ detail, view }: { detail: DistributionDetail; view: DistributionView }) {
  return (
    <Card variant="surface" padding="md" layout="stack">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" gap="none" flex={1}>
          <Text variant="heading" truncate>{detail.title}</Text>
        </Container>
        <Badge variant={badgeVariant(detail.statusTone)} size="sm">{detail.statusLabel}</Badge>
      </Container>

      {detail.errorMessage ? (
        <Container layout="vertical" gap="xs">
          <Text variant="caption" color="error">
            {sanitizeErrorText(detail.errorMessage, view.copy.detailErrorFallback)}
          </Text>
          {detail.remediation ? (
            <Text variant="caption" color="warning">
              {sanitizeErrorText(detail.remediation, '')}
            </Text>
          ) : null}
        </Container>
      ) : null}

      <OutputFieldList fields={detail.fields} />

      {detail.remoteUrl ? (
        <a href={detail.remoteUrl} target="_blank" rel="noreferrer">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Icon icon={ExternalLink} size="sm" color="muted" />
            <Text variant="body-xs" color="info">{view.copy.liveLinkLabel}</Text>
          </Container>
        </a>
      ) : null}

      {detail.timeline.length > 0 ? (
        <Container layout="vertical" gap="xs">
          <Text variant="label">{view.copy.detailTimelineTitle}</Text>
          {detail.timeline.map((event, index) => (
            <Container key={`ev-${index}`} layout="horizontal" gap="sm" alignItems="center">
              <StatusDot status={toneDot(event.statusTone)} />
              <Container layout="vertical" gap="none" flex={1}>
                <Text variant="body-xs" truncate>{event.statusLabel}</Text>
              </Container>
              <Text variant="caption" color="faint">{event.observedAtLabel}</Text>
            </Container>
          ))}
        </Container>
      ) : null}
    </Card>
  );
}

export function ContentDistributionPanel() {
  const evidenceRows = useBitfieldData('content-distribution:contentMediaEvidence');
  const view = React.useMemo(() => readDistributionView(evidenceRows), [evidenceRows]);
  const [selectedIntentId, setSelectedIntentId] = React.useState<string | null>(null);

  React.useEffect(() => {
    console.log(`[ui:content-distribution] mounted input=${view.destinations.length + view.posts.length} records`);
  }, [view.destinations.length, view.posts.length]);

  const selectedDetail = selectedIntentId ? view.detailByIntent[selectedIntentId] ?? null : null;
  const { copy } = view;

  const renderRowCells = (row: QueueRow) =>
    view.queueColumns.map((column) => {
      const cell = row.cells.find((item) => item.columnKey === column.key);
      return (
        <TableCell key={column.key}>
          {cell ? <QueueCellView cell={cell} column={column} liveLinkLabel={copy.liveLinkLabel} /> : null}
        </TableCell>
      );
    });

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" padding="lg" height="full">
        <Container layout="vertical" gap="xs">
          {copy.heading ? <Text variant="heading-lg">{copy.heading}</Text> : null}
          {copy.subtitle ? <Text variant="label">{copy.subtitle}</Text> : null}
        </Container>

        {view.blockers.map((blocker, index) => (
          <SafeErrorCard key={`blocker-${index}`} message={blocker} title={copy.blockerSectionTitle} />
        ))}

        {view.statBand.length > 0 ? (
          <StatStrip stats={view.statBand.map((item) => ({ label: item.label, value: item.value }))} />
        ) : null}

        <Container layout="vertical" gap="sm">
          {copy.targetSectionTitle ? <Text variant="heading">{copy.targetSectionTitle}</Text> : null}
          {view.destinations.length === 0 ? (
            <Container layout="vertical" gap="xs" padding="xl" alignItems="center">
              <Text variant="body" color="secondary">{copy.targetEmptyTitle}</Text>
              <Text variant="label">{copy.targetEmptyHint}</Text>
            </Container>
          ) : (
            <Container layout="grid" gridCols={view.layout.channelGridDensity} gap="md">
              {view.destinations.map((destination, index) => (
                <DestinationCard
                  key={destination.target_id ?? destination.destination_id ?? index}
                  destination={destination}
                  connectedLabel={copy.connectedLabel}
                  disconnectedLabel={copy.disconnectedLabel}
                />
              ))}
            </Container>
          )}
        </Container>

        <Container layout="vertical" gap="sm">
          {copy.intentSectionTitle ? <Text variant="heading">{copy.intentSectionTitle}</Text> : null}
          {view.queueRows.length === 0 ? (
            <Container layout="vertical" gap="xs" padding="xl" alignItems="center">
              <Text variant="body" color="secondary">{copy.intentEmptyTitle}</Text>
              <Text variant="label">{copy.intentEmptyHint}</Text>
            </Container>
          ) : (
            <Container layout="responsive-split" gap="lg" alignItems="start">
              <Container layout="vertical" gap="sm" flex={1}>
                <ResponsiveSwitch
                  wide={(
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {view.queueColumns.map((column) => (
                            <TableHead key={column.key} aria-label={column.label || copy.liveLinkLabel}>
                              {column.label}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {view.queueRows.map((row) => (
                          <TableRow
                            key={row.intentId}
                            selected={row.intentId === selectedIntentId}
                            onClick={() => setSelectedIntentId(row.intentId)}
                          >
                            {renderRowCells(row)}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  narrow={(
                    <Container layout="vertical" gap="sm">
                      {view.queueRows.map((row) => (
                        <Card
                          key={`m:${row.intentId}`}
                          variant="surface"
                          padding="md"
                          layout="stack"
                          onClick={() => setSelectedIntentId(row.intentId)}
                          selected={row.intentId === selectedIntentId}
                        >
                          <Text variant="body" truncate>{row.primaryText}</Text>
                          <Container layout="horizontal" gap="sm" alignItems="center" wrap>
                            {row.cells.map((cell) => {
                              const column = view.queueColumns.find((item) => item.key === cell.columnKey);
                              if (!column || column.primary) return null;
                              return (
                                <QueueCellView
                                  key={cell.columnKey}
                                  cell={cell}
                                  column={column}
                                  liveLinkLabel={copy.liveLinkLabel}
                                />
                              );
                            })}
                          </Container>
                        </Card>
                      ))}
                    </Container>
                  )}
                />
              </Container>

              <Container layout="vertical" gap="sm" flex={1}>
                {selectedDetail ? (
                  <PostDetail detail={selectedDetail} view={view} />
                ) : (
                  <Card variant="surface" padding="lg" layout="stack">
                    <Text variant="body" color="secondary">{copy.detailPlaceholder}</Text>
                  </Card>
                )}
              </Container>
            </Container>
          )}
        </Container>
      </Container>
    </ScrollableSurface>
  );
}
