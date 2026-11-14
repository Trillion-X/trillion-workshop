import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { JsonRecord, SurfaceReturnActionDescriptor } from '../read-data/account-surface-model';
import type { SurfaceTargetSender } from './account-surface-actions';

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonReply(payload: Uint8Array): unknown {
  const text = new TextDecoder().decode(payload);
  return text.trim() ? JSON.parse(text) : {};
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function matches(action: SurfaceReturnActionDescriptor, params: URLSearchParams) {
  return Object.entries(action.match_query ?? {}).every(
    ([name, expected]) => params.get(name) === expected,
  );
}

function payloadFromQuery(action: SurfaceReturnActionDescriptor, params: URLSearchParams) {
  const payload: JsonRecord = {};
  for (const [field, spec] of Object.entries(action.payload_fields ?? {})) {
    const value = isRecord(spec) && typeof spec.query_param === 'string'
      ? params.get(spec.query_param)
      : null;
    if (!value) return null;
    payload[field] = value;
  }
  return payload;
}

function resolveValue(
  value: unknown,
  scope: { payload: JsonRecord; context: JsonRecord; results: JsonRecord },
): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.fromPayload === 'string') return readPath(scope.payload, value.fromPayload);
  if (typeof value.fromContext === 'string') return readPath(scope.context, value.fromContext);
  if (typeof value.fromResult === 'string') return readPath(scope.results, value.fromResult);
  const resolved: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    resolved[key] = resolveValue(nested, scope);
  }
  return resolved;
}

function consumeUrl(action: SurfaceReturnActionDescriptor) {
  const url = new URL(window.location.href);
  for (const param of action.clear_query_params ?? []) {
    url.searchParams.delete(param);
  }
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
  if (action.reload_on_success) window.location.assign(nextUrl);
}

/**
 * Generic URL return-action consumer: match declared query params, run the
 * declared target steps in order (each step's payload resolved from the query
 * payload, the surface context, and prior step results), then clear the
 * consumed params. Every name here comes from descriptor DATA — this handler
 * knows no targets, params, or domain vocabulary of its own.
 *
 * Returns true when an action matched and completed (callers should expect a
 * reload when the action declares reload_on_success).
 */
export async function consumeSurfaceUrlReturnActions(
  actions: readonly SurfaceReturnActionDescriptor[] | undefined,
  context: JsonRecord,
  sender: SurfaceTargetSender = sendRequestToBitfieldTarget as SurfaceTargetSender,
): Promise<{ matched: boolean; error?: string }> {
  if (typeof window === 'undefined' || !actions?.length) return { matched: false };
  const params = new URLSearchParams(window.location.search);

  for (const action of actions) {
    if (!matches(action, params)) continue;
    const payload = payloadFromQuery(action, params);
    if (!payload) continue;

    const results: JsonRecord = {};
    try {
      for (const step of action.steps ?? []) {
        const stepPayload = resolveValue(step.payload ?? {}, { payload, context, results });
        const reply = await sender({
          target: step.target,
          payload: isRecord(stepPayload) ? stepPayload : {},
        });
        const replyPayload = isRecord(reply) ? reply.payload : undefined;
        const body = ArrayBuffer.isView(replyPayload)
          ? readJsonReply(replyPayload as Uint8Array)
          : reply;
        if (typeof step.resultKey === 'string' && step.resultKey) {
          results[step.resultKey] = body as JsonRecord[keyof JsonRecord];
        }
      }
    } catch (error) {
      // The action is consumed either way so a bad token cannot loop the
      // surface forever; the surface shows its normal signed-out state and
      // the technical detail stays in the console (L114).
      console.error('url return action failed:', error);
      consumeUrl({ ...action, reload_on_success: false });
      return { matched: true, error: 'That sign-in link could not be completed. Request a new one below.' };
    }
    consumeUrl(action);
    return { matched: true };
  }
  return { matched: false };
}
