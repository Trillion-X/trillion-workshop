export type AnyRecord = Record<string, unknown>;

export interface BindingDescriptor {
  key: string;
  source?: string;
  path?: string[];
  value?: unknown;
}

export interface DescribedRecordActionDescriptor {
  id: string;
  target: string;
  method: string;
  input?: AnyRecord;
  bindings?: BindingDescriptor[];
  resultSelector?: AnyRecord;
}

export interface DescribedRecordActionContext {
  actionId: string;
  operationId: string;
  sources?: Record<string, unknown>;
  values?: AnyRecord;
  descriptors: DescribedRecordActionDescriptor[];
}

export interface DescribedRecordOwnerActionRequest {
  target: string;
  payload: {
    method: string;
    action_id: string;
    operation_id: string;
    input: AnyRecord;
    result_selector?: AnyRecord;
  };
  trace: {
    actionId: string;
    operationId: string;
    bindingKeys: string[];
  };
}

export interface DescribedRecordActionBuildResult {
  requests: DescribedRecordOwnerActionRequest[];
  errors: Array<{ code: string; detail: string }>;
}

function isObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(source: unknown, path: string[] = []): unknown {
  return path.reduce((current, segment) => (isObject(current) ? current[segment] : undefined), source);
}

function bindingValue(binding: BindingDescriptor, context: DescribedRecordActionContext): unknown {
  if (binding.value !== undefined) return binding.value;
  const source = binding.source ? context.sources?.[binding.source] : context.values;
  return readPath(source, binding.path);
}

function buildInput(
  descriptor: DescribedRecordActionDescriptor,
  context: DescribedRecordActionContext,
): { input: AnyRecord; bindingKeys: string[] } {
  const input: AnyRecord = { ...(descriptor.input ?? {}), ...(context.values ?? {}) };
  const bindingKeys: string[] = [];
  for (const binding of descriptor.bindings ?? []) {
    const value = bindingValue(binding, context);
    if (value !== undefined) {
      input[binding.key] = value;
      bindingKeys.push(binding.key);
    }
  }
  return { input, bindingKeys };
}

export function buildDescribedRecordActionRequest(
  context: DescribedRecordActionContext,
): DescribedRecordActionBuildResult {
  const errors: DescribedRecordActionBuildResult['errors'] = [];
  if (!context.actionId) errors.push({ code: 'missing-action-id', detail: 'actionId is required' });
  if (!context.operationId) errors.push({ code: 'missing-operation-id', detail: 'operationId is required' });

  const descriptor = context.descriptors.find((entry) => entry.id === context.actionId);
  if (!descriptor) errors.push({ code: 'missing-descriptor', detail: context.actionId });
  if (descriptor && !descriptor.target) errors.push({ code: 'missing-target', detail: descriptor.id });
  if (descriptor && !descriptor.method) errors.push({ code: 'missing-method', detail: descriptor.id });
  if (errors.length > 0 || !descriptor) return { requests: [], errors };

  const { input, bindingKeys } = buildInput(descriptor, context);
  return {
    requests: [{
      target: descriptor.target,
      payload: {
        method: descriptor.method,
        action_id: descriptor.id,
        operation_id: context.operationId,
        input,
        result_selector: descriptor.resultSelector,
      },
      trace: {
        actionId: descriptor.id,
        operationId: context.operationId,
        bindingKeys,
      },
    }],
    errors: [],
  };
}
