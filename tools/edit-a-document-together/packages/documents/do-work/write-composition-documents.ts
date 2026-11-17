import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
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
} from '@bitfield/runtime-kit/protocol';
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
// Version notes: one index record per save (hash + time, never a content copy).
// WS1 PART A (L126): version notes are pure exhaust — no live UI subscriber reads
// them off the shared published-records aggregate today (readVersionNotes in
// scene-views.ts is only exercised by its own unit test; zero production caller).
// They write to a package-scoped current-item path instead of the published path
// so they never enter the 34.7MB aggregate that all 60 subscriber packages
// re-materialize on every read. If a surface later wires readVersionNotes to a
// real feed, point it at this same scoped path via a record_from_matching_records
// sink (the documents triple), never back onto the published path.
export const VERSION_NOTE_ADDRESS_PREFIX = 'package::documents::version-note::';
export const COMPOSITION_VERSION_NOTE_PATH = ['current-item', 'documents-exhaust'] as const;

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
 * Thrown when a write was accepted by transport but its durability could NOT be
 * VERIFIED — the post-write verify-read failed, so we cannot prove the guarded
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
  readSnapshot: () => Promise<CompositionDocumentSnapshot>;
  write: (content: CompositionContent) => Promise<void>;
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
 * `readClockMs` is required and has no default. This module is compiled into
 * Documents' own targets, which the engine replays against the log: a clock this
 * module reached for itself would make the same log produce a different version
 * note on a different day. Targets pass `() => readTrustedRuntimeClockMs(context)`,
 * so the read happens only on the write path and a read-only target never needs a
 * clock at all. Browser surfaces pass their own clock, which the log records as
 * the input it is. Nothing here changed about the fail-closed empty-write guard:
 * `compositionHasAuthoredText` still refuses an empty tree over authored content.
 */
export function createCompositionDocumentsLogStore(
  partitionLabel: string,
  readClockMs: () => number,
  sceneAddress: string = DOCUMENTS_ADDRESS,
  sender: BitfieldRequestSender = sendRequestToBitfieldTarget as BitfieldRequestSender,
  addressMode: 'label-hash' | 'identity-text' = 'label-hash',
): CompositionDocumentsLogStore {
  const partition = nonEmpty(partitionLabel, 'partitionLabel');
  const scene = nonEmpty(sceneAddress, 'sceneAddress');
  let basis: CurrentBasis | null = null;
  let unverifiedWrite: { basis: CurrentBasis; writtenHash: Uint8Array } | null = null;
  // `basis` is read-modify-written across `await` points, so overlapping ops
  // would read a STALE basis → spurious self-conflict + dropped edits on fast edits
  // (Codex + local convergence 2026-06-20, made worse by ~8s engine writes).
  // Serialize EVERY basis-touching op through one chain so each runs strictly
  // after the previous completes — atomic read-modify-write. (L055 root:
  // single-writer basis; L063: eliminates the whole write-overlap race class.)
  const serialize = createSerialChain();

  function read(): Promise<CompositionContent | null> {
    return readSnapshot().then((snapshot) => snapshot.content);
  }

  function readSnapshot(): Promise<CompositionDocumentSnapshot> {
    return serialize(async () => {
      const current = await readCurrent(partition, scene, sender, addressMode);
      const content = contentFromCurrent(current);
      basis = basisFromCurrent(current);
      unverifiedWrite = null; // the caller explicitly adopts this current snapshot
      const payloadBytes = currentPayloadBytes(current);
      return {
        content,
        documentHash: payloadBytes ? makeHashCodeHexFromBytes(Uint8Array.from(payloadBytes)) : null,
      };
    });
  }

  function write(content: CompositionContent): Promise<void> {
    return serialize(() => writeOnce(content));
  }

  async function writeOnce(content: CompositionContent): Promise<void> {
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
    const payloadBytes = textEncoder.encode(JSON.stringify(content));
    const writtenHash = payloadHashBytes(payloadBytes);
    // The caller's clock, never one this module reached for: see the factory doc.
    const savedAt = new Date(readClockMs()).toISOString();
    // Second write in the same batch: a version note indexing this save.
    // The note carries only hash + time (an index, never a content copy) —
    // the log itself holds every prior payload.
    const versionNoteBytes = textEncoder.encode(JSON.stringify({
      kind: 'composition-version-note',
      payload_hash: makeHashCodeHexFromBytes(Uint8Array.from(payloadBytes)),
      saved_at: savedAt,
    }));
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
    }, {
      partitionLabel: partition,
      addressLabel: `${VERSION_NOTE_ADDRESS_PREFIX}${savedAt}`,
      pathLabels: COMPOSITION_VERSION_NOTE_PATH,
      payloadBytes: versionNoteBytes,
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
        throw new CompositionSaveUnverifiedError();
      }
      const sameBasis = current.expectedPayloadHash === null
        ? currentBasis.expectedPayloadHash === null
        : currentBasis.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, currentBasis.expectedPayloadHash);
      const attemptedBytesAreCurrent = current.expectedPayloadHash !== null && bytesEqual(current.expectedPayloadHash, writtenHash);
      if (!sameBasis && !attemptedBytesAreCurrent) {
        basis = current;
        throw new CompositionWriteConflictError();
      }
      // An unchanged record is a failed save, not a conflict. An ambiguous
      // response after our bytes appeared also must not claim success or reload.
      // Keep the local edit and original failure, with this verified CAS basis.
      basis = current;
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
      throw new CompositionSaveUnverifiedError();
    }
    const outcome = resolveWriteOutcome(writtenHash, basisFromCurrent(after).expectedPayloadHash);
    basis = outcome.newBasis;
    if (!outcome.applied) throw new CompositionWriteConflictError();
  }

  return { read, readSnapshot, write };
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
