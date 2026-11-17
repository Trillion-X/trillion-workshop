// packages/tasks/show/TaskList.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Table/list view of tasks showing status, agent count, and dependency info.
// Supports search filtering and status filtering.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Search filters by task ID and title
// 2. Status filter pills toggle individual status filters
// 3. Dependency info (blocks/blockedBy) shown per task row
// 4. Zero data fetching — pure presentation from props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useMemo } from 'react';
import type { TaskEntry } from '@/packages/tasks/read-data/task-graph-types';
import { Badge, Button, Container, Input, Text, VirtualList } from '../../../../ui';

type TaskRow = TaskEntry;

interface TaskListProps {
  tasks: TaskRow[];
  onTaskClick: (taskId: string) => void;
}

/** Above this many rows the list windows its DOM through the shared
 *  VirtualList so render cost is O(visible), never O(total) — thousands of
 *  tasks must scroll, not freeze. Below it, plain rendering: identical
 *  markup, zero windowing machinery. */
const TASK_LIST_VIRTUALIZATION_THRESHOLD = 150;

/** Estimated row height (min-h-[44px] rows + list gap). Rows are uniform, so
 *  windowing off this estimate stays visually exact. */
const TASK_ROW_ESTIMATED_HEIGHT = 48;

/** Windowed-list viewport height: the list owns its own scroll element
 *  instead of growing the page by thousands of rows. */
const TASK_LIST_VIEWPORT_HEIGHT = 640;

/** Maps task status string to Badge variant */
function statusToBadgeVariant(status: string): 'warning' | 'info' | 'success' | 'error' {
  switch (status) {
    case 'in_progress': return 'info';
    case 'completed': return 'success';
    case 'failed': return 'error';
    default: return 'warning';
  }
}

export function TaskList({ tasks, onTaskClick }: TaskListProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = tasks;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t => t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q));
    }
    if (statusFilter) {
      result = result.filter(t => t.status === statusFilter);
    }
    return result;
  }, [tasks, search, statusFilter]);

  const statuses = ['pending', 'in_progress', 'completed', 'blocked', 'failed'];

  return (
    <div>
      {/* Search + filter bar */}
      <div className="flex items-center gap-2 mb-3">
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks..."
          className="flex-1 py-1.5"
        />
        <div className="flex gap-1">
          {statuses.map(s => (
            <Button
              key={s}
              variant={statusFilter === s ? 'accent' : 'ghost'}
              size="sm"
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s.replace('_', ' ')}
            </Button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="space-y-1">
        {filtered.length === 0 && (
          <Text variant="body" color="muted" className="py-4 text-center">No tasks match filter</Text>
        )}
        <VirtualList
          items={filtered}
          itemKey={(task) => task.id}
          estimateSize={() => TASK_ROW_ESTIMATED_HEIGHT}
          threshold={TASK_LIST_VIRTUALIZATION_THRESHOLD}
          scrollParent="self"
          maxHeight={TASK_LIST_VIEWPORT_HEIGHT}
          rowGap={4}
          renderItem={(task) => (
          <Container layout="vertical" gap="none">
          <Button
            variant="ghost"
            onClick={() => onTaskClick(task.id)}
            className="w-full flex items-center gap-3 px-3 py-2 text-left min-h-[44px] justify-start"
          >
            <Text variant="label" mono color="muted" className="w-12 shrink-0" as="span">#{task.id}</Text>
            <Badge variant={statusToBadgeVariant(task.status)} size="md">
              {task.status.replace('_', ' ')}
            </Badge>
            {task.approach && (
              <Badge variant="neutral" size="md">
                {task.approach}
              </Badge>
            )}
            <Text variant="body" className="truncate flex-1" as="span">{task.title}</Text>
            {(task.attachments ?? []).map((attachment: string) => (
              <Badge key={attachment} variant="neutral" size="md" title={attachment}>
                {attachment.split(/[/:]/).filter(Boolean).pop()}
              </Badge>
            ))}
            {task.agentCount > 0 && (
              <Text variant="label" color="muted" as="span">{task.agentCount} agents</Text>
            )}
            {(task.blocks.length > 0 || task.blockedBy.length > 0) && (
              <Text variant="label" color="muted" as="span" title={`Blocks: ${task.blocks.join(', ')} | Blocked by: ${task.blockedBy.join(', ')}`}>
                {task.blockedBy.length > 0 && `\u25B9${task.blockedBy.length}`}
                {task.blocks.length > 0 && ` \u25C3${task.blocks.length}`}
              </Text>
            )}
          </Button>
          </Container>
          )}
        />
      </div>
    </div>
  );
}
