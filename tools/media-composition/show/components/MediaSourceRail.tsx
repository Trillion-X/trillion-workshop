import * as React from 'react';

import type { MediaWorkspaceSource } from '../../read-data/read-media-workspace';
import { Badge } from '../../../ui/show/badge';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { MediaThumb } from '../../../ui/show/media-thumb';
import { ProgressBar } from '../../../ui/show/progress-bar';
import { ScrollableSurface } from '../../../ui/show/scrollable-surface';
import { Text } from '../../../ui/show/text';

export type MediaSourceRailProps = {
  title?: string;
  sources: MediaWorkspaceSource[];
  selectedSourceId: string;
  sourceFamily: (source: MediaWorkspaceSource) => string;
  sourceDetail: (source: MediaWorkspaceSource) => string;
  onSelectSource: (sourceId: string) => void;
  fileAction: React.ReactNode;
};

export function MediaSourceRail({
  title = 'Choose media',
  sources,
  selectedSourceId,
  sourceFamily,
  sourceDetail,
  onSelectSource,
  fileAction,
}: MediaSourceRailProps) {
  return (
    <Card variant="surface" padding="md" layout="stack">
      <Container layout="horizontal" justifyContent="between" alignItems="center">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-lg">{title}</Text>
        </Container>
        <Badge size="lg" variant="neutral">{sources.length}</Badge>
      </Container>

      <ScrollableSurface>
        <Container layout="vertical" gap="sm">
          {sources.map((source) => {
            const selected = source.source_id === selectedSourceId;
            const family = sourceFamily(source);
            const detail = sourceDetail(source);
            return (
              <Card
                key={source.source_id}
                variant={selected ? 'active' : 'nested'}
                padding="sm"
                interactive
                selected={selected}
                onClick={() => onSelectSource(source.source_id)}
              >
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <MediaThumb family={family} selected={selected} />
                  <Container layout="vertical" gap="xs">
                    <Container layout="horizontal" justifyContent="between" alignItems="center" gap="sm">
                      <Text variant="body" weight="semibold">{source.label}</Text>
                      <Badge size="sm" variant={selected ? 'accent' : 'neutral'}>{family}</Badge>
                    </Container>
                    <Text variant="body-xs" color="faint">{detail}</Text>
                    <ProgressBar percentage={66} color="var(--accent-blue)" height="6px" />
                  </Container>
                </Container>
              </Card>
            );
          })}
          {sources.length === 0 ? (
            <Card variant="nested" padding="md">
              <Text variant="body" weight="semibold">Add media.</Text>
              <Text variant="body" color="faint">Pick or drop video, audio, or images.</Text>
            </Card>
          ) : null}
        </Container>
      </ScrollableSurface>

      {fileAction}
    </Card>
  );
}
