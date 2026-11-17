// packages/service-connections/do-work/seal-session-acquisition.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Seal a finished SESSION-BACKED acquire into durable connection facts. The
// acquire process ran as a live compute.process_session, the user acted on the
// mid-run challenge (typed the pairing code), and the process emitted its
// self-describing completion line (`summary`/`paired`/`connected` — captured
// verbatim by `readAcquireChallengeFeed().completion`). This module folds that
// completion + the acquire descriptor's own outcome contract into the SAME
// write path every acquire uses: `connectServiceWithCredentialHandle` (facts
// via the owner write-door; the reactive publish trigger flips the tile).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. DATA-described outcome (L090): WHICH completion field proves success,
//    WHICH carries the account label, WHICH carries the credential ref — all
//    declared by the descriptor's `acquire.outcome` paths. This module never
//    names `paired`, `self_jid`, or any vendor vocabulary.
// 2. Fail-closed: no declared success path -> no seal. Success path falsy ->
//    no seal. A session that dies unpaired writes NOTHING (no fake Connected —
//    the same L063 gate as connect-service's validation-gated connect).
// 3. Secrets never pass through here: the completion carries a REFERENCE to
//    where the process sealed its credential (a vault key / blob path), never
//    the bytes.
import {
  connectServiceWithCredentialHandle,
} from './connect-service';
import {
  deriveConnectionInstanceId,
  type ServiceConnectionTarget,
} from '../read-data/read-service-connection-options';

/** Outcome read from a completion line via the descriptor's declared paths. */
export interface SessionAcquireOutcomeView {
  /** True only when the descriptor declares a success path AND it is truthy. */
  succeeded: boolean;
  /** Account label at the declared label path ('' when absent). */
  accountLabel: string;
  /** Credential reference at the declared ref path ('' when absent). */
  credentialRef: string;
}

function valueAtPath(record: Record<string, unknown>, path: unknown): unknown {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  let current: unknown = record;
  for (const key of path) {
    if (typeof key !== 'string' || !current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Fold the completion line through the descriptor's `outcome` contract:
 *   acquire.outcome = {
 *     success: [<path into completion — truthy means the user is connected>],
 *     label:   [<path to the account identity to display>],       (optional)
 *     credential_ref: [<path to where the credential was sealed>], (optional)
 *   }
 * No outcome contract, or a falsy success value -> succeeded: false (fail
 * closed — invariant 2).
 */
export function readSessionAcquireOutcome(
  acquire: Record<string, unknown>,
  completion: Record<string, unknown>,
): SessionAcquireOutcomeView {
  const view: SessionAcquireOutcomeView = { succeeded: false, accountLabel: '', credentialRef: '' };
  const outcome = acquire.outcome;
  if (!outcome || typeof outcome !== 'object') return view;
  const contract = outcome as Record<string, unknown>;
  view.succeeded = Boolean(valueAtPath(completion, contract.success));
  const label = valueAtPath(completion, contract.label);
  if (typeof label === 'string') view.accountLabel = label;
  const ref = valueAtPath(completion, contract.credential_ref);
  if (typeof ref === 'string') view.credentialRef = ref;
  return view;
}

/**
 * Seal a successful session acquire as connection facts. Returns the account
 * label written (for the toast) or null when the completion did not prove
 * success (nothing written — fail closed). `writeFacts` is injected for tests
 * (defaults to the real connect write path).
 */
export async function sealSessionAcquisition(input: {
  acquire: Record<string, unknown>;
  completion: Record<string, unknown>;
  connection: ServiceConnectionTarget;
  existingConnectionIds?: Iterable<string>;
  writeFacts?: typeof connectServiceWithCredentialHandle;
}): Promise<string | null> {
  const outcome = readSessionAcquireOutcome(input.acquire, input.completion);
  if (!outcome.succeeded) return null;
  const accountLabel = outcome.accountLabel || input.connection.serviceName;
  const connectionId = deriveConnectionInstanceId(
    input.connection.serviceVendor,
    accountLabel,
    new Set(input.existingConnectionIds ?? []),
  );
  const writeFacts = input.writeFacts ?? connectServiceWithCredentialHandle;
  await writeFacts({
    connection: {
      ...input.connection,
      id: connectionId,
      // AGNOSTIC serviceName stays static (e.g. "WhatsApp"). Account identity
      // is stored separately in accountLabel for multi-account grouping.
      accountLabel: outcome.accountLabel || undefined,
    },
    credentialHandleRef: outcome.credentialRef,
  });
  return accountLabel;
}
