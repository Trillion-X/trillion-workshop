// packages/ui/show/action-affordance/write-affordance-live.ts
//
// Publish a user-authored action-affordance record to the LIVE log via
// engine.operation.write-batch (the post-log-ownership front door — folder
// edits are proposals, never live truth). Shared by every surface that mounts
// the editor (composition doc, board); the sender is injectable.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildEngineWriteBatchRequestFromLabels } from '#workspace-records';
import {
  buildActionAffordanceWriteItem,
  resolveActionAffordanceWriteAddress,
  slugOf,
  type ActionAffordanceDraft,
  type ActionAffordanceWriteItem,
} from './write-action-affordance';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The LIVE engine.operation.write-batch reply is 8 raw bytes: the write count
// as a u64 little-endian (proven live: a 2-entry batch replies \x02\0\0\0\0\0\0\0).
// Object/JSON forms also appear in test senders — decode all three.
function writeCountOf(reply: unknown): number {
  if (isRecord(reply) && ('write_count' in reply || 'writeCount' in reply)) {
    const raw = reply.write_count ?? reply.writeCount;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  }
  if (isRecord(reply) && reply.payload !== undefined) return writeCountOf(reply.payload);
  let bytes: Uint8Array | null = null;
  if (reply instanceof Uint8Array) bytes = reply;
  else if (reply instanceof ArrayBuffer) bytes = new Uint8Array(reply);
  else if (ArrayBuffer.isView(reply)) bytes = new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  else if (typeof reply === 'string') bytes = textEncoder.encode(reply);
  if (!bytes) return 0;
  if (bytes.byteLength === 8) {
    let value = 0;
    for (let shift = 7; shift >= 0; shift -= 1) value = value * 256 + bytes[shift]!;
    return Number.isSafeInteger(value) ? value : 0;
  }
  const text = textDecoder.decode(bytes).trim();
  if (!text) return 0;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? writeCountOf(parsed) : 0;
  } catch {
    return 0;
  }
}

export type BitfieldRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

/** Build the generic durable last-used configuration record. It shares the
 *  user-actions namespace but is not an action-affordance, so the action reader
 *  remains a pure action fold and the configuration reader remains independent. */
export function buildActionAffordanceConfigurationWriteItem(
  actionId: string,
  answers: Record<string, unknown>,
): ActionAffordanceWriteItem {
  const suffix = slugOf(actionId);
  return {
    address: `package::user-actions::configuration::${suffix}`,
    path: ['current-item', 'published-record'],
    payload: {
      kind: 'action-affordance-configuration',
      version: 1,
      action_id: actionId,
      answers,
    },
  };
}

/** Write ANY prebuilt action-affordance write-item (authored action OR a curried
 *  preset) to the live log. The ONE write path — writeActionAffordanceLive and the
 *  preset save both funnel here, so a saved preset and an authored action publish
 *  through identical bytes. Throws when the engine rejects the single write. */
export async function writeActionAffordanceItemLive(
  item: ActionAffordanceWriteItem,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  const reply = await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: item.address,
    pathLabels: [...item.path],
    payloadBytes: textEncoder.encode(JSON.stringify(item.payload)),
  }]) as { target: string; payload: unknown });
  if (writeCountOf(reply) !== 1) {
    throw new Error('The action could not be saved.');
  }
  console.log(`[action-affordance] authored live: ${item.address}`);
  return item.address;
}

/** Persist last-used answers through the same live Envelope write-batch path
 *  as authored actions and presets. The caller supplies only generic action id
 *  and answers; no product-specific configuration is known here. */
export async function writeActionAffordanceConfigurationLive(
  actionId: string,
  answers: Record<string, unknown>,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  return writeActionAffordanceItemLive(
    buildActionAffordanceConfigurationWriteItem(actionId, answers),
    partitionLabel,
    sender,
  );
}

/** Write the authored action as a live published record. Resolves the record's
 *  address; throws when the engine rejects the write (caller shows the error). */
export async function writeActionAffordanceLive(
  draft: ActionAffordanceDraft,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  return writeActionAffordanceItemLive(buildActionAffordanceWriteItem(draft), partitionLabel, sender);
}

/** Set a user action's liveness at its OWN log address — ONE primitive whose two
 *  configurations are archive (`is_active:false` — a soft delete: the reader skips
 *  inactive rows so the action vanishes from every surface while the log keeps
 *  history) and restore (`is_active:true` — the same record returns everywhere,
 *  powering an "Undo remove"). Preserves the rest of the record so nothing else is
 *  lost. A row without a resolvable live write address (e.g. a test fixture)
 *  cannot be flipped. Throws when the engine does not apply the single write. */
export async function setActionAffordanceActiveLive(
  affordance: { readonly id?: string; readonly source_address?: string; readonly payload: unknown },
  isActive: boolean,
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  // The IDENTITY-TEXT address (create address), NOT the feed's content-hash
  // recordId — writing to the hash mints an orphan and leaves the live record.
  const address = resolveActionAffordanceWriteAddress(affordance);
  if (!address) throw new Error('This action cannot be changed.');
  const base = isRecord(affordance.payload) ? affordance.payload : {};
  const next = { ...base, kind: 'action-affordance', is_active: isActive };
  const reply = await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: address,
    pathLabels: ['current-item', 'published-record'],
    payloadBytes: textEncoder.encode(JSON.stringify(next)),
  }]) as { target: string; payload: unknown });
  if (writeCountOf(reply) !== 1) {
    throw new Error('The action could not be changed.');
  }
  console.log(`[action-affordance] set is_active:${isActive} live: ${address}`);
  return address;
}

/** Archive/remove a user action — the `is_active:false` configuration of
 *  {@link setActionAffordanceActiveLive}, kept as the named verb call sites use. */
export async function archiveActionAffordanceLive(
  affordance: { readonly id?: string; readonly source_address?: string; readonly payload: unknown },
  partitionLabel: string,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<string> {
  return setActionAffordanceActiveLive(affordance, false, partitionLabel, sender);
}
