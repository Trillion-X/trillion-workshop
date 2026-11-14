import React from 'react';
import type { TrainingBatchData } from '../read-data/read-ai-training-batches';

export type TrainingBatchPanelProps = {
  data: TrainingBatchData;
  title?: string;
};

export function TrainingBatchPanel({ data, title = 'Training batches' }: TrainingBatchPanelProps) {
  return (
    <section data-package="ai-training-batch" data-surface="ai-training-batch-panel">
      <header>
        <h2>{title}</h2>
      </header>
      <h3>Recipes</h3>
      <ul>
        {data.recipes.map((recipe) => (
          <li key={recipe.id}>{recipe.label ?? recipe.id}</li>
        ))}
      </ul>
      <h3>Batches</h3>
      <ul>
        {data.batches.map((batch) => (
          <li key={batch.id}>{batch.id}: {batch.status ?? 'unknown'}</li>
        ))}
      </ul>
    </section>
  );
}
