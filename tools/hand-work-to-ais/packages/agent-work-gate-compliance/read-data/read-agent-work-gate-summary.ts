// packages/agent-work-gate-compliance/read-data/read-agent-work-gate-summary.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure descriptor-projected row decoding for the agent work gate summary feed.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Readers consume descriptor-projected `gate-analytics` rows
// 2. Canonical ownership remains on `prop:gate_analytics:*`
// 3. Feed decoding stays pure and maps directly into the UI analytics shape
//
// =============================================================================

export interface GateAnalytics {
  totalTasks: number;
  totalGates: number;
  completedGates: number;
  deferredGates: number;
  notNeededGates: number;
  pendingGates: number;
  complianceRate: number;
  gateCategoryBreakdown: Record<
    string,
    {
      total: number;
      completed: number;
      deferred: number;
    }
  >;
  agentReliability: Array<{
    agentId: string;
    completionRate: number;
    deferralRate: number;
  }>;
  trends: Array<{
    date: string;
    complianceRate: number;
    taskCount: number;
  }>;
}

interface GateAnalyticsRow {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
}

function propertyKey(propertyId: string): string {
  const index = propertyId.lastIndexOf(':');
  return index >= 0 ? propertyId.slice(index + 1) : propertyId;
}

export function decodeGateAnalyticsFeed(raw: unknown): GateAnalytics[] {
  if (!Array.isArray(raw)) return [];

  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as GateAnalyticsRow;
    if (typeof entry.property_id !== 'string') continue;

    const subjectId = typeof entry.subject_id === 'string' ? entry.subject_id : '';
    const record = grouped.get(subjectId) ?? {};
    record[propertyKey(entry.property_id)] = entry.value;
    grouped.set(subjectId, record);
  }

  return [...grouped.values()]
    .map((row) => ({
      totalTasks: Number(row.total_tasks ?? 0),
      totalGates: Number(row.total_gates ?? 0),
      completedGates: Number(row.completed_gates ?? 0),
      deferredGates: Number(row.deferred_gates ?? 0),
      notNeededGates: Number(row.not_needed_gates ?? 0),
      pendingGates: Number(row.pending_gates ?? 0),
      complianceRate: Number(row.compliance_rate ?? 0),
      gateCategoryBreakdown:
        row.gate_category_breakdown && typeof row.gate_category_breakdown === 'object'
          ? (row.gate_category_breakdown as GateAnalytics['gateCategoryBreakdown'])
          : {},
      agentReliability: Array.isArray(row.agent_reliability)
        ? (row.agent_reliability as GateAnalytics['agentReliability'])
        : [],
      trends: Array.isArray(row.trends) ? (row.trends as GateAnalytics['trends']) : [],
    }));
}
