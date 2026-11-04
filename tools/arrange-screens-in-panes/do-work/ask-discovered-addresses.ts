// packages/screen-arrangement/do-work/ask-discovered-addresses.ts
//
// Invokes screen-surface targets with screen-owned request bytes. The target
// owns the reply bytes or error; screen-arrangement only decides whether it can
// mount the reply.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { DiscoveredAddress } from '../read-data/read-published-records';

export interface DiscoveredAddressReply {
  target: string;
  recordId: string;
  sourcePath: string;
  durationMs: number;
  reply: unknown;
  error: string | null;
}

export interface DiscoveredAddressRequest {
  published_record: unknown;
  caller_request: unknown;
}

export function makeDiscoveredAddressRequest(
  address: DiscoveredAddress,
  callerRequest: unknown,
): DiscoveredAddressRequest {
  return {
    published_record: address.payload,
    caller_request: callerRequest,
  };
}

export async function askDiscoveredAddress(
  address: DiscoveredAddress,
  callerRequest: unknown,
  signal?: AbortSignal,
): Promise<DiscoveredAddressReply> {
  const startedAt = performance.now();

  try {
    const payload = makeDiscoveredAddressRequest(address, callerRequest);
    const reply = await sendRequestToBitfieldTarget({ target: address.target, payload }, signal);
    return {
      target: address.target,
      recordId: address.recordId,
      sourcePath: address.sourcePath,
      durationMs: performance.now() - startedAt,
      reply,
      error: null,
    };
  } catch (rawError: unknown) {
    const error = rawError instanceof Error ? rawError.message : String(rawError);
    return {
      target: address.target,
      recordId: address.recordId,
      sourcePath: address.sourcePath,
      durationMs: performance.now() - startedAt,
      reply: null,
      error,
    };
  }
}
