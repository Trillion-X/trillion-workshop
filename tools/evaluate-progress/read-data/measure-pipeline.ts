// tools/evaluate-progress/read-data/measure-pipeline.ts
// Measures run as stages. A stage reads the raw facts ("$facts") or the rows an earlier stage emitted (a stage whose value is a list of objects), so one measure can rank, filter or pack what another derived.


import {
  deriveMeasure,
  type FactRecord,
  type MeasureDefinition,
  type MeasureFact,
  type OpMap,
} from './derive-measure.ts';

export const RAW_FACTS = "$facts";

export type PipelineStage = {
  id: string;
  def: MeasureDefinition;
  from?: string[];
};

export type MeasurePipeline = {
  stages: PipelineStage[];
  result?: string;
};

export type MeasurePipelineResult = {
  stages: Record<string, MeasureFact>;
  order: string[];
  result: MeasureFact | null;
};

function rowsFrom(fact: MeasureFact | undefined, emit: string | null | undefined): FactRecord[] {
  if (!fact || !Array.isArray(fact.value)) return [];
  return (fact.value as unknown[]).flatMap((row) => {
    if (row == null || typeof row !== "object" || Array.isArray(row)) return [];
    const r = row as Record<string, unknown>;
    if (emit && r.kind === undefined) return [{ ...r, kind: emit }];
    return [r as FactRecord];
  });
}

export function runMeasurePipeline(
  facts: FactRecord[],
  pipeline: MeasurePipeline,
  opMap: OpMap,
): MeasurePipelineResult {
  const stages: Record<string, MeasureFact> = {};
  const emitById: Record<string, string | null | undefined> = {};
  const order: string[] = [];

  for (const stage of pipeline.stages ?? []) {
    const sources = stage.from && stage.from.length > 0 ? stage.from : [RAW_FACTS];
    const pool: FactRecord[] = [];
    for (const src of sources) {
      if (src === RAW_FACTS) pool.push(...facts);
      else pool.push(...rowsFrom(stages[src], emitById[src]));
    }
    stages[stage.id] = deriveMeasure(pool, stage.def, opMap);
    emitById[stage.id] = stage.def.emit;
    order.push(stage.id);
  }

  const resultId = pipeline.result ?? order[order.length - 1];
  const result = resultId != null ? stages[resultId] ?? null : null;
  return { stages, order, result };
}
