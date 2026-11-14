import type { DeriveDispatch } from '@/packages/visual-database/do-work/resolve-derived-fields';
import {
  buildExecutionHistoryVisualDatabaseProjection,
  type ExecutionHistoryVisualDatabaseProjection,
} from '@/packages/ai-execution-history/read-data/execution-history-visual-database';

export type RunTriageVisualDatabaseProjection = ExecutionHistoryVisualDatabaseProjection;

export async function buildRunTriageVisualDatabaseProjection(
  surfaceInput: unknown,
  feed: unknown,
  dispatch: DeriveDispatch,
): Promise<RunTriageVisualDatabaseProjection | null> {
  return buildExecutionHistoryVisualDatabaseProjection(surfaceInput, feed, dispatch);
}
