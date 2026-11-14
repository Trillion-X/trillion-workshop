// packages/tasks/show/TasksPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Unified task panel with internal view type tabs: List, Kanban, DAG.
// Replaces the separate DAG, Kanban, and System sidebar tabs with a single
// composable view. All task data flows through this component to the active
// sub-view. Each sub-view shows dependency info (blocks/blockedBy).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. View type state is local (not persisted)
// 2. All sub-views receive identical task data
// 3. Dependency info visible in every view type
// 4. Zero data fetching — pure presentation from props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useMemo } from 'react';
import { TaskList } from '@/packages/tasks/show/TaskList';
import { KanbanBoard } from '@/packages/tasks/show/KanbanBoard';
import { TaskDAG } from '@/packages/tasks/show/TaskDAG';
import { Tabs, TabsList, TabsTrigger, TabsContent, Text } from '@/packages/ui';
import type { DAGNode, DAGEdge, TaskEntry } from '@/packages/tasks/read-data/task-graph-types';

interface TasksPanelProps {
  tasks: (TaskEntry & { projectId?: string; projectName?: string })[];
  dagNodes: DAGNode[];
  dagEdges: DAGEdge[];
  onNodeClick: (nodeId: string) => void;
  filterBar?: React.ReactNode;
}

export function TasksPanel({ tasks, dagNodes, dagEdges, onNodeClick, filterBar }: TasksPanelProps) {
  const [viewType, setViewType] = useState('list');

  // Derive KanbanCardData from tasks (moved from App.tsx)
  const kanbanCards = useMemo(() => tasks.map((t) => ({
    id: t.id,
      projectId: t.projectId,
    title: t.title,
    status: t.status === 'in_progress' ? 'in_progress' as const : t.status as 'pending' | 'completed' | 'failed' | 'blocked',
    agentCount: t.agentCount,
    completedAt: t.completedAt,
    isSystemTask: false,
    description: t.description,
  })), [tasks]);

  return (
    <div>
      {filterBar && <div className="mb-3">{filterBar}</div>}

      {/* View type tabs + content */}
      <Tabs value={viewType} onValueChange={setViewType}>
        <div className="flex items-center gap-1 mb-4">
          <Text variant="heading-lg" className="mr-4" as="h2">Tasks</Text>
          <TabsList>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="kanban">Kanban</TabsTrigger>
            <TabsTrigger value="dag">DAG</TabsTrigger>
          </TabsList>
          <Text variant="label" color="muted" className="ml-auto" as="span">{tasks.length} tasks</Text>
        </div>

        <TabsContent value="list">
          <TaskList tasks={tasks} onTaskClick={onNodeClick} />
        </TabsContent>
        <TabsContent value="kanban">
          <KanbanBoard tasks={kanbanCards} />
        </TabsContent>
        <TabsContent value="dag">
          <TaskDAG nodes={dagNodes} edges={dagEdges} direction="LR" onNodeClick={onNodeClick} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
