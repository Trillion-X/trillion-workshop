//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Per-agent DETAIL panel rendered inside the hub's main area when one agent is
// opened from the Agents category. The hub's persistent LEFT COLUMN owns the
// top-level switch (Agents / Models / Tools / Instructions / Memory / Runs /
// Permissions); this panel never re-creates that nav. It shows ONE agent's
// real content INLINE — instruction bodies, what each tool does, model,
// permissions, recent work — no click-to-reveal, no decorative glyphs.
//
// Reference anatomy (CS-268 Mobbin contract): Attio/Linear record page (full
// object inline, sectioned), Relevance AI agent object, Zapier blocked-reason
// proximity. This view arranges owner-fed data; it is never a second truth.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Real content is VISIBLE, not hidden behind a click (the "6-word
//    instructions" failure: a title with the body buried is not the content).
// 2. No decorative/unlabeled glyph rows — every visible element earns its place
//    by serving the next action (L118).
// 3. No internal vocabulary in visible copy (copy lock: Agents, Agent, Tool,
//    Model, Run, Memory, Instruction, Permission, Allowed, Blocked, …).
// 4. Empty sections say so honestly; no sample rows ever (no fake data).
//
// =============================================================================

import React from 'react';
import { ArrowLeft, Check, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Container,
  Icon,
  NamedIcon,
  SegmentedControl,
  Text,
} from '@/packages/ui';
import type {
  AgentCardViewModel,
  CapabilityIconConfig,
  InstructionBlockRecord,
  MemoryRecord,
  ModelDescriptorRecord,
  ModelRuntimeRecord,
  PermissionRow,
  ToolDescriptorRecord,
  ConversationSessionRow,
} from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { formatRelativeTime, resolvePlacement } from '@/packages/agents-hub/read-data/resolve-agent-cards';

export type ManagerTab = 'profile' | 'tools' | 'models' | 'runs' | 'memory' | 'instructions' | 'permissions';

const TABS: readonly { id: ManagerTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'tools', label: 'Tools' },
  { id: 'models', label: 'Models' },
  { id: 'runs', label: 'Runs' },
  { id: 'memory', label: 'Memory' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'permissions', label: 'Permissions' },
];

export interface AgentManagerViewProps {
  agent: AgentCardViewModel;
  onBack: () => void;
  onEdit: (id: string) => void;
  /** Owner-fed collections, already decoded blind from the feed. */
  tools: readonly ToolDescriptorRecord[];
  models: readonly ModelDescriptorRecord[];
  runtimes: readonly ModelRuntimeRecord[];
  capabilityConfig: CapabilityIconConfig;
  sessions: readonly ConversationSessionRow[];
  memories: readonly MemoryRecord[];
  instructionBlocks: readonly InstructionBlockRecord[];
  permissions: readonly PermissionRow[];
}

/** A titled section row: bold label + muted body, all inline. */
function SectionCard({ title, badge, badgeTone, body }: {
  title: string;
  badge?: string;
  badgeTone?: 'muted' | 'success' | 'error';
  body?: string;
}): React.ReactElement {
  return (
    <Card variant="nested" padding="sm" layout="stack">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Text variant="body-sm" weight="semibold">{title}</Text>
        {badge && <Badge variant={badgeTone ?? 'muted'}>{badge}</Badge>}
      </Container>
      {body && <Text variant="body-xs" color="muted">{body}</Text>}
    </Card>
  );
}

export function AgentManagerView({
  agent,
  onBack,
  onEdit,
  tools,
  models,
  runtimes,
  capabilityConfig,
  sessions,
  memories,
  instructionBlocks,
  permissions,
}: AgentManagerViewProps): React.ReactElement {
  const [tab, setTab] = React.useState<ManagerTab>('profile');

  // Owner-fed scoping: refs on the agent profile select the rows.
  const agentTools = tools.filter((tool) => agent.profile.tool_refs.includes(tool.id));
  const agentModels = models.filter((model) => agent.profile.model_refs.includes(model.id));
  const runtimeById = React.useMemo(
    () => new Map(runtimes.map((runtime) => [runtime.runtime_id, runtime])),
    [runtimes],
  );
  const agentSessions = [...sessions]
    .filter((session) => session.agentId === agent.id)
    .sort((left, right) => (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''));
  const agentMemories = memories.filter((memory) => memory.agent_ref === agent.id || agent.profile.memory_refs.includes(memory.id));
  const agentBlocks = agent.profile.instruction_refs
    .map((ref) => instructionBlocks.find((block) => block.id === ref))
    .filter((block): block is InstructionBlockRecord => Boolean(block));
  const warningCount = permissions.filter((permission) => !permission.allowed).length;

  const empty = (message: string) => <Text variant="body-xs" color="faint">{message}</Text>;

  const tabContent: Record<ManagerTab, React.ReactNode> = {
    profile: (
      <Container layout="vertical" gap="sm">
        {[
          ...(agent.description ? [{ label: 'About', value: agent.description }] : []),
          ...(agent.modelLabel ? [{ label: 'Model', value: agent.modelLabel }] : []),
          { label: 'Tools', value: agentTools.length === 0 ? 'None yet' : String(agentTools.length) },
          { label: 'Instructions', value: agentBlocks.length === 0 ? 'None yet' : String(agentBlocks.length) },
          { label: 'Recent work', value: agentSessions.length === 0 ? 'None yet' : String(agentSessions.length) },
        ].map((row) => (
          <Container key={row.label} layout="horizontal" gap="md" alignItems="baseline">
            <Container layout="vertical" minWidth="120px">
              <Text variant="body-xs" color="faint">{row.label}</Text>
            </Container>
            <Text variant="body-sm">{row.value}</Text>
          </Container>
        ))}
        <Container layout="horizontal" gap="sm">
          <Button variant="secondary" size="sm" onClick={() => onEdit(agent.id)}>Edit agent</Button>
        </Container>
      </Container>
    ),
    tools: agentTools.length === 0
      ? empty('No tools yet.')
      : (
        <Container layout="vertical" gap="xs">
          {agentTools.map((tool) => (
            <SectionCard
              key={tool.id}
              title={tool.label ?? 'Tool'}
              badge={tool.status ?? 'Active'}
              body={tool.description}
            />
          ))}
        </Container>
      ),
    models: agentModels.length === 0
      ? empty('No model chosen yet.')
      : (
        <Container layout="vertical" gap="xs">
          {agentModels.map((model) => {
            const placement = resolvePlacement(model, runtimeById, capabilityConfig);
            return (
            <Card key={model.id} variant="nested" padding="sm" layout="stack">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <NamedIcon name={placement.icon} size="xs" />
                  <Text variant="body-sm" weight="semibold">{model.display_name ?? model.id}</Text>
                </Container>
                <Badge variant="muted">{placement.label}</Badge>
              </Container>
              {model.capabilities.length > 0 && (
                <Text variant="body-xs" color="muted">{`Handles ${model.capabilities.join(', ')}.`}</Text>
              )}
            </Card>
            );
          })}
        </Container>
      ),
    runs: agentSessions.length === 0
      ? empty('No recent work yet.')
      : (
        <Container layout="vertical" gap="xs">
          {agentSessions.slice(0, 50).map((session) => {
            const when = formatRelativeTime(session.lastActivityAt ?? session.startedAt);
            const count = session.messageCount && session.messageCount > 0
              ? `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}` : '';
            return (
              <SectionCard
                key={session.recordId}
                title={session.title ?? session.prompt ?? 'Session'}
                badge={[when, count].filter(Boolean).join(' · ') || undefined}
                body={session.title ? (session.prompt ?? undefined) : undefined}
              />
            );
          })}
        </Container>
      ),
    memory: agentMemories.length === 0
      ? empty('Nothing remembered yet.')
      : (
        <Container layout="vertical" gap="xs">
          {agentMemories.map((memory) => (
            <SectionCard key={memory.id} title={memory.label ?? 'Memory'} body={memory.body} />
          ))}
        </Container>
      ),
    instructions: agentBlocks.length === 0
      ? empty('No instructions yet.')
      : (
        <Container layout="vertical" gap="sm">
          {agentBlocks.map((block, index) => (
            <Card key={block.id} variant="nested" padding="sm" layout="stack">
              <Text variant="body-sm" weight="semibold">{block.label ?? `Instruction ${String(index + 1)}`}</Text>
              {block.body
                ? <Text variant="body-xs" color="muted">{block.body}</Text>
                : <Text variant="body-xs" color="faint">This instruction has no text yet.</Text>}
            </Card>
          ))}
        </Container>
      ),
    permissions: permissions.length === 0
      ? empty('No permissions to review.')
      : (
        <Container layout="vertical" gap="xs">
          {permissions.map((permission) => (
            <Card key={permission.id} variant="nested" padding="sm" layout="stack">
              <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Icon icon={permission.allowed ? Check : X} size="xs" />
                  <Text variant="body-sm" weight="semibold">{permission.label}</Text>
                </Container>
                <Badge variant={permission.allowed ? 'success' : 'error'}>
                  {permission.allowed ? 'Allowed' : 'Blocked'}
                </Badge>
              </Container>
              {!permission.allowed && permission.reason && (
                <Text variant="body-xs" color="muted">{permission.reason}</Text>
              )}
            </Card>
          ))}
        </Container>
      ),
  };

  return (
    <Container layout="vertical" gap="md" flex="1" minHeight="0" overflow="hidden">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button variant="ghost" size="sm" aria-label="Back to agents" onClick={onBack}>
          <Icon icon={ArrowLeft} size="xs" />
          Agents
        </Button>
        <Container layout="vertical" flex="1">
          <Text variant="heading-md">{agent.name}</Text>
          {agent.modelLabel && <Text variant="body-xs" color="faint">{agent.modelLabel}</Text>}
        </Container>
        {warningCount > 0 && (
          <Badge variant="warning">{`${String(warningCount)} blocked`}</Badge>
        )}
      </Container>

      <SegmentedControl
        items={TABS.map((entry) => ({ id: entry.id, label: entry.label }))}
        value={tab}
        onValueChange={(value) => setTab(value as ManagerTab)}
        ariaLabel="Agent sections"
      />

      <Container layout="vertical" gap="sm" flex="1" overflow="y-auto" minHeight="0">
        {tabContent[tab]}
      </Container>
    </Container>
  );
}
