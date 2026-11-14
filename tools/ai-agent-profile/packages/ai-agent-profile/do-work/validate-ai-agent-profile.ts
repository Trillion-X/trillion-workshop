/*
 * Record-contract validator for the ai-agent-profile published-record. A brought
 * agent (built with ANY framework: LangGraph, Mastra, CrewAI, by hand) arrives as
 * ONE ai-agent-profile record; the framework/protocol it speaks is the one
 * self-describing DATA field `runtime_adapter_ref`, resolved by
 * ai-cli-launch-adapters. This validator enforces the package-record-contract
 * (the only required field is `id`) and, when present, the shape of
 * `runtime_adapter_ref`. The field is purely additive and optional: a record
 * that omits runtime_adapter_ref is valid, and two records that differ ONLY in
 * that field validate identically.
 *
 * Pure: no engine, no store, no Envelope, mirroring read-ai-agent-profiles.ts so
 * it unit-tests with no runtime. The required-field set is DATA (the contract),
 * so this code never hardcodes an enum of fields, and it is OPEN-world: extra
 * self-describing fields (label/description/status/model_refs/instruction_refs/
 * tool_refs/memory_refs and anything a future owner stamps on) are carried
 * through untouched. The profile record is the SSOT; the validator never rewrites
 * it.
 */

export type AgentProfileRecordContract = {
  record_kind: string;
  required_fields: string[];
  optional_fields?: string[];
};

/** The package's own contract (mirrors the package-record-contract DATA row). */
export const AGENT_PROFILE_RECORD_CONTRACT: AgentProfileRecordContract = {
  record_kind: 'ai-agent-profile',
  required_fields: ['id'],
  optional_fields: ['runtime_adapter_ref'],
};

export type ValidatedAgentProfile = Record<string, unknown> & {
  kind: 'ai-agent-profile';
  id: string;
  runtime_adapter_ref?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A required field is satisfied when present and, if a string, non-empty. */
function requiredFieldPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * Validate one ai-agent-profile record against its contract. Throws a TypeError
 * on any violation; returns the record unchanged on success. `contract` is DATA
 * (defaults to the package's own contract) so the required-field set is never a
 * hardcoded enum here.
 */
export function validateAgentProfileRecord(
  record: unknown,
  contract: AgentProfileRecordContract = AGENT_PROFILE_RECORD_CONTRACT,
): ValidatedAgentProfile {
  if (!isRecord(record)) throw new TypeError('ai-agent-profile record must be an object');
  if (record.kind !== contract.record_kind) {
    throw new TypeError(`ai-agent-profile record kind must equal ${contract.record_kind}`);
  }
  for (const field of contract.required_fields) {
    if (!requiredFieldPresent(record[field])) {
      throw new TypeError(`ai-agent-profile record requires a non-empty ${field}`);
    }
  }
  // The one self-describing optional field a brought agent needs. Present OR
  // absent are BOTH valid; present-but-malformed fails closed.
  if (record.runtime_adapter_ref !== undefined && !isNonEmptyString(record.runtime_adapter_ref)) {
    throw new TypeError('runtime_adapter_ref, when present, must be a non-empty string');
  }
  return record as ValidatedAgentProfile;
}

/** Never throws. True when the record satisfies its contract. */
export function isValidAgentProfileRecord(
  record: unknown,
  contract: AgentProfileRecordContract = AGENT_PROFILE_RECORD_CONTRACT,
): boolean {
  try {
    validateAgentProfileRecord(record, contract);
    return true;
  } catch {
    return false;
  }
}
