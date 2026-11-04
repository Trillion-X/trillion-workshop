import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineReadCurrentRequestForServingPartition,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  ENGINE_OPERATION_TARGET,
  ENGINE_READ_CURRENT_OPERATION_LABEL,
  ENGINE_WRITE_BATCH_OPERATION_LABEL,
  makeHashCodeHexFromBytes,
  makeIdentityTextAddressFromLabel,
  type EngineReadCurrentReply,
} from '#workspace-records';
import {
  readCompositionContent,
  type CompositionContent,
} from '../read-data/documents';

// The live content address — the SSOT the good era always wrote and where the
// user's real pages live (911+ log versions). Shared with the name/export/board
// composers and the read-only note entry. Never retire/redirect this address in
// a contract: a `remove:true` here retracts the user's actual authored pages.
export const DOCUMENTS_ADDRESS = 'package::documents::documents';
export const DOCUMENTS_PATH = ['current-item', 'published-record'] as const;

/** Resolve the serving app's document config when the browser's first snapshot is unavailable. */
export async function readServingCompositionRuntimeConfig(
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
): Promise<unknown> {
  const request = buildEngineReadCurrentRequestForServingPartition('package::documents::runtime-config');
  const current = decodeEngineReadCurrentReply(payloadBytesFromReply(await sender(request)));
  return current.found && current.payload ? JSON.parse(textDecoder.decode(current.payload)) : null;
}

type BitfieldRequestSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

export type CurrentBasis = {
  expectedPayloadHash: Uint8Array | null;
};

/**
 * One authoritative Documents record read.  Operations that need an observed
 * document identity must use this rather than re-hashing a reconstructed tree:
 * the hash is over the exact current payload bytes that the CAS guard protects.
 */
export type CompositionDocumentSnapshot = {
  content: CompositionContent | null;
  documentHash: string | null;
};

/** The exact payload identity independently confirmed by a successful write. */
export type CompositionDocumentWriteReceipt = {
  documentHash: string;
};

/**
 * Thrown when a guarded composition-document write was REJECTED because the log
 * basis advanced under it (a concurrent writer). The store re-syncs its basis to
 * the actual current before throwing, so the next write is correct; callers map
 * this to the `conflict` save-status (L098 — the store owns the translation).
 */
export class CompositionWriteConflictError extends Error {
  constructor(message = 'composition document write rejected: log basis advanced (concurrent write)') {
    super(message);
    this.name = 'CompositionWriteConflictError';
  }
}

/**
 * Thrown when a write's durability could NOT be VERIFIED — including a lost
 * acknowledgement. The verify-read failed, so we cannot prove the guarded
 * write applied (vs a CAS rejection with write_count==0). Fail-closed (L117): an
 * unverifiable save must NOT be reported as saved. The store retains its attempted
 * basis and bytes; a retry may proceed only if current still matches that basis
 * or the exact previous attempted bytes. A different current value is a conflict;
 * the caller keeps the on-screen edits and retries on the next keystroke. An
 * already-applied write can be confirmed or continued without a false conflict.
 * Distinct from
 * CompositionWriteConflictError so the caller does NOT reload (which would revert
 * the un-persisted in-flight edits).
 */
export class CompositionSaveUnverifiedError extends Error {
  constructor(message = 'composition document save could not be confirmed; it will retry') {
    super(message);
    this.name = 'CompositionSaveUnverifiedError';
  }
}

/**
 * Thrown when a write was REFUSED because it would overwrite authored content with
 * a text-empty tree — the emptied-notes clobber (a transient empty/failed load hands
 * the surface an empty tree, an unrelated edit then persists it, and every authored
 * page collapses to "Untitled page"). This is the L063/L128 CATEGORY kill made
 * structural: an empty tree can NEVER replace a tree that has authored text. The
 * store re-reads TRUE current before deciding, so the check is authoritative, not
 * based on a stale cached basis. Distinct from the conflict/unverified errors: the
 * caller keeps its on-screen edits (nothing is dropped), the bad empty write is the
 * only thing rejected. A genuinely-first empty document (current also text-empty)
 * always passes — a real edit is never blocked.
 */
export class CompositionEmptyWriteRejectedError extends Error {
  constructor(message = 'composition document write rejected: refused to overwrite authored content with an empty tree') {
    super(message);
    this.name = 'CompositionEmptyWriteRejectedError';
  }
}

/**
 * Structural text-presence predicate over a composition tree (generic, not Society):
 * a node carries authored text at `props.text`; the tree has authored text iff ANY
 * node anywhere (recursively) has a non-whitespace `props.text`. Structural nodes
 * (frames, layouts, empty blocks) contribute none. Used ONLY by the fail-closed
 * write guard — never on the happy path.
 */
export function compositionHasAuthoredText(content: CompositionContent | null): boolean {
  if (!content) return false;
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const n = node as { props?: { text?: unknown }; children?: unknown };
    const text = n.props?.text;
    if (typeof text === 'string' && text.trim().length > 0) return true;
    return Array.isArray(n.children) && n.children.some(walk);
  };
  return Array.isArray(content.children) && content.children.some(walk);
}

/**
 * Pure write-verification decision. Did our write land? Compare the bytes we
 * wrote against the actual current bytes after the write attempt. Equal ⇒
 * applied. Either way `newBasis` is the ACTUAL current hash — never the
 * unpersisted written hash on a rejected write (the latent basis-corruption fix).
 */
export function resolveWriteOutcome(
  writtenHash: Uint8Array,
  currentHashAfterWrite: Uint8Array | null,
): { applied: boolean; newBasis: CurrentBasis } {
  const applied = currentHashAfterWrite != null && bytesEqual(currentHashAfterWrite, writtenHash);
  return { applied, newBasis: { expectedPayloadHash: currentHashAfterWrite } };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export type CompositionDocumentsLogStore = {
  read: () => Promise<CompositionContent | null>;
  readSnapshot: (options?: { adopt?: boolean }) => Promise<CompositionDocumentSnapshot>;
  /** Adopt an unchanged snapshot returned by this store, synchronously in the caller's mutation queue. */
  adoptSnapshot: (snapshot: CompositionDocumentSnapshot) => boolean;
  write: (content: CompositionContent) => Promise<CompositionDocumentWriteReceipt>;
  /** Clear refusal recovery after this exact local revision is confirmed by the record owner. */
  confirmWrite: (documentHash: string) => void;
  /** Rebase only the exact current locally accepted frame whose record generation was permanently refused. */
  recoverRefusedWrite: (documentHash: string, expectedIdentity?: string | null) => Promise<boolean>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serialize async operations so they never interleave: each task runs strictly
 * after the previous settles, preserving submission order. A rejecting task does
 * NOT stall later tasks (the chain is kept alive). Used to make the store's
 * mutable `basis` read-modify-write atomic across `await` points.
 */
export function createSerialChain(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task);
    chain = result.then(noop, noop);
    return result;
  };
}

function noop(): void {
  /* swallow result/error so the next chained op always proceeds */
}

/**
 * Saves conditionally update the one current document record. The clock argument
 * remains in the callable ABI for installed targets; saves no longer invoke it
 * or emit discarded version-note rows. Revision retention belongs to the record
 * owner, and a hash/time note never established a restorable document version.
 */
export function createCompositionDocumentsLogStore(
  partitionLabel: string,
  _readClockMs: () => number,
  sceneAddress: string = DOCUMENTS_ADDRESS,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
  addressMode: 'label-hash' | 'identity-text' = 'label-hash',
): CompositionDocumentsLogStore {
  const partition = nonEmpty(partitionLabel, 'partitionLabel');
  const scene = nonEmpty(sceneAddress, 'sceneAddress');
  let basis: CurrentBasis | null = null;
  let unverifiedWrite: { basis: CurrentBasis; writtenHash: Uint8Array } | null = null;
  let refusalRecovery: { documentHash: string; previousBasis: CurrentBasis; resultingBasis: CurrentBasis } | null = null;
  let basisRevision = 0;
  let observationRevision = 0;
  let pendingBasisOperations = 0;
  // Provenance belongs to the exact object returned by this store. The immutable
  // hash/fingerprint pair records what was read without freezing a caller's draft
  // tree or trusting a hash copied onto different content.
  const observedSnapshots = new WeakMap<CompositionDocumentSnapshot, {
    basis: CurrentBasis;
    documentHash: string | null;
    contentFingerprint: string;
    basisRevision: number;
    observationRevision: number;
  }>();
  // `basis` is read-modify-written across `await` points, so overlapping ops
  // would read a STALE basis → spurious self-conflict + dropped edits on fast edits
  // (Codex + local convergence 2026-06-20, made worse by ~8s engine writes).
  // Serialize EVERY basis-touching op through one chain so each runs strictly
  // after the previous completes — atomic read-modify-write. (L055 root:
  // single-writer basis; L063: eliminates the whole write-overlap race class.)
  const serialize = createSerialChain();

  function serializeBasisChange<T>(operation: () => Promise<T>): Promise<T> {
    // Count queued work immediately: synchronous adoption cannot jump ahead of
    // an already-submitted write or adopting read while that work awaits its turn.
    pendingBasisOperations += 1;
    return serialize(async () => {
      basisRevision += 1;
      try {
        return await operation();
      } finally {
        pendingBasisOperations -= 1;
      }
    });
  }

  function read(): Promise<CompositionContent | null> {
    return readSnapshot().then((snapshot) => snapshot.content);
  }

  function readSnapshot(options: { adopt?: boolean } = {}): Promise<CompositionDocumentSnapshot> {
    const adopt = options.adopt !== false;
    const readSnapshotOnce = async (): Promise<CompositionDocumentSnapshot> => {
      const startingBasisRevision = basisRevision;
      const current = await readCurrent(partition, scene, sender, addressMode);
      const content = contentFromCurrent(current);
      const observedBasis = basisFromCurrent(current);
      if (adopt) {
        basis = observedBasis;
        unverifiedWrite = null; // only an explicit adoption changes the draft's basis
        if (!refusalRecovery || !sameBasis(observedBasis, refusalRecovery.resultingBasis)) refusalRecovery = null;
      }
      const payloadBytes = currentPayloadBytes(current);
      const snapshot = {
        content,
        documentHash: payloadBytes ? makeHashCodeHexFromBytes(Uint8Array.from(payloadBytes)) : null,
      };
      observedSnapshots.set(snapshot, {
        basis: observedBasis,
        documentHash: snapshot.documentHash,
        contentFingerprint: contentFingerprint(content),
        basisRevision: startingBasisRevision,
        observationRevision: ++observationRevision,
      });
      return snapshot;
    };
    return adopt ? serializeBasisChange(readSnapshotOnce) : serialize(readSnapshotOnce);
  }

  function adoptSnapshot(snapshot: CompositionDocumentSnapshot): boolean {
    const observed = observedSnapshots.get(snapshot);
    if (!observed || pendingBasisOperations > 0
        || observed.basisRevision !== basisRevision
        || observed.observationRevision !== observationRevision
        || snapshot.documentHash !== observed.documentHash) return false;
    try {
      if (contentFingerprint(snapshot.content) !== observed.contentFingerprint) return false;
    } catch {
      return false;
    }
    // No await is allowed between this change and the caller's matching local
    // state change. The eventual write still sends the exact observed CAS guard,
    // so another writer arriving after the read is rejected by the record owner.
    basis = observed.basis;
    unverifiedWrite = null;
    if (!refusalRecovery || !sameBasis(observed.basis, refusalRecovery.resultingBasis)) refusalRecovery = null;
    basisRevision += 1;
    return true;
  }

  function confirmWrite(documentHash: string): void {
    if (refusalRecovery?.documentHash === documentHash) refusalRecovery = null;
  }

  function recoverRefusedWrite(documentHash: string, expectedIdentity?: string | null): Promise<boolean> {
    pendingBasisOperations += 1;
    return serialize(async () => {
      const refused = refusalRecovery;
      try {
        if (!refused || refused.documentHash !== documentHash || !basis || !sameBasis(basis, refused.resultingBasis)) return false;
        // The mount supplies the latest refused outbox generation's actual CAS condition. Coalescing may have
        // removed intermediate local frames, so that condition can precede this store's last optimistic basis.
        // Never read/adopt an unrelated remote writer; the retried CAS still protects against concurrent changes.
        const retryBasis = expectedIdentity === undefined ? refused.previousBasis : {
          expectedPayloadHash: expectedIdentity === null ? null : multihashBytesFromCodeHex(expectedIdentity),
        };
        basisRevision += 1;
        basis = retryBasis;
        unverifiedWrite = null;
        refusalRecovery = null;
        return true;
      } finally {
        pendingBasisOperations -= 1;
      }
    });
  }

  function write(content: CompositionContent): Promise<CompositionDocumentWriteReceipt> {
    // A queued save represents the exact tree the caller submitted. Do not keep
    // a live reference to a mutable editor tree while earlier reads/writes drain:
    // otherwise later typing can silently change the meaning of an already-queued
    // save (and two receipts can describe bytes the caller never submitted).
    let submittedJson: string;
    let submittedContent: CompositionContent;
    try {
      submittedJson = JSON.stringify(content);
      submittedContent = JSON.parse(submittedJson) as CompositionContent;
    } catch (error) {
      return Promise.reject(error);
    }
    return serializeBasisChange(() => writeOnce(submittedContent, submittedJson));
  }

  async function writeOnce(content: CompositionContent, submittedJson: string): Promise<CompositionDocumentWriteReceipt> {
    // Any later mutation attempt supersedes the single refusal-recovery receipt,
    // even if that later attempt itself fails before reaching the owner.
    refusalRecovery = null;
    // One authoritative current-read, memoized: shared by the fail-closed guard and
    // the basis computation so the empty-incoming path costs the SAME sender calls as
    // a normal save (the guard adds no extra round-trip).
    let currentReply: EngineReadCurrentReply | null = null;
    const readCurrentOnce = async (): Promise<EngineReadCurrentReply> =>
      (currentReply ??= await readCurrent(partition, scene, sender, addressMode));
    if (unverifiedWrite) {
      let current: CurrentBasis;
      try {
        current = basisFromCurrent(await readCurrentOnce());
      } catch {
        throw new CompositionSaveUnverifiedError(); // retain uncertainty and local edit
      }
      const previous = unverifiedWrite;
      const unchanged = current.expectedPayloadHash === null
        ? previous.basis.expectedPayloadHash === null
        : previous.basis.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, previous.basis.expectedPayloadHash);
      const priorWriteApplied = current.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, previous.writtenHash);
      basis = current;
      if (!sameBasis(current, previous.basis) && !priorWriteApplied) refusalRecovery = null;
      unverifiedWrite = null;
      if (!unchanged && !priorWriteApplied) throw new CompositionWriteConflictError();
    }
    // FAIL-CLOSED (L063/L128 category kill): an empty tree must NEVER overwrite
    // authored content. Only when the INCOMING tree carries zero authored text do we
    // check TRUE current — if current has authored text, refuse the write so a
    // transient empty/failed load can never collapse the user's pages to "Untitled
    // page". A genuinely-first empty doc (current also text-empty) passes untouched —
    // a real edit is never blocked.
    if (!compositionHasAuthoredText(content)) {
      const persisted = contentFromCurrent(await readCurrentOnce());
      if (compositionHasAuthoredText(persisted)) {
        // Structured observability: prove the guard fired and what it protected.
        console.error('[documents] fail-closed: refused empty write over authored content', JSON.stringify({
          address: DOCUMENTS_ADDRESS,
          incoming_top_level_docs: content.children?.length ?? 0,
          persisted_top_level_docs: persisted?.children?.length ?? 0,
        }));
        throw new CompositionEmptyWriteRejectedError();
      }
    }
    const currentBasis = basis ?? basisFromCurrent(await readCurrentOnce());
    const payloadBytes = textEncoder.encode(submittedJson);
    const writtenHash = payloadHashBytes(payloadBytes);
    const documentHash = makeHashCodeHexFromBytes(Uint8Array.from(payloadBytes));
    const writeRequest = buildEngineWriteBatchRequestFromLabels([{
      partitionLabel: partition,
      ...(addressMode === 'identity-text'
        ? { addressMultihashHex: makeIdentityTextAddressFromLabel(scene) }
        : { addressLabel: scene }),
      pathLabels: DOCUMENTS_PATH,
      payloadBytes,
      expectedCurrent: {
        payloadHash: currentBasis.expectedPayloadHash,
      },
    }]);
    try {
      await sender(writeRequest);
    } catch (writeError) {
      // Atomic write-batch rejects its promise on ExpectedCurrentMismatch.
      // Transport wrappers may discard that typed error. Read the owner instead
      // of guessing from error text or retrying a stale edit against newer bytes.
      let current: CurrentBasis;
      try {
        current = basisFromCurrent(await readCurrent(partition, scene, sender, addressMode));
      } catch {
        // Retained local edits still belong to the attempted basis. Do not
        // silently rebase their retry onto a newer record we could not inspect.
        basis = currentBasis;
        unverifiedWrite = { basis: currentBasis, writtenHash };
        refusalRecovery = null;
        throw new CompositionSaveUnverifiedError();
      }
      const sameBasis = current.expectedPayloadHash === null
        ? currentBasis.expectedPayloadHash === null
        : currentBasis.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, currentBasis.expectedPayloadHash);
      const attemptedBytesAreCurrent = current.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, writtenHash);
      if (!sameBasis && !attemptedBytesAreCurrent) {
        basis = current;
        refusalRecovery = null;
        throw new CompositionWriteConflictError();
      }
      basis = current;
      // Exact readback proves durability even when the transport lost the write
      // acknowledgement. An unchanged older record remains a failed save.
      if (attemptedBytesAreCurrent) {
        refusalRecovery = { documentHash, previousBasis: currentBasis, resultingBasis: current };
        return { documentHash };
      }
      throw writeError;
    }
    // Guarded (CAS) write: the engine REJECTS the write when current no longer
    // matches `expectedCurrent` — a concurrent writer advanced the basis. The
    // current atomic owner rejects (handled above); older owners can return a
    // zero-write reply. In either case we VERIFY by re-reading current and
    // comparing hashes — the proven pattern (apply-current-state-writes-live.mjs
    // `verifyPreparedWrites`). See observations/2026-06-20-conflict-detection-*.md.
    //   • verify confirms our bytes  → applied → basis = writtenHash.
    //   • verify shows other bytes   → CONFLICT → basis = ACTUAL current (never the
    //                                  unpersisted written hash) + throw.
    //   • verify read FAILS          → retain attempted basis/bytes; a retry must
    //                                  resolve that uncertainty before writing.
    // L090 future-optimal: have the SDK decode `write_count` so this extra read is
    // unnecessary — flagged for the runtime-kit SDK owner (cross-lane, hook-blocked).
    let after: EngineReadCurrentReply;
    try {
      after = await readCurrent(partition, scene, sender, addressMode);
    } catch {
      // Verify-read failed → we cannot PROVE the guarded write landed. Fail-closed
      // (L117): keep both possible legitimate bases. A later retry must not
      // adopt an unrelated writer's newer content as permission to overwrite it.
      basis = currentBasis;
      unverifiedWrite = { basis: currentBasis, writtenHash };
      refusalRecovery = null;
      throw new CompositionSaveUnverifiedError();
    }
    const outcome = resolveWriteOutcome(writtenHash, basisFromCurrent(after).expectedPayloadHash);
    basis = outcome.newBasis;
    if (!outcome.applied) {
      refusalRecovery = null;
      throw new CompositionWriteConflictError();
    }
    refusalRecovery = { documentHash, previousBasis: currentBasis, resultingBasis: outcome.newBasis };
    return { documentHash };
  }

  return { read, readSnapshot, adoptSnapshot, write, confirmWrite, recoverRefusedWrite };
}

function sameBasis(left: CurrentBasis, right: CurrentBasis): boolean {
  if (left.expectedPayloadHash === null || right.expectedPayloadHash === null) return left.expectedPayloadHash === right.expectedPayloadHash;
  return bytesEqual(left.expectedPayloadHash, right.expectedPayloadHash);
}

function contentFingerprint(content: CompositionContent | null): string {
  return makeHashCodeHexFromBytes(textEncoder.encode(JSON.stringify(content)));
}

async function readCurrent(partitionLabel: string, sceneAddress: string, sender: BitfieldRequestSender, addressMode: 'label-hash' | 'identity-text'): Promise<EngineReadCurrentReply> {
  const request = buildEngineReadCurrentRequestFromLabels(partitionLabel, sceneAddress, { addressMode });
  try {
    return decodeEngineReadCurrentReply(payloadBytesFromReply(await sender(request)));
  } catch (error) {
    // A gateway failure can occur while the hosted runner is recovering. This
    // operation is read-only; retry its identical bytes once. Never apply this
    // policy to write-batch, whose outcome may already have been committed.
    if (!/\b(?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(String(error))) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    return decodeEngineReadCurrentReply(payloadBytesFromReply(await sender(request)));
  }
}

function contentFromCurrent(current: EngineReadCurrentReply): CompositionContent | null {
  const payloadBytes = currentPayloadBytes(current);
  if (!payloadBytes) return null;
  return readCompositionContent(JSON.parse(textDecoder.decode(payloadBytes)));
}

function basisFromCurrent(current: EngineReadCurrentReply): CurrentBasis {
  const payloadBytes = currentPayloadBytes(current);
  return {
    expectedPayloadHash: payloadBytes ? payloadHashBytes(payloadBytes) : null,
  };
}

function currentPayloadBytes(current: EngineReadCurrentReply): Uint8Array | null {
  return current.found ? current.payload : null;
}

function payloadHashBytes(payloadBytes: Uint8Array): Uint8Array {
  return multihashBytesFromCodeHex(makeHashCodeHexFromBytes(Uint8Array.from(payloadBytes)));
}

function multihashBytesFromCodeHex(codeHex: string): Uint8Array {
  const [codePart, digestPart] = codeHex.split(':');
  if (!codePart || !digestPart) throw new Error('Runtime Kit hash code hex was not code:digest');
  const digest = hexToBytes(digestPart);
  return concatBytes(unsignedVarint(Number.parseInt(codePart, 16)), unsignedVarint(digest.byteLength), digest);
}

function unsignedVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('multihash varint value is invalid');
  const bytes: number[] = [];
  let next = value;
  do {
    const byte = next & 0x7f;
    next = Math.floor(next / 128);
    bytes.push(next === 0 ? byte : byte | 0x80);
  } while (next !== 0);
  return new Uint8Array(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('hex bytes are invalid');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(...segments: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(segments.reduce((sum, segment) => sum + segment.byteLength, 0));
  let cursor = 0;
  for (const segment of segments) {
    output.set(segment, cursor);
    cursor += segment.byteLength;
  }
  return output;
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (isRecord(reply)) {
    const payload = reply.payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  throw new Error('engine.operation read-current reply did not include decodable payload bytes');
}

function isRecord(value: unknown): value is { payload?: unknown } {
  return typeof value === 'object' && value !== null;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Documents ${label} is empty`);
  return trimmed;
}

export const DOCUMENTS_ENGINE_TARGET = ENGINE_OPERATION_TARGET;
export const DOCUMENTS_READ_OPERATION = ENGINE_READ_CURRENT_OPERATION_LABEL;
export const DOCUMENTS_WRITE_OPERATION = ENGINE_WRITE_BATCH_OPERATION_LABEL;
