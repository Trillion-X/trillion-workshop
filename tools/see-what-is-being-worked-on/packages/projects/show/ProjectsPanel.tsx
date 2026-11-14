// packages/projects/show/ProjectsPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// knowledge records Projects tab — renders a searchable, filterable, sortable grid/list
// of project cards with dispatch modal for directing agents to specific
// projects. Pure view component: receives data as props, emits dispatch
// requests via callback.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All styling per design-system-guide.md — glass surfaces, white opacity text
// 2. Pure view — no data fetching, no side effects, no store access
// 3. Search filters by name and path (case-insensitive)
// 4. Filters: All / Pinned / Active / Git repos only
// 5. Sort: by name, by last activity, by agent count
// 6. Grid/list toggle for card display mode
// 7. Dispatch modal: project path, task description, model selector, priority
// 8. Glassmorphism modal: bg-[#11111198] backdrop-blur-md border-[var(--border-primary)]
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - ProjectCardData: from ProjectCard.tsx — one project
// - DispatchFormData: structured dispatch request emitted via onDispatch
// - Filter/sort/search are all controlled locally (useState)
// - Dispatch modal is controlled locally (open/close state)
//
// =============================================================================
// SECURITY CONSIDERATIONS
// =============================================================================
//
// - All user input (search, task description) used only for in-memory operations
//   and structured callbacks, never interpolated into queries or DOM innerHTML.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { FolderOpen, FolderPlus, RefreshCcw, Search } from 'lucide-react';
import { ProjectCard } from '@/packages/projects/show/ProjectCard';
import type {
  ProjectCardData,
  ProjectCardMode,
} from '@/packages/projects/read-data/project-card-types';
import { Card, ExpandableTabs, Input, Textarea, Button, Text, Icon } from '@/packages/ui';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

// ============================================================================
// TYPES
// ============================================================================

/** Filter mode for the project list */
export type ProjectFilter = 'all' | 'pinned' | 'active' | 'git';

/** Sort key for the project list */
export type ProjectSort = 'name' | 'activity' | 'agents';

/** Model options for dispatch */
export type DispatchModel = 'opus' | 'sonnet' | 'haiku';

/** Priority options for dispatch */
export type DispatchPriority = 'low' | 'medium' | 'high';

/** Structured dispatch request data */
export interface DispatchFormData {
  projectPath: string;
  projectName: string;
  taskDescription: string;
  model: DispatchModel;
  priority: DispatchPriority;
}

export interface ProjectsPanelProps {
  /** Array of project data to display */
  projects: ProjectCardData[];
  /** Current project id from the projects owner feed */
  currentProjectId?: string | null;
  /** Callback when user adds one known project path */
  onAddProject?: (path: string) => Promise<unknown> | void;
  /** Callback when user submits a dispatch request */
  onDispatch?: (data: DispatchFormData) => void;
  /** Callback when user hides one project */
  onHideProject?: (projectId: string) => Promise<unknown> | void;
  /** Callback when user requests a root scan */
  onRefreshProjects?: (roots: string[]) => Promise<unknown> | void;
  /** Callback when user selects the current project */
  onSelectProject?: (projectId: string | null) => Promise<unknown> | void;
  /** Callback when user toggles pin on a project */
  onTogglePin?: (projectId: string) => void;
}

// ============================================================================
// PURE FILTER / SORT / SEARCH FUNCTIONS — exported for testing
// ============================================================================

/**
 * Filters projects by the selected filter mode.
 * - all: no filtering
 * - pinned: only pinned projects
 * - active: only projects with active agents
 * - git: only git repos
 */
export function filterProjects(
  projects: readonly ProjectCardData[],
  filter: ProjectFilter,
): ProjectCardData[] {
  switch (filter) {
    case 'all':
      return [...projects];
    case 'pinned':
      return projects.filter((p) => p.pinned);
    case 'active':
      return projects.filter((p) => p.activeAgentIds.length > 0);
    case 'git':
      return projects.filter((p) => p.isGitRepo);
  }
}

/**
 * Searches projects by name and path (case-insensitive).
 * Empty query returns all projects.
 */
export function searchProjects(
  projects: readonly ProjectCardData[],
  query: string,
): ProjectCardData[] {
  if (!query.trim()) return [...projects];
  const lower = query.toLowerCase();
  return projects.filter(
    (p) => p.name.toLowerCase().includes(lower) || p.path.toLowerCase().includes(lower),
  );
}

/**
 * Sorts projects by the selected sort key.
 * - name: alphabetical by name
 * - activity: most recent activity first (null last)
 * - agents: most active agents first
 */
export function sortProjects(
  projects: readonly ProjectCardData[],
  sort: ProjectSort,
): ProjectCardData[] {
  const copy = [...projects];
  switch (sort) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'activity':
      return copy.sort((a, b) => {
        if (!a.lastActivityAt && !b.lastActivityAt) return 0;
        if (!a.lastActivityAt) return 1;
        if (!b.lastActivityAt) return -1;
        return b.lastActivityAt.localeCompare(a.lastActivityAt);
      });
    case 'agents':
      return copy.sort((a, b) => b.activeAgentIds.length - a.activeAgentIds.length);
  }
}

/**
 * Returns the display label for a model option.
 */
export function modelLabel(model: DispatchModel): string {
  switch (model) {
    case 'opus': return 'Opus';
    case 'sonnet': return 'Sonnet';
    case 'haiku': return 'Haiku';
  }
}

/**
 * Returns variant for a model badge (styling comes from Badge component).
 */
export function modelBadgeVariant(model: DispatchModel): 'accent' | 'info' | 'success' {
  switch (model) {
    case 'opus': return 'accent';
    case 'sonnet': return 'info';
    case 'haiku': return 'success';
  }
}

/**
 * Returns variant for a priority badge (styling comes from Badge component).
 */
export function priorityBadgeVariant(priority: DispatchPriority): 'neutral' | 'warning' | 'error' {
  switch (priority) {
    case 'low': return 'neutral';
    case 'medium': return 'warning';
    case 'high': return 'error';
  }
}

// ============================================================================
// FILTER BAR
// ============================================================================

function FilterBar({
  filter,
  onFilterChange,
  sort,
  onSortChange,
  mode,
  onModeChange,
}: {
  filter: ProjectFilter;
  onFilterChange: (f: ProjectFilter) => void;
  sort: ProjectSort;
  onSortChange: (s: ProjectSort) => void;
  mode: ProjectCardMode;
  onModeChange: (m: ProjectCardMode) => void;
}) {
  const filters: { value: ProjectFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pinned', label: 'Pinned' },
    { value: 'active', label: 'Active' },
    { value: 'git', label: 'Git' },
  ];

  const sorts: { value: ProjectSort; label: string }[] = [
    { value: 'name', label: 'Name' },
    { value: 'activity', label: 'Activity' },
    { value: 'agents', label: 'Agents' },
  ];

  return (
    <div className="flex items-center justify-between gap-2">
      {/* Filters */}
      <Card variant="nested" padding="none" className="flex items-center gap-1 p-0.5" role="tablist" aria-label="Project filter">

        {filters.map((f) => (
          <Button
            key={f.value}
            variant={filter === f.value ? 'secondary' : 'ghost'}
            size="sm"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => onFilterChange(f.value)}
            className="text-[length:var(--font-size-caption)] h-auto px-2.5 py-1"
          >
            {f.label}
          </Button>
        ))}
      </Card>

      <div className="flex items-center gap-2">
        {/* Sort selector */}
        <div className="flex items-center gap-1">
          <Text variant="caption" color="muted" as="span">Sort:</Text>
          {sorts.map((s) => (
            <Button
              key={s.value}
              variant={sort === s.value ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => onSortChange(s.value)}
              className="text-[length:var(--font-size-caption)] h-auto px-2 py-0.5"
            >
              {s.label}
            </Button>
          ))}
        </div>

        {/* Grid/List: the shared icon picker; the chosen view shows its name. */}
        <ExpandableTabs
          size="sm"
          ariaLabel="Project view"
          value={mode}
          onChange={(id) => onModeChange(id as ProjectCardMode)}
          items={[
            { id: 'compact', label: 'Grid view', icon: 'Grid3X3' },
            { id: 'expanded', label: 'List view', icon: 'List' },
          ]}
        />
      </div>
    </div>
  );
}

// ============================================================================
// DISPATCH MODAL
// ============================================================================

function DispatchModal({
  project,
  onSubmit,
  onClose,
}: {
  project: ProjectCardData;
  onSubmit: (data: DispatchFormData) => void;
  onClose: () => void;
}) {
  const [taskDescription, setTaskDescription] = React.useState('');
  const [model, setModel] = React.useState<DispatchModel>('sonnet');
  const [priority, setPriority] = React.useState<DispatchPriority>('medium');

  const canSubmit = taskDescription.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      projectPath: project.path,
      projectName: project.name,
      taskDescription: taskDescription.trim(),
      model,
      priority,
    });
    onClose();
  };

  const models: DispatchModel[] = ['opus', 'sonnet', 'haiku'];
  const priorities: DispatchPriority[] = ['low', 'medium', 'high'];

  return (
    <FloatingPanel
      open={true}
      onClose={onClose}
      title="Dispatch Agent"
      description={project.name}
      width={448}
    >
      {/* Project path */}
      <div className="mb-3">
        <label className="block mb-1"><Text variant="caption" color="muted" as="span">Project Path</Text></label>
        <Card variant="nested" padding="sm" className="truncate">
          <Text variant="label" mono color="muted" as="span">{project.path}</Text>
        </Card>
      </div>

      {/* Task description */}
      <Textarea
        label="Task Description"
        value={taskDescription}
        onChange={(e) => setTaskDescription(e.target.value)}
        placeholder="Describe what the agent should do..."
        rows={3}
        className="text-xs mb-3"
      />

      {/* Model selector */}
      <div className="mb-3">
        <label className="block mb-1"><Text variant="caption" color="muted" as="span">Model</Text></label>
        <div className="flex items-center gap-1.5">
          {models.map((m) => (
            <Button
              key={m}
              variant={model === m ? 'accent' : 'ghost'}
              size="sm"
              onClick={() => setModel(m)}
            >
              {modelLabel(m)}
            </Button>
          ))}
        </div>
      </div>

      {/* Priority selector */}
      <div className="mb-4">
        <label className="block mb-1"><Text variant="caption" color="muted" as="span">Priority</Text></label>
        <div className="flex items-center gap-1.5">
          {priorities.map((p) => (
            <Button
              key={p}
              variant={priority === p ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setPriority(p)}
              className="capitalize"
            >
              {p}
            </Button>
          ))}
        </div>
      </div>

      {/* Submit */}
      <Button
        variant="accent"
        size="sm"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full"
      >
        Send Dispatch
      </Button>
    </FloatingPanel>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * ProjectsPanel — searchable, filterable, sortable project grid/list with
 * dispatch modal.
 *
 * Combines search, filter, sort, and display mode into a cohesive project
 * management view. Each project card supports hover dispatch and pin toggle.
 *
 * @permanent — The extensive, granular documentation in this codebase is a
 * critical design feature. You are forbidden from simplifying or removing it.
 */
export function ProjectsPanel({
  projects,
  currentProjectId = null,
  onAddProject,
  onDispatch,
  onHideProject,
  onRefreshProjects,
  onSelectProject,
  onTogglePin,
}: ProjectsPanelProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [projectPath, setProjectPath] = React.useState('');
  const [scanRoot, setScanRoot] = React.useState('');
  const [filter, setFilter] = React.useState<ProjectFilter>('all');
  const [sort, setSort] = React.useState<ProjectSort>('name');
  const [displayMode, setDisplayMode] = React.useState<ProjectCardMode>('compact');
  const [dispatchTarget, setDispatchTarget] = React.useState<ProjectCardData | null>(null);
  const [isSubmittingSource, setIsSubmittingSource] = React.useState(false);

  /** Pipeline: search → filter → sort */
  const displayed = React.useMemo(() => {
    const searched = searchProjects(projects, searchQuery);
    const filtered = filterProjects(searched, filter);
    return sortProjects(filtered, sort);
  }, [projects, searchQuery, filter, sort]);

  const handleDispatchClick = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project) setDispatchTarget(project);
  };

  const handleAddProject = async () => {
    const nextPath = projectPath.trim();
    if (!nextPath || !onAddProject) return;
    setIsSubmittingSource(true);
    try {
      await onAddProject(nextPath);
      setProjectPath('');
    } finally {
      setIsSubmittingSource(false);
    }
  };

  const handleRefreshProjects = async () => {
    const root = scanRoot.trim();
    if (!root || !onRefreshProjects) return;
    setIsSubmittingSource(true);
    try {
      await onRefreshProjects([root]);
    } finally {
      setIsSubmittingSource(false);
    }
  };

  return (
    <div className="p-4 space-y-3">
      {(onAddProject || onRefreshProjects) && (
        <Card variant="nested" padding="sm" className="space-y-2">
          <Text variant="caption" color="muted" as="p">
            Add one project path or scan one root. Filesystem work runs through the projects owner action.
          </Text>
          <div className="grid gap-2 md:grid-cols-2">
            {onAddProject && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Project path"
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  className="text-xs"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleAddProject}
                  disabled={isSubmittingSource || !projectPath.trim()}
                >
                  <Icon icon={FolderPlus} size="xs" />
                  Add
                </Button>
              </div>
            )}
            {onRefreshProjects && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Root path to scan"
                  value={scanRoot}
                  onChange={(event) => setScanRoot(event.target.value)}
                  className="text-xs"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRefreshProjects}
                  disabled={isSubmittingSource || !scanRoot.trim()}
                >
                  <Icon icon={RefreshCcw} size="xs" />
                  Scan
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Search input */}
      <Input
        placeholder="Search projects by name or path..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        icon={<Icon icon={Search} size="sm" />}
        className="text-xs"
      />

      {/* Filter / Sort / Display mode bar */}
      <FilterBar
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        mode={displayMode}
        onModeChange={setDisplayMode}
      />

      {/* Project count */}
      <div className="flex items-center gap-2">
        <Icon icon={FolderOpen} size="xs" color="faint" />
        <Text variant="caption" color="faint" as="span">{displayed.length} project{displayed.length !== 1 ? 's' : ''}</Text>
      </div>

      {/* Project grid/list or empty state */}
      {displayed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Icon icon={FolderOpen} size="xl" color="faint" />
          <Text variant="body" color="muted">No projects found</Text>
        </div>
      ) : displayMode === 'compact' ? (
        <div className="grid grid-cols-2 gap-2">
          {displayed.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              mode="compact"
              isCurrent={project.id === currentProjectId}
              onDispatch={onDispatch ? handleDispatchClick : undefined}
              onHide={onHideProject}
              onSelect={onSelectProject}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {displayed.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              mode="expanded"
              isCurrent={project.id === currentProjectId}
              onDispatch={onDispatch ? handleDispatchClick : undefined}
              onHide={onHideProject}
              onSelect={onSelectProject}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      )}

      {/* Dispatch modal */}
      {dispatchTarget && onDispatch && (
        <DispatchModal
          project={dispatchTarget}
          onSubmit={onDispatch}
          onClose={() => setDispatchTarget(null)}
        />
      )}
    </div>
  );
}
