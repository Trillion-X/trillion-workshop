export type PublishedRecord = {
  payload?: unknown;
};

export type ExecutionRun = {
  agent_ref?: string;
  ended_at?: string;
  id: string;
  // The human-meaningful "what this run did" — derived from the run's objective
  // snapshot (the actual task the agent was given), so the history reads as work
  // done ("Adversarial review of a workflow-definition change"), not an opaque
  // provider id. Absent only when the run carries no objective/label.
  objective?: string;
  started_at?: string;
  status?: string;
  total_cost?: number;
  total_units?: number;
};

export type ExecutionStep = {
  duration_ms?: number;
  id: string;
  run_ref: string;
  sort_order?: number;
  status?: string;
  tool_ref?: string;
};

export type ExecutionReviewDecision = {
  id: string;
  execution_ref: string;
  candidate_ref: string;
  decision: string;
  review_note: string;
  reviewer_ref: string;
  reviewed_at: string;
  supersedes_review_ref?: string;
  evidence_refs: string[];
};

export type ExecutionHistory = {
  runs: ExecutionRun[];
  steps: ExecutionStep[];
  reviews: ExecutionReviewDecision[];
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

// Collapse an objective/prompt into one legible line: single-spaced, cut at the
// first sentence boundary when that yields a reasonable summary, else hard-capped.
function firstMeaningfulLine(source: string, max = 140): string {
  const oneLine = source.replace(/\s+/g, ' ').trim();
  const dot = oneLine.indexOf('. ');
  // A clean first-sentence cut is a natural end — no ellipsis.
  if (dot >= 24 && dot <= max) return oneLine.slice(0, dot + 1).trim();
  if (oneLine.length <= max) return oneLine;
  // Hard cap mid-text — mark it truncated.
  return `${oneLine.slice(0, max).trim()}…`;
}

// Derive the human-meaningful objective of a run. Prefer the objective snapshot
// (the actual task text); fall back to the label's objective clause (the part
// after "<agent_ref> — "). Returns undefined when neither is present.
function readObjective(payload: Record<string, unknown>): string | undefined {
  const objective = payload.objective;
  const snapshot = isRecord(objective) ? text(objective.snapshot_text) : undefined;
  if (snapshot) return firstMeaningfulLine(snapshot);
  const label = text(payload.label);
  if (label) {
    const dash = label.indexOf(' — ');
    return firstMeaningfulLine(dash >= 0 ? label.slice(dash + 3) : label);
  }
  return undefined;
}

export function readExecutionHistory(records: readonly PublishedRecord[]): ExecutionHistory {
  const runs: ExecutionRun[] = [];
  const steps: ExecutionStep[] = [];
  const reviews: ExecutionReviewDecision[] = [];

  for (const record of records) {
    if (!isRecord(record.payload)) continue;
    if (record.payload.kind === 'ai-execution-run') {
      const id = text(record.payload.id);
      const agentRef = text(record.payload.agent_ref);
      const endedAt = text(record.payload.ended_at);
      const startedAt = text(record.payload.started_at);
      const status = text(record.payload.status);
      const objective = readObjective(record.payload);
      const totalCost = numberValue(record.payload.total_cost);
      const totalUnits = numberValue(record.payload.total_units);
      if (id) runs.push({
        ...(agentRef ? { agent_ref: agentRef } : {}),
        ...(endedAt ? { ended_at: endedAt } : {}),
        id,
        ...(objective ? { objective } : {}),
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(status ? { status } : {}),
        ...(totalCost == null ? {} : { total_cost: totalCost }),
        ...(totalUnits == null ? {} : { total_units: totalUnits }),
      });
      continue;
    }
    if (record.payload.kind === 'ai-execution-step') {
      const id = text(record.payload.id);
      const run_ref = text(record.payload.run_ref);
      const durationMs = numberValue(record.payload.duration_ms);
      const sortOrder = numberValue(record.payload.sort_order);
      const status = text(record.payload.status);
      const toolRef = text(record.payload.tool_ref);
      if (id && run_ref) steps.push({
        ...(durationMs == null ? {} : { duration_ms: durationMs }),
        id,
        run_ref,
        ...(sortOrder == null ? {} : { sort_order: sortOrder }),
        ...(status ? { status } : {}),
        ...(toolRef ? { tool_ref: toolRef } : {}),
      });
      continue;
    }
    if (record.payload.kind === 'ai-execution-review-decision') {
      const id = text(record.payload.id);
      const executionRef = text(record.payload.execution_ref);
      const candidateRef = text(record.payload.candidate_ref);
      const decision = text(record.payload.decision);
      const reviewNote = text(record.payload.review_note);
      const reviewerRef = text(record.payload.reviewer_ref);
      const reviewedAt = text(record.payload.reviewed_at);
      const supersedesReviewRef = text(record.payload.supersedes_review_ref);
      const evidenceRefs = Array.isArray(record.payload.evidence_refs)
        ? record.payload.evidence_refs.map(text).filter((value): value is string => !!value)
        : [];
      if (id && executionRef && candidateRef && decision && reviewNote && reviewerRef && reviewedAt) reviews.push({
        id,
        execution_ref: executionRef,
        candidate_ref: candidateRef,
        decision,
        review_note: reviewNote,
        reviewer_ref: reviewerRef,
        reviewed_at: reviewedAt,
        ...(supersedesReviewRef ? { supersedes_review_ref: supersedesReviewRef } : {}),
        evidence_refs: evidenceRefs,
      });
    }
  }

  return {
    // Most recent run first — a history surface leads with the latest activity.
    // Fall back to id ordering when a run carries no start timestamp.
    runs: runs.sort((left, right) => {
      const l = left.started_at ?? '';
      const r = right.started_at ?? '';
      if (l && r && l !== r) return r.localeCompare(l);
      if (l && !r) return -1;
      if (!l && r) return 1;
      return right.id.localeCompare(left.id);
    }),
    steps: steps.sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.id.localeCompare(right.id)),
    reviews: reviews.sort((left, right) => right.reviewed_at.localeCompare(left.reviewed_at) || right.id.localeCompare(left.id)),
  };
}
