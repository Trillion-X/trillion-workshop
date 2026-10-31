import { readTaskString } from './read-task-json.ts';

export interface TaskEntry {
  id: string;
  taskNumber: string;
  title: string;
  projectId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  objective: string;
  acceptanceCriteria: string;
  blockedBy: string[];
  blocks: string[];
  // Opaque reference strings (an address or a file path). The decoder never
  // interprets them — consumers show or follow them as-is.
  attachments: string[];
  createdDate: string;
  updatedDate: string;
}

interface FactRow {
  subject_id?: string;
  property_id?: string;
  value?: unknown;
}

function valueToString(value: unknown): string {
  return readTaskString(value);
}

function valueToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(valueToString);
  return [];
}

function readRecordArray(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function rowsBySubject(raw: unknown): Map<string, Record<string, unknown>> {
  const grouped = new Map<string, Record<string, unknown>>();

  for (const row of readRecordArray(raw) as FactRow[]) {
    const subjectId = typeof row.subject_id === 'string' ? row.subject_id : '';
    const propertyId = typeof row.property_id === 'string' ? row.property_id : '';
    if (!subjectId || !propertyId) continue;

    const current = grouped.get(subjectId) ?? { id: subjectId };
    current[propertyId.split(':').pop() ?? propertyId] = row.value;
    grouped.set(subjectId, current);
  }

  return grouped;
}

export function decodeTasksFeed(raw: unknown): TaskEntry[] {
  const tasks = Array.from(rowsBySubject(raw).values()).map((row) => ({
    id: valueToString(row.id),
    taskNumber: valueToString(row.task_number),
    title: valueToString(row.title),
    projectId: valueToString(row.project_id),
    status: (valueToString(row.status) || 'pending') as TaskEntry['status'],
    priority: (valueToString(row.priority) || 'MEDIUM') as TaskEntry['priority'],
    objective: valueToString(row.objective),
    acceptanceCriteria: valueToString(row.acceptance_criteria),
    blockedBy: valueToStringArray(row.blocked_by),
    blocks: [] as string[],
    attachments: valueToStringArray(row.attachments),
    createdDate: valueToString(row.created_date),
    updatedDate: valueToString(row.updated_date),
  }));

  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker && !blocker.blocks.includes(task.id)) {
        blocker.blocks.push(task.id);
      }
    }
  }

  return tasks;
}
