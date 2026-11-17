// packages/agent-catalog/read-data/read-agent-catalog.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Leaf adapter from the owner-published agent-role-catalog feed to the browser
// AgentCatalog view contract.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads only the addressed catalog feed published by Society owner actions
// 2. Conversion is presentation-shape only; canonical ownership remains in the feed
// 3. No connection, query, mutation, or SQL/table access
// 4. No browser-owned runtime authority
//
// =============================================================================

import { decodeAgentRoleCatalogFeed } from './read-agent-role-catalog';
import type {
  AgentCatalogEntry as RoleCatalogEntry,
  SkillCatalogEntry as RoleSkillEntry,
} from '@/packages/agent-catalog/read-data/agent-role-catalog-types';

export interface CatalogAgentEntry {
  name: string;
  description: string;
  model: string;
  tools: string[];
  skills: string[];
  memoryType: string;
  filename: string;
}

export interface CatalogSkillEntry {
  name: string;
  description: string;
  ruleReferences: string[];
  filename: string;
}

function filenameFromId(id: string): string {
  return `${id.replace(/^[^:]+:/, '')}.md`;
}

function roleModel(role: RoleCatalogEntry): string {
  if (role.type === 'orchestrator') return 'opus';
  if (role.type === 'auditor') return 'sonnet';
  return 'haiku';
}

function toAgentCatalogEntry(role: RoleCatalogEntry): CatalogAgentEntry {
  return {
    name: role.name,
    description: role.description,
    model: roleModel(role),
    tools: [...role.capabilities],
    skills: [],
    memoryType: role.type === 'orchestrator' ? 'persistent' : 'project',
    filename: filenameFromId(role.id),
  };
}

function toSkillCatalogEntry(skill: RoleSkillEntry): CatalogSkillEntry {
  return {
    name: skill.name,
    description: skill.description,
    ruleReferences: [],
    filename: filenameFromId(skill.id),
  };
}

export function decodeCatalogFeed(raw: unknown): {
  agents: CatalogAgentEntry[];
  skills: CatalogSkillEntry[];
} {
  const catalog = decodeAgentRoleCatalogFeed(raw);

  return {
    agents: catalog.agents.map(toAgentCatalogEntry),
    skills: catalog.skills.map(toSkillCatalogEntry),
  };
}
