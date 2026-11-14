import { sendRequestToBitfieldTarget } from '#workspace-records';

type JsonRecord = Record<string, unknown>;

export interface PlaceableSurfaceCompletionTarget {
  readonly target: string;
  readonly correlation: Readonly<JsonRecord>;
}

type Dispatch = (request: {
  target: string;
  payload: JsonRecord;
}) => Promise<unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as JsonRecord
    : null;
}

function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => jsonSafe(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value as JsonRecord).every((entry) => jsonSafe(entry, seen));
  seen.delete(value);
  return valid;
}

export function readPlaceableSurfaceCompletionTarget(
  value: unknown,
): PlaceableSurfaceCompletionTarget {
  const descriptor = record(value);
  const target = typeof descriptor?.target === 'string' ? descriptor.target.trim() : '';
  const correlation = record(descriptor?.correlation);
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(target)) {
    throw new Error('Surface completion target is missing or invalid.');
  }
  if (!correlation || Object.keys(correlation).length === 0 || !jsonSafe(correlation)) {
    throw new Error('Surface completion correlation is missing or invalid.');
  }
  return { target, correlation };
}

function decodeReply(value: unknown): unknown {
  const wrapper = record(value);
  const payload = wrapper?.payload;
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  }
  if (payload instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payload)));
  }
  if (ArrayBuffer.isView(payload)) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    ));
  }
  return wrapper?.payload ?? value;
}

/**
 * Complete one owner-declared placeable-surface interaction through its DATA
 * target. The source owns `result`; this seam only carries the opaque JSON-safe
 * value together with the caller's correlation. The receiving owner validates
 * the request; a correlation value is not proof of permission.
 */
export async function dispatchPlaceableSurfaceCompletion(
  completionTarget: unknown,
  result: unknown,
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<unknown> {
  const descriptor = readPlaceableSurfaceCompletionTarget(completionTarget);
  if (!record(result) || !jsonSafe(result)) {
    throw new Error('Surface completion result is missing or invalid.');
  }
  return decodeReply(await dispatch({
    target: descriptor.target,
    payload: {
      correlation: descriptor.correlation,
      result,
    },
  }));
}
