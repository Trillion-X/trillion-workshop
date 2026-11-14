// packages/ask-questions-sort-answers-follow-up/read-data/read-producer-message.ts
//
// PURPOSE
// Poll an ai-records-producer message turn (result/error) the proven way: build
// the read-current request with the canonical protocol encoder and decode with
// the canonical decoder. The producer writes its result at the LABEL-HASH
// (binding) address, and a reader polling identity-text finds nothing forever.
//
// It used to say the producer writes on `runtime-partition`, and that was false in
// a way that broke this poll. The result write is the producer's `step_16`, whose
// single item declares address, path and payload and NO `partition_key`, so
// `build_writes` leaves `PendingWrite.partition_key` as None
// (step_executor.rs:1046-1049) and `write_batch.rs:12-16` falls back to the ENVELOPE
// partition, which bitfield-runner stamps as the serving app
// (package_target_handlers.rs:128). So the result lands in the app the caller is
// running in, while this reader was polling a partition no installed app owns.
// Writer and reader pointed at different stores, and because SynthesisView wraps
// the call in a catch, the divergence surfaced as a spinner for 120s, never an error.
//
// Do NOT trace this through the `{"from":"context","path":"partition_key"}` bindings.
// They are the obvious-looking route and they are the wrong one: they govern the
// producer's own reads and its `--partition-key` argv, not where the result lands.
// Both reach the same app today, so that route gives the right answer for the wrong
// reason, and whoever leans on it is lost the first time the two differ.
//
// Hence `partition` below comes from this entry's own GENERATED live-read
// descriptor. It is not omitted, because the binary encoder throws unless exactly
// one of partitionLabel or partitionMultihashCodeHex is present, and that throw is
// swallowed by the caller's catch into a permanent pending. This is a reader, not a
// target, so `readTrustedRuntimePartition` is unavailable here: the runner hands a
// partition to targets only.
//
// DEVIATION from the independent review, stated so it is not mistaken for an
// oversight. The review asked for a REQUIRED parameter injected by the mount, the
// shape used by visual-database, crm and poker-table, on the grounds that a default
// lets a later call site quietly reintroduce a wrong app name. That reason is about
// the SOURCE of the default, not its requiredness: a default read from the
// generator's own stamp cannot be a wrong app name, and it regenerates if the
// package set moves. What the default does cost is the import path below, which
// names the `synthesis` entry inside a shared read-data module. Today that is
// accurate, since the only consumer is SynthesisView mounted by mount-synthesis, and
// all five entry scopes carry the same value.
//
// CORRECTED 2026-09-04: an earlier version of this note called the import a compromise
// forced by a blocked reference-adaptation contract, whose directive.message_sha256 the
// validator checks for FORMAT only and offers no command to produce. That blocker is
// real and it was never on the path, because the mount never needed to change. For a
// module used by ONE entry this import IS the correct shape, not a stand-in for one.
// The same correction was applied to caption-renderer, where believing otherwise cost
// four consecutive wrong answers.
//
// Move to mount injection when a SECOND entry starts using this file, because then one
// entry's descriptor is the wrong scope for the other. Choose by how many entries use
// the module, never by the file's suffix.
//
// This is the exact lesson from the chat reply-render fix; the
// SynthesisView reuses it here so a synthesis over answers can dispatch the OWNED
// ai-records-producer by address and read the reply back (No-God-Package: this
// package NEVER resolves a provider/model/prompt — that stays in ai-records-producer).
//
// Generic + protocol-only. Lives in read-data/ because the entry-bytes build
// aliases `@bitfield/runtime-kit/protocol` to the real protocol module.
//
// L088 follow-up: the canonical home for this reader is ai-records-producer's own
// read-data (chat + group + this package each replicate ~40 lines). Extracting it
// there and having the three consume it removes the duplication.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
// The generator stamps this with the partition of the package set the entry was
// built into, so it is the app this code actually runs in. Despite the file name
// it imports no React, only @bitfield/runtime-kit/internal/owner-surface, which
// the non-react sibling kit imports too, so this adds no dependency.
import { bitfieldGeneratedLiveReadScopeDescriptor } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/synthesis/runtime-kit-react';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ProducerMessageStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'done'; readonly text: string; readonly provenance?: string }
  | { readonly state: 'error'; readonly message: string };

type Sender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

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
  sender: Sender,
  partition: string,
  address: string,
): Promise<Record<string, unknown> | null> {
  // The producer writes the result at the LABEL-HASH address — always poll label-hash.
  const request = buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode: 'label-hash' });
  const reply = await sender(request as { target: string; payload: Uint8Array });
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

/** Pull the first assistant message text out of a producer result record. */
export function messageTextFromResult(result: Record<string, unknown>): { text: string; provenance?: string } | null {
  const items = Array.isArray(result.items) ? result.items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.text === 'string' && r.text.length > 0) {
      return { text: r.text, provenance: typeof r.model_provenance_ref === 'string' ? r.model_provenance_ref : undefined };
    }
  }
  return null;
}

/** A result record with an error field + no message = a failed turn (not still-pending). */
export function resultError(result: Record<string, unknown>): string | null {
  const code = typeof result.error_code === 'string' ? result.error_code : '';
  const msg = typeof result.error_message === 'string' ? result.error_message : '';
  if (!code && !msg) return null;
  return 'This couldn’t be generated right now — the model may need setup. Try again in a moment.';
}

/** Poll a producer message turn: done (text) / error / pending. */
export async function readProducerMessage(
  resultAddress: string,
  errorAddress: string,
  partition: string = bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<ProducerMessageStatus> {
  const result = await readRecord(sender, partition, resultAddress);
  if (result) {
    const msg = messageTextFromResult(result);
    if (msg) return { state: 'done', text: msg.text, provenance: msg.provenance };
    const failed = resultError(result);
    if (failed) return { state: 'error', message: failed };
  }
  const error = await readRecord(sender, partition, errorAddress);
  if (error) return { state: 'error', message: 'This couldn’t be generated right now — try again in a moment.' };
  return { state: 'pending' };
}
