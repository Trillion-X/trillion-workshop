//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One agent card in the hub grid. Reference anatomy: Langdock agents grid —
// identity row (avatar mark + name + overflow menu), 2-line description,
// meta row (model + local/cloud mark + capability icons), usage row
// (runs · tokens · cost) only when usage exists. The avatar doubles as the
// selection checkbox (SelectableAvatar); the unread dot rides on the avatar.
//
// =============================================================================

import React from 'react';
import {
  Badge,
  Button,
  CapabilityIconRow,
  Card,
  Container,
  Dropdown,
  NamedIcon,
  SelectableAvatar,
  Text,
  Tooltip,
} from '@/packages/ui';
import type { AgentCardViewModel } from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { formatCost, formatUnits } from '@/packages/agents-hub/read-data/resolve-agent-cards';

export interface AgentCardProps {
  agent: AgentCardViewModel;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}

export const AgentCard = React.memo(function AgentCard({
  agent,
  selected,
  onToggleSelect,
  onOpen,
  onEdit,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: AgentCardProps) {
  const menuItems = [
    { value: 'edit', label: 'Edit', icon: 'Pencil' },
    { value: 'duplicate', label: 'Duplicate', icon: 'Copy' },
    agent.archived
      ? { value: 'restore', label: 'Restore', icon: 'ArchiveRestore' }
      : { value: 'archive', label: 'Archive', icon: 'Archive' },
    { value: 'delete', label: 'Delete', icon: 'Trash2', tint: '#fda4af' },
  ];

  const usage = [
    agent.runCount > 0 ? `${agent.runCount} run${agent.runCount === 1 ? '' : 's'}` : '',
    formatUnits(agent.totalUnits) ? `${formatUnits(agent.totalUnits)} tokens` : '',
    formatCost(agent.totalCost),
  ].filter(Boolean).join(' · ');

  return (
    <Card
      variant="surface"
      padding="md"
      interactive
      selected={selected}
      onClick={() => onOpen(agent.id)}
      role="button"
      aria-label={agent.name}
    >
      <Container layout="vertical" gap="sm">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <SelectableAvatar
            name={agent.name}
            selected={selected}
            onToggle={() => onToggleSelect(agent.id)}
            dot={agent.conversationCount > 0}
            dotLabel="Has conversations"
          />
          <Container layout="vertical" flex="1" overflow="hidden">
            <Text variant="body" weight="semibold" truncate>{agent.name}</Text>
          </Container>
          <Dropdown
            items={menuItems}
            value=""
            onValueChange={(value) => {
              if (value === 'edit') onEdit(agent.id);
              if (value === 'duplicate') onDuplicate(agent.id);
              if (value === 'archive') onArchive(agent.id);
              if (value === 'restore') onRestore(agent.id);
              if (value === 'delete') onDelete(agent.id);
            }}
            customTrigger={
              <Button
                variant="ghost"
                size="xs"
                aria-label="Agent actions"
                onClick={(event: React.MouseEvent) => event.stopPropagation()}
              >
                <NamedIcon name="MoreHorizontal" size="sm" />
              </Button>
            }
            align="end"
          />
        </Container>

        {agent.description && (
          <Text variant="body-xs" color="muted" clamp={2}>{agent.description}</Text>
        )}

        <Container layout="horizontal" gap="sm" alignItems="center" wrap="wrap">
          {agent.modelLabel && (
            <Container layout="horizontal" gap="xs" alignItems="center" overflow="hidden">
              <Tooltip label={agent.placement.label}>
                <NamedIcon name={agent.placement.icon} size="xs" />
              </Tooltip>
              <Text variant="caption" color="subtle" truncate>{agent.modelLabel}</Text>
            </Container>
          )}
          <CapabilityIconRow items={agent.capabilityIcons} />
          {agent.archived && <Badge variant="muted">Archived</Badge>}
        </Container>

        {usage && (
          <Text variant="caption" color="faint">{usage}</Text>
        )}
      </Container>
    </Card>
  );
});
