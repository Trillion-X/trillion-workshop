export type PublishedRecord = {
  payload?: unknown;
};

export type MemoryContextItem = {
  access_count?: number;
  agent_ref?: string;
  body: string;
  embedding_ref?: string;
  expires_at?: string;
  id: string;
  importance_score?: number;
  label?: string;
  memory_type?: string;
  subject_ref?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readMemoryContext(records: readonly PublishedRecord[], subjectRef?: string): MemoryContextItem[] {
  return records
    .map((record) => record.payload)
    .filter(isRecord)
    .filter((record) => record.kind === 'memory-context-item' || record.kind === 'ai-memory-record')
    .flatMap((record) => {
      const body = text(record.body) ?? (isRecord(record.content) ? JSON.stringify(record.content) : text(record.content));
      const id = text(record.id);
      if (!body || !id) return [];
      const accessCount = numberValue(record.access_count);
      const agentRef = text(record.agent_ref);
      const embeddingRef = text(record.embedding_ref);
      const expiresAt = text(record.expires_at);
      const importanceScore = numberValue(record.importance_score) ?? numberValue(record.relevance_score);
      const label = text(record.label);
      const memoryType = text(record.memory_type);
      const subject = text(record.subject_ref);
      return [{
        ...(accessCount == null ? {} : { access_count: accessCount }),
        ...(agentRef ? { agent_ref: agentRef } : {}),
        body,
        ...(embeddingRef ? { embedding_ref: embeddingRef } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        id,
        ...(importanceScore == null ? {} : { importance_score: importanceScore }),
        ...(label ? { label } : {}),
        ...(memoryType ? { memory_type: memoryType } : {}),
        ...(subject ? { subject_ref: subject } : {}),
      }];
    })
    .filter((item) => !subjectRef || item.subject_ref === subjectRef)
    .sort((left, right) => String(left.label ?? left.id).localeCompare(String(right.label ?? right.id)));
}
