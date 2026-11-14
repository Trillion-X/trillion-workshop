// packages/projects/show/ProjectCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Individual project card for the Projects panel. Renders project identity
// (name, path), git status (branch badge, dirty count, ahead/behind), active
// agent badges, Claude memory indicator, and a pinned star. Supports two
// display modes: compact (grid) and expanded (list). Pure view component —
// no data fetching, no side effects.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Glassmorphism card: bg-[var(--glass-bg-subtle)] hover:bg-[var(--glass-bg-hover)]/[0.08] border border-[var(--border-primary)] rounded-lg
// 2. Git badge colors: branch=status-info, dirty=status-warning, clean=status-success
// 3. Model badges: Opus=accent-purple, Sonnet=status-info, Haiku=status-success
// 4. Compact (grid) and expanded (list) display modes
// 5. Pure view — zero side effects, zero data fetching
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - ProjectCardData: component-local prop type (wiring agent adds to domain types)
// - ProjectGitStatusData: git status sub-object (branch, dirtyFileCount, etc.)
// - Display mode controlled by parent via `mode` prop
//
// =============================================================================
// SECURITY CONSIDERATIONS
// =============================================================================
//
// - All user data (project names, paths) rendered as text content, never
//   interpolated into innerHTML or dangerouslySetInnerHTML.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { CheckCircle2, EyeOff, Folder, GitBranch, Star, Users, Brain, Send } from 'lucide-react';
import { Card, Badge, Button, Text, Icon } from '@/packages/ui';
import type {
  ProjectCardData,
  ProjectCardMode,
} from '@/packages/projects/read-data/project-card-types';

// ============================================================================
// TYPES
// ============================================================================

export interface ProjectCardProps {
  project: ProjectCardData;
  mode: ProjectCardMode;
  isCurrent?: boolean;
  onDispatch?: (projectId: string) => void;
  onHide?: (projectId: string) => void;
  onSelect?: (projectId: string) => void;
  onTogglePin?: (projectId: string) => void;
}

// ============================================================================
// PURE HELPER FUNCTIONS — exported for testing
// ============================================================================

/**
 * Returns Badge variant for the git dirty status indicator.
 * Clean = success, dirty = warning.
 */
export function gitStatusVariant(dirtyCount: number): 'warning' | 'success' {
  return dirtyCount > 0 ? 'warning' : 'success';
}

/**
 * Formats a dirty file count into a compact display string.
 * 0 → "clean", N → "N dirty"
 */
export function formatDirtyCount(count: number): string {
  return count === 0 ? 'clean' : `${count} dirty`;
}

/**
 * Truncates a file path for display, keeping the last N segments.
 * /projects/bitfield -> ~/projects/bitfield (keeps last 2 + ~)
 */
export function truncatePath(path: string, maxSegments: number = 3): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= maxSegments) return path;
  return '~/' + segments.slice(-maxSegments).join('/');
}

/**
 * Returns the number of active agents working on this project.
 */
export function activeAgentCount(project: ProjectCardData): number {
  return project.activeAgentIds.length;
}

/**
 * Formats ahead/behind into a compact display string.
 * null → null, {ahead:0,behind:0} → null, {ahead:2,behind:1} → "+2/-1"
 */
export function formatAheadBehind(ab: { ahead: number; behind: number } | null): string | null {
  if (!ab) return null;
  if (ab.ahead === 0 && ab.behind === 0) return null;
  const parts: string[] = [];
  if (ab.ahead > 0) parts.push(`+${ab.ahead}`);
  if (ab.behind > 0) parts.push(`-${ab.behind}`);
  return parts.join('/');
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * ProjectCard — renders a single project as a glassmorphism card.
 *
 * Supports compact (grid) and expanded (list) modes. The compact mode shows
 * name, branch, dirty count, and agent count. The expanded mode additionally
 * shows the full path, ahead/behind, team names, and memory indicator.
 *
 * @permanent — The extensive, granular documentation in this codebase is a
 * critical design feature. You are forbidden from simplifying or removing it.
 */
export function ProjectCard({
  project,
  mode,
  isCurrent = false,
  onDispatch,
  onHide,
  onSelect,
  onTogglePin,
}: ProjectCardProps) {
  const [hovered, setHovered] = React.useState(false);
  const agentCount = activeAgentCount(project);
  const aheadBehindStr = project.gitStatus ? formatAheadBehind(project.gitStatus.aheadBehind) : null;
  const selectionClass = isCurrent ? 'ring-1 ring-[var(--accent-primary)]' : '';

  if (mode === 'compact') {
    return (
      <Card
        variant="nested"
        padding="sm"
        interactive
        className={`group relative ${selectionClass}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => onSelect?.(project.id)}
        role="article"
        aria-label={`Project: ${project.name}`}
      >
        {/* Top row: icon + name + pin */}
        <div className="flex items-center gap-2 mb-1.5">
          <Icon icon={Folder} color="faint" className="shrink-0" />
          <Text variant="body" className="truncate flex-1" as="span">
            {project.name}
          </Text>
          {isCurrent && <Icon icon={CheckCircle2} size="sm" color="accent" className="shrink-0" />}
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => { e.stopPropagation(); onTogglePin?.(project.id); }}
            className="h-auto w-auto min-h-0 min-w-0 p-0"
            aria-label={project.pinned ? 'Unpin project' : 'Pin project'}
          >
            <Icon
              icon={Star}
              size="sm"
              color={project.pinned ? 'warning' : 'ghost'}
              className="shrink-0"
              style={project.pinned ? { fill: 'var(--color-warning)' } : undefined}
            />
          </Button>
        </div>

        {/* Path */}
        <Text variant="caption" mono color="muted" className="truncate mb-2" as="p">
          {truncatePath(project.path)}
        </Text>

        {/* Bottom row: git status + agents */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {project.isGitRepo && project.gitStatus && (
              <>
                <Badge variant="info" size="sm" className="flex items-center gap-1">
                  <Icon icon={GitBranch} size="xs" />
                  {project.gitStatus.branch}
                </Badge>
                <Badge variant={gitStatusVariant(project.gitStatus.dirtyFileCount)} size="sm">
                  {formatDirtyCount(project.gitStatus.dirtyFileCount)}
                </Badge>
              </>
            )}
          </div>

          {agentCount > 0 && (
            <Text variant="caption" color="muted" as="span" className="flex items-center gap-1">
              <Icon icon={Users} size="xs" />
              {agentCount}
            </Text>
          )}
        </div>

        {hovered && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1">
            {onHide && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => { e.stopPropagation(); onHide(project.id); }}
                className="text-[length:var(--font-size-caption)]"
                aria-label={`Hide ${project.name}`}
              >
                <Icon icon={EyeOff} size="xs" />
              </Button>
            )}
            {onDispatch && (
              <Button
                variant="accent"
                size="sm"
                onClick={(e) => { e.stopPropagation(); onDispatch(project.id); }}
                className="text-[length:var(--font-size-caption)]"
                aria-label={`Dispatch agent to ${project.name}`}
              >
                <Icon icon={Send} size="xs" />
                Dispatch
              </Button>
            )}
          </div>
        )}
      </Card>
    );
  }

  // Expanded (list) mode
  return (
    <Card
      variant="nested"
      padding="none"
      interactive
      className={`group relative flex items-center gap-3 px-3 py-2.5 ${selectionClass}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onSelect?.(project.id)}
      role="article"
      aria-label={`Project: ${project.name}`}
    >
      {/* Icon */}
      <Icon icon={Folder} color="faint" className="shrink-0" />

      {/* Name */}
      <Text variant="body" className="w-32 truncate shrink-0" as="span">
        {project.name}
      </Text>
      {isCurrent && <Icon icon={CheckCircle2} size="sm" color="accent" className="shrink-0" />}

      {/* Path */}
      <Text variant="caption" mono color="muted" className="truncate flex-1 min-w-0" as="span">
        {project.path}
      </Text>

      {/* Git status badges */}
      {project.isGitRepo && project.gitStatus && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="info" size="sm" className="flex items-center gap-1">
            <Icon icon={GitBranch} size="xs" />
            {project.gitStatus.branch}
          </Badge>
          <Badge variant={gitStatusVariant(project.gitStatus.dirtyFileCount)} size="sm">
            {formatDirtyCount(project.gitStatus.dirtyFileCount)}
          </Badge>
          {aheadBehindStr && (
            <Badge variant="muted" size="sm">
              {aheadBehindStr}
            </Badge>
          )}
        </div>
      )}

      {/* Agent badges */}
      {agentCount > 0 && (
        <Text variant="caption" color="muted" as="span" className="flex items-center gap-1 shrink-0">
          <Icon icon={Users} size="xs" />
          {agentCount}
        </Text>
      )}

      {/* Team names */}
      {project.activeTeamNames.length > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          {project.activeTeamNames.slice(0, 2).map((team) => (
            <Badge key={team} variant="accent" size="sm">
              {team}
            </Badge>
          ))}
          {project.activeTeamNames.length > 2 && (
            <Text variant="caption" color="muted" as="span">+{project.activeTeamNames.length - 2}</Text>
          )}
        </div>
      )}

      {/* Claude memory indicator */}
      {project.hasClaudeMemory && (
        <Icon icon={Brain} size="sm" color="accent" className="shrink-0 opacity-60" aria-label="Has Claude memory" />
      )}

      {/* Pin star */}
      {onTogglePin && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => { e.stopPropagation(); onTogglePin(project.id); }}
          className="shrink-0 h-auto w-auto min-h-0 min-w-0 p-0"
          aria-label={project.pinned ? 'Unpin project' : 'Pin project'}
        >
          <Icon
            icon={Star}
            size="sm"
            color={project.pinned ? 'warning' : 'ghost'}
            style={project.pinned ? { fill: 'var(--color-warning)' } : undefined}
          />
        </Button>
      )}

      {hovered && (
        <div className="flex items-center gap-1 shrink-0">
          {onHide && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onHide(project.id); }}
              className="text-[length:var(--font-size-caption)]"
              aria-label={`Hide ${project.name}`}
            >
              <Icon icon={EyeOff} size="xs" />
            </Button>
          )}
          {onDispatch && (
            <Button
              variant="accent"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onDispatch(project.id); }}
              className="text-[length:var(--font-size-caption)]"
              aria-label={`Dispatch agent to ${project.name}`}
            >
              <Icon icon={Send} size="xs" />
              Dispatch
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
