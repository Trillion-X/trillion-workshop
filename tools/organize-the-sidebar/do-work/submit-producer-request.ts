// packages/group/do-work/submit-producer-request.ts
//
// PURPOSE
// Fire a producer GENERICALLY by DATA — the blind Group Board's submit half. A
// producer (source-pull, cron fill, multi-source pull) is named by a DATA
// `ProducerSubmitDescriptor`: which workflow definition
// to run + the address templates where it will publish result/error. This module
// builds the generic `slot::workflow` `execute_definition` envelope and returns
// the resolved status addresses. It NEVER imports or names a concrete producer —
// adding a new producer is a DATA row (a new descriptor), ZERO code change here.
//
// NON-NEGOTIABLE INVARIANTS
//   - PRODUCER-BLIND (L069/L098/L106): no concrete-producer import, no branch on
//     producer identity. The descriptor is opaque DATA carried from the shelf/owner.
//     A `group` author with zero knowledge of producers can compile + use this.is.
//   - THE PRODUCER OWNS ITS RECORDS (L098): this only FIRES the producer's workflow
//     definition; the producer's def writes its own result/error records (incl. the
//     honest no-input record). The board never writes a producer's records.
//   - STATUS ADDRESSES ARE DATA: derived from the descriptor's templates ({id} →
//     requestId), handed back so `read-producer-status.ts` reads status blindly.

import { sendRequestToBitfieldTarget } from '#workspace-records';

/** The generic workflow slot — fires any admitted workflow definition by id. */
const WORKFLOW_TARGET = 'slot::workflow';

/** DATA describing how to invoke ONE producer + where it publishes. Opaque to the board. */
export interface ProducerSubmitDescriptor {
  /** The admitted workflow-definition id the producer runs (e.g. a source-pull or process action). */
  readonly definitionId: string;
  /** Where the producer writes success — `{id}` is replaced by the requestId. */
  readonly resultAddressTemplate: string;
  /** Where the producer writes the honest error/no-result record — `{id}` → requestId. */
  readonly errorAddressTemplate: string;
  /** How those addresses are read (matches how the producer's def wrote them). */
  readonly addressMode?: 'label-hash' | 'identity-text';
  /** The partition the producer's workflow def writes its result/error records to. When
   *  set, the board polls THIS partition for status instead of its own data partition.
   *  Required when the producer's workflow partition_key differs from the board's
   *  partitionLabel (e.g. a workflow with partition_key:"runtime-partition" mounted
   *  into a board whose own partition is something else). Absent → the board's own
   *  partitionLabel is used.
   *
   *  The example here used to name "bitfield-studio" as where the board lives. That
   *  app is retired, and this package names no app by design: it is installed in many
   *  sets, so the board's partition is whichever app it runs in. */
  readonly resultPartitionLabel?: string;
  /** Producer-specific static input the def requires (e.g. `{ options: {}, requested_at: '' }`).
   *  Kept DATA so the board never knows a producer's input schema. */
  readonly baseInput?: Record<string, unknown>;
  /** The action's RAW input_template (bindings + compose), carried so the invoking
   *  surface can resolve it against a live invoke context — filling `typed.text` with
   *  the surface's SUBJECT (the board's selected items' text, a composition block's
   *  text). This is how an action composes `instruction + subject` and acts on the
   *  selection instead of an empty prompt. Opaque DATA — the board never reads its keys. */
  readonly inputTemplate?: Record<string, unknown>;
}

export interface ProducerRequestArgs {
  /** Caller-supplied stable id (the board mints it; never Date/random inside here). */
  readonly requestId: string;
  /** Opaque owner input carried straight through to the producer's workflow def.
   *  The board never inspects, names, or constrains this — it is DATA from the owner. */
  readonly input: Record<string, unknown>;
  /** The board group the produced item(s) land in. */
  readonly targetGroupRef: string;
}

/** What the board needs back: the id it polls + the DATA addresses to poll. */
export interface ProducerSubmission {
  readonly requestId: string;
  readonly statusAddresses: {
    readonly resultAddress: string;
    readonly errorAddress: string;
    readonly addressMode?: 'label-hash' | 'identity-text';
    /** The partition to poll for this producer's result/error. Absent → board's own partition. */
    readonly resultPartitionLabel?: string;
  };
}

/** A sender of an engine-operation request → opaque reply. Browser default talks to the live engine. */
export type ProducerRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

/** Replace every `{id}` in an address template with the requestId. */
function fillTemplate(template: string, id: string): string {
  return template.split('{id}').join(id);
}

/**
 * Fire the producer's workflow definition (DATA `definitionId`) with the core
 * producer-agnostic input, and resolve its status addresses from DATA templates.
 * The producer's def does the rest (run a provider OR write the honest record);
 * the board polls `statusAddresses` via `readProducerStatus`.
 *
 * FIRE-AND-POLL (NON-NEGOTIABLE — L055/L063/L069): the producer is semantically
 * fire-and-poll, so the request is NO-REPLY. `include_output: false` is the DATA bit
 * the platform's EXISTING generic no-reply primitive matches (`package-entry-scope-binding.json`
 * declares `slot::workflow` / `execute_definition` / `include_output:false` with empty
 * `answer_cells`; `targetWriteDeclaresNoReply` routes a matching call through
 * `noReplyBytesSender`, which resolves IMMEDIATELY). Without it the call is reply-required,
 * so the browser AND the engine await the whole workflow inline — a producer whose def runs
 * a slow `compute.process` (a 30-60s CLI process) then starves the engine's current-state/snapshot
 * worker and freezes the app. Fast producers (~1s) hid this. The fix is generic: ONE data bit,
 * no producer branch, no new process mode — every producer using this envelope becomes no-reply.
 * The board's `readProducerStatus` polling stays the ONLY status mechanism (the producer's def
 * writes its own result/error record). See `reference_producer_execute_definition_blocks_engine_on_slow_compute_process`.
 */
export async function submitProducerRequest(
  descriptor: ProducerSubmitDescriptor,
  args: ProducerRequestArgs,
  sender: ProducerRequestSender = sendRequestToBitfieldTarget as ProducerRequestSender,
): Promise<ProducerSubmission> {
  await sender({
    target: WORKFLOW_TARGET,
    payload: {
      operation: 'execute_definition',
      // NO-REPLY marker — matches the generic no-reply binding so this returns immediately
      // instead of awaiting the (possibly slow) workflow inline. See the doc comment above.
      include_output: false,
      definition_id: descriptor.definitionId,
      input: {
        ...(descriptor.baseInput ?? {}),
        ...args.input,
        // Routing fields must match the status addresses returned below. Opaque
        // producer input cannot redirect a result away from its initiating card.
        request_id: args.requestId,
        target_group_ref: args.targetGroupRef,
      },
    },
  });
  return {
    requestId: args.requestId,
    statusAddresses: {
      resultAddress: fillTemplate(descriptor.resultAddressTemplate, args.requestId),
      errorAddress: fillTemplate(descriptor.errorAddressTemplate, args.requestId),
      ...(descriptor.addressMode ? { addressMode: descriptor.addressMode } : {}),
      ...(descriptor.resultPartitionLabel ? { resultPartitionLabel: descriptor.resultPartitionLabel } : {}),
    },
  };
}
