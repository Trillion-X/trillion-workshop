// packages/sidebar/do-work/ask-discovered-addresses.ts
//
// Invokes routable targets with caller-owned bytes. The targets own their reply
// bytes or errors; this layer does not define what any reply means.

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
  provider_record: unknown;
  caller_request: unknown;
}

export function makeDiscoveredAddressRequest(
  address: DiscoveredAddress,
  callerRequest: unknown,
): DiscoveredAddressRequest {
  return {
    provider_record: address.payload,
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

export async function askDiscoveredAddresses(
  addresses: readonly DiscoveredAddress[],
  payload: unknown,
  signal?: AbortSignal,
): Promise<DiscoveredAddressReply[]> {
  return Promise.all(addresses.map((address) => askDiscoveredAddress(address, payload, signal)));
}
