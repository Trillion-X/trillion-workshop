// packages/agent-catalog/show/OrganizationalChart.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Visual organizational chart displaying all agent roles and skills in a
// glassmorphic card layout. Shows agent name, type, description, capabilities,
// and deployment status (active/idle/instance count). Dynamically discovered
// from EEAF agent/skill catalog entities.
//
// This is the "employee directory" view for the AI Bitfield Studio —
// displaying the full roster of available agent roles (not just active instances),
// along with their skills and current deployment status.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure view component — receives catalog data as props, no fetching
// 2. All styling through ui/ component props (Card, Badge, Container, Text)
// 3. Responsive grid: 2 columns on narrow, 3 on wide
// 4. Glassmorphism: glass-surface cards with proper opacity/backdrop-blur
// 5. Status indicators: green dot = active, gray dot = idle
// 6. AgentIdentity is NOT used here — it expects runtime-agent data. AgentCatalogEntry
//    is a catalog definition (static roles), not a live runtime instance. Mixing
//    these types would violate SSOT by fabricating runtime facts from catalog data.
// 7. Skills section: horizontal pill layout below agents
// 8. Zero raw HTML elements, zero inline styles, zero className
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
//
// =============================================================================

import React from 'react';
import { Card, Badge, Container, Text, StatusDot } from '@/packages/ui';
import type { AgentCatalogEntry, SkillCatalogEntry } from '@/packages/agent-catalog/read-data/agent-role-catalog-types';

// ============================================================================
// PROPS
// ============================================================================

export interface OrganizationalChartProps {
  agents: readonly AgentCatalogEntry[];
  skills: readonly SkillCatalogEntry[];
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Maps agent active state to StatusDot variant.
 */
function statusIndicatorVariant(
  isActive: boolean,
): 'success' | 'idle' {
  return isActive ? 'success' : 'idle';
}

// ============================================================================
// SUBCOMPONENTS
// ============================================================================

/**
 * Single agent card in the org chart.
 * Displays name, type, description, capabilities, and status.
 *
 * NOTE: AgentIdentity is intentionally NOT used here. AgentIdentity expects
 * runtime-agent data. AgentCatalogEntry is a static catalog definition — a role,
 * not an instance. Using AgentIdentity would require fabricating runtime facts
 * from catalog data, which violates SSOT. The AgentNode below renders the same
 * visual elements (StatusDot + name + type Badge) correctly from catalog props.
 */
const AgentNode = React.memo(function AgentNode({ agent }: { agent: AgentCatalogEntry }) {
  const statusVariant = statusIndicatorVariant(agent.isActive);

  return (
    <Card variant="nested" padding="md" interactive>
      <Container layout="vertical" gap="sm">
        {/* Header: Name + Status Dot */}
        <Container layout="horizontal" alignItems="center" gap="sm">
          <StatusDot
            status={statusVariant}
            size="md"
            pulse={agent.isActive}
            label={agent.isActive ? 'Active' : 'Idle'}
          />
          <Text variant="body-xs" weight="medium" truncate>
            {agent.name}
          </Text>
        </Container>

        {/* Type Badge */}
        <Badge variant={agent.badgeVariant} size="sm">
          {agent.type}
        </Badge>

        {/* Description */}
        <Text variant="caption" color="muted">
          {agent.description}
        </Text>

        {/* Capabilities as small pills */}
        {agent.capabilities.length > 0 && (
          <Container layout="horizontal" gap="xs" wrap>
            {agent.capabilities.map((cap) => (
              <Badge key={cap} variant="muted" size="sm">
                {cap}
              </Badge>
            ))}
          </Container>
        )}

        {/* Instance count badge if > 0 */}
        {agent.instanceCount > 0 && (
          <Badge variant="success" size="sm">
            {agent.instanceCount} instance{agent.instanceCount !== 1 ? 's' : ''}
          </Badge>
        )}
      </Container>
    </Card>
  );
});
AgentNode.displayName = 'AgentNode';

/**
 * Skills section — horizontal pill list of all available skills.
 */
const SkillsPill = React.memo(function SkillsPill({ skills }: { skills: readonly SkillCatalogEntry[] }) {
  return (
    <Card variant="surface" padding="md">
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" alignItems="center" gap="sm">
          <Text variant="body" weight="medium">
            Available Skills
          </Text>
          <Badge variant="neutral">{skills.length}</Badge>
        </Container>
        {skills.length === 0 ? (
          <Text variant="caption" color="muted">
            No skills available
          </Text>
        ) : (
          <Container layout="horizontal" gap="xs" wrap>
            {skills.map((skill) => (
              <Badge key={skill.id} variant="accent" size="md">
                {skill.name}
              </Badge>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
});
SkillsPill.displayName = 'SkillsPill';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * OrganizationalChart — displays all agent roles in a glassmorphic grid.
 *
 * Renders:
 * 1. Agent grid (2-3 columns responsive) with AgentNode cards
 * 2. Skills section below with horizontal pill layout
 * 3. Empty states for no agents or no skills
 *
 * @example
 * ```tsx
 * return <OrganizationalChart agents={catalog.agents} skills={catalog.skills} />;
 * ```
 */
export function OrganizationalChart({
  agents,
  skills,
}: OrganizationalChartProps) {
  return (
    <Container layout="vertical" gap="lg" width="full">
      {/* Agents Section */}
      <Container layout="vertical" gap="md">
        <Container layout="horizontal" alignItems="center" gap="sm">
          <Text variant="heading-lg" weight="semibold">
            Agent Roster
          </Text>
          <Badge variant="neutral">{agents.length}</Badge>
        </Container>

        {agents.length === 0 ? (
          <Card variant="ghost" padding="lg">
            <Text variant="body" color="muted">
              No agents configured
            </Text>
          </Card>
        ) : (
          <Container layout="grid" gridCols={3} gap="md">
            {agents.map((agent) => (
              <AgentNode key={agent.id} agent={agent} />
            ))}
          </Container>
        )}
      </Container>

      {/* Skills Section */}
      <SkillsPill skills={skills} />
    </Container>
  );
}
