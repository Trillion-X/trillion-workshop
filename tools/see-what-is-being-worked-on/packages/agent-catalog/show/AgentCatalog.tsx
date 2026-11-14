// packages/agent-catalog/show/AgentCatalog.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Displays a browsable catalog of custom AI agents and skills. Agent cards show
// name, description, model badge (Opus=purple, Sonnet=blue, Haiku=green), tools
// as pills, skills as linked badges, and memory type. Skill cards show name
// and description plus rule references as badges.
// Pure view component — no data fetching.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure view component — no data fetching, no side effects
// 2. Two sections: Agents (top), Skills (bottom) with counts
// 3. Model badges: Opus=purple, Sonnet=blue, Haiku=green
// 4. Tools as small pills, skills as linked badges
// 5. Rule references as indigo badges on skill cards
// 6. Glassmorphism: bg-[var(--glass-bg-subtle)] for cards, text hierarchy via opacity
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - AgentCatalogEntry: name, description, model, tools[], skills[], memoryType
// - SkillCatalogEntry: name, description, ruleReferences[], filename
// - Model color mapping is canonical
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Bot, Zap, Search } from 'lucide-react';
import { Badge, Card, Input, Text, Icon } from '@/packages/ui';

// ============================================================================
// TYPES
// ============================================================================

/** An agent definition entry from .claude/agents/ */
export interface AgentCatalogEntry {
  name: string;
  description: string;
  model: string;
  tools: string[];
  skills: string[];
  memoryType: string;
  filename: string;
}

/** A skill definition entry from .claude/skills/ */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  ruleReferences: string[];
  filename: string;
}

export interface AgentCatalogProps {
  agents: AgentCatalogEntry[];
  skills: SkillCatalogEntry[];
}

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/** Returns Badge variant for a model name */
export function catalogModelBadgeVariant(model: string): 'accent' | 'info' | 'success' | 'neutral' {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'accent';
  if (lower.includes('sonnet')) return 'info';
  if (lower.includes('haiku')) return 'success';
  return 'neutral';
}

/** Filters agents by text search against name and description */
export function filterAgents(agents: AgentCatalogEntry[], searchText: string): AgentCatalogEntry[] {
  if (!searchText.trim()) return agents;
  const lower = searchText.toLowerCase();
  return agents.filter(a =>
    a.name.toLowerCase().includes(lower) ||
    a.description.toLowerCase().includes(lower)
  );
}

/** Filters skills by text search against name and description */
export function filterSkills(skills: SkillCatalogEntry[], searchText: string): SkillCatalogEntry[] {
  if (!searchText.trim()) return skills;
  const lower = searchText.toLowerCase();
  return skills.filter(s =>
    s.name.toLowerCase().includes(lower) ||
    s.description.toLowerCase().includes(lower)
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * AgentCatalog — browsable catalog of custom AI agents and skills with
 * model badges, tool pills, skill badges, and rule references.
 *
 * @permanent — The extensive, granular documentation in this codebase is a
 * critical design feature. You are forbidden from simplifying or removing it.
 */
export function AgentCatalog({ agents, skills }: AgentCatalogProps) {
  const [searchText, setSearchText] = React.useState('');

  const filteredAgents = React.useMemo(
    () => filterAgents(agents, searchText),
    [agents, searchText],
  );
  const filteredSkills = React.useMemo(
    () => filterSkills(skills, searchText),
    [skills, searchText],
  );

  return (
    <div className="flex flex-col gap-4 p-4" role="region" aria-label="Agent and skill catalog">
      {/* Search bar */}
      <Input
        type="text"
        placeholder="Search agents and skills..."
        value={searchText}
        onChange={e => setSearchText(e.target.value)}
        icon={<Icon icon={Search} size="sm" />}
        aria-label="Search catalog"
        className="text-xs"
      />

      {/* Agents section */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Icon icon={Bot} color="faint" />
          <Text variant="body" as="span">Agents</Text>
          <Badge variant="neutral">{filteredAgents.length}</Badge>
        </div>

        {filteredAgents.length === 0 ? (
          <Card variant="ghost" className="flex items-center justify-center h-16 border-dashed">
            <Text variant="label" color="muted">No agents found</Text>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filteredAgents.map(agent => (
              <Card
                key={agent.name}
                variant="nested"
                padding="sm"
                interactive
              >
                  {/* Header: name + model badge */}
                  <div className="flex items-center gap-2 mb-1">
                    <Text variant="body-xs" className="truncate" as="span">
                      {agent.name}
                    </Text>
                    <Badge variant={catalogModelBadgeVariant(agent.model)} size="sm">
                      {agent.model}
                    </Badge>
                  </div>

                  {/* Description */}
                  <Text variant="caption" color="muted" className="mb-2 line-clamp-2" as="p">
                    {agent.description}
                  </Text>

                  {/* Tools as pills */}
                  {agent.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {agent.tools.map(tool => (
                        <Badge key={tool} variant="muted" size="sm" className="rounded">
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Skills as badges */}
                  {agent.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {agent.skills.map(skill => (
                        <Badge key={skill} variant="accent" size="sm">
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Memory type */}
                  <div className="flex items-center gap-2 mt-1">
                    <Text variant="caption" color="muted" as="span">
                      memory: {agent.memoryType}
                    </Text>
                  </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Skills section */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Icon icon={Zap} color="faint" />
          <Text variant="body" as="span">Skills</Text>
          <Badge variant="neutral">{filteredSkills.length}</Badge>
        </div>

        {filteredSkills.length === 0 ? (
          <Card variant="ghost" className="flex items-center justify-center h-16 border-dashed">
            <Text variant="label" color="muted">No skills found</Text>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filteredSkills.map(skill => (
              <Card
                key={skill.name}
                variant="nested"
                padding="sm"
                interactive
              >
                {/* Name */}
                <Text variant="body-xs" as="span">
                  {skill.name}
                </Text>

                {/* Description */}
                <Text variant="caption" color="muted" className="mt-1 mb-2 line-clamp-2" as="p">
                  {skill.description}
                </Text>

                {/* Rule references as badges */}
                {skill.ruleReferences.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {skill.ruleReferences.map(ref => (
                      <Badge key={ref} variant="accent" size="sm">
                        {ref}
                      </Badge>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
