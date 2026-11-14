import {
  createTrustedRuntimeIdMinter,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { readAuthorizationTimeTarget } from './read-authorization-time.ts';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import {
  CONTROL_NOTE_KIND,
  CONTROL_HANDBACK_KIND,
  ONLY_ONE_CONTROLS_RULE,
  AlreadyInControlError,
  assertNobodyElseIsInControl,
  buildControlHandBack,
  decodeControlNotes,
  effectiveNow,
  isCurrentlyInControl,
  type ControlNote,
} from './exclusive-control-lease-core.ts';

/*
 * The two LIVE package-target routes that make the one-controller takeover BUTTONS
 * real. The operator console dispatches `slot::permission-lease.record-lease`
 * ("Take the wheel") and `slot::permission-lease.revoke-lease` ("Hand back") by
 * name (blind Envelope). Those targets must be backed by real code that WRITES the
 * control-note / hand-back DATA that ai-action-guard.govern-computer-action already
 * reads to deny the operator. Without a backing route the button silently degrades
 * to read-only and no note is recorded (verified live 2026-08-20: `permission-lease`
 * had ZERO `/boot` routes).
 *
 * These live inside permission-lease's own charter: they only record and check
 * permission-lease's OWN `permission_lease` / `permission_lease_revocation` records.
 * They import no other package, name no other owner's addresses, own no policy
 * (ai-action-guard) and no audit (ai-execution-history). The pure cores
 * (assertNobodyElseIsInControl, decodeControlNotes, buildControlHandBack, effectiveNow,
 * isCurrentlyInControl) are reused verbatim from exclusive-control-lease-core.ts, so
 * every decision unit-tests with no engine. The Envelope side effects (read the
 * live records, write the durable record) are injected, the exact style of
 * govern-computer-action.
 *
 * Read is the generic ambient `slot::find-current-items` over `published-record`
 * (the same op the guard reads notes with). Write is the generic ambient
 * `engine.operation.write-batch` over `engine.operation.label-addressed` (no
 * partition: the runner resolves the app's own partition, exactly as sidebar's
 * writeCollectionView does), landing the record in `published-record` where
 * find-current-items sees it.
 *
 * Wire values and slot addresses kept as-is on purpose, tracked in the plan
 * rename-the-lease-jargon-to-plain-words: the record `kind` stays 'permission_lease'
 * / 'permission_lease_revocation', the record fields stay `lease_ref` / `lease_class`,
 * and the dispatched slots stay `slot::permission-lease.record-lease` /
 * `.revoke-lease`, because ai-action-guard's live console (mount-openbot-operator.tsx)
 * dispatches those exact strings today. Only the TypeScript-facing names here are
 * plain; the file name is deferred with the wire layer since renaming it moves the
 * manifest `source_path` and needs a rebuild.
 */

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const FIND_CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
const NOTE_ADDRESS_PREFIX = 'package::permission-lease::exclusive-control-lease::';
const HANDBACK_ADDRESS_PREFIX = 'package::permission-lease::exclusive-control-revocation::';
const TEXT_DECODER = new TextDecoder();

export type ControlTargetSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

export type RecordControlReceipt = {
  kind: 'permission-lease-exclusive-control-grant-receipt';
  accepted: boolean;
  scope_ref: string;
  holder: string;
  lease_ref: string | null;
  already_held: boolean;
  recorded: boolean;
  conflict?: { held_by: string; held_lease_ref: string };
};

export type HandBackControlReceipt = {
  kind: 'permission-lease-exclusive-control-revoke-receipt';
  accepted: boolean;
  scope_ref: string;
  revoked_lease_refs: string[];
  recorded: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeReply(reply: unknown): Record<string, unknown> {
  if (reply instanceof Uint8Array) return JSON.parse(TEXT_DECODER.decode(reply)) as Record<string, unknown>;
  if (isRecord(reply) && reply.payload instanceof Uint8Array) {
    return JSON.parse(TEXT_DECODER.decode(reply.payload)) as Record<string, unknown>;
  }
  if (!isRecord(reply)) throw new Error('engine op returned no object');
  return reply;
}

function extractRecordPayload(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  if (isRecord(item.payload)) return item.payload;
  if (typeof item.payload_base64 === 'string' && item.payload_base64.length > 0) {
    return JSON.parse(TEXT_DECODER.decode(decodeBase64(item.payload_base64))) as Record<string, unknown>;
  }
  if (typeof item.value_json === 'string' && item.value_json.length > 0) {
    return JSON.parse(item.value_json) as Record<string, unknown>;
  }
  return item;
}

/** Ambient find-current-items over published-record: the generic read op, no partition. */
async function findCurrentItems(
  sender: ControlTargetSender,
  where: Array<{ field: string; eq?: unknown; in?: unknown[] }>,
): Promise<Record<string, unknown>[]> {
  const clauses = where.map((clause) =>
    clause.in !== undefined ? { field: clause.field, in: clause.in } : { field: clause.field, eq: clause.eq });
  const reply = decodeReply(await sender({
    target: FIND_CURRENT_ITEMS_TARGET,
    payload: { operation: 'find-current-items', in: 'published-record', where: { all: clauses } },
  }));
  const raw = Array.isArray(reply.items) ? reply.items
    : Array.isArray(reply.results) ? reply.results
    : Array.isArray(reply.records) ? reply.records
    : [];
  return raw.map(extractRecordPayload).filter((value): value is Record<string, unknown> => isRecord(value));
}

/** Ambient write-batch of one self-describing record into published-record, no partition. */
async function writePublishedRecord(
  sender: ControlTargetSender,
  addressLabel: string,
  payload: Record<string, unknown>,
): Promise<void> {
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
}

/**
 * SP3 high-water mark. The effective clock never drops below the newest timestamp
 * already durably observed (a note `since` or a hand-back `revoked_at`), so a
 * rolled-back system clock cannot resurrect a hold expired by those observations or
 * re-order a hand-back before the take it releases. Derived from DATA, never a
 * hardcoded floor.
 */
function deriveHighWaterMark(
  notes: ControlNote[],
  handBacks: Record<string, unknown>[],
): Date | undefined {
  let maxMs = Number.NEGATIVE_INFINITY;
  const consider = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
  };
  for (const note of notes) {
    consider(note.since);
    // A future deadline is not an observation that its time has passed.
  }
  for (const record of handBacks) {
    consider(record.revoked_at);
  }
  return Number.isFinite(maxMs) ? new Date(maxMs) : undefined;
}

async function readScopeState(
  sender: ControlTargetSender,
  scopeRef: string,
): Promise<{ notes: ControlNote[]; highWaterMark: Date | undefined }> {
  const [noteRecords, handBackRecords] = await Promise.all([
    findCurrentItems(sender, [
      { field: 'kind', eq: CONTROL_NOTE_KIND },
      { field: 'lease_class', eq: ONLY_ONE_CONTROLS_RULE },
      { field: 'scope_ref', eq: scopeRef },
    ]),
    findCurrentItems(sender, [{ field: 'kind', eq: CONTROL_HANDBACK_KIND }]),
  ]);
  // decodeControlNotes applies both a note-payload `revoked:true` and any matching
  // hand-back record, so the returned notes already carry hand-backs.
  const notes = decodeControlNotes({ things: [...noteRecords, ...handBackRecords] });
  return { notes, highWaterMark: deriveHighWaterMark(notes, handBackRecords) };
}

// The nonce keeps two notes on the same scope and holder in the same millisecond
// distinct; it is an IDENTITY, and idempotency is decided upstream by
// assertNobodyElseIsInControl. Taking the nonce source as a VALUE lets the target
// feed it from the entropy the engine recorded, so a replayed grant names the
// same note instead of a new one.
function newLeaseRef(
  scopeRef: string,
  holder: string,
  effNow: Date,
  mintNonce: () => string,
): string {
  const nonce = mintNonce().replace(/-/g, '').slice(0, 8);
  return `lease:${ONLY_ONE_CONTROLS_RULE}:${scopeRef}:${holder}:${effNow.getTime()}-${nonce}`;
}

/* =============================================================================
 * TARGET 1: record-lease ("Take the wheel"). The operator console dispatches this
 * with { operation, lease_class, scope_ref, holder, reason } and NO lease_ref, so
 * the handler mints a unique one. At most one party may be driving one scope at a
 * time (assertNobodyElseIsInControl -> AlreadyInControlError): a second party
 * cannot take a wheel a current holder already holds. The SAME holder re-taking a
 * wheel they already hold is idempotent (returns the held note, no new write).
 * ========================================================================== */
export async function recordControlTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: ControlTargetSender = sendRequestToBitfieldTarget as ControlTargetSender,
  now: () => Date | Promise<Date> = async () => new Date((await readAuthorizationTimeTarget(
    { request_ref: 'permission-lease:record-lease' }, context, sender,
  )).now_ms),
): Promise<RecordControlReceipt> {
  if (!isRecord(input)) throw new TypeError('record-lease request must be an object');
  const scopeRef = requiredText(input.scope_ref, 'scope_ref');
  const holder = requiredText(input.holder, 'holder');
  const holderSubjectRef = optionalText(input.holder_subject_ref);
  const reason = optionalText(input.reason);
  const expiresAt = input.expires_at === null ? null : optionalText(input.expires_at);

  // Sample the shared scope revision BEFORE reading holders. The revision and
  // new note are written atomically, so two empty reads cannot both acquire it.
  const scopeAddress = `package::permission-lease::control-scope::${encodeURIComponent(scopeRef)}`;
  const scopeRevision = decodeReply(await sender({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: { operation_label: 'engine.operation.read-current', address_label: scopeAddress, address_mode: 'label_hash' },
  }));
  let expectedScopeHash: string | null = null;
  let scopeGeneration = 0;
  if (scopeRevision.found !== false) {
    if (scopeRevision.found !== true || typeof scopeRevision.content_hash !== 'string') {
      throw new Error('Control scope could not be read.');
    }
    const priorMarker = scopeRevision.payload;
    if (!isRecord(priorMarker) || priorMarker.scope_ref !== scopeRef
      || !Number.isSafeInteger(priorMarker.generation) || Number(priorMarker.generation) < 1
      || Number(priorMarker.generation) >= Number.MAX_SAFE_INTEGER) throw new Error('Control scope revision is invalid.');
    scopeGeneration = Number(priorMarker.generation);
    let binary = '';
    for (const byte of makeMultihashEncodedBytesFromCodeHex(scopeRevision.content_hash)) binary += String.fromCharCode(byte);
    expectedScopeHash = btoa(binary);
  }
  const { notes, highWaterMark } = await readScopeState(sender, scopeRef);
  const observedNow = await now();
  const effNow = effectiveNow(observedNow, highWaterMark);

  const currentHold = notes.find((note) => isCurrentlyInControl(note, scopeRef, effNow));
  if (currentHold) {
    if (currentHold.holder === holder) {
      // Idempotent re-take: this party already controls this scope.
      return {
        kind: 'permission-lease-exclusive-control-grant-receipt',
        accepted: true,
        scope_ref: scopeRef,
        holder,
        lease_ref: currentHold.lease_ref,
        already_held: true,
        recorded: false,
      };
    }
    // A different party holds the wheel: refuse (deny beats a second controller).
    return {
      kind: 'permission-lease-exclusive-control-grant-receipt',
      accepted: false,
      scope_ref: scopeRef,
      holder,
      lease_ref: null,
      already_held: false,
      recorded: false,
      conflict: { held_by: currentHold.holder, held_lease_ref: currentHold.lease_ref },
    };
  }

  const leaseRef = optionalText(input.lease_ref)
    ?? newLeaseRef(scopeRef, holder, effNow, createTrustedRuntimeIdMinter(context));
  const sinceIso = effNow.toISOString();

  let note: ControlNote;
  try {
    // Defensive pure-core guard: still enforces one-controller-at-a-time + SP3 at write time.
    note = assertNobodyElseIsInControl(
      notes,
      {
        leaseRef,
        scopeRef,
        holder,
        ...(holderSubjectRef ? { holderSubjectRef } : {}),
        ...(reason ? { reason } : {}),
        since: sinceIso,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      { now: observedNow, highWaterMark },
    );
  } catch (error) {
    if (error instanceof AlreadyInControlError) {
      return {
        kind: 'permission-lease-exclusive-control-grant-receipt',
        accepted: false,
        scope_ref: scopeRef,
        holder,
        lease_ref: null,
        already_held: false,
        recorded: false,
        conflict: { held_by: error.heldBy, held_lease_ref: error.heldLeaseRef },
      };
    }
    throw error;
  }

  const payload: Record<string, unknown> = {
    kind: note.kind,
    lease_ref: note.lease_ref,
    lease_class: note.lease_class,
    scope_ref: note.scope_ref,
    holder: note.holder,
    subject_ref: holderSubjectRef ?? note.holder,
    allowed_actions: ['computer.actuate'],
    since: note.since,
    revoked: false,
    ...(holderSubjectRef ? { holder_subject_ref: holderSubjectRef } : {}),
    ...(reason ? { reason } : {}),
    ...(note.expires_at !== undefined ? { expires_at: note.expires_at } : {}),
  };

  const writtenBatch = decodeReply(await sender({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: scopeAddress, address_mode: 'label_hash',
          path_labels: ['current-item', 'permission-control-scope'],
          payload: { scope_ref: scopeRef, lease_ref: leaseRef, generation: scopeGeneration + 1 },
          expected_current: { payload_hash_base64: expectedScopeHash },
        },
        {
          address_label: `${NOTE_ADDRESS_PREFIX}${encodeURIComponent(leaseRef)}`,
          address_mode: 'label_hash', path_labels: [...PUBLISHED_RECORD_PATH], payload,
        },
      ],
    },
  }));
  if (writtenBatch.write_count !== 2) throw new Error('Control acquisition was not recorded.');

  // Owner readback: the record must be current and found before we report accepted.
  const readback = await readScopeState(sender, scopeRef);
  const written = readback.notes.find((candidate) => candidate.lease_ref === leaseRef);
  if (!written || written.revoked === true) {
    throw new Error('control note write could not be confirmed by owner readback');
  }

  return {
    kind: 'permission-lease-exclusive-control-grant-receipt',
    accepted: true,
    scope_ref: scopeRef,
    holder,
    lease_ref: leaseRef,
    already_held: false,
    recorded: true,
  };
}

/* =============================================================================
 * TARGET 2: revoke-lease ("Hand back"). The operator console dispatches this with
 * { operation, lease_class, scope_ref, reason } and NO lease_ref, so the handler
 * finds every party CURRENTLY driving the scope and writes a durable
 * `permission_lease_revocation` naming each held lease_ref. Idempotent: handing
 * back an already-free wheel writes nothing and succeeds.
 * ========================================================================== */
export async function handBackControlTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: ControlTargetSender = sendRequestToBitfieldTarget as ControlTargetSender,
  now: () => Date | Promise<Date> = async () => new Date((await readAuthorizationTimeTarget(
    { request_ref: 'permission-lease:revoke-lease' }, context, sender,
  )).now_ms),
): Promise<HandBackControlReceipt> {
  if (!isRecord(input)) throw new TypeError('revoke-lease request must be an object');
  const scopeRef = requiredText(input.scope_ref, 'scope_ref');
  const reason = optionalText(input.reason);
  const subjectRef = optionalText(input.subject_ref);
  const explicitLeaseRef = optionalText(input.lease_ref);

  const { notes, highWaterMark } = await readScopeState(sender, scopeRef);
  const effNow = effectiveNow(await now(), highWaterMark);
  const revokedAt = effNow.toISOString();

  const targets = explicitLeaseRef
    ? notes.filter((note) => note.lease_ref === explicitLeaseRef && isCurrentlyInControl(note, scopeRef, effNow))
    : notes.filter((note) => isCurrentlyInControl(note, scopeRef, effNow));

  const revokedRefs: string[] = [];
  for (const note of targets) {
    const handBack = buildControlHandBack(note.lease_ref, {
      ...(subjectRef ? { subjectRef } : {}),
      ...(reason ? { reason } : {}),
      revokedAt,
    });
    await writePublishedRecord(sender, `${HANDBACK_ADDRESS_PREFIX}${encodeURIComponent(note.lease_ref)}`, handBack);
    revokedRefs.push(note.lease_ref);
  }

  if (revokedRefs.length === 0) {
    // Nothing current to hand back: the wheel is already free. Idempotent success.
    return {
      kind: 'permission-lease-exclusive-control-revoke-receipt',
      accepted: true,
      scope_ref: scopeRef,
      revoked_lease_refs: [],
      recorded: false,
    };
  }

  // Owner readback: nobody may still be driving the scope.
  const after = await readScopeState(sender, scopeRef);
  const readbackNow = effectiveNow(await now(), after.highWaterMark);
  const stillDriving = after.notes.find((note) => isCurrentlyInControl(note, scopeRef, readbackNow));
  if (stillDriving) {
    throw new Error('hand-back could not be confirmed: a party is still driving after hand-back');
  }

  return {
    kind: 'permission-lease-exclusive-control-revoke-receipt',
    accepted: true,
    scope_ref: scopeRef,
    revoked_lease_refs: revokedRefs,
    recorded: true,
  };
}
