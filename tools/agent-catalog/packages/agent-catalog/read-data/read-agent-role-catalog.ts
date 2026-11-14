// packages/agent-catalog/read-data/read-agent-role-catalog.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure addressed-feed decoder for the agent role and skill catalog.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Agent-role catalog truth comes only from the owner-published addressed feed
// 2. This module only decodes feed payloads
// 3. No connection access or writes
// 4. No SQL/table vocabulary
//
// =============================================================================

import type { AgentCatalogEntry, SkillCatalogEntry } from '@/packages/agent-catalog/read-data/agent-role-catalog-types';

interface CatalogFact {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
}

interface MutableAgentCatalogEntry {
  id: string;
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  isActive: boolean;
  instanceCount: number;
  badgeVariant: AgentCatalogEntry['badgeVariant'];
}

interface MutableSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asBadgeVariant(value: unknown): AgentCatalogEntry['badgeVariant'] {
  return value === 'accent' || value === 'info' || value === 'success' ? value : 'neutral';
}

function newAgent(id: string): MutableAgentCatalogEntry {
  return {
    id,
    name: '',
    type: '',
    description: '',
    capabilities: [],
    isActive: false,
    instanceCount: 0,
    badgeVariant: 'neutral',
  };
}

function newSkill(id: string): MutableSkillCatalogEntry {
  return {
    id,
    name: '',
    description: '',
  };
}

export function decodeAgentRoleCatalogFeed(raw: unknown): {
  agents: AgentCatalogEntry[];
  skills: SkillCatalogEntry[];
} {
  const rows = Array.isArray(raw) ? raw : [];
  const agents = new Map<string, MutableAgentCatalogEntry>();
  const skills = new Map<string, MutableSkillCatalogEntry>();

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const row = entry as CatalogFact;
    const subjectId = asString(row.subject_id);
    const propertyId = asString(row.property_id);
    if (!subjectId || !propertyId) continue;

    const value = row.value;

    if (propertyId.startsWith('prop:agent_role:')) {
      const agent = agents.get(subjectId) ?? newAgent(subjectId);
      if (propertyId === 'prop:agent_role:name') {
        agent.name = asString(value);
      } else if (propertyId === 'prop:agent_role:type') {
        agent.type = asString(value);
      } else if (propertyId === 'prop:agent_role:description') {
        agent.description = asString(value);
      } else if (propertyId === 'prop:agent_role:capabilities') {
        agent.capabilities = asStringArray(value);
      } else if (propertyId === 'prop:agent_role:is_active') {
        agent.isActive = asBoolean(value);
      } else if (propertyId === 'prop:agent_role:instance_count') {
        agent.instanceCount = asNumber(value);
      } else if (propertyId === 'prop:agent_role:badge_variant') {
        agent.badgeVariant = asBadgeVariant(value);
      }
      agents.set(subjectId, agent);
    } else if (propertyId.startsWith('prop:skill_definition:')) {
      const skill = skills.get(subjectId) ?? newSkill(subjectId);
      if (propertyId === 'prop:skill_definition:name') {
        skill.name = asString(value);
      } else if (propertyId === 'prop:skill_definition:description') {
        skill.description = asString(value);
      }
      skills.set(subjectId, skill);
    }
  }

  return {
    agents: Array.from(agents.values()).sort((left, right) => left.name.localeCompare(right.name)),
    skills: Array.from(skills.values()).sort((left, right) => left.name.localeCompare(right.name)),
  };
}
