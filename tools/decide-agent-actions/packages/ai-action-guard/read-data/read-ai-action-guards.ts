export type PublishedRecord = {
  payload?: unknown;
};

export type GuardLimit = {
  action_ref?: string;
  exhausted?: boolean;
  id: string;
  limit?: number;
  period_ref?: string;
  remaining?: number;
  subject_ref?: string;
  used?: number;
};

export type GuardState = {
  allowed?: boolean;
  action_ref?: string;
  decision_count?: number;
  exhausted?: boolean;
  failure_count?: number;
  id: string;
  last_failure_at?: string;
  last_success_at?: string;
  limit_ref?: string;
  state?: string;
  subject_ref?: string;
};

export type GuardDecision = {
  action_ref?: string;
  authority_ref?: string;
  decided_at?: string;
  decision?: string;
  error?: string;
  id: string;
  output_is_authority?: boolean;
  owner_action_ref?: string;
  reason?: string;
  requested_at?: string;
  subject_ref?: string;
  target?: string;
};

export type ActionGuardData = {
  decisions: GuardDecision[];
  exhausted: Array<GuardLimit | GuardState>;
  limits: GuardLimit[];
  states: GuardState[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readActionGuards(records: readonly PublishedRecord[]): ActionGuardData {
  const decisions: GuardDecision[] = [];
  const limits: GuardLimit[] = [];
  const states: GuardState[] = [];

  for (const record of records) {
    if (!isRecord(record.payload)) continue;
    if (record.payload.kind === 'ai-guard-limit') {
      const id = text(record.payload.id);
      const actionRef = text(record.payload.action_ref);
      const limit = numberValue(record.payload.limit);
      const periodRef = text(record.payload.period_ref);
      const subject = text(record.payload.subject_ref);
      const used = numberValue(record.payload.used) ?? numberValue(record.payload.used_count) ?? numberValue(record.payload.decision_count);
      const exhausted = boolValue(record.payload.exhausted) ?? (limit != null && used != null ? used >= limit : undefined);
      const remaining = limit != null && used != null ? Math.max(limit - used, 0) : undefined;
      if (id) limits.push({
        ...(actionRef ? { action_ref: actionRef } : {}),
        ...(exhausted == null ? {} : { exhausted }),
        id,
        ...(limit == null ? {} : { limit }),
        ...(periodRef ? { period_ref: periodRef } : {}),
        ...(remaining == null ? {} : { remaining }),
        ...(subject ? { subject_ref: subject } : {}),
        ...(used == null ? {} : { used }),
      });
      continue;
    }
    if (record.payload.kind === 'ai-guard-state') {
      const allowed = boolValue(record.payload.allowed);
      const id = text(record.payload.id);
      const actionRef = text(record.payload.action_ref);
      const decisionCount = numberValue(record.payload.decision_count) ?? numberValue(record.payload.used_count);
      const exhausted = boolValue(record.payload.exhausted);
      const failureCount = numberValue(record.payload.failure_count);
      const lastFailureAt = text(record.payload.last_failure_at);
      const lastSuccessAt = text(record.payload.last_success_at);
      const limitRef = text(record.payload.limit_ref);
      const state = text(record.payload.state);
      const subject = text(record.payload.subject_ref);
      if (id) states.push({
        ...(allowed == null ? {} : { allowed }),
        ...(actionRef ? { action_ref: actionRef } : {}),
        ...(decisionCount == null ? {} : { decision_count: decisionCount }),
        ...(exhausted == null ? {} : { exhausted }),
        ...(failureCount == null ? {} : { failure_count: failureCount }),
        id,
        ...(lastFailureAt ? { last_failure_at: lastFailureAt } : {}),
        ...(lastSuccessAt ? { last_success_at: lastSuccessAt } : {}),
        ...(limitRef ? { limit_ref: limitRef } : {}),
        ...(state ? { state } : {}),
        ...(subject ? { subject_ref: subject } : {}),
      });
      continue;
    }
    if (record.payload.kind === 'ai-guard-decision') {
      const id = text(record.payload.id);
      const actionRef = text(record.payload.action_ref);
      const authorityRef = text(record.payload.authority_ref);
      const decidedAt = text(record.payload.decided_at);
      const decision = text(record.payload.decision);
      const error = text(record.payload.error);
      const outputIsAuthority = boolValue(record.payload.output_is_authority);
      const ownerActionRef = text(record.payload.owner_action_ref);
      const reason = text(record.payload.reason);
      const requestedAt = text(record.payload.requested_at);
      const subject = text(record.payload.subject_ref);
      const target = text(record.payload.target);
      if (id) decisions.push({
        ...(actionRef ? { action_ref: actionRef } : {}),
        ...(authorityRef ? { authority_ref: authorityRef } : {}),
        ...(decidedAt ? { decided_at: decidedAt } : {}),
        ...(decision ? { decision } : {}),
        ...(error ? { error } : {}),
        id,
        ...(outputIsAuthority == null ? {} : { output_is_authority: outputIsAuthority }),
        ...(ownerActionRef ? { owner_action_ref: ownerActionRef } : {}),
        ...(reason ? { reason } : {}),
        ...(requestedAt ? { requested_at: requestedAt } : {}),
        ...(subject ? { subject_ref: subject } : {}),
        ...(target ? { target } : {}),
      });
    }
  }

  const sortedDecisions = decisions.sort((left, right) => {
    const leftTime = left.decided_at ?? left.requested_at ?? '';
    const rightTime = right.decided_at ?? right.requested_at ?? '';
    return rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id);
  });
  const sortedLimits = limits.sort((left, right) => left.id.localeCompare(right.id));
  const sortedStates = states.sort((left, right) => left.id.localeCompare(right.id));

  return {
    decisions: sortedDecisions,
    exhausted: [
      ...sortedLimits.filter((limit) => limit.exhausted),
      ...sortedStates.filter((state) => state.exhausted),
    ],
    limits: sortedLimits,
    states: sortedStates,
  };
}
