export type PublishedRecord = {
  payload?: unknown;
};

export type TrainingBatch = {
  created_at?: string;
  creator_ref?: string;
  id: string;
  model_ref?: string;
  source_refs: string[];
  status?: string;
};

export type TrainingRecipe = {
  config?: unknown;
  id: string;
  label?: string;
};

export type TrainingBatchData = {
  batches: TrainingBatch[];
  recipes: TrainingRecipe[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function readTrainingBatches(records: readonly PublishedRecord[]): TrainingBatchData {
  const batches: TrainingBatch[] = [];
  const recipes: TrainingRecipe[] = [];

  for (const record of records) {
    if (!isRecord(record.payload)) continue;
    if (record.payload.kind === 'ai-training-batch') {
      const id = text(record.payload.id);
      if (id) batches.push({
        created_at: text(record.payload.created_at),
        creator_ref: text(record.payload.creator_ref),
        id,
        model_ref: text(record.payload.model_ref),
        source_refs: textList(record.payload.source_refs),
        status: text(record.payload.status),
      });
      continue;
    }
    if (record.payload.kind === 'training-recipe') {
      const id = text(record.payload.id);
      if (id) recipes.push({ config: record.payload.config, id, label: text(record.payload.label) });
    }
  }

  return {
    batches: batches.sort((left, right) => left.id.localeCompare(right.id)),
    recipes: recipes.sort((left, right) => String(left.label ?? left.id).localeCompare(String(right.label ?? right.id))),
  };
}
