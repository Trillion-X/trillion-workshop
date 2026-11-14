import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  JsonRecord,
  SurfaceAction,
  SurfaceActionDescriptor,
} from '../read-data/account-surface-model';

export interface SurfaceActionContext {
  input?: JsonRecord;
  context?: JsonRecord;
}

export interface SurfaceTargetRequest {
  target: string;
  payload: JsonRecord;
}

export type SurfaceTargetSender = (request: SurfaceTargetRequest) => Promise<unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(value: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function resolveValue(value: unknown, context: SurfaceActionContext): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.fromInput === 'string') {
    const next = readPath(context.input ?? {}, value.fromInput);
    return next === undefined ? value.default : next;
  }
  if (typeof value.fromContext === 'string') {
    const next = readPath(context.context ?? {}, value.fromContext);
    return next === undefined ? value.default : next;
  }
  const resolved: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    resolved[key] = resolveValue(nested, context);
  }
  return resolved;
}

export function buildSurfaceActionPayload(
  action: SurfaceAction | SurfaceActionDescriptor,
  context: SurfaceActionContext = {},
): JsonRecord {
  const payload = resolveValue(action.payload ?? action.input ?? {}, context);
  return isRecord(payload) ? payload : {};
}

export function buildSurfaceActionRequest(
  action: SurfaceAction | SurfaceActionDescriptor,
  context: SurfaceActionContext = {},
): SurfaceTargetRequest {
  if ('disabled' in action && action.disabled) {
    throw new Error(action.disabledReason ?? 'This action is not available.');
  }
  const locus = action.locus ?? 'workflow';
  const target = action.target ?? (locus === 'workflow' ? 'slot::workflow' : locus);
  const input = buildSurfaceActionPayload(action, context);

  if (locus === 'workflow') {
    if (!action.definitionId) throw new Error(`Action ${action.id} has no owner definition.`);
    return {
      target,
      payload: {
        operation: action.operation ?? 'execute_definition',
        definition_id: action.definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    };
  }

  if (locus === 'process' || locus === 'process-session') {
    return {
      target,
      payload: {
        operation: action.operation ?? locus,
        action_id: action.id,
        input,
      },
    };
  }

  return { target, payload: input };
}

export async function invokeSurfaceAction(
  action: SurfaceAction | SurfaceActionDescriptor,
  context: SurfaceActionContext = {},
  sender: SurfaceTargetSender = sendRequestToBitfieldTarget as SurfaceTargetSender,
): Promise<unknown> {
  return sender(buildSurfaceActionRequest(action, context));
}
