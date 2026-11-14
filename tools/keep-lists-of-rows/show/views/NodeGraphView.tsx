//
// Generic visual-database adapter for the shared node graph. Record meaning,
// identity, labels, status, and relationships are projected only from the
// topology descriptor carried by the active view.

import React from 'react';
import { GitBranch } from 'lucide-react';
import { EmptyPlaceholder } from '../../../ui';
import { NodeGraph } from '../../../ui/show/node-graph/NodeGraph';
import { projectTopology, type TopologyRecord } from '../../../ui/show/node-graph/project-topology';
import type {
  VisualDatabaseRecord,
  VisualDatabaseViewDescriptor,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';

export interface NodeGraphViewProps {
  records: readonly VisualDatabaseRecord[];
  view: VisualDatabaseViewDescriptor;
  onSelectNode?: (nodeRef: string) => void;
}

function topologyRecords(records: readonly VisualDatabaseRecord[]): readonly TopologyRecord[] {
  return records
    .map((record) => record.raw)
    .filter((raw): raw is TopologyRecord => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw));
}

export function NodeGraphView({ records, view, onSelectNode }: NodeGraphViewProps): React.ReactElement {
  const topology = view.topology
    ? projectTopology(topologyRecords(records), view.topology)
    : { nodes: [], edges: [] };

  return (
    <NodeGraph
      nodes={topology.nodes}
      edges={topology.edges}
      onSelectNode={onSelectNode}
      ariaLabel={view.label}
      emptyState={(
        <EmptyPlaceholder
          icon={GitBranch}
          message="No connected records to display yet."
          data-reach-role="empty-state"
        />
      )}
    />
  );
}
