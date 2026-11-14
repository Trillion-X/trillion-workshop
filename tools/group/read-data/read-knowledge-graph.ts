// Thin caller of the maintained public record-graph owner. No descriptor engine
// or record topology is owned by the Apps surface.
import { projectGraphRecords } from 'trillion-workshop/tools/record-graph/read-data/graph-walk.mjs';

export type KnowledgeGraphProjection = ReturnType<typeof projectGraphRecords>;

export function projectKnowledgeGraph(records: unknown): KnowledgeGraphProjection {
  return projectGraphRecords(records);
}
