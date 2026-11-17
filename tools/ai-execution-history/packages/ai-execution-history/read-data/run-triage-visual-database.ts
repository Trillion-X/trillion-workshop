import type { DeriveDispatch } from '../../../../keep-lists-of-rows/do-work/resolve-derived-fields';
import {
  buildExecutionHistoryVisualDatabaseProjection,
  type ExecutionHistoryVisualDatabaseProjection,
} from './execution-history-visual-database';

export type RunTriageVisualDatabaseProjection = ExecutionHistoryVisualDatabaseProjection;

export async function buildRunTriageVisualDatabaseProjection(
  surfaceInput: unknown,
  feed: unknown,
  dispatch: DeriveDispatch,
): Promise<RunTriageVisualDatabaseProjection | null> {
  return buildExecutionHistoryVisualDatabaseProjection(surfaceInput, feed, dispatch);
}
