//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Quick-view modal for one agent. Reference anatomy: Langdock agent modal —
// centered identity, stat strip (Conversations / Model / Spend), capability
// icons, tools, ordered instruction preview, then a message input and two
// actions: Edit (secondary) + Start chat (primary). Sending a message
// dispatches blind through the caller-provided handler; the modal stays open.
//
// =============================================================================

import React from 'react';
import {
  Button,
  CapabilityIconRow,
  Container,
  NamedIcon,
  StatStrip,
  Text,
  Textarea,
  Tooltip,
} from '@/packages/ui';
import type { AgentCardViewModel, MemoryRecord } from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { formatCost } from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

export interface AgentQuickViewProps {
  agent: AgentCardViewModel;
  /** This agent's memory records (already filtered by the caller) */
  memories: readonly MemoryRecord[];
  onClose: () => void;
  onEdit: (id: string) => void;
  /** Opens the full manager (tabbed list/detail) for this agent. */
  onOpenManager?: (id: string) => void;
  /** Dispatches one message to this agent. Resolves when the send is accepted. */
  onSendMessage: (id: string, text: string) => Promise<void>;
}

export function AgentQuickView({ agent, memories, onClose, onEdit, onOpenManager, onSendMessage }: AgentQuickViewProps) {
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendFailed, setSendFailed] = React.useState(false);

  const stats = [
    { label: 'Conversations', value: String(agent.conversationCount) },
    ...(agent.modelLabel ? [{ label: 'Model', value: agent.modelLabel }] : []),
    ...(formatCost(agent.totalCost) ? [{ label: 'Spend', value: formatCost(agent.totalCost) }] : []),
  ];

  const send = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      await onSendMessage(agent.id, trimmed);
      setDraft('');
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }, [agent.id, onSendMessage, sending]);

  return (
    <FloatingPanel open onClose={onClose} label="Agent" width={448}>
      <Container layout="vertical" gap="md" alignItems="center">
        <Container layout="vertical" gap="xs" alignItems="center">
          <Text variant="heading-md">{agent.name}</Text>
          {agent.description && (
            <Text variant="body-xs" color="muted" align="center">{agent.description}</Text>
          )}
          <Container layout="horizontal" gap="sm" alignItems="center">
            {agent.modelLabel && (
              <Tooltip label={agent.placement.label}>
                <NamedIcon name={agent.placement.icon} size="xs" />
              </Tooltip>
            )}
            <CapabilityIconRow items={agent.capabilityIcons} size="sm" />
          </Container>
        </Container>

        <Container layout="vertical" gap="sm" width="full">
          <StatStrip stats={stats} />

          {agent.toolLabels.length > 0 && (
            <Container layout="vertical" gap="xs">
              <Text variant="overline" color="faint">Tools</Text>
              <Text variant="body-xs" color="subtle">{agent.toolLabels.join(' · ')}</Text>
            </Container>
          )}

          {agent.instructionBlocks.length > 0 && (
            <Container layout="vertical" gap="xs">
              <Text variant="overline" color="faint">Instructions</Text>
              {agent.instructionBlocks.map((block, index) => (
                <Text key={block.id} variant="body-xs" color={block.missing ? 'faint' : 'subtle'} truncate>
                  {index + 1}. {block.missing ? 'Unavailable block' : block.label || 'Untitled block'}
                </Text>
              ))}
            </Container>
          )}

          {memories.length > 0 && (
            <Container layout="vertical" gap="xs">
              <Text variant="overline" color="faint">Remembers</Text>
              {memories.slice(0, 3).map((memory) => (
                <Text key={memory.id} variant="body-xs" color="subtle" truncate>
                  {memory.label ?? memory.body}
                </Text>
              ))}
              {memories.length > 3 && (
                <Text variant="caption" color="faint">and {memories.length - 3} more</Text>
              )}
            </Container>
          )}

          <Container layout="vertical" gap="xs" width="full">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Message ${agent.name}…`}
              rows={2}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            {sendFailed && (
              <Text variant="caption" color="error">Message didn’t send. Try again.</Text>
            )}
          </Container>
        </Container>

        <Container layout="horizontal" gap="sm" width="full">
          {onOpenManager && (
            <Container layout="vertical" flex="1">
              <Button variant="secondary" size="md" onClick={() => onOpenManager(agent.id)}>
                See everything
              </Button>
            </Container>
          )}
          <Container layout="vertical" flex="1">
            <Button variant="secondary" size="md" onClick={() => onEdit(agent.id)}>
              Edit agent
            </Button>
          </Container>
          <Container layout="vertical" flex="1">
            <Button
              variant="primary"
              size="md"
              disabled={draft.trim().length === 0 || sending}
              onClick={() => void send(draft)}
            >
              {sending ? 'Sending…' : 'Send message'}
            </Button>
          </Container>
        </Container>
      </Container>
    </FloatingPanel>
  );
}
