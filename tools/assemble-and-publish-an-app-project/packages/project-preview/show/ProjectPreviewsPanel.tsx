import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Card, Icon, Text } from '@/packages/ui';
import { ProjectPreviewButton } from '@/packages/project-preview/show/ProjectPreviewButton';
import type { ProjectPreviewDescriptor } from '@/packages/project-preview/read-data/read-project-preview-descriptors';

export interface ProjectPreviewsPanelProps {
  previews: ProjectPreviewDescriptor[];
}

export function ProjectPreviewsPanel({ previews }: ProjectPreviewsPanelProps) {
  return (
    <div className="space-y-3">
      <div>
        <Text variant="label" as="h2">Project previews</Text>
        <Text variant="caption" color="muted" as="p">
          Shows project preview URLs through project-preview owner records.
        </Text>
      </div>

      {previews.length === 0 ? (
        <Card variant="nested" padding="sm">
          <Text variant="caption" color="muted" as="p">
            No preview URLs are published yet.
          </Text>
        </Card>
      ) : (
        <div className="space-y-2">
          {previews.map((preview) => (
            <Card
              key={preview.id}
              variant="nested"
              padding="sm"
              className="flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <Text variant="body" as="p" className="truncate">{preview.name}</Text>
                <Text variant="caption" color="muted" mono as="p" className="truncate">
                  {preview.url}
                </Text>
              </div>
              <ProjectPreviewButton preview={preview} />
            </Card>
          ))}
        </div>
      )}

      <Text variant="caption" color="faint" as="p" className="flex items-center gap-1">
        <Icon icon={ExternalLink} size="xs" />
        External open is a separate escape hatch; Preview writes the in-app surface.
      </Text>
    </div>
  );
}
