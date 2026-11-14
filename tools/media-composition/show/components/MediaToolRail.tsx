import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { ToolTile } from '../../../ui/show/tool-tile';

export type MediaTool = {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
};

export type MediaToolRailProps = {
  tools: MediaTool[];
  selectedToolId: string;
  onSelectTool: (toolId: string) => void;
};

export function MediaToolRail({ tools, selectedToolId, onSelectTool }: MediaToolRailProps) {
  return (
    <Card variant="surface" padding="sm">
      <Container layout="horizontal" gap="sm" wrap>
        {tools.map((tool) => (
          <ToolTile
            key={tool.id}
            icon={tool.icon}
            label={tool.label}
            detail={tool.detail}
            selected={tool.id === selectedToolId}
            orientation="row"
            onClick={() => onSelectTool(tool.id)}
          />
        ))}
      </Container>
    </Card>
  );
}
