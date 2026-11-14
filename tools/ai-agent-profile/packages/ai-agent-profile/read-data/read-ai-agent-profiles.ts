export type PublishedRecord = {
  payload?: unknown;
};

export type AgentProfile = {
  description?: string;
  guard_ref?: string;
  id: string;
  instruction_refs: string[];
  instruction_selection?: Record<string, unknown>;
  label?: string;
  model_refs: string[];
  tool_refs: string[];
  // Live-loop fields (fail-open, all optional). An autonomous loop stamps these
  // onto the profile record as it spawns/adapts/retires agents (readbacks
  // cont.42/46). They are the SSOT translation of the raw record — a consumer
  // reads THESE, never the raw record shape (L098). `status` is a RAW string,
  // never an enum: a consumer maps it to a display tone via an injected DATA map
  // (L090). `department`/`role` drive board clustering; `updated_at_ms` drives a
  // "last active" readout. `role` mirrors `department` when only one is present.
  status?: string;
  department?: string;
  role?: string;
  updated_at_ms?: number;
  runtime_adapter_ref?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readAgentProfiles(records: readonly PublishedRecord[]): AgentProfile[] {
  return records
    .map((record) => record.payload)
    .filter(isRecord)
    .filter((record) => record.kind === 'ai-agent-profile')
    .flatMap((record) => {
      const id = text(record.id);
      if (!id) return [];
      const description = text(record.description);
      const guardRef = text(record.guard_ref);
      const label = text(record.label);
      const status = text(record.status);
      const department = text(record.department) ?? text(record.role);
      const role = text(record.role) ?? text(record.department);
      const updatedAtMs = finiteNumber(record.updated_at_ms) ?? finiteNumber(record.updatedAtMs);
      const runtimeAdapterRef = text(record.runtime_adapter_ref);
      const instructionSelection = object(record.instruction_selection);
      return [{
        ...(description ? { description } : {}),
        ...(guardRef ? { guard_ref: guardRef } : {}),
        id,
        instruction_refs: textList(record.instruction_refs),
        ...(instructionSelection ? { instruction_selection: instructionSelection } : {}),
        ...(label ? { label } : {}),
        model_refs: textList(record.model_refs),
        tool_refs: textList(record.tool_refs),
        ...(status ? { status } : {}),
        ...(department ? { department } : {}),
        ...(role ? { role } : {}),
        ...(updatedAtMs !== undefined ? { updated_at_ms: updatedAtMs } : {}),
        ...(runtimeAdapterRef ? { runtime_adapter_ref: runtimeAdapterRef } : {}),
      }];
    })
    .sort((left, right) => String(left.label ?? left.id).localeCompare(String(right.label ?? right.id)));
}
