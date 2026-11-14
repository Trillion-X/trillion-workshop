// packages/project-gate-compliance/show/ProjectGateCompliancePanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical project gate compliance view. Reads owner-fed aggregate compliance,
// completion-gate rows, and explorer task->project mappings to show which
// selected projects need attention.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads only package descriptor-bound owner feeds
// 2. No store selectors, merged-project helper, or fake audit/issues family
// 3. Project filtering is local view state over records this package already reads
//
// =============================================================================

import * as React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { SelectablePillBar } from '@/packages/ui/show/selectable-pill-bar';
import { Badge, Card, Text, Icon } from '@/packages/ui';
import {
  decodeProjectComplianceFeed,
} from '@/packages/project-gate-compliance/read-data/read-project-compliance';
import {
  decodeCompletionGatesFeed,
} from '@/packages/project-gate-compliance/read-data/read-completion-gates';
import {
  buildAttentionProjects,
  buildComplianceSummary,
  decodeProjectGateTasksFeed,
  decodeProjectNamesFeed,
  pickLatestCompliance,
  summarizeGatesByProject,
} from '@/packages/project-gate-compliance/read-data/read-project-gate-attention';

function severityVariant(severity: string): 'error' | 'warning' | 'info' {
  if (severity === 'error') return 'error';
  if (severity === 'warning') return 'warning';
  return 'info';
}

function percent(passed: number, failed: number): number {
  const total = passed + failed;
  return total > 0 ? Math.round((passed / total) * 100) : 0;
}

export function ProjectGateCompliancePanel() {
  const projectsEntry = useBitfieldData('project-registry');
  const tasksEntry = useBitfieldData('project-tasks');
  const gatesEntry = useBitfieldData('completion-gates');
  const complianceEntry = useBitfieldData('project-compliance');
  const [selectedProjectIds, setSelectedProjectIds] = React.useState<string[]>([]);

  const complianceRecords = React.useMemo(
    () => decodeProjectComplianceFeed(complianceEntry),
    [complianceEntry],
  );
  const tasks = React.useMemo(
    () => decodeProjectGateTasksFeed(tasksEntry),
    [tasksEntry],
  );
  const gates = React.useMemo(
    () => decodeCompletionGatesFeed(gatesEntry),
    [gatesEntry],
  );
  const latestCompliance = React.useMemo(
    () => pickLatestCompliance(complianceRecords),
    [complianceRecords],
  );
  const projectNames = React.useMemo(
    () => decodeProjectNamesFeed(projectsEntry),
    [projectsEntry],
  );
  const projectItems = React.useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) ids.add(task.projectId);
    for (const projectId of latestCompliance.keys()) ids.add(projectId);
    for (const projectId of projectNames.keys()) ids.add(projectId);

    return Array.from(ids)
      .sort((left, right) => (projectNames.get(left) ?? left).localeCompare(projectNames.get(right) ?? right))
      .map((id) => ({ id, label: projectNames.get(id) ?? id }));
  }, [latestCompliance, projectNames, tasks]);
  const activeProjectIds = React.useMemo(
    () => selectedProjectIds.filter((id) => projectItems.some((item) => item.id === id)),
    [projectItems, selectedProjectIds],
  );
  const visibleProjectIds = activeProjectIds.length > 0
    ? activeProjectIds
    : projectItems.map((item) => item.id);
  const gateSummary = React.useMemo(
    () => summarizeGatesByProject(gates, tasks, visibleProjectIds),
    [gates, tasks, visibleProjectIds],
  );
  const summary = React.useMemo(
    () => buildComplianceSummary(visibleProjectIds, latestCompliance, gateSummary),
    [visibleProjectIds, latestCompliance, gateSummary],
  );
  const attentionProjects = React.useMemo(
    () => buildAttentionProjects(visibleProjectIds, projectNames, latestCompliance, gateSummary),
    [visibleProjectIds, projectNames, latestCompliance, gateSummary],
  );
  const toggleProject = React.useCallback((projectId: string) => {
    setSelectedProjectIds((current) => {
      const selected = activeProjectIds.length > 0
        ? new Set(activeProjectIds)
        : new Set(projectItems.map((item) => item.id));
      if (selected.has(projectId)) selected.delete(projectId);
      else selected.add(projectId);
      return Array.from(selected);
    });
  }, [activeProjectIds, projectItems]);

  if (
    projectsEntry === null &&
    tasksEntry === null &&
    gatesEntry === null &&
    complianceEntry === null &&
    projectItems.length === 0
  ) {
    return (
      <Card variant="surface" padding="lg">
        <Text variant="body-xs" color="muted">
          Loading compliance...
        </Text>
      </Card>
    );
  }

  if (false || false || false || false) {
    return (
      <Card variant="surface" padding="lg">
        <Text variant="body-xs" color="error">
          Failed to load canonical compliance feeds
        </Text>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SelectablePillBar
        items={projectItems}
        selectedIds={visibleProjectIds}
        allLabel="All Projects"
        ariaLabel="Filter compliance by project"
        onSelectAll={() => setSelectedProjectIds(projectItems.map((item) => item.id))}
        onToggle={toggleProject}
      />

      <Card variant="nested" padding="md" className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Icon icon={ShieldAlert} size="sm" color="faint" />
          <Text variant="label" color="muted">Selected</Text>
          <Text variant="label" weight="semibold">{summary.selectedProjects}</Text>
        </div>
        <div className="w-px h-4 bg-[var(--glass-bg-hover)]" />
        <div className="flex items-center gap-2">
          <Text variant="label" color="muted">Audited</Text>
          <Text variant="label" weight="semibold">{summary.auditedProjects}</Text>
        </div>
        <div className="w-px h-4 bg-[var(--glass-bg-hover)]" />
        <div className="flex items-center gap-2">
          <Text variant="label" color="muted">Pass Rate</Text>
          <Text variant="label" color={summary.failedChecks > 0 ? 'warning' : 'success'} weight="semibold">
            {percent(summary.passedChecks, summary.failedChecks)}%
          </Text>
        </div>
        <div className="w-px h-4 bg-[var(--glass-bg-hover)]" />
        <div className="flex items-center gap-2">
          <Text variant="label" color="muted">Pending Gates</Text>
          <Text variant="label" color={summary.pendingGates > 0 ? 'warning' : 'success'} weight="semibold">
            {summary.pendingGates}
          </Text>
        </div>
      </Card>

      <Card variant="nested" padding="md" className="flex flex-wrap items-center gap-4">
        <Badge variant="success">Completed {summary.completedGates}</Badge>
        <Badge variant="warning">Deferred {summary.deferredGates}</Badge>
        <Badge variant="neutral">Not Needed {summary.notNeededGates}</Badge>
        <Badge variant={summary.pendingGates > 0 ? 'warning' : 'success'}>Pending {summary.pendingGates}</Badge>
        <Badge variant={summary.failedChecks > 0 ? 'error' : 'success'}>
          Failed Checks {summary.failedChecks}
        </Badge>
      </Card>

      {attentionProjects.length === 0 ? (
        <Card variant="surface" padding="lg">
          <Text variant="label">No selected projects currently need compliance attention.</Text>
        </Card>
      ) : (
        <Card variant="surface" padding="md">
          <Text variant="overline" color="muted" className="mb-3">
            Projects Requiring Attention
          </Text>
          <div className="space-y-2">
            {attentionProjects.map((project) => (
              <Card key={project.projectId} variant="nested" padding="sm" className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <Text variant="label">{project.projectName}</Text>
                  <Text variant="caption" color="muted">
                    {project.failedChecks} failed checks • {project.pendingGates} pending gates • {project.completedGates} completed gates
                  </Text>
                </div>
                <Badge variant={severityVariant(project.severity)}>
                  {project.severity}
                </Badge>
                <Badge variant={project.pendingGates > 0 ? 'warning' : 'success'}>
                  {project.totalChecks > 0 ? `${percent(project.totalChecks - project.failedChecks, project.failedChecks)}%` : 'no audit'}
                </Badge>
              </Card>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
