export type JsonRecord = Record<string, unknown>;

export interface ActionInputCopy {
  key: string;
  from?: readonly string[];
  value?: unknown;
}

export interface ConfiguredWorkspaceActionDescriptor {
  id: string;
  label?: string;
  operation?: string;
  target?: string;
  definition_id?: string;
  input?: JsonRecord;
  copy?: readonly ActionInputCopy[];
}

// The caller-assembled LOOKUP bag that copy rules and the operation row read from. It is not
// the Runtime Kit context object and it must never sit at argument two: the target admission
// guard reserves that position for the runtime's injected context, which carries exactly two
// fields (`runtime.partition_label` and `packageData`). A homonym named `context` there passes the guard by name
// and then throws `operation_id is required` on the first live dispatch, because the runtime
// never sends any of these fields. Found 2026-09-05 as the second instance of this shape.
export interface ConfiguredWorkspaceActionLookup {
  operation_id: string;
  record_ref?: string;
  field_values?: JsonRecord;
  relationships?: readonly JsonRecord[];
  source_refs?: readonly string[];
  selected?: JsonRecord | null;
  answers?: JsonRecord;
  descriptors?: readonly ConfiguredWorkspaceActionDescriptor[];
}

// One request object: the action descriptor with its lookup bag under `lookup`.
export type ConfiguredWorkspaceActionRequest = ConfiguredWorkspaceActionDescriptor & {
  lookup: ConfiguredWorkspaceActionLookup;
};

export interface TargetRequest {
  target: string;
  payload: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(value: unknown, path: readonly string[] = []): unknown {
  return path.reduce((current, segment) => (isRecord(current) ? current[segment] : undefined), value);
}

function copiedInput(action: ConfiguredWorkspaceActionDescriptor, lookup: ConfiguredWorkspaceActionLookup): JsonRecord {
  const input: JsonRecord = { ...(action.input ?? {}), ...(lookup.answers ?? {}) };
  for (const rule of action.copy ?? []) {
    const value = rule.value !== undefined ? rule.value : readPath(lookup, rule.from);
    if (value !== undefined) input[rule.key] = value;
  }
  return input;
}

function recordOperation(action: ConfiguredWorkspaceActionDescriptor, lookup: ConfiguredWorkspaceActionLookup, input: JsonRecord): JsonRecord {
  return {
    kind: 'configured-record-workspace.operation',
    operation_id: lookup.operation_id,
    action_id: action.id,
    operation: action.operation ?? 'record.write-batch',
    record_ref: lookup.record_ref ?? null,
    field_values: lookup.field_values ?? {},
    relationships: lookup.relationships ?? [],
    source_refs: lookup.source_refs ?? [],
    input,
  };
}

function splitActionRequest(actionRequest: ConfiguredWorkspaceActionRequest): {
  action: ConfiguredWorkspaceActionDescriptor;
  lookup: ConfiguredWorkspaceActionLookup;
} {
  const { lookup, ...action } = actionRequest;
  if (!isRecord(lookup)) throw new Error('lookup is required');
  return { action, lookup };
}

// Argument two is left to the Runtime Kit calling convention (the injected runtime context),
// which this builder never reads.
export function buildConfiguredRecordWorkspaceActionRequest(
  actionRequest: ConfiguredWorkspaceActionRequest,
): TargetRequest {
  const { action, lookup } = splitActionRequest(actionRequest);
  if (!lookup.operation_id) throw new Error('operation_id is required');
  const input = copiedInput(action, lookup);
  if (action.definition_id) {
    return {
      target: action.target ?? 'slot::workflow',
      payload: {
        operation: action.operation ?? 'execute_definition',
        definition_id: action.definition_id,
        include_steps: false,
        include_output: false,
        input: {
          ...input,
          operation_id: lookup.operation_id,
          record_ref: lookup.record_ref ?? null,
        },
      },
    };
  }
  return {
    target: action.target ?? 'engine.operation.write-batch',
    payload: {
      operation: action.operation ?? 'record.write-batch',
      operations: [recordOperation(action, lookup, input)],
    },
  };
}

export function buildConfiguredRecordWorkspaceRequestByDescriptorId(
  descriptor_id: string,
  lookup: ConfiguredWorkspaceActionLookup,
): TargetRequest {
  const action = lookup.descriptors?.find((entry) => entry.id === descriptor_id);
  if (!action) throw new Error(`Missing action descriptor: ${descriptor_id}`);
  return buildConfiguredRecordWorkspaceActionRequest({ ...action, lookup });
}
