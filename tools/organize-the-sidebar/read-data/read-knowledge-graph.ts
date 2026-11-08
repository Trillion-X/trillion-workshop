// The surface composes the maintained record graph; record truth and topology
// live in record-graph. The caller supplies records, never projection descriptors.
import { projectGraphRecords } from '../../record-graph/read-data/graph-walk.mjs';

export type KnowledgeGraphProjection = ReturnType<typeof projectGraphRecords>;

export function projectKnowledgeGraph(records: unknown): KnowledgeGraphProjection {
  return projectGraphRecords(records);
}
