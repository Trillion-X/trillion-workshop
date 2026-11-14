// bitfield/packages/tasks/index.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Composition Engine entry point for the Tasks component.
// Wraps UnifiedTaskPanel with package descriptor task data.
// Registered as `component:tasks` in the compute.process compilation pipeline.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Default export is a CE-compatible function component
// 2. Pulls task rows from descriptor-bound task data only
// 3. Derives presentation DAG data from task owner facts
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useMemo } from 'react'
import { useBitfieldData } from '@bitfield/runtime-kit/react'
import {
  decodeTasksFeed,
} from '@/packages/tasks/read-data/read-tasks'
import { TasksPanel } from '@/packages/tasks/show/TasksPanel'
import { SelectablePillBar } from '@/packages/ui/show/selectable-pill-bar'
import type { TaskEntry } from '@/packages/tasks/read-data/task-graph-types'

function toSharedTask(task: ReturnType<typeof decodeTasksFeed>[number]): TaskEntry & { projectId?: string; projectName?: string } {
  return {
    id: task.id,
    projectId: task.projectId || undefined,
    projectName: task.projectId || undefined,
    title: task.title,
    status: task.status,
    agentCount: 0,
    description: task.objective,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    attachments: task.attachments,
    completedAt: task.status === 'completed' ? task.updatedDate || null : null,
  };
}

export default function Tasks() {
  const tasksEntry = useBitfieldData()
  const [selectedProjectIds, setSelectedProjectIds] = React.useState<string[]>([])
  const taskRecords = useMemo(
    () => decodeTasksFeed(tasksEntry),
    [tasksEntry],
  )
  const tasks = useMemo(() => {
    const allTasks = taskRecords.map(toSharedTask)
    const availableProjectIds = new Set(allTasks.map((task) => task.projectId).filter((id): id is string => !!id))
    const activeProjectIds = selectedProjectIds.filter((id) => availableProjectIds.has(id))
    if (activeProjectIds.length === 0) return allTasks
    const selected = new Set(activeProjectIds)
    return allTasks.filter((task) => !task.projectId || selected.has(task.projectId))
  }, [selectedProjectIds, taskRecords])
  const projectItems = useMemo(() => {
    const ids = new Set<string>()
    for (const task of taskRecords) {
      if (task.projectId) ids.add(task.projectId)
    }
    return Array.from(ids)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, label: id }))
  }, [taskRecords])
  const activeProjectIds = useMemo(
    () => selectedProjectIds.filter((id) => projectItems.some((item) => item.id === id)),
    [projectItems, selectedProjectIds],
  )
  const visibleProjectIds = activeProjectIds.length > 0
    ? activeProjectIds
    : projectItems.map((item) => item.id)
  const toggleProject = React.useCallback((projectId: string) => {
    setSelectedProjectIds((current) => {
      const validIds = new Set(projectItems.map((item) => item.id))
      const selected = activeProjectIds.length > 0
        ? new Set(current.filter((id) => validIds.has(id)))
        : new Set(validIds)
      if (selected.has(projectId)) selected.delete(projectId)
      else selected.add(projectId)
      return Array.from(selected)
    })
  }, [activeProjectIds, projectItems])
  const dagNodes = useMemo(
    () => tasks.map(t => ({
      id: t.id,
      label: t.title,
      status: t.status === 'failed' ? 'blocked' as const : t.status,
      agentCount: t.agentCount,
    })),
    [tasks],
  )
  const dagEdges = useMemo(
    () => tasks.flatMap(task => task.blockedBy.map(blockerId => ({ source: blockerId, target: task.id }))),
    [tasks],
  )

  return (
    <TasksPanel
      tasks={tasks}
      dagNodes={dagNodes}
      dagEdges={dagEdges}
      filterBar={(
        <SelectablePillBar
          items={projectItems}
          selectedIds={visibleProjectIds}
          allLabel="All Projects"
          ariaLabel="Filter tasks by project"
          onSelectAll={() => setSelectedProjectIds(projectItems.map((item) => item.id))}
          onToggle={toggleProject}
        />
      )}
      onNodeClick={() => {}}
    />
  )
}
