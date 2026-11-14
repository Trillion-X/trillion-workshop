/*
 * The LIVE route behind `slot::permission-lease.save-what-someone-is-allowed-to-do`.
 *
 * Why this file exists at all. The manifest published the pure decision function
 * itself as the target's `export_name`, and that function takes a SECOND argument
 * carrying three outside effects: confirm the yes, write the note, read it back.
 * Nothing in production supplied them. Every implementation anyone can find is a
 * unit-test fixture. So the shipped "Save permission" control reached a real
 * export, called it with one argument, and died on `seams.confirmAllowed is not a
 * function` before a single decision ran. A target that resolves is not a target
 * that works, and a TypeError is the least useful refusal a permission system can
 * give: it says nothing about whether you were allowed.
 *
 * What is here is only the wiring. Every decision stays in
 * `save-what-someone-is-allowed-to-do.ts`, which unit-tests with no engine. This
 * file has no policy in it: it resolves the three seams against the real runtime
 * and hands them over.
 *
 * The confirm seam dispatches `access-rule.verify-decision` by name, which is how
 * every other guarded owner in this set asks the same question, so a yes still has
 * to exist in durable truth and cannot be asserted by the caller.
 *
 * Read is the generic ambient `slot::find-current-items` over `published-record`,
 * the same op the guard reads notes with. Write is the generic ambient
 * `engine.operation.write-batch` over `engine.operation.label-addressed`. Both
 * match `exclusive-control-lease-targets.ts` exactly, because they are the same
 * two operations against the same store and a second spelling of them here would
 * be a second thing to keep true.
 */

import {
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { CONTROL_NOTE_KIND } from './exclusive-control-lease-core.ts';
import {
  saveWhatSomeoneIsAllowedToDo,
  type AllowedConfirmation,
  type AllowedToReceipt,
} from './save-what-someone-is-allowed-to-do.ts';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const FIND_CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const VERIFY_DECISION_TARGET = 'access-rule.verify-decision';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
const TEXT_DECODER = new TextDecoder();

export type AllowedToTargetSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A reply may be direct JSON or runtime-wrapped JSON bytes. */
function decodeReply(reply: unknown): Record<string, unknown> {
  if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || ArrayBuffer.isView(reply)) {
    const bytes = reply instanceof Uint8Array
      ? reply
      : reply instanceof ArrayBuffer
        ? new Uint8Array(reply)
        : new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
    const parsed = JSON.parse(TEXT_DECODER.decode(bytes));
    if (!isRecord(parsed)) throw new Error('target reply must be an object');
    return parsed;
  }
  if (!isRecord(reply)) throw new Error('target reply must be an object');
  if (reply.payload !== undefined && reply.payload !== reply) return decodeReply(reply.payload);
  return reply;
}

function extractRecordPayload(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (isRecord(item.payload)) return item.payload;
  if (typeof item.value_json === 'string' && item.value_json.length > 0) {
    return JSON.parse(item.value_json) as Record<string, unknown>;
  }
  return item;
}

/**
 * Ask durable truth whether this yes really exists, for this holder, over this
 * thing. A reply that is not a recognisable answer is `verified: false` with a
 * reason, never a throw: refusing is the safe outcome and the caller gets a
 * receipt saying why instead of a stack trace.
 */
function confirmThroughAccessRule(sender: AllowedToTargetSender) {
  return async (claim: {
    decision_proof: string;
    actor_ref: string;
    session_ref: string;
    subject_ref: string;
    action_ref?: string;
    revisions: Record<string, string>;
  }): Promise<AllowedConfirmation> => {
    let reply: Record<string, unknown>;
    try {
      reply = decodeReply(await sender({ target: VERIFY_DECISION_TARGET, payload: claim }));
    } catch (error) {
      return { verified: false, reason: `could-not-reach-the-decision-owner: ${String(error)}` };
    }
    const decision = extractRecordPayload(reply.decision);
    if (reply.verified !== true || !isRecord(decision)) {
      return { verified: false, reason: typeof reply.reason === 'string' ? reply.reason : 'not-allowed' };
    }
    // The yes must name THIS holder as its subject and THIS actor. The core
    // already asks with the holder as subject, so a durable answer about
    // somebody else is a mismatch worth refusing rather than trusting.
    if (decision.subject_ref !== claim.subject_ref || decision.actor_ref !== claim.actor_ref) {
      return { verified: false, reason: 'the-yes-names-someone-else' };
    }
    const things = decision.authorized_action_refs;
    const proof = decision.decision_proof;
    if (!Array.isArray(things) || typeof proof !== 'string' || proof === '') {
      return { verified: false, reason: 'the-yes-did-not-say-what-it-allows' };
    }
    return {
      verified: true,
      decision: {
        authorized_action_refs: things.filter((entry): entry is string => typeof entry === 'string'),
        decision_proof: proof,
        // Carried through rather than dropped. Keeping two fields and
        // discarding the rest meant the saver could not check a resource or a
        // deadline even in principle, so the only thing it could verify was the
        // one thing it already narrowed.
        ...(isRecord(decision.constraints) ? { constraints: decision.constraints } : {}),
      },
    };
  };
}

/** Ambient write-batch of one self-describing record into published-record. */
function writeThroughEngine(sender: AllowedToTargetSender) {
  return async (addressLabel: string, payload: Record<string, unknown>): Promise<void> => {
    await sender({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: {
        operation_label: ENGINE_WRITE_BATCH_OPERATION,
        writes: [{
          address_label: addressLabel,
          address_mode: 'label_hash',
          path_labels: [...PUBLISHED_RECORD_PATH],
          payload,
        }],
      },
    });
  };
}

/** Ambient find-current-items over published-record, narrowed to this note. */
function readThroughEngine(sender: AllowedToTargetSender) {
  return async (noteRef: string): Promise<Record<string, unknown>[]> => {
    const reply = decodeReply(await sender({
      target: FIND_CURRENT_ITEMS_TARGET,
      payload: {
        operation: 'find-current-items',
        in: 'published-record',
        where: {
          all: [
            { field: 'kind', eq: CONTROL_NOTE_KIND },
            { field: 'lease_ref', eq: noteRef },
          ],
        },
      },
    }));
    const raw = Array.isArray(reply.items) ? reply.items
      : Array.isArray(reply.results) ? reply.results
      : Array.isArray(reply.records) ? reply.records
      : [];
    return raw.map(extractRecordPayload).filter((value): value is Record<string, unknown> => isRecord(value));
  };
}

/**
 * The published entry point. Takes the declared input shape, resolves the three
 * seams against the running app, and returns the receipt the core produced.
 *
 * A refusal comes back as a receipt with `accepted: false` and a reason, which is
 * what a caller can act on. A malformed request still throws, because a request
 * missing a required field is a caller defect rather than a decision.
 */
export async function saveWhatSomeoneIsAllowedToDoTarget(
  input: unknown,
  _context?: BitfieldRuntimeContext,
  sender: AllowedToTargetSender = sendRequestToBitfieldTarget as AllowedToTargetSender,
): Promise<AllowedToReceipt> {
  return saveWhatSomeoneIsAllowedToDo(input, {
    confirmAllowed: confirmThroughAccessRule(sender),
    writeAllowedNote: writeThroughEngine(sender),
    readAllowedNotes: readThroughEngine(sender),
  });
}
