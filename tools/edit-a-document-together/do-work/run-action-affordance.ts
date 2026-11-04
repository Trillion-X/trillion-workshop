// packages/documents/do-work/run-action-affordance.ts
//
// Fire an action-affordance run and await its completion for the doc surface.
// Dispatch is the resolved envelope from the shared affordance leaf; completion
// is observed at the DATA status addresses the record carries (the same
// result/error polling contract producers already write). This package never
// names a producer or another feature package — addresses arrive as DATA.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';
import type { ResolvedStatusAddresses } from '../../ui/show/action-affordance';

const textDecoder = new TextDecoder();

export type AffordanceRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

export type AffordanceRunOutcome =
  | { readonly state: 'done'; readonly resultPayload: Record<string, unknown> }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'timeout' }
  // The run reported itself non-final (final:false) and handed a live continuation
  // to onInterim. The poll stops here: the live stream is now the source of truth, and
  // the caller finalizes from it (never a producer terminal-result, which never comes
  // for a streaming run). No place/error/timeout is owned by the poll after this.
  | { readonly state: 'streaming' };

function bytesOf(reply: unknown): Uint8Array | null {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return new TextEncoder().encode(reply);
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload !== undefined && payload !== reply) return bytesOf(payload);
  }
  return null;
}

/** An action with no separately-polled status may return its terminal receipt
 * directly. Preserve that generic reply instead of discarding it: this is how
 * any owner can return opaque refs for a surface to re-resolve from live DATA. */
function directResultPayload(reply: unknown): Record<string, unknown> {
  if (reply && typeof reply === 'object' && !Array.isArray(reply) && !(reply instanceof Uint8Array) && !(reply instanceof ArrayBuffer) && !ArrayBuffer.isView(reply)) {
    const record = reply as Record<string, unknown>;
    // An envelope ({ target, payload }) carries its answer as `payload`: an object as it is, bytes decoded.
    if (bytesOf(record.payload)) return directResultPayload(record.payload);
    if (record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)) return record.payload as Record<string, unknown>;
    return record;
  }
  const bytes = bytesOf(reply);
  if (!bytes) return {};
  try {
    const value = JSON.parse(textDecoder.decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readRecordAt(
  sender: AffordanceRequestSender,
  partition: string,
  address: string,
  addressMode?: string,
): Promise<Record<string, unknown> | null> {
  const request = addressMode
    ? buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode })
    : buildEngineReadCurrentRequestFromLabels(partition, address);
  const reply = await sender(request as { target: string; payload: unknown });
  const bytes = bytesOf(reply);
  if (!bytes) return null;
  const current = decodeEngineReadCurrentReply(bytes);
  if (!current.found) return null;
  try {
    const value = JSON.parse(textDecoder.decode(current.payload));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface RunAffordanceArgs {
  readonly target: string;
  readonly payload: unknown;
  readonly statusAddresses: ResolvedStatusAddresses | null;
  /** The doc's own partition — overridden by the record's result partition. */
  readonly partitionLabel: string;
  /** Poll cadence + budget (Society DATA — callers pass what the action wants). */
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sender?: AffordanceRequestSender;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called AT MOST ONCE the first time the polled result declares itself
   *  NON-terminal (`final:false`) — the caller receives the OPAQUE result
   *  payload to interpret in its own domain (e.g. attach to a live output feed).
   *  Polling continues to the terminal result either way. This rail stays domain-
   *  blind: it reads only the generic boolean, never any producer-specific field. */
  readonly onInterim?: (resultPayload: Record<string, unknown>) => void;
}

/** Whether a polled result is the run's TERMINAL value. A producer marks an
 *  in-progress update with `final:false` (a self-describing boolean — Physics,
 *  not an extensible status enum) so the poll keeps waiting; ANY other record
 *  (the final result, an error result, or a legacy record with no `final`
 *  field) is terminal. Back-compat: a one-shot producer that never writes
 *  `final` is always terminal — behavior is byte-identical. */
function isTerminalResult(result: Record<string, unknown>): boolean {
  return result.final !== false;
}

const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Dispatch the envelope, then poll result → error → pending until done or the
 * budget runs out. No status addresses → fire-and-forget (resolved as done with
 * an empty payload — the record declared no observable completion).
 */
export async function runActionAffordance(args: RunAffordanceArgs): Promise<AffordanceRunOutcome> {
  const sender = args.sender ?? (sendRequestToBitfieldTarget as AffordanceRequestSender);
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dispatchReply = await sender({ target: args.target, payload: args.payload });
  console.log(`[action-affordance] composition dispatched → ${args.target}`);
  const status = args.statusAddresses;
  if (!status) return { state: 'done', resultPayload: directResultPayload(dispatchReply) };
  const partition = status.resultPartitionLabel ?? args.partitionLabel;
  const interval = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const budget = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let interimSeen = false;
  for (let waited = 0; waited <= budget; waited += interval) {
    const result = await readRecordAt(sender, partition, status.resultAddress, status.addressMode);
    if (result) {
      if (isTerminalResult(result)) {
        console.log('[action-affordance] composition run result found');
        return { state: 'done', resultPayload: result };
      }
      // Non-terminal (final:false) — hand the opaque payload to the caller and
      // STOP: the live stream is now the source of truth (a streaming run never gets
      // a terminal producer result — the workflow ends at the interim pointer). The
      // caller finalizes from the stream when it ends.
      if (!interimSeen) {
        interimSeen = true;
        console.log('[action-affordance] composition run streaming — poll yields to the live stream');
        args.onInterim?.(result);
      }
      return { state: 'streaming' };
    }
    const error = await readRecordAt(sender, partition, status.errorAddress, status.addressMode);
    if (error) {
      return { state: 'error', message: typeof error.message === 'string' ? error.message : '' };
    }
    await sleep(interval);
  }
  return { state: 'timeout' };
}
