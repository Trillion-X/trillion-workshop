// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-producer-status.ts @ e99ac5976
// packages/chat/read-data/read-chat-producer-status.ts
//
// PURPOSE
// Read an ai-records-producer turn result/error live, the SAME proven way the
// group board does (group/read-data/read-producer-status.ts): build the
// read-current request with the canonical protocol encoder and decode the reply
// with the canonical decoder. This lives in read-data/ (NOT do-work/) because
// the entry-bytes build aliases `@bitfield/runtime-kit/protocol` to the real
// protocol module, whereas the do-work stored-bytes build aliases only the bare
// `@bitfield/runtime-kit` (so a `/protocol` import there fails to resolve).
//
// The earlier do-work reader hand-rolled a `bytes.slice(9)` "rough approximation"
// of the reply format that returned null even when the producer wrote the reply —
// that is why a sent message never surfaced a response. This uses the proven
// encoder/decoder instead.
//
// NON-NEGOTIABLE INVARIANTS
//   - PRODUCER-BLIND: chat names only the producer's result/error addresses it was
//     handed; it does not know how the producer computes a reply.
//   - SAME DECODER AS THE BOARD: no bespoke byte slicing.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** One reply item the producer returns (message kind for chat). */
export interface ProducerResultItem {
  readonly kind?: string;
  readonly text?: string;
  readonly role?: string;
  readonly src?: string;
  readonly contentType?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export type ProducerStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'done'; readonly items: readonly ProducerResultItem[]; readonly modelId?: string; readonly providerModelId?: string; readonly cliId?: string }
  | { readonly state: 'error'; readonly code?: string; readonly message: string; readonly retryable?: boolean; readonly modelId?: string; readonly providerModelId?: string; readonly cliId?: string };

function routingFields(record: Record<string, unknown>) {
  return {
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(typeof record.model_id === 'string' && record.model_id ? { modelId: record.model_id } : {}),
    ...(typeof record.provider_model_id === 'string' && record.provider_model_id ? { providerModelId: record.provider_model_id } : {}),
    ...(typeof record.cli_id === 'string' && record.cli_id ? { cliId: record.cli_id } : {}),
  };
}

function currentEntryRecord(value: unknown): Record<string, unknown> | null {
  let decoded = value;
  if (value instanceof Uint8Array) {
    try { decoded = JSON.parse(textDecoder.decode(value)); } catch { return null; }
  } else if (value instanceof ArrayBuffer) {
    try { decoded = JSON.parse(textDecoder.decode(new Uint8Array(value))); } catch { return null; }
  }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
}

/** Reduce reactive owner-record inputs into the same producer status contract. */
export function readChatProducerStatusFromEntries(resultEntry: unknown, errorEntry: unknown): ProducerStatus {
  const result = currentEntryRecord(resultEntry);
  if (result) {
    const items = itemsFromResult(result.items);
    if (items) return { state: 'done', items, ...routingFields(result) };
    const failed = resultRecordError(result);
    if (failed) return { state: 'error', code: failed.code, message: failed.message, ...routingFields(result) };
  }
  const error = currentEntryRecord(errorEntry);
  if (error) return {
    state: 'error',
    code: typeof error.code === 'string' ? error.code : typeof error.error_code === 'string' ? error.error_code : undefined,
    message: humanizeProducerError(typeof error.message === 'string' ? error.message : typeof error.error_message === 'string' ? error.error_message : ''),
    ...routingFields(error),
  };
  return { state: 'pending' };
}

/** Where the producer wrote this turn's result/error (the chat dispatch returns these). */
export interface ProducerStatusAddresses {
  readonly resultAddress: string;
  readonly errorAddress: string;
  readonly addressMode?: 'label-hash' | 'identity-text';
  /** Producer writes to `runtime-partition`; override the caller partition with it. */
  readonly resultPartitionLabel?: string;
}

export type ProducerStatusSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

function payloadBytesFromReply(reply: unknown): Uint8Array | null {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  return null;
}

async function readRecord(
  sender: ProducerStatusSender,
  partition: string,
  address: string,
  addressMode?: string,
): Promise<Record<string, unknown> | null> {
  const request = addressMode
    ? buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode: addressMode as 'label-hash' | 'identity-text' })
    : buildEngineReadCurrentRequestFromLabels(partition, address);
  const reply = await sender(request);
  const bytes = payloadBytesFromReply(reply);
  if (!bytes) return null;
  const current = decodeEngineReadCurrentReply(bytes);
  if (!current.found || !current.payload) return null;
  try {
    const value = JSON.parse(textDecoder.decode(current.payload));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Turn a raw producer failure (often a multi-line Python traceback or an
 * adapter stderr dump) into ONE clean, human, actionable sentence for the chat
 * bubble. GENERIC — never names a specific model/provider (L090/L114): the
 * producer is blind to which agent failed, so the message stays universal and
 * the raw detail stays in the producer's error record + ai-execution-history for
 * diagnostics. The goal is that a user who picks an un-set-up model sees a clear
 * "needs setup" line instead of a stack trace or an endless "Thinking…" spinner.
 */
export function humanizeProducerError(rawMessage: string): string {
  return 'This model couldn’t respond — it may need an API key or setup. Try another model, or set it up under AI Providers.';
}

/** True when a producer RESULT record is a failure (carries an error, no reply
 *  items). The producer writes failures to the result address as
 *  `{error_code, error_message, items: []}`, so a result with no items + an
 *  error field is an error, not a still-pending turn. */
export function resultRecordError(
  result: Record<string, unknown>,
): { code?: string; message: string } | null {
  const code = typeof result.error_code === 'string' && result.error_code ? result.error_code : undefined;
  const rawMessage = typeof result.error_message === 'string' ? result.error_message : '';
  if (!code && !rawMessage) return null;
  return { code, message: humanizeProducerError(rawMessage) };
}

/** Validate + normalize the producer's `items` array (message replies). */
export function itemsFromResult(value: unknown): readonly ProducerResultItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: ProducerResultItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const item: ProducerResultItem = {
      kind: typeof r.kind === 'string' ? r.kind : undefined,
      text: typeof r.text === 'string' ? r.text : undefined,
      role: typeof r.role === 'string' ? r.role : undefined,
      src: typeof r.src === 'string' ? r.src : undefined,
      contentType: typeof r.contentType === 'string' ? r.contentType : undefined,
      extra: r.extra && typeof r.extra === 'object' ? (r.extra as Record<string, unknown>) : undefined,
    };
    if (item.text !== undefined || item.src !== undefined) items.push(item);
  }
  return items.length ? items : undefined;
}

/** Poll a chat turn's producer result/error with the canonical encoder/decoder. */
export async function readChatProducerStatus(
  partition: string,
  addresses: ProducerStatusAddresses,
  sender: ProducerStatusSender = sendRequestToBitfieldTarget as ProducerStatusSender,
): Promise<ProducerStatus> {
  const pollPartition = addresses.resultPartitionLabel ?? partition;
  const result = await readRecord(sender, pollPartition, addresses.resultAddress, addresses.addressMode);
  if (result) {
    const items = itemsFromResult(result.items);
    if (items) return { state: 'done', items, ...routingFields(result) };
    // A result record with no items but an error field is a FAILED turn (e.g. an
    // un-set-up model: the producer ran the adapter, it threw, and the failure
    // was written to the result address). Surface it immediately as a clean
    // human error instead of falling through to pending → poll-deadline timeout
    // (which made an unconfigured model look like an endless "Thinking…").
    const failed = resultRecordError(result);
    if (failed) return { state: 'error', code: failed.code, message: failed.message, ...routingFields(result) };
  }

  const error = await readRecord(sender, pollPartition, addresses.errorAddress, addresses.addressMode);
  if (error) {
    return {
      state: 'error',
      code: typeof error.code === 'string' ? error.code : typeof error.error_code === 'string' ? error.error_code : undefined,
      message: humanizeProducerError(typeof error.message === 'string' ? error.message : typeof error.error_message === 'string' ? error.error_message : ''),
      ...routingFields(error),
    };
  }

  return { state: 'pending' };
}

/**
 * Read a tool-result record a guarded tool wrote at `address` (#53 S2 ReAct loop).
 * Generic — returns the raw self-describing record ({status, command, stdout,
 * reason, …}); the caller frames it back to the model. Same canonical decoder as
 * the producer status read; no bespoke byte slicing. Returns null until written.
 */
export async function readChatToolResultRecord(
  partition: string,
  address: string,
  addressMode: 'label-hash' | 'identity-text' = 'identity-text',
  sender: ProducerStatusSender = sendRequestToBitfieldTarget as ProducerStatusSender,
): Promise<Record<string, unknown> | null> {
  return readRecord(sender, partition, address, addressMode);
}
